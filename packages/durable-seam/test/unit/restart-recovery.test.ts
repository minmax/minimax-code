//
// Restart / crash-recovery tests: a seam reopened over the same durable log
// rebuilds its active registry from ONE snapshot point read (plus a short
// forward delta), a prepared outcome survived mid-phase reproduces verbatim,
// and the replay path (no snapshots at all) lands on the same registry.
//

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	DurableSeam,
	SEAM_ENTRY_KINDS,
	toolResultEntryId,
	type DurableLogPort,
	type PortCommit,
	type PortDelta,
	type PortEntry,
	type PortEntryDraft,
	type SeamWaitView,
} from '../../src/index.js';
import { InMemoryDurableLog, join, mkdtempSync, openSqliteBackend, tmpdir, type SqliteZstdBackend } from '../helpers.js';

function registryFingerprint(seam: DurableSeam): string {
	return JSON.stringify({
		waits: seam.listWaits(),
		deliveries: seam.listActiveDeliveries(),
		pending: seam.listPendingPrepared().map((prepared) => prepared.preparedEntryId),
	});
}

/**
 * Port decorator counting `getEntry` calls so a test can observe that
 * snapshot recovery probes O(log revisions) point reads instead of scanning.
 */
class CountingGetEntryPort implements DurableLogPort {
	getEntryCalls = 0;
	private readonly base: DurableLogPort;

	constructor(base: DurableLogPort) {
		this.base = base;
	}

	appendBatch(entries: readonly PortEntryDraft[]): Promise<PortCommit> {
		return this.base.appendBatch(entries);
	}

	getEntry(entryId: string): PortEntry | undefined {
		this.getEntryCalls += 1;
		return this.base.getEntry(entryId);
	}

	readDeltaChecked(afterSeq: number, limitBytes: number): PortDelta {
		return this.base.readDeltaChecked(afterSeq, limitBytes);
	}

	head(): number {
		return this.base.head();
	}

	maxBatchBytes(): number | null {
		return this.base.maxBatchBytes?.() ?? null;
	}
}

describe('recovery over the in-memory port', () => {
	it('restores waits, deliveries, and pending prepared outcomes', async () => {
		const log = new InMemoryDurableLog();
		const seam = await DurableSeam.open(log);

		await seam.acceptOwnerInput({ conversationId: 'c', requestId: 'r1', content: 'a', whenBusy: 'steer' });
		await seam.acceptOwnerInput({ conversationId: 'c', requestId: 'r2', content: 'b', whenBusy: 'followUp' });
		await seam.settleDelivery({ conversationId: 'c', requestId: 'r1' });
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'c' });
		await seam.openForegroundWait({ waitId: 'w2', toolCallId: 'tc2', conversationId: 'c' });
		const prepared = await seam.prepareRelease({ waitId: 'w1', expectedVersion: 1, backgroundHandle: 'h' });

		const restarted = await DurableSeam.open(log);
		const report = await restarted.recover(); // re-running recovery is supported
		expect(report.snapshotRevision).toBeGreaterThan(0);
		expect(report.recoveredWaits).toBe(2);
		expect(report.recoveredDeliveries).toBe(1); // r1 settled, r2 active
		expect(report.tornTail).toBeNull();

		const w1 = restarted.getWait('w1');
		expect(w1).toMatchObject({ state: 'backgrounded', stateVersion: 2, openedCommitSeq: 4 });
		expect(w1?.preparedOutcome).toEqual(prepared.outcome);

		// The reopened seam can finish what the crashed one started: reproduce
		// the prepared outcome as the single tool result.
		const pending = restarted.listPendingPrepared();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.preparedEntryId).toBe(prepared.preparedEntryId);
		const finalized = await restarted.finalizeTool({ toolCallId: 'tc1', outcome: prepared.outcome });
		expect(finalized.status).toBe('committed');
		expect(restarted.listPendingPrepared()).toHaveLength(0);

		// The foreground wait survived untouched.
		expect(restarted.getWait('w2')).toMatchObject({ state: 'foreground', stateVersion: 1 });
		const completed = await restarted.finalizeTool({ toolCallId: 'tc2', outcome: { status: 'ok' } });
		expect(completed.wait).toEqual({ waitId: 'w2', state: 'completed', stateVersion: 2 });
	});

	it('replays the whole log when no snapshot exists, landing on the same registry', async () => {
		const log = new InMemoryDurableLog();
		const seam = await DurableSeam.open(log);
		await seam.acceptOwnerInput({ conversationId: 'c', requestId: 'r1', content: 'a', whenBusy: 'steer' });
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'c' });
		await seam.prepareRelease({ waitId: 'w1', expectedVersion: 1 });
		const fingerprintBefore = registryFingerprint(seam);

		// A log without any snapshot entry (as if written by a snapshot-less
		// predecessor): recovery must take the full replay path and reach the
		// identical registry.
		const withoutSnapshots = InMemoryDurableLog.fromEntries(
			log.batches.flat().filter((entry) => entry.kind !== SEAM_ENTRY_KINDS.snapshot),
		);
		const restarted = await DurableSeam.open(withoutSnapshots);
		const report = await restarted.recover();
		expect(report.snapshotRevision).toBe(0);
		expect(report.snapshotCommitSeq).toBeNull();
		expect(report.replayedEntries).toBeGreaterThan(0);
		expect(registryFingerprint(restarted)).toBe(fingerprintBefore);
	});
});

