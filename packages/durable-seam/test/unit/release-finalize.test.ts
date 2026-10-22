//
// T_release / T_complete tests: the stateVersion CAS, the irreversible
// foreground -> backgrounded transition, the exactly-once tool result, and
// the rule that a prepared outcome is reproduced verbatim (never re-decided).
//

import { beforeEach, describe, expect, it } from 'vitest';

import {
	DurableSeam,
	ToolResultConflictError,
	UnknownWaitError,
	VersionConflictError,
	WaitIdConflictError,
	WaitTerminalError,
	SEAM_ENTRY_KINDS,
	hashJson,
	waitOpenedEntryId,
	waitPreparedEntryId,
	toolResultEntryId,
} from '../../src/index.js';
import { InMemoryDurableLog } from '../helpers.js';

let log: InMemoryDurableLog;
let seam: DurableSeam;

beforeEach(async () => {
	log = new InMemoryDurableLog();
	seam = await DurableSeam.open(log);
});

describe('openForegroundWait', () => {
	it('opens durably at stateVersion 1 and replays idempotently', async () => {
		const opened = await seam.openForegroundWait({
			waitId: 'w1',
			toolCallId: 'tc1',
			conversationId: 'parent',
			childConversationId: 'child',
			cancelOnParentAbort: true,
		});
		expect(opened).toMatchObject({ waitId: 'w1', state: 'foreground', stateVersion: 1, status: 'committed' });
		expect(opened.commitSeq).toBe(1);

		const view = seam.getWait('w1');
		expect(view).toMatchObject({
			toolCallId: 'tc1',
			state: 'foreground',
			stateVersion: 1,
			cancelOnParentAbort: true,
			childConversationId: 'child',
		});
		expect(view?.openedCommitSeq).toBe(opened.commitSeq);
		expect(seam.waitByToolCallId('tc1')?.waitId).toBe('w1');

		// A repeat must repeat the SAME identity (including the optional
		// anchor fields) — otherwise it is a WAIT_ID_CONFLICT, not a replay.
		const repeat = await seam.openForegroundWait({
			waitId: 'w1',
			toolCallId: 'tc1',
			conversationId: 'parent',
			childConversationId: 'child',
			cancelOnParentAbort: true,
		});
		expect(repeat.status).toBe('replayed');
		expect(repeat.stateVersion).toBe(1);
		expect(log.batches).toHaveLength(1);

		// A different identity under the same waitId is refused.
		await expect(
			seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'elsewhere' }),
		).rejects.toBeInstanceOf(WaitIdConflictError);
		expect(log.batches).toHaveLength(1);
	});
});

