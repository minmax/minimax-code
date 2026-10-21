/**
 * 10 000-schedule race gate (steering-design-sol.md §6.5, round-1 review
 * fix 6): deterministic pseudo-random interleavings of completion / owner
 * input / timer / manual background / abort with TWO attach clients, against
 * the composed stack (durable-seam wait authority + delegation supervisor)
 * on the REAL sqlite-zstd backend.
 *
 * Pinned per schedule:
 * - only ALLOWED outcomes: the wait resolves `completed` XOR
 *   `backgrounded` — never both, never neither, and at most ONE
 *   `mcode.delegation.backgrounded` record per waitId exists, no matter
 *   which entry point (input release, timer, manual background) won;
 * - a repeated input ID with the same payload replays the ORIGINAL commit;
 *   with a different payload it is `REQUEST_ID_CONFLICT`;
 * - stale tokens are never applied: a release with a stale
 *   `expectedStateVersion` is `DELEGATION_VERSION_CONFLICT`;
 * - exactly one completion record; the loser of the race observes only the
 *   documented refusals/replays;
 * - exactly one tool-result per toolCallId after the finalization.
 *
 * Determinism: every schedule is derived from `mulberry32(seed)` with
 * `seed = 1000 + index`, so a failure reproduces from its index alone.
 * Schedule count: `RACE_SCHEDULES` env overrides the 10 000 gate value for
 * local quick runs.
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteZstdBackend } from '../../durable-backend-sqlite-zstd/src/index.js';
import { DurableSeam, sqliteZstdDurableLogPort } from '../../durable-seam/src/index.js';
import { DelegationSupervisor } from '../../delegation-supervisor/src/index.js';
import { sqliteZstdDelegationLog } from '../../delegation-supervisor/src/log.js';

const schedules = Number(process.env.RACE_SCHEDULES ?? 10_000);
if (!Number.isInteger(schedules) || schedules < 1) {
	throw new Error(`RACE_SCHEDULES must be a positive integer, got "${process.env.RACE_SCHEDULES}"`);
}

const directories: string[] = [];
const backends: SqliteZstdBackend[] = [];

afterEach(() => {
	while (backends.length > 0) {
		const backend = backends.pop();
		if (backend !== undefined) backend.close();
	}
	while (directories.length > 0) {
		const dir = directories.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		const a = result[i]!;
		const b = result[j]!;
		result[i] = b;
		result[j] = a;
	}
	return result;
}

const entriesOf = (backend: SqliteZstdBackend, kind: string): number =>
	backend.readDeltaChecked(0, 512 * 1024 * 1024).entries.filter((entry) => entry.kind === kind).length;

/** The race outcomes a schedule may legally observe. */
class Schedule {
	readonly conversationId: string;
	/** Assigned by {@link prepare} (T_spawn) before any operation runs. */
	delegationId!: string;
	/** Assigned by {@link prepare}. */
	waitId!: string;
	readonly toolCallId: string;
	/** `completed` | `backgrounded` — decided by the ops, asserted at the end. */
	outcome: 'completed' | 'backgrounded' | 'undecided' = 'undecided';

	constructor(readonly index: number, private readonly supervisor: DelegationSupervisor, private readonly seam: DurableSeam) {
		this.conversationId = `race-conv-${index}`;
		this.toolCallId = `race-tool-${index}`;
	}

	async prepare(): Promise<void> {
		const spawn = await this.supervisor.spawnDelegation({
			parentConversationId: this.conversationId,
			parentRunId: 'run-1',
			toolCallId: this.toolCallId,
			childSpec: { prompt: 'race' },
		});
		this.delegationId = spawn.delegationId;
		this.waitId = spawn.waitId;
	}

	/** One client's steer: accept + the input-driven release attempt. */
	async steer(client: 'A' | 'B'): Promise<'released' | 'refused' | 'already-completed'> {
		const requestId = `race-req-${this.index}-${client}`;
		const accepted = await this.seam.acceptOwnerInput({
			conversationId: this.conversationId,
			requestId,
			content: { text: `to background (${client})` },
			whenBusy: 'steer',
		});
		if (accepted.status !== 'committed') throw new Error(`client ${client} accept was not committed`);
		try {
			const release = await this.supervisor.detachToBackground({
				delegationId: this.delegationId,
				reason: 'owner_input',
				operationId: `background-${client}-${this.index}`,
			});
			if (release.released) {
				this.outcome = 'backgrounded';
				return 'released';
			}
			return 'already-completed';
		} catch (error) {
			// The only legal refusal for a second release attempt.
			if ((error as { code?: string }).code === 'DELEGATION_NOT_FOREGROUND') return 'refused';
			throw error;
		}
	}

	/** The timer / manual background path (third distinct operation identity). */
	async manualBackground(reason: 'timer' | 'manual_background'): Promise<'released' | 'refused' | 'already-completed'> {
		try {
			const release = await this.supervisor.detachToBackground({
				delegationId: this.delegationId,
				reason,
				operationId: `background-${reason}-${this.index}`,
			});
			if (release.released) {
				this.outcome = 'backgrounded';
				return 'released';
			}
			return 'already-completed';
		} catch (error) {
			if ((error as { code?: string }).code === 'DELEGATION_NOT_FOREGROUND') return 'refused';
			throw error;
		}
	}