describe('recovery over the real sqlite-zstd backend', () => {
	let directory: string;
	const openBackends: SqliteZstdBackend[] = [];

	// Each test manages its own backend handles on a fresh directory; the
	// afterEach net closes whatever a failed test left behind.
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'durable-seam-'));
		openBackends.length = 0;
	});

	afterEach(async () => {
		for (const backend of openBackends.splice(0)) {
			await backend.close().catch(() => undefined);
		}
	});

	async function closeOpenBackends(): Promise<void> {
		for (const backend of openBackends.splice(0)) {
			await backend.close();
		}
	}

	async function openSeam(): Promise<{ readonly seam: DurableSeam; readonly port: DurableLogPort }> {
		const opened = openSqliteBackend(directory);
		openBackends.push(opened.backend);
		return { seam: await DurableSeam.open(opened.port), port: opened.port };
	}

	it('reproduces the prepared outcome after a crash between the release phases', async () => {
		// Phase 1: accept, wait, prepare — then the process "dies".
		const first = await openSeam();
		await first.seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'c', cancelOnParentAbort: true });
		const prepared = await first.seam.prepareRelease({
			waitId: 'w1',
			expectedVersion: 1,
			reason: 'owner_input',
			backgroundHandle: { supervisorTaskId: 'sup-1' },
		});
		await closeOpenBackends();

		// Phase 2: a fresh process opens the same generation.
		const second = await openSeam();
		const view: SeamWaitView | undefined = second.seam.getWait('w1');
		expect(view).toMatchObject({ state: 'backgrounded', stateVersion: 2, cancelOnParentAbort: true });
		expect(view?.preparedOutcome).toEqual(prepared.outcome);

		// The prepared outcome is reproduced — the child is NOT re-run, no
		// second outcome is decided.
		const finalized = await second.seam.finalizeTool({ toolCallId: 'tc1', outcome: prepared.outcome });
		expect(finalized.status).toBe('committed');
		expect(second.seam.listPendingPrepared()).toHaveLength(0);
		await closeOpenBackends();

		// Phase 3: yet another restart sees exactly one tool result, and a
		// repeat finalize replays the original commit (idempotent forever).
		const third = await openSeam();
		expect(third.port.getEntry(toolResultEntryId('tc1'))).toBeDefined();

			const replay = await third.seam.finalizeTool({ toolCallId: 'tc1', outcome: prepared.outcome });
			expect(replay.status).toBe('replayed');
			expect(replay.commitSeq).toBe(finalized.commitSeq);
			// The advisory wait view is stable across the restart too: the
			// replay rebuilds it from the durable result, not the live registry.
			expect(replay.wait).toEqual(finalized.wait);
		await expect(
			third.seam.finalizeTool({ toolCallId: 'tc1', outcome: { kind: 'background', forged: true } }),
		).rejects.toMatchObject({ code: 'TOOL_RESULT_CONFLICT' });
	});

	it('keeps accept dedup and conflict semantics across restarts', async () => {
		const first = await openSeam();
		const accepted = await first.seam.acceptOwnerInput({
			conversationId: 'c',
			requestId: 'r1',
			content: { text: 'steer me' },
			whenBusy: 'steer',
		});
		await closeOpenBackends();

		const second = await openSeam();
		const replay = await second.seam.acceptOwnerInput({
			conversationId: 'c',
			requestId: 'r1',
			content: { text: 'steer me' },
			whenBusy: 'steer',
		});
		expect(replay).toMatchObject({
			status: 'replayed',
			commitSeq: accepted.commitSeq,
			submissionId: accepted.submissionId,
			inputEntryId: accepted.inputEntryId,
		});
		await expect(
			second.seam.acceptOwnerInput({ conversationId: 'c', requestId: 'r1', content: { text: 'other' }, whenBusy: 'steer' }),
		).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
		expect(second.seam.listActiveDeliveries()).toHaveLength(1);
	});

	it('keeps wait snapshots bounded over many terminal waits on the real backend', async () => {
		// Batch cap 16 KiB: a snapshot that accumulated one ~250-byte record
		// per wait would exceed the cap within ~30 open+finalize cycles and
		// wedge EVERY later seam commit. Terminal removal keeps the snapshot
		// at the active set, so hundreds of cycles commit at the same size.
		const capped = openSqliteBackend(mkdtempSync(join(tmpdir(), 'durable-seam-capped-')), {
			maxBatchUncompressedBytes: 16 * 1024,
		});
		openBackends.push(capped.backend);
		const seam = await DurableSeam.open(capped.port);

		for (let i = 1; i <= 120; i += 1) {
			await seam.openForegroundWait({ waitId: `w${i}`, toolCallId: `tc${i}`, conversationId: 'c' });
			await seam.finalizeTool({ toolCallId: `tc${i}`, outcome: { status: 'ok', i } });
		}

		expect(capped.port.head()).toBe(240);
		expect(seam.listWaits()).toEqual([]);
	});

	it('recovers via O(log revisions) snapshot point reads, not a history scan', async () => {
		const log = new InMemoryDurableLog();
		const seam = await DurableSeam.open(log);
		const cycles = 40;
		for (let i = 1; i <= cycles; i += 1) {
			await seam.openForegroundWait({ waitId: `w${i}`, toolCallId: `tc${i}`, conversationId: 'c' });
			await seam.finalizeTool({ toolCallId: `tc${i}`, outcome: { status: 'ok', i } });
		}
		const revisions = cycles * 2; // one snapshot revision per seam commit

		const counting = new CountingGetEntryPort(log);
		const restarted = await DurableSeam.open(counting);
		expect(restarted.listWaits()).toEqual([]);

		// Exponential doubling finds the first miss (⌈log2 revisions⌉ + 1
		// reads), the binary search closes in (⌈log2 interval⌉ reads): a
		// small logarithmic count, decisively below the revision count.
		const ceilLog2 = Math.ceil(Math.log2(revisions));
		expect(counting.getEntryCalls).toBeGreaterThanOrEqual(ceilLog2);
		expect(counting.getEntryCalls).toBeLessThanOrEqual(2 * ceilLog2 + 4);
		expect(counting.getEntryCalls).toBeLessThan(revisions / 2);
	});
});