describe('tool call anchors at most one wait', () => {
	it('refuses a second waitId over an already-anchored tool call', async () => {
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'parent' });

		// Two waitIds over one tool call would race for the SINGLE outcome
		// slot of T_complete; the loser's prepared outcome could never be
		// finalized.
		await expect(
			seam.openForegroundWait({ waitId: 'w2', toolCallId: 'tc1', conversationId: 'parent' }),
		).rejects.toMatchObject({ code: 'WAIT_ID_CONFLICT' });

		// Nothing was written by the refused open, and the anchor is intact.
		expect(seam.waitByToolCallId('tc1')?.waitId).toBe('w1');
		expect(seam.getWait('w2')).toBeUndefined();
		expect(log.batches).toHaveLength(1);
	});

	it('refuses anchoring a wait to an already-finalized tool call', async () => {
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'parent' });
		await seam.finalizeTool({ toolCallId: 'tc1', outcome: { status: 'ok' } });
		// w1 went terminal and left the projection; tc1's single result slot
		// is taken, so a NEW wait over it could never receive an outcome.
		await expect(
			seam.openForegroundWait({ waitId: 'w2', toolCallId: 'tc1', conversationId: 'parent' }),
		).rejects.toMatchObject({ code: 'TOOL_RESULT_CONFLICT' });
		expect(log.batches).toHaveLength(2);
	});

	it('keeps both guards across a restart (durable registry, not memory)', async () => {
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'parent' });
		await seam.openForegroundWait({ waitId: 'w9', toolCallId: 'tc9', conversationId: 'parent' });
		await seam.finalizeTool({ toolCallId: 'tc1', outcome: { status: 'ok' } });

		const restarted = await DurableSeam.open(log);

		// w1 is terminal (reconstructed only from entries) — its tool result
		// still refuses a new anchor...
		await expect(
			restarted.openForegroundWait({ waitId: 'w2', toolCallId: 'tc1', conversationId: 'parent' }),
		).rejects.toMatchObject({ code: 'TOOL_RESULT_CONFLICT' });
		// ...and w9 is active (recovered) — the recovered registry refuses a
		// second anchor just the same.
		await expect(
			restarted.openForegroundWait({ waitId: 'w2', toolCallId: 'tc9', conversationId: 'parent' }),
		).rejects.toMatchObject({ code: 'WAIT_ID_CONFLICT' });
	});

	it('refuses to prepare a release for a foreground wait whose tool call is already finalized', async () => {
		// This state cannot be produced through the primitives (a foreground
		// wait always completes in the same commit as its tool result); craft
		// it directly in the log as a foreign/legacy writer would.
		await log.appendBatch([
			{
				id: waitOpenedEntryId('wx'),
				kind: SEAM_ENTRY_KINDS.waitOpened,
				payload: {
					waitId: 'wx',
					toolCallId: 'tcx',
					conversationId: 'parent',
					delegationId: null,
					childConversationId: null,
					childRunId: null,
					cancelOnParentAbort: false,
					state: 'foreground',
					stateVersion: 1,
					openedCommitSeq: 0,
				},
			},
			{
				id: toolResultEntryId('tcx'),
				kind: SEAM_ENTRY_KINDS.toolResult,
				payload: {
					toolCallId: 'tcx',
					waitId: null,
					outcome: { status: 'decided-elsewhere' },
					outcomeHash: hashJson({ status: 'decided-elsewhere' }),
					waitTransition: null,
					waitStateVersionAfter: null,
					finalizedAtMs: 0,
				},
			},
		]);

		const reopened = await DurableSeam.open(log);
		expect(reopened.getWait('wx')).toMatchObject({ state: 'foreground', stateVersion: 1 });

		// Preparing would write a background outcome that can never be
		// finalized — refused with TOOL_RESULT_CONFLICT instead.
		await expect(reopened.prepareRelease({ waitId: 'wx', expectedVersion: 1 })).rejects.toMatchObject({
			code: 'TOOL_RESULT_CONFLICT',
		});
		expect(log.batches).toHaveLength(1);
	});
});

describe('prepareRelease — T_release', () => {
	it('commits the prepared background outcome and advances the CAS version', async () => {
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'parent' });

		const prepared = await seam.prepareRelease({
			waitId: 'w1',
			expectedVersion: 1,
			reason: 'owner_input',
			backgroundHandle: { taskId: 'sup-1' },
		});

		expect(prepared.status).toBe('committed');
		expect(prepared.stateVersion).toBe(2);
		expect(prepared.preparedEntryId).toBe(waitPreparedEntryId('w1'));
		expect(prepared.outcome).toMatchObject({
			kind: 'background',
			waitId: 'w1',
			toolCallId: 'tc1',
			reason: 'owner_input',
			backgroundHandle: { taskId: 'sup-1' },
			cancelOnParentAbort: false,
		});

		const view = seam.getWait('w1');
		expect(view?.state).toBe('backgrounded');
		expect(view?.stateVersion).toBe(2);
		expect(view?.preparedOutcome?.backgroundHandle).toEqual({ taskId: 'sup-1' });
		expect(seam.listPendingPrepared()).toHaveLength(1);

		// The commit holds exactly the control entry plus the snapshot.
		expect(log.batches[1]!.map((entry) => entry.kind)).toEqual([
			SEAM_ENTRY_KINDS.backgrounded,
			SEAM_ENTRY_KINDS.snapshot,
		]);
	});

	it('rejects a stale expectedVersion with the current version attached', async () => {
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'parent' });
		try {
			await seam.prepareRelease({ waitId: 'w1', expectedVersion: 7 });
			expect.fail('expected VersionConflictError');
		} catch (error) {
			expect(error).toBeInstanceOf(VersionConflictError);
			expect((error as VersionConflictError).currentVersion).toBe(1);
		}
		expect(seam.getWait('w1')?.state).toBe('foreground');
	});

	it('is crash-retryable: repeating with the current version replays the outcome', async () => {
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'parent' });
		const first = await seam.prepareRelease({ waitId: 'w1', expectedVersion: 1, backgroundHandle: 'h1' });

		// Same version the prepare moved the wait TO — a retry after a crash
		// must return the stored outcome, not fail.
		const retry = await seam.prepareRelease({ waitId: 'w1', expectedVersion: 2, backgroundHandle: 'h1' });
		expect(retry.status).toBe('replayed');
		expect(retry.outcome).toEqual(first.outcome);
		expect(retry.preparedEntryId).toBe(first.preparedEntryId);
		expect(log.batches).toHaveLength(2);

		// But the STALE pre-release version stays a conflict.
		await expect(seam.prepareRelease({ waitId: 'w1', expectedVersion: 1 })).rejects.toBeInstanceOf(
			VersionConflictError,
		);
	});

	it('refuses unknown waits and terminal waits', async () => {
		await expect(seam.prepareRelease({ waitId: 'ghost', expectedVersion: 1 })).rejects.toBeInstanceOf(
			UnknownWaitError,
		);

		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'parent' });
		await seam.finalizeTool({ toolCallId: 'tc1', outcome: { status: 'ok' } });
		// foreground --T_complete--> completed: a release can no longer win.
		await expect(seam.prepareRelease({ waitId: 'w1', expectedVersion: 2 })).rejects.toMatchObject({
			code: 'WAIT_TERMINAL',
		});
		await expect(seam.prepareRelease({ waitId: 'w1', expectedVersion: 2 })).rejects.toBeInstanceOf(
			WaitTerminalError,
		);
	});
});

