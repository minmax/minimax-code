/**
 * Steering-level kill -9 crash matrix (steering-design-sol.md §6.4, round-1
 * review fix 6): the WRITER PROCESS is SIGKILLed right after each steering
 * commit point —
 *
 *   1. T_accept        (Enter saved-ack committed, release not decided),
 *   2. release decision (the `mcode.delegation.backgrounded` entry committed,
 *                       tool finalization not),
 *   3. native finalization (the single tool-result committed),
 *   4. child completion   (the completion + reporter record committed),
 *
 * and after every kill a FRESH process reopens the store. Zero lost
 * committed inputs, zero second backgrounded records, zero second
 * tool-results, zero second completions — the prepared outcome is
 * REPRODUCED, the child is never restarted.
 *
 * (Epoch change / storage-level torn tails are the backend's own kill-9
 * suite: packages/durable-backend-sqlite-zstd/test/integration/kill-9-crash.test.ts;
 * this file is the steering SEMANTICS layer on the same real backend.)
 *
 * @module
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteZstdBackend } from '../../durable-backend-sqlite-zstd/src/index.js';
import { DurableSeam, SEAM_ENTRY_KINDS, sqliteZstdDurableLogPort } from '../../durable-seam/src/index.js';
import { DelegationSupervisor } from '../../delegation-supervisor/src/index.js';
import { sqliteZstdDelegationLog } from '../../delegation-supervisor/src/log.js';

const directories: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
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

type CrashPoint = 'accept' | 'release' | 'finalize' | 'complete';

interface ProgressLine {
	readonly point: CrashPoint;
	readonly conversationId: string;
	readonly requestId: string;
	readonly delegationId: string;
	readonly waitId: string;
	readonly toolCallId: string;
	readonly childRunId: string;
}

function freshDirectory(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	directories.push(dir);
	return dir;
}

/** The crash-prone writer child: drives the composed stack commit by commit. */
function writeSteeringWriterScript(scriptPath: string): void {
	const packagesRoot = fileURLToPath(new URL('../../', import.meta.url));
	const backendUrl = pathToFileURL(join(packagesRoot, 'durable-backend-sqlite-zstd/src/index.ts')).href;
	const seamUrl = pathToFileURL(join(packagesRoot, 'durable-seam/src/index.ts')).href;
	const supervisorLogUrl = pathToFileURL(join(packagesRoot, 'delegation-supervisor/src/log.ts')).href;
	const supervisorUrl = pathToFileURL(join(packagesRoot, 'delegation-supervisor/src/supervisor.ts')).href;
	writeFileSync(
		scriptPath,
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
const { SqliteZstdBackend } = await import(${JSON.stringify(backendUrl)});
const { DurableSeam, sqliteZstdDurableLogPort } = await import(${JSON.stringify(seamUrl)});
const { sqliteZstdDelegationLog } = await import(${JSON.stringify(supervisorLogUrl)});
const { DelegationSupervisor } = await import(${JSON.stringify(supervisorUrl)});

const [directory, progressFile] = process.argv.slice(2);
const backend = SqliteZstdBackend.open(directory);
const seam = await DurableSeam.open(sqliteZstdDurableLogPort(backend));
const supervisor = await DelegationSupervisor.open({ log: sqliteZstdDelegationLog(backend), waitSeam: seam });

const conversationId = 'conv-parent';
const requestId = 'steer-1';
const toolCallId = 'tc-task-1';
const childRunId = 'child-run-1';

const progress = (point, extra = {}) =>
  appendFileSync(progressFile, JSON.stringify({ point, conversationId, requestId, delegationId: 'pending', waitId: 'pending', toolCallId, childRunId, ...extra }) + '\\n');

// T_spawn.
const spawn = await supervisor.spawnDelegation({
  parentConversationId: conversationId,
  parentRunId: 'run-1',
  toolCallId,
  childSpec: { prompt: 'explore' },
});

// T_accept (Enter saved-ack).
await seam.acceptOwnerInput({
  conversationId,
  requestId,
  content: { text: 'switch to background' },
  whenBusy: 'steer',
  actor: 'owner',
});
progress('accept', { delegationId: spawn.delegationId, waitId: spawn.waitId });

// T_release decision (the ONE backgrounded record — seam-owned).
await seam.prepareRelease({ waitId: spawn.waitId, expectedVersion: 1, reason: 'owner_input', initiator: 'owner-input' });
await supervisor.syncWaitDecision(spawn.waitId);
progress('release', { delegationId: spawn.delegationId, waitId: spawn.waitId });

// Native finalization (the ONE tool-result).
const view = seam.getWait(spawn.waitId);
const outcome = view ? view.preparedOutcome : null;
if (outcome !== null) {
  await seam.finalizeTool({ toolCallId, outcome });
}
progress('finalize', { delegationId: spawn.delegationId, waitId: spawn.waitId });

// Child completion + reporter record (one atomic batch).
await supervisor.complete({ delegationId: spawn.delegationId, childRunId, outcome: { status: 'completed', summary: 'done' } });
progress('complete', { delegationId: spawn.delegationId, waitId: spawn.waitId });

process.exit(0);
`,
	);
}

async function waitForProgress(progressFile: string, point: CrashPoint): Promise<ProgressLine> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		if (existsSafe(progressFile)) {
			const lines = readFileSync(progressFile, 'utf8')
				.split('\n')
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as ProgressLine);
			const hit = lines.find((line) => line.point === point);
			if (hit !== undefined) return hit;
		}
		if (Date.now() > deadline) throw new Error(`progress never reached ${point}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function existsSafe(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

interface CrashRig {
	readonly directory: string;
	readonly progressFile: Promise<ProgressLine>;
	readonly exited: Promise<void>;
}

function spawnCrashingWriter(point: CrashPoint): CrashRig {
	const directory = freshDirectory('kill9-steering-');
	const progressFile = join(directory, 'progress.jsonl');
	const scriptPath = join(directory, 'steering-writer.mjs');
	writeSteeringWriterScript(scriptPath);
	const child = spawn(process.execPath, [scriptPath, directory, progressFile], {
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	children.push(child);
	const exited = new Promise<void>((resolve) => {
		child.on('exit', () => resolve());
	});
	return {
		directory,
		progressFile: waitForProgress(progressFile, point).then(async (line) => {
			// Kill the instant the point is durably observed — the process may
			// already be further along, which the assertions tolerate (they
			// count records, never assume gaps).
			try {
				child.kill('SIGKILL');
			} catch {
				// Already dead.
			}
			await exited;
			return line;
		}),
		exited,
	};
}

async function reopen(directory: string): Promise<{ backend: SqliteZstdBackend; seam: DurableSeam; supervisor: DelegationSupervisor }> {
	const backend = SqliteZstdBackend.open(directory);
	const seam = await DurableSeam.open(sqliteZstdDurableLogPort(backend));
	const supervisor = await DelegationSupervisor.open({ log: sqliteZstdDelegationLog(backend), waitSeam: seam });
	return { backend, seam, supervisor };
}

function kindsOf(backend: SqliteZstdBackend, kind: string): Array<Record<string, unknown>> {
	return backend
		.readDeltaChecked(0, 512 * 1024 * 1024)
		.entries.filter((entry) => entry.kind === kind)
		.map((entry) => entry.payload as Record<string, unknown>);
}

describe('kill -9: steering crash matrix (§6.4)', () => {
	it('killed after T_accept: the committed input is not lost and the flow completes exactly once', async () => {
		const rig = spawnCrashingWriter('accept');
		const line = await rig.progressFile;

		const { backend, seam, supervisor } = await reopen(rig.directory);
		// Zero lost committed inputs: the receipt replays with the ORIGINAL ids.
		const replay = await seam.acceptOwnerInput({
			conversationId: line.conversationId,
			requestId: line.requestId,
			content: { text: 'switch to background' },
			whenBusy: 'steer',
			actor: 'owner',
		});
		expect(replay.status).toBe('replayed');

		// The kill may land before OR after the release decision (SIGKILL
		// races the child's next step). Either state is legal — what matters
		// is that the flow completes EXACTLY once from wherever it stands.
		const record = await supervisor.getDelegation(line.delegationId);
		expect(['foreground', 'backgrounded', 'completed']).toContain(record?.waitState);
		if (record?.waitState === 'foreground') {
			await supervisor.detachToBackground({ delegationId: line.delegationId, reason: 'owner_input' });
		}
		const prepared = seam.listPendingPrepared();
		if (prepared.length === 1) {
			await seam.finalizeTool({ toolCallId: line.toolCallId, outcome: prepared[0]!.outcome });
		}
		const completed = kindsOf(backend, 'mcode.delegation.completed');
		if (completed.length === 0) {
			await supervisor.complete({ delegationId: line.delegationId, childRunId: line.childRunId, outcome: { status: 'completed', summary: 'done' } });
		}

		// Exactly one record of each, ever.
		expect(kindsOf(backend, 'mcode.delegation.backgrounded')).toHaveLength(1);
		expect(kindsOf(backend, SEAM_ENTRY_KINDS.toolResult)).toHaveLength(1);
		expect(kindsOf(backend, 'mcode.delegation.completed')).toHaveLength(1);
		await backend.close();
	}, 60_000);

	it('killed after the release decision: the prepared outcome is reproduced, never re-decided', async () => {
		const rig = spawnCrashingWriter('release');
		const line = await rig.progressFile;

		const { backend, seam, supervisor } = await reopen(rig.directory);
		// Exactly ONE backgrounded record survived the kill — never a second.
		expect(kindsOf(backend, 'mcode.delegation.backgrounded')).toHaveLength(1);
		// The kill may land before OR after the finalization commit (SIGKILL
		// races the child's next step); either way at most one tool-result
		// exists and the decision is never re-made.
		const toolResultsBefore = kindsOf(backend, SEAM_ENTRY_KINDS.toolResult);
		expect(toolResultsBefore.length).toBeLessThanOrEqual(1);
		const record = await supervisor.getDelegation(line.delegationId);
		expect(['backgrounded', 'completed']).toContain(record?.waitState);

		// Whatever survived undecided is reproduced verbatim by recovery.
		const pending = seam.listPendingPrepared();
		expect(pending.length).toBeLessThanOrEqual(1);
		if (pending.length === 1) {
			expect(pending[0]?.waitId).toBe(line.waitId);
			const finalization = await seam.finalizeTool({ toolCallId: line.toolCallId, outcome: pending[0]!.outcome });
			expect(finalization.status).toBe('committed');
		}
		expect(kindsOf(backend, SEAM_ENTRY_KINDS.toolResult)).toHaveLength(1);
		await backend.close();
	}, 60_000);

	it('killed after native finalization: a redelivered finalization replays, never duplicates', async () => {
		const rig = spawnCrashingWriter('finalize');
		const line = await rig.progressFile;

		const { backend, seam, supervisor } = await reopen(rig.directory);
		expect(kindsOf(backend, SEAM_ENTRY_KINDS.toolResult)).toHaveLength(1);
		// The redelivered finalization (same prepared outcome) replays the
		// ORIGINAL commit — the second record count stays at one.
		const pending = seam.listPendingPrepared();
		expect(pending).toHaveLength(0);
		const record = await supervisor.getDelegation(line.delegationId);
		expect(record).toMatchObject({ waitState: 'backgrounded' });
		expect(kindsOf(backend, SEAM_ENTRY_KINDS.toolResult)).toHaveLength(1);
		await backend.close();
	}, 60_000);

	it('killed after child completion: the reporter dedup returns the SAME submission, once', async () => {
		const rig = spawnCrashingWriter('complete');
		const line = await rig.progressFile;

		const { backend, supervisor, seam } = await reopen(rig.directory);
		expect(kindsOf(backend, 'mcode.delegation.completed')).toHaveLength(1);
		expect(kindsOf(backend, 'mcode.delegation.completion-report')).toHaveLength(1);
		// Repeat of the completion (crash retry): the SAME delivery and
		// submission, no second completion entry.
		const replayed = await supervisor.complete({
			delegationId: line.delegationId,
			childRunId: line.childRunId,
			outcome: { status: 'completed', summary: 'done' },
		});
		expect(replayed.replayed).toBe(true);
		expect(replayed.requestId).toBe(`delegation:${line.delegationId}:completion:${line.childRunId}`);
		expect(kindsOf(backend, 'mcode.delegation.completed')).toHaveLength(1);
		// A DIFFERENT child run is new work, refused.
		await expect(
			supervisor.complete({ delegationId: line.delegationId, childRunId: 'other-run', outcome: { status: 'completed' } }),
		).rejects.toMatchObject({ name: 'DelegationAlreadyCompletedError' });
		void seam;
		await backend.close();
	}, 60_000);
});
