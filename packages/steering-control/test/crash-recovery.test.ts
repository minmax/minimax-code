/**
 * Crash-mid-release (§6 gate 4, §3 T_release): a death between the release
 * commit and the tool finalization must REPRODUCE the prepared outcome on
 * recovery — never restart the child, never write a second tool-result.
 *
 * The fake seam's durable maps survive the "restart" (a new control instance
 * over the same seam), which is exactly the recovery surface of §3.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { createReactiveControl } from '../src/reactive-control.js';
import { deriveWaitId } from '../src/wait-set.js';
import type { ReactiveDelegationControl } from '../src/types.js';
import {
	createFakeFence,
	createFakeSeam,
	driven,
	TestClock,
	until,
	type FakeFence,
	type FakeSeam,
} from './helpers.js';

interface Harness {
	clock: TestClock;
	seam: FakeSeam;
	fenceA: FakeFence;
	fenceB: FakeFence;
	controlA: ReactiveDelegationControl;
	controlB: ReactiveDelegationControl;
}

function harness(hangFirstFinalizeFor: string): Harness {
	const clock = new TestClock();
	const seam = createFakeSeam({ clock });
	const fenceA = createFakeFence();
	const fenceB = createFakeFence();
	const controlA = createReactiveControl(seam, { clock: () => clock.now(), effectFence: fenceA });
	const controlB = createReactiveControl(seam, { clock: () => clock.now(), effectFence: fenceB });
	// First finalize for this wait never returns: the process died mid-release.
	seam.hangFinalize = prepared => prepared.waitId === hangFirstFinalizeFor;
	return { clock, seam, fenceA, fenceB, controlA, controlB };
}

/** Starts the steer and waits until its release decision is durably prepared. */
async function steerUntilPrepared(
	control: ReactiveDelegationControl,
	clock: TestClock,
	seam: FakeSeam,
	conversationId: string,
): Promise<void> {
	void driven(clock, control.onCommittedSteer({ parentConversationId: conversationId }));
	await until(() => seam.preparedStore.size === 1);
}

describe('crash mid-release', () => {
	it('reproduces the prepared outcome exactly once after a restart', async () => {
		const waitId = deriveWaitId({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1' });
		const rig = harness(waitId);
		const { seam, clock, controlA, controlB } = rig;
		seam.registerDelegation({ waitId, taskId: 'task-1' });
		controlA.registerWait({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1', stateVersion: 1 });

		// Process A dies between prepare (committed) and finalize (hung).
		await steerUntilPrepared(controlA, clock, seam, 'conv-1');
		expect(seam.finalizedByToolCallId.size).toBe(0); // the tool-result is not durable

		// Prepared-but-unfinalized outcome is visible to recovery.
		const preparedList = await seam.listPreparedReleases({ parentConversationId: 'conv-1' });
		expect(preparedList).toHaveLength(1);
		const prepared = preparedList[0];
		expect(prepared?.taskId).toBe('task-1');

		// Process B takes over: recovery reproduces the prepared outcome.
		const report = await driven(clock, controlB.recover());
		expect(report.failed).toHaveLength(0);
		expect(report.finalized).toHaveLength(1);
		expect(report.finalized[0]).toEqual({
			toolCallId: 'tc-1',
			taskId: 'task-1',
			outcome: 'background',
			replayed: false,
		});
		expect(rig.fenceB.engagements).toHaveLength(1);
		expect(rig.fenceB.engagements[0]?.refs).toEqual([
			{ waitId, toolCallId: 'tc-1', taskId: 'task-1', delegationId: `delegation:${waitId}` },
		]);

		// The child was NOT restarted: exactly one prepare for the waitId ever
		// happened, and the durable tool-result index holds exactly one entry.
		expect(seam.prepareCalls.filter(request => request.wait.waitId === waitId)).toHaveLength(1);
		expect(seam.finalizedByToolCallId.size).toBe(1);

		// A redelivery of the finalization is idempotent (replayed flag).
		const redelivered = await seam.finalizeTool(prepared!);
		expect(redelivered.replayed).toBe(true);
		expect(seam.finalizedByToolCallId.size).toBe(1);
	});

	it('recovery is a no-op when nothing is prepared-but-unfinalized', async () => {
		const rig = harness('never-matches');
		const { seam, clock, controlA, controlB } = rig;
		const waitId = deriveWaitId({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1' });
		seam.registerDelegation({ waitId, taskId: 'task-1' });
		controlA.registerWait({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1', stateVersion: 1 });

		const result = await driven(clock, controlA.onCommittedSteer({ parentConversationId: 'conv-1' }));
		expect(result?.released).toHaveLength(1);

		const report = await driven(clock, controlB.recover());
		expect(report.finalized).toHaveLength(0);
		expect(report.failed).toHaveLength(0);
		expect(report.fence).toHaveLength(0);
		expect(seam.finalizeCalls).toHaveLength(1);
	});

	it('a second recovery pass finds nothing left to reproduce', async () => {
		const waitId = deriveWaitId({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1' });
		const rig = harness(waitId);
		const { seam, clock, controlA, controlB } = rig;
		seam.registerDelegation({ waitId, taskId: 'task-1' });
		controlA.registerWait({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1', stateVersion: 1 });

		await steerUntilPrepared(controlA, clock, seam, 'conv-1'); // dies mid-release

		const first = await driven(clock, controlB.recover());
		expect(first.finalized).toHaveLength(1);
		const finalizeCallsAfterFirst = seam.finalizeCalls.length;

		const second = await driven(clock, controlB.recover());
		expect(second.finalized).toHaveLength(0);
		expect(second.failed).toHaveLength(0);
		expect(seam.finalizeCalls).toHaveLength(finalizeCallsAfterFirst);
	});

	it('recovery reports a failing finalization instead of losing it', async () => {
		const waitId = deriveWaitId({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1' });
		const clock = new TestClock();
		const seam = createFakeSeam({ clock });
		const fence = createFakeFence();
		const controlA = createReactiveControl(seam, { clock: () => clock.now(), effectFence: fence });
		const controlB = createReactiveControl(seam, { clock: () => clock.now(), effectFence: fence });
		// The death happens inside finalize: the decision is committed, the
		// tool-result is not, and the in-flight finalization never returns.
		seam.hangFinalize = () => true;
		seam.registerDelegation({ waitId, taskId: 'task-1' });
		controlA.registerWait({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1', stateVersion: 1 });

		await steerUntilPrepared(controlA, clock, seam, 'conv-1');
		expect(seam.finalizedByToolCallId.size).toBe(0);

		// The native finalizer now fails (e.g. the tool-task is gone).
		seam.finalizeTool = async () => {
			throw new Error('finalizer bridge unavailable');
		};
		const report = await driven(clock, controlB.recover());
		expect(report.finalized).toHaveLength(0);
		expect(report.failed).toEqual([
			{ operationId: expect.any(String), waitId, error: 'finalizer bridge unavailable' },
		]);
		// The prepared outcome is still durable for the next recovery attempt.
		expect(await seam.listPreparedReleases()).toHaveLength(1);
	});
});