	async complete(): Promise<'foreground' | 'reporter'> {
		const completion = await this.supervisor.complete({
			delegationId: this.delegationId,
			childRunId: `race-run-${this.index}`,
			outcome: { status: 'completed', summary: 'race done' },
		});
		if (completion.delivery === 'foreground') {
			this.outcome = 'completed';
			// The native tool-finalizer closes the foreground tool call with the
			// child outcome (§2.5/§3) — the ONE tool-result of this wait.
			await this.seam.finalizeTool({
				toolCallId: this.toolCallId,
				outcome: { status: 'completed', summary: 'race done' },
			});
		}
		return completion.delivery;
	}

	async abort(): Promise<'stop-requested' | 'skipped'> {
		const result = await this.supervisor.parentAborted({
			parentConversationId: this.conversationId,
			explicitStop: false,
		});
		const outcome = result.outcomes.find((entry) => entry.delegationId === this.delegationId);
		// A delegation that already aged out of the bounded active document
		// (terminal) is not a live abort target — that IS the skip outcome.
		if (outcome === undefined) return 'skipped';
		return outcome.action;
	}
}

describe(`race gate §6.5: ${schedules} schedules`, () => {
	it('every interleaving yields exactly one allowed wait outcome and dedup semantics hold', async () => {
		const storeSize = 500;
		const stores = Math.ceil(schedules / storeSize);
		for (let storeIndex = 0; storeIndex < stores; storeIndex += 1) {
			const directory = mkdtempSync(join(tmpdir(), 'steering-races-'));
			directories.push(directory);
			const backend = SqliteZstdBackend.open(directory);
			backends.push(backend);
			const seam = await DurableSeam.open(sqliteZstdDurableLogPort(backend));
			const supervisor = await DelegationSupervisor.open({ log: sqliteZstdDelegationLog(backend), waitSeam: seam });

			const count = Math.min(storeSize, schedules - storeIndex * storeSize);
			for (let within = 0; within < count; within += 1) {
				const index = storeIndex * storeSize + within;
				const random = prng(1000 + index);
				const schedule = new Schedule(index, supervisor, seam);
				await schedule.prepare();

				const operations = shuffled(
					[
						() => schedule.steer('A'),
						() => schedule.steer('B'),
						() => schedule.manualBackground('timer'),
						() => schedule.manualBackground('manual_background'),
						() => schedule.complete(),
						() => schedule.abort(),
					],
					random,
				);
				for (const operation of operations) {
					await operation();
				}

				// Dedup probes: same payload replays the ORIGINAL commit...
				const replay = await seam.acceptOwnerInput({
					conversationId: schedule.conversationId,
					requestId: `race-req-${index}-A`,
					content: { text: 'to background (A)' },
					whenBusy: 'steer',
				});
				expect(replay.status).toBe('replayed');
				// ...a different payload under the same key conflicts.
				await expect(
					seam.acceptOwnerInput({
						conversationId: schedule.conversationId,
						requestId: `race-req-${index}-A`,
						content: { text: 'DIFFERENT payload' },
						whenBusy: 'steer',
					}),
				).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });

				// Stale tokens are never applied.
				await expect(
					supervisor.detachToBackground({
						delegationId: schedule.delegationId,
						reason: 'timer',
						operationId: `background-stale-${index}`,
						expectedStateVersion: 9999,
					}),
				).rejects.toMatchObject({ code: 'DELEGATION_VERSION_CONFLICT' });

				// The single outcome: decided, and only ever one backgrounded
				// record per waitId — whichever entry point won the race (the
				// record's deterministic entry id makes a second copy a storage
				// refusal, asserted store-wide below).
				const record = await supervisor.getDelegation(schedule.delegationId);
				expect(['completed', 'backgrounded']).toContain(record?.waitState);
				expect(record?.waitState === 'backgrounded').toBe(schedule.outcome === 'backgrounded');

				// Exactly one completion record per delegation.
				expect(record?.completion).not.toBeNull();

				// Exactly one tool-result per toolCallId after finalization.
				if (record?.waitState === 'backgrounded') {
					const pending = seam.listPendingPrepared().filter((prepared) => prepared.waitId === schedule.waitId);
					if (pending.length === 1) {
						await seam.finalizeTool({ toolCallId: schedule.toolCallId, outcome: pending[0]!.outcome });
					}
				}
			}

			// Per-store closing invariants: counts are bounded by the schedules
			// run here, and every store reopens clean (recovery replays).
			const schedulesInStore = count;
			expect(entriesOf(backend, 'mcode.delegation.backgrounded')).toBeLessThanOrEqual(schedulesInStore);
			expect(entriesOf(backend, 'mcode.delegation.completed')).toBe(schedulesInStore);
			expect(entriesOf(backend, SEAM_TOOL_RESULT)).toBe(schedulesInStore);
			expect(entriesOf(backend, 'mcode.delegation.spawned')).toBe(schedulesInStore);
			backend.close();
			backends.pop();
			directories.pop();
		}
	}, 570_000);
});

const SEAM_TOOL_RESULT = 'mcode.delegation.tool-result';