describe('finalizeTool — T_complete', () => {
	it('commits the single tool result and completes a foreground wait', async () => {
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'parent' });

		const result = await seam.finalizeTool({ toolCallId: 'tc1', outcome: { status: 'completed', runs: 1 } });
		expect(result.status).toBe('committed');
		expect(result.toolResultEntryId).toBe(toolResultEntryId('tc1'));
		expect(result.wait).toEqual({ waitId: 'w1', state: 'completed', stateVersion: 2 });
		// Terminal waits leave the bounded projection; their state lives in
		// the entries.
		expect(seam.getWait('w1')).toBeUndefined();
		expect(seam.waitByToolCallId('tc1')).toBeUndefined();

		// Exactly-once: the same outcome replays the ORIGINAL commit...
		const replay = await seam.finalizeTool({ toolCallId: 'tc1', outcome: { status: 'completed', runs: 1 } });
		expect(replay.status).toBe('replayed');
		expect(replay.commitSeq).toBe(result.commitSeq);
		// ...and the advisory wait view is stable between the commit and its
		// replay, although the terminal wait has left the live registry.
		expect(replay.wait).toEqual(result.wait);
		// ...and a different outcome is refused — never a second tool result.
		await expect(seam.finalizeTool({ toolCallId: 'tc1', outcome: { status: 'failed' } })).rejects.toBeInstanceOf(
			ToolResultConflictError,
		);
		expect(log.batches.filter((batch) => batch.some((entry) => entry.id === toolResultEntryId('tc1')))).toHaveLength(1);
		expect(seam.listPendingPrepared()).toHaveLength(0);
	});

	it('reproduces a prepared outcome verbatim after T_release', async () => {
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'parent' });
		const prepared = await seam.prepareRelease({ waitId: 'w1', expectedVersion: 1 });

		const finalized = await seam.finalizeTool({ toolCallId: 'tc1', outcome: prepared.outcome });
		expect(finalized.status).toBe('committed');
		// backgrounded is irreversible for this waitId: the tool result lands,
		// the (now terminal) wait leaves the bounded projection.
		expect(finalized.wait).toEqual({ waitId: 'w1', state: 'backgrounded', stateVersion: 2 });
		expect(seam.getWait('w1')).toBeUndefined();
		expect(seam.listPendingPrepared()).toHaveLength(0);

		// The replay reports the same wait view as the original commit (the
		// version comes from the prepared entry, which finalization did not
		// change).
		const replay = await seam.finalizeTool({ toolCallId: 'tc1', outcome: prepared.outcome });
		expect(replay.status).toBe('replayed');
		expect(replay.wait).toEqual(finalized.wait);

		// Reproducing must be verbatim: any other outcome is a conflict.
		await expect(seam.finalizeTool({ toolCallId: 'tc1', outcome: { kind: 'background', forged: true } })).rejects
			.toBeInstanceOf(ToolResultConflictError);
	});

	it('refuses to finalize a backgrounded wait with an outcome that contradicts the prepared one', async () => {
		await seam.openForegroundWait({ waitId: 'w1', toolCallId: 'tc1', conversationId: 'parent' });
		await seam.prepareRelease({ waitId: 'w1', expectedVersion: 1, backgroundHandle: { taskId: 't' } });

		await expect(
			seam.finalizeTool({ toolCallId: 'tc1', outcome: { status: 'completed' } }),
		).rejects.toBeInstanceOf(ToolResultConflictError);
		// Nothing was written by the refused finalize.
		expect(log.entries.get(toolResultEntryId('tc1'))).toBeUndefined();
		expect(log.batches).toHaveLength(2);
	});

	it('finalizes a tool call that belongs to no registered wait', async () => {
		const result = await seam.finalizeTool({ toolCallId: 'tc-orphan', outcome: 'done' });
		expect(result.status).toBe('committed');
		expect(result.wait).toBeNull();

		const replay = await seam.finalizeTool({ toolCallId: 'tc-orphan', outcome: 'done' });
		expect(replay.status).toBe('replayed');
		expect(replay.commitSeq).toBe(result.commitSeq);
	});
});

