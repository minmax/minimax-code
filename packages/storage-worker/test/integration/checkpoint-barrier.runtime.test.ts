import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';

import { createStorageWorker } from '../../src/client.js';
import { TOOL_OUTCOME_UNKNOWN } from '../../src/contracts.js';
import type { Entry, StorageWorker, StorageWorkerBackend } from '../../src/contracts.js';
import { withCheckpointPolicy } from '../../src/runtime-hooks.js';
import {
	sqliteZstdStorageBackend,
	toEntryDraft,
	type SqliteZstdBackendLike,
	type SqliteZstdCommitLike,
	type SqliteZstdEntryDraft,
} from '../../src/sqlite-zstd-adapter.js';

// Checkpoint-policy integration on the REAL runtime path (SE-SW-002): the
// `withCheckpointPolicy` wiring driven through the REAL storage worker (its
// own batch-window thread) and the REAL sqlite-zstd backend. The emulated
// sequence is the architecture's kill scenario — [LLM request -> 3 tool
// effects -> process kill] — with the invariants:
//   1. no committed entry is ever lost,
//   2. TOOL_OUTCOME_UNKNOWN belongs exactly to the interrupted calls,
//   3. no repeats (no entry committed twice, no call re-run implicitly).
// Scenario 1 runs the whole sequence in-process with the third effect
// aborted mid-flight; scenario 2 runs it in a child process that is killed
// with SIGKILL exactly while the third effect is in flight, then reopens the
// database from outside. Scenario 3 pins the fail-closed mapping: an
// unconfirmable batch yields TOOL_OUTCOME_UNKNOWN for the effect — never a
// start, never an implicit retry.

