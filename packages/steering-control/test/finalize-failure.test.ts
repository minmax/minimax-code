/**
 * Regressions for the review findings of steering-control-w3 round 2:
 *
 * HIGH  — a failing seam.finalizeTool left the handle in 'releasing' forever,
 *         so the next steer hit `already-final` and awaited an outcome that
 *         never settles, wedging the single-slot control plane for every
 *         lane. Now the committed prepared outcome is retried (idempotent
 *         per operationId) and every job completes.
 * MEDIUM — a child completion refused inside the claim→prepare window was
 *         lost: after a stale refusal the wait stayed a blocker forever with
 *         an unsettled outcome although the child finished durably first.
 *         Now the claim rollback replays the retained completion.
 * LOW   — a refused WaitSetOverflowError registration left empty
 *         conversation/run maps behind; capacity is now validated before any
 *         map is created (covered by the existing overflow test + internal
 *         ordering, no public observable).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import type { InternalWaitHandle } from '../src/wait-set.js';
import { deriveWaitId } from '../src/wait-set.js';
import type { WaitHandle } from '../src/types.js';
import { driven, setup, until, type Rig } from './helpers.js';

function register(rig: Rig, toolCallId: string, stateVersion = 1): WaitHandle {
	const key = { parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId };
	rig.seam.registerDelegation({ waitId: deriveWaitId(key), taskId: `task:${toolCallId}`, stateVersion });
	return rig.control.registerWait({ ...key, stateVersion });
}

describe('finalize failure does not wedge the control plane (HIGH)', () => {
	it('the next steer retries the committed prepared outcome to completion', async () => {
		const rig = setup();
		const handle = register(rig, 'tc-1');
		const originalFinalize = rig.seam.finalizeTool.bind(rig.seam);
		let finalizeFailedOnce = false;
		let finalizeAttempts = 0;
		rig.seam.finalizeTool = async prepared => {
			finalizeAttempts += 1;
			if (!finalizeFailedOnce) {
				finalizeFailedOnce = true;
				throw new Error('finalizer bridge unavailable');
			}
			return originalFinalize(prepared);
		};

		// Pass 1: the decision commits, the finalization fails — the job must
		// COMPLETE with a failed record, never hang.
		const first = await driven(rig.clock, rig.control.onCommittedSteer({ parentConversationId: 'conv-1' }));
		expect(first?.released).toHaveLength(0);
		expect(first?.skipped).toHaveLength(1);
		expect(first?.skipped[0]?.status).toBe('failed');
		expect(first?.skipped[0]?.error).toBe('finalizer bridge unavailable');
		// Truthfully still blocking: the tool-round is not finished yet.
		expect(rig.control.blockers({ parentConversationId: 'conv-1' })).toHaveLength(1);

		// Pass 2: the same wait is retried from its committed prepared
		// outcome — no second prepare, no child restart, no wedge.
		const second = await driven(rig.clock, rig.control.onCommittedSteer({ parentConversationId: 'conv-1' }));
		expect(second?.released).toHaveLength(1);
		const durablePrepared = [...rig.seam.preparedStore.values()][0];
		expect(second?.released[0]?.operationId).toBe(durablePrepared?.operationId);
		// The finalizer was entered twice (one failed attempt, one successful
		// redelivery of the SAME operationId) and produced exactly one durable
		// tool-result for the toolCallId.
		expect(finalizeAttempts).toBe(2);
		expect(rig.seam.finalizeCalls).toHaveLength(1); // the failed attempt never reached the fake
		expect(rig.seam.finalizeCalls[0]?.operationId).toBe(durablePrepared?.operationId);
		expect(rig.seam.finalizedByToolCallId.size).toBe(1);
		// Exactly one prepareRelease ever happened for the wait.
		expect(rig.seam.prepareCalls).toHaveLength(1);

		const outcome = await handle.outcome;
		expect(outcome.kind).toBe('backgrounded');
		expect(rig.control.blockers({ parentConversationId: 'conv-1' })).toHaveLength(0);

		// The control plane stayed drainable throughout: another job runs.
		const report = await driven(rig.clock, rig.control.recover());
		expect(report.finalized).toHaveLength(0);
		expect(report.failed).toHaveLength(0);
	});

	it('recover() settles a finalize-failed waiter directly', async () => {
		const rig = setup();
		const handle = register(rig, 'tc-1');
		const originalFinalize = rig.seam.finalizeTool.bind(rig.seam);
		let finalizeFailedOnce = false;
		rig.seam.finalizeTool = async prepared => {
			if (!finalizeFailedOnce) {
				finalizeFailedOnce = true;
				throw new Error('finalizer bridge unavailable');
			}
			return originalFinalize(prepared);
		};

		const first = await driven(rig.clock, rig.control.onCommittedSteer({ parentConversationId: 'conv-1' }));
		expect(first?.skipped[0]?.status).toBe('failed');

		// Startup recovery path instead of a second steer: reproduces the
		// prepared outcome and settles the still-claimed waiter.
		const report = await driven(rig.clock, rig.control.recover());
		expect(report.finalized).toHaveLength(1);
		expect(report.failed).toHaveLength(0);
		expect((await handle.outcome).kind).toBe('backgrounded');
		expect(rig.seam.finalizedByToolCallId.size).toBe(1);
		expect(rig.control.blockers({ parentConversationId: 'conv-1' })).toHaveLength(0);
	});
});

describe('completion inside the claim→prepare window (MEDIUM)', () => {
	function asyncValidatingSeam(rig: Rig): void {
		const originalPrepare = rig.seam.prepareRelease.bind(rig.seam);
		rig.seam.prepareRelease = async request => {
			await rig.clock.sleep(5); // validation happens asynchronously
			return originalPrepare(request);
		};
	}

	it('a completion refused mid-window is replayed after a stale refusal', async () => {
		const rig = setup();
		// Durable record is at version 9; the registering side saw 7.
		const key = { parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1' };
		rig.seam.registerDelegation({ waitId: deriveWaitId(key), taskId: 'task-1', stateVersion: 9 });
		const handle = rig.control.registerWait({ ...key, stateVersion: 7 });
		asyncValidatingSeam(rig);

		// Steer starts; the claim is taken, the prepare is in flight.
		const pending = rig.control.onCommittedSteer({ parentConversationId: 'conv-1' });
		await until(() => (handle as InternalWaitHandle).isReleasing());
		// The child completes durably INSIDE the window: refused, but kept.
		expect(handle.completeForeground({ summary: 'child finished first' })).toBe(false);

		const result = await driven(rig.clock, pending);
		// The release was refused (stale) — so the earlier completion wins.
		expect(result?.skipped[0]?.status).toBe('stale-version');

		// The outcome settles — the retained completion is replayed.
		const outcome = await handle.outcome;
		expect(outcome).toEqual({ kind: 'completed', result: { summary: 'child finished first' } });
		expect(rig.control.blockers({ parentConversationId: 'conv-1' })).toHaveLength(0);
		// No durable trace of a release; a follow-up steer detaches nothing.
		expect(rig.seam.finalizeCalls).toHaveLength(0);
		const again = await driven(rig.clock, rig.control.onCommittedSteer({ parentConversationId: 'conv-1' }));
		expect(again).toBeNull();
	});

	it('a completion refused mid-window is superseded when the release commits', async () => {
		const rig = setup();
		const handle = register(rig, 'tc-1'); // version matches — release commits
		asyncValidatingSeam(rig);

		const pending = rig.control.onCommittedSteer({ parentConversationId: 'conv-1' });
		await until(() => (handle as InternalWaitHandle).isReleasing());
		expect(handle.completeForeground({ summary: 'too late' })).toBe(false);

		const result = await driven(rig.clock, pending);
		expect(result?.released).toHaveLength(1);
		// The committed backgrounded outcome supersedes the late completion;
		// the child result reaches the parent via the supervisor instead.
		const outcome = await handle.outcome;
		expect(outcome.kind).toBe('backgrounded');
		expect(rig.seam.finalizedByToolCallId.size).toBe(1);
		expect(rig.control.blockers({ parentConversationId: 'conv-1' })).toHaveLength(0);
	});
});