describe('bounded active-state projection', () => {
	it('keeps terminal waits out of the registry AND the snapshot as history grows', async () => {
		for (let i = 1; i <= 50; i += 1) {
			await seam.openForegroundWait({ waitId: `w${i}`, toolCallId: `tc${i}`, conversationId: 'parent' });
			await seam.finalizeTool({ toolCallId: `tc${i}`, outcome: { status: 'ok', i } });
		}

		// The registry is a projection of ACTIVE objects only...
		expect(seam.listWaits()).toEqual([]);
		// ...and the snapshot riding the LAST commit carries none of the 50
		// terminal waits (a snapshot without terminal removal would hold all
		// of them here).
		const snapshot = log.entries.get(`mcode:seam:snapshot:100`)!;
		expect(snapshot).toBeDefined();
		const payload = snapshot.payload as { readonly waits: unknown[] };
		expect(payload.waits).toEqual([]);
	});

	it('judges a duplicate open against the durable identity and replays terminal state from entries', async () => {
		await seam.openForegroundWait({
			waitId: 'w1',
			toolCallId: 'tc1',
			conversationId: 'parent',
			cancelOnParentAbort: true,
		});
		const prepared = await seam.prepareRelease({ waitId: 'w1', expectedVersion: 1 });
		await seam.finalizeTool({ toolCallId: 'tc1', outcome: prepared.outcome });
		// The wait left the bounded projection entirely.
		expect(seam.getWait('w1')).toBeUndefined();

		// A brand-new seam (empty registry) still recognizes the durable wait.
		const restarted = await DurableSeam.open(log);

		// Same identity → replay of the reconstructed terminal state.
		const replay = await restarted.openForegroundWait({
			waitId: 'w1',
			toolCallId: 'tc1',
			conversationId: 'parent',
			cancelOnParentAbort: true,
		});
		expect(replay).toMatchObject({
			status: 'replayed',
			state: 'backgrounded',
			stateVersion: 2,
			commitSeq: 1,
		});

		// A DIFFERENT tool call under the same waitId is a conflict, not a
		// silent replay — the anchor is exactly-once too.
		await expect(
			restarted.openForegroundWait({ waitId: 'w1', toolCallId: 'tc-other', conversationId: 'parent' }),
		).rejects.toBeInstanceOf(WaitIdConflictError);

		// A prepareRelease crash-retry after the wait went terminal is
		// answered from the stored prepared outcome, not with UNKNOWN_WAIT.
		const retry = await restarted.prepareRelease({ waitId: 'w1', expectedVersion: 2 });
		expect(retry.status).toBe('replayed');
		expect(retry.outcome).toEqual(prepared.outcome);
		expect(retry.preparedEntryId).toBe(prepared.preparedEntryId);
	});
});