const directories: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
	while (workers.length > 0) {
		const worker = workers.pop();
		if (worker !== undefined) await worker.dispose().catch(() => {});
	}
	for (const child of children.splice(0)) {
		try {
			child.kill('SIGKILL');
		} catch {
			// Already dead.
		}
	}
	while (directories.length > 0) {
		const dir = directories.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function freshDirectory(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	directories.push(dir);
	return dir;
}

function entry(entryId: string, text: string, parentId: string | null = null): Entry {
	const payload = { text, role: 'user' };
	return {
		entryId,
		parentId,
		kind: 'pi.session',
		payload,
		bytes: Buffer.byteLength(
			JSON.stringify(toEntryDraft({ entryId, parentId, kind: 'pi.session', payload, bytes: 0 })),
		),
	};
}

/** Workers to tear down even when an assertion throws mid-scenario. */
const workers: StorageWorker[] = [];

function trackedWorker(backend: StorageWorkerBackend, options = {}): StorageWorker {
	const worker = createStorageWorker(backend, { windowMs: 60_000, ...options });
	workers.push(worker);
	return worker;
}

/** Traces the REAL sqlite-zstd backend so the event order includes commits. */
function tracedSqliteBackend(
	directory: string,
	events: string[],
): { backend: SqliteZstdBackendLike; closeReal: () => Promise<void> } {
	const real = openSqliteZstdBackend(directory);
	return {
		backend: {
			appendBatch: async (drafts: readonly SqliteZstdEntryDraft[]): Promise<SqliteZstdCommitLike> => {
				const commit = await real.appendBatch(drafts);
				events.push(`commit:${drafts.map((draft) => draft.id).join(',')}`);
				return commit;
			},
			checkpoint: async () => {
				await real.checkpoint();
				events.push('backend-checkpoint');
			},
		},
		closeReal: () => real.close(),
	};
}

interface MemoryBackend {
	backend: StorageWorkerBackend;
	state: {
		appendedIds: string[];
		failCheckpoint: boolean;
	};
}

function memoryBackend(): MemoryBackend {
	let seq = 0;
	const state = { appendedIds: [], failCheckpoint: false };
	const backend: StorageWorkerBackend = {
		async appendBatch(entries) {
			state.appendedIds.push(...entries.map((item) => item.entryId));
			seq += 1;
			return { batchId: String(seq), seq, head: String(seq) };
		},
		async checkpoint() {
			if (state.failCheckpoint) throw new Error('checkpoint unavailable');
			return null;
		},
	};
	return { backend, state };
}

describe('checkpoint barrier on the real runtime path (withCheckpointPolicy)', () => {
	it('drives [LLM request -> 3 tool effects -> kill]: every barrier flush lands, unknown exactly for the interrupted call, no repeats', async () => {
		const directory = freshDirectory('checkpoint-runtime-');
		const events: string[] = [];
		const { backend, closeReal } = tracedSqliteBackend(directory, events);
		const worker = trackedWorker(sqliteZstdStorageBackend(backend));
		const unknownReports: Array<{ callId: string; reason: string }> = [];
		const runtime = withCheckpointPolicy(worker, {
			onUnknownOutcome: (marker, info) => {
				unknownReports.push({ callId: marker.callId, reason: info.reason });
			},
		});

		// LLM step: the request entries are enqueued, the result is emitted
		// only behind the fail-closed barrier.
		await worker.enqueue(entry('llm-1-request', 'plan the move', null));
		await runtime.emitLlmStepResult({ stepId: 'llm-1' }, async () => {
			await worker.enqueue(entry('llm-1-result', 'assistant: use tools', 'llm-1-request'));
			events.push('llm-emitted');
		});

		// Three tool effects; the third is "killed" mid-flight through the
		// turn's abort signal.
		const controller = new AbortController();
		let resolveThirdStarted!: () => void;
		const thirdStarted = new Promise<void>((resolve) => {
			resolveThirdStarted = resolve;
		});

		for (const callId of ['call-1', 'call-2', 'call-3'] as const) {
			await worker.enqueue(entry(`${callId}-intent`, `${callId} intent`, 'llm-1-result'));
			const pending = runtime.runToolEffect(
				{ callId, toolName: 'demo.tool' },
				async () => {
					events.push(`effect:${callId}`);
					if (callId === 'call-3') {
						resolveThirdStarted();
						await new Promise<never>((_, reject) => {
							controller.signal.addEventListener('abort', () => reject(new Error('killed mid-effect')));
						});
					}
					return `ok:${callId}`;
				},
				{ signal: controller.signal },
			);
			// The "kill" of the third call lands once the effect is in flight.
			if (callId === 'call-3') {
				await thirdStarted;
				controller.abort();
			}
			const outcome = await pending;
			if (callId === 'call-3') {
				expect(outcome).toEqual({ outcome: TOOL_OUTCOME_UNKNOWN });
			} else {
				expect(outcome).toEqual({ outcome: 'completed', value: `ok:${callId}` });
				// The runtime records the confirmed outcome into the session.
				await worker.enqueue(entry(`${callId}-result`, `outcome of ${callId}`, `${callId}-intent`));
			}
		}

		// Every guarded step ran strictly after its batch commit AND the
		// backend checkpoint probe; the interrupted call produced no further
		// flush (its outcome was never recorded).
		expect(events).toEqual([
			'commit:llm-1-request',
			'backend-checkpoint',
			'llm-emitted',
			'commit:llm-1-result,call-1-intent',
			'backend-checkpoint',
			'effect:call-1',
			'commit:call-1-result,call-2-intent',
			'backend-checkpoint',
			'effect:call-2',
			'commit:call-2-result,call-3-intent',
			'backend-checkpoint',
			'effect:call-3',
		]);

		// Unknown belongs exactly to the interrupted call.
		expect(runtime.unknownOutcomeCallIds).toEqual(['call-3']);
		expect(unknownReports).toEqual([{ callId: 'call-3', reason: 'interrupted' }]);

		// Durability of everything committed before the "kill": dispose the
		// writer, reopen the database from scratch, read the whole chain back.
		await worker.dispose();
		await closeReal();
		const reopened = openSqliteZstdBackend(directory);
		try {
			expect(reopened.readDelta(0, 1024 * 1024).map((item) => item.id)).toEqual([
				'llm-1-request',
				'llm-1-result',
				'call-1-intent',
				'call-1-result',
				'call-2-intent',
				'call-2-result',
				'call-3-intent',
			]);
			expect(reopened.readResume()).not.toBeNull();
		} finally {
			await reopened.close();
		}
	}, 30_000);

	it('fails closed on an uncommitted batch: the effect receives TOOL_OUTCOME_UNKNOWN without starting and without an implicit retry', async () => {
		const { backend, state } = memoryBackend();
		const worker = trackedWorker(backend);
		const unknownReports: Array<{ callId: string; reason: string; error?: string }> = [];
		const runtime = withCheckpointPolicy(worker, {
			onUnknownOutcome: (marker, info) => {
				unknownReports.push({
					callId: marker.callId,
					reason: info.reason,
					...(info.error !== undefined ? { error: info.error.message } : {}),
				});
			},
		});

		// Durability cannot be confirmed: the batch is (or may be) uncommitted.
		state.failCheckpoint = true;
		await worker.enqueue(entry('e1', 'tool intent'));

		let runs = 0;
		const outcome = await runtime.runToolEffect(
			{ callId: 'call-x', toolName: 'fs.write' },
			async () => {
				runs += 1;
				return 'never';
			},
		);
		expect(outcome).toEqual({ outcome: TOOL_OUTCOME_UNKNOWN });
		expect(runs).toBe(0);
		expect(runtime.unknownOutcomeCallIds).toEqual(['call-x']);
		expect(unknownReports).toEqual([
			{ callId: 'call-x', reason: 'barrier-failed', error: 'checkpoint unavailable' },
		]);

		// The guarded LLM emit refuses too, naming the blocked step; the
		// original barrier failure stays reachable as the cause.
		await worker.enqueue(entry('e2', 'next intent', 'e1'));
		const emitFailure = await runtime
			.emitLlmStepResult({ stepId: 'llm-2' }, async () => 'never-emitted')
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(emitFailure).toBeInstanceOf(Error);
		expect((emitFailure as Error).message).toContain('LLM step "llm-2"');
		expect(((emitFailure as Error).cause as Error).message).toBe('checkpoint unavailable');

		// No repeats: an implicit second attempt of the recorded call is
		// refused outright.
		await expect(
			runtime.runToolEffect({ callId: 'call-x', toolName: 'fs.write' }, async () => {
				runs += 1;
				return 'again';
			}),
		).rejects.toThrow(/unknown outcome/);
		expect(runs).toBe(0);

		// Explicit recovery decision + healed backend: the call runs once and
		// the unknown record clears.
		state.failCheckpoint = false;
		const recovered = await runtime.runToolEffect(
			{ callId: 'call-x', toolName: 'fs.write' },
			async () => {
				runs += 1;
				return 'recovered';
			},
			{ allowAfterUnknownOutcome: true },
		);
		expect(recovered).toEqual({ outcome: 'completed', value: 'recovered' });
		expect(runs).toBe(1);
		expect(runtime.unknownOutcomeCallIds).toEqual([]);
		expect(state.appendedIds).toEqual(['e1', 'e2']);
	}, 30_000);

	it('survives kill -9 mid-effect: every committed entry is durable exactly once, the interrupted call has no recorded outcome', async () => {
		const dir = freshDirectory('checkpoint-runtime-kill9-');
		const progressFile = join(dir, 'progress.jsonl');
		const shimPath = join(dir, 'ts-resolve-shim.mjs');
		const childPath = join(dir, 'runtime-child.mjs');

		// Resolve shim shared by the child's main thread (inlined below) and
		// its storage-worker thread (--import): .js specifiers fall back to
		// the repository's TypeScript sources under raw Node.
		writeFileSync(
			shimPath,
			`
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try { return nextResolve(specifier, context); }
      catch { return nextResolve(specifier.replace(/\\.js$/, '.ts'), context); }
    }
    return nextResolve(specifier, context);
  },
});
`,
		);

		const storageSrcUrl = pathToFileURL(
			fileURLToPath(new URL('../../src/', import.meta.url)),
		).href;
		const backendUrl = pathToFileURL(
			fileURLToPath(new URL('../../../durable-backend-sqlite-zstd/src/index.ts', import.meta.url)),
		).href;

		// The child drives the REAL runtime path end to end: real storage
		// worker (its own batch-window thread), real sqlite-zstd backend, the
		// withCheckpointPolicy wiring, and the emulated turn [LLM request ->
		// 3 tool effects]. Its progress file is the durable observation
		// channel: appendFileSync writes survive SIGKILL (the OS keeps the
		// page cache), which is what makes the post-kill assertions possible.
		writeFileSync(
			childPath,
			`
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try { return nextResolve(specifier, context); }
      catch { return nextResolve(specifier.replace(/\\.js$/, '.ts'), context); }
    }
    return nextResolve(specifier, context);
  },
});

const SOURCE_BASE = ${JSON.stringify(storageSrcUrl)};
const { createStorageWorker } = await import(SOURCE_BASE + 'client.ts');
const { sqliteZstdStorageBackend } = await import(SOURCE_BASE + 'sqlite-zstd-adapter.ts');
const { withCheckpointPolicy } = await import(SOURCE_BASE + 'runtime-hooks.ts');
const { openSqliteZstdBackend } = await import(${JSON.stringify(backendUrl)});

const [directory, progressFile] = process.argv.slice(2);
const progress = (line) => appendFileSync(progressFile, JSON.stringify(line) + '\\n');

const backend = openSqliteZstdBackend(directory);
const worker = createStorageWorker(sqliteZstdStorageBackend(backend), {
  windowMs: 60_000,
  workerExecArgv: ['--import', ${JSON.stringify(pathToFileURL(shimPath).href)}],
});
const runtime = withCheckpointPolicy(worker);

const entry = (entryId, parentId, payload) => ({
  entryId, parentId, kind: 'pi.session', payload,
  bytes: Buffer.byteLength(JSON.stringify({ id: entryId, parentId, kind: 'pi.session', payload })),
});

progress({ event: 'turn-start' });
await worker.enqueue(entry('llm-1-request', null, { role: 'user', text: 'plan the move' }));
await runtime.emitLlmStepResult({ stepId: 'llm-1' }, async () => {
  await worker.enqueue(entry('llm-1-result', 'llm-1-request', { role: 'assistant', text: 'use tools' }));
  progress({ event: 'llm-emitted' });
});

for (const callId of ['call-1', 'call-2', 'call-3']) {
  await worker.enqueue(entry(callId + '-intent', 'llm-1-result', { callId }));
  const outcome = await runtime.runToolEffect(
    { callId, toolName: 'demo.tool' },
    async () => {
      progress({ event: 'effect-start', callId });
      if (callId === 'call-3') {
        // The kill -9 from the test lands exactly here: the effect is in
        // flight, its outcome unobservable. The heartbeat keeps the event
        // loop open the way a real long-running effect (network wait,
        // subprocess) would.
        setInterval(() => {}, 1_000);
        await new Promise(() => {});
      }
      return 'ok-' + callId;
    },
  );
  if (outcome.outcome !== 'completed') {
    // Never fabricate an outcome for an unconfirmed call: record the
    // unknown and stop the turn.
    progress({ event: 'effect-outcome', callId, outcome: outcome.outcome });
    break;
  }
  await worker.enqueue(entry(callId + '-result', callId + '-intent', { callId }));
  progress({ event: 'effect-outcome', callId, outcome: 'completed' });
}

progress({ event: 'turn-complete' });
await worker.dispose();
backend.close();
progress({ event: 'done' });
`,
		);

		const child = spawn(process.execPath, [childPath, dir, progressFile], {
			// The progress file is the channel; a crashed child still surfaces
			// its stderr in the test log.
			stdio: ['ignore', 'ignore', 'inherit'],
		});
		children.push(child);
		const exited = new Promise<void>((resolve) => {
			child.on('exit', () => resolve());
		});

		// Wait until the child is exactly mid-third-effect, then kill -9.
		let earlyExitError: Error | null = null;
		let killed = false;
		const exitedEarly = exited.then(() => {
			// Only an exit that happens BEFORE the test's own SIGKILL is a
			// failure: after the kill this same promise resolves too.
			if (!killed) {
				earlyExitError = new Error(
					`runtime child exited before the kill marker; progress: ${readProgress(progressFile)
						.map((line) => JSON.stringify(line))
						.join(' | ')}`,
				);
			}
		});
		await Promise.race([
			waitForProgress(progressFile, (line) => line.event === 'effect-start' && line.callId === 'call-3'),
			exitedEarly,
		]);
		killed = true;
		child.kill('SIGKILL');
		await exited;
		if (earlyExitError !== null) throw earlyExitError;

		// Reopen the database from OUTSIDE the killed process: every entry
		// committed before the kill is there, each exactly once, in commit
		// order — and the interrupted call's result never landed.
		const reopened = openSqliteZstdBackend(dir);
		try {
			expect(reopened.readDelta(0, 1024 * 1024).map((item) => item.id)).toEqual([
				'llm-1-request',
				'llm-1-result',
				'call-1-intent',
				'call-1-result',
				'call-2-intent',
				'call-2-result',
				'call-3-intent',
			]);
			expect(reopened.readResume()).not.toBeNull();
		} finally {
			reopened.close();
		}

		// The durable outcome log: confirmed outcomes exactly for the two
		// finished calls; the third started but has no recorded outcome — the
		// interrupted one, i.e. the unknown set is exactly {call-3}.
		const lines = readProgress(progressFile);
		expect(lines.filter((line) => line.event === 'effect-outcome')).toEqual([
			{ event: 'effect-outcome', callId: 'call-1', outcome: 'completed' },
			{ event: 'effect-outcome', callId: 'call-2', outcome: 'completed' },
		]);
		const started = lines.filter((line) => line.event === 'effect-start').map((line) => line.callId);
		const confirmed = lines
			.filter((line) => line.event === 'effect-outcome')
			.map((line) => line.callId);
		expect(started).toEqual(['call-1', 'call-2', 'call-3']);
		expect(started.filter((callId) => !confirmed.includes(callId))).toEqual(['call-3']);
	}, 60_000);
});

interface ProgressLine {
	event: string;
	callId?: string;
	outcome?: string;
}

function readProgress(progressFile: string): ProgressLine[] {
	try {
		return readFileSync(progressFile, 'utf8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as ProgressLine);
	} catch {
		return [];
	}
}

/** Waits until the progress file records a line matching `predicate`. */
async function waitForProgress(
	progressFile: string,
	predicate: (line: ProgressLine) => boolean,
): Promise<void> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		if (readProgress(progressFile).some(predicate)) return;
		if (Date.now() > deadline) {
			throw new Error(
				`progress stalled; got: ${readProgress(progressFile)
					.map((line) => JSON.stringify(line))
					.join(' | ')}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
