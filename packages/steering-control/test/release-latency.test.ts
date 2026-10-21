/**
 * Acceptance gate §6.2 (steering-design-sol.md), measured on the TEST CLOCK:
 * saved-ack → committed release p99 ≤ 250 ms when a single `task` wait is the
 * only blocker. `onCommittedSteer` is invoked after the saved-ack, so
 * `ReleaseResult.elapsedMs` is exactly that measurement. The controller must
 * add no delay of its own: only the two seam transactions (prepare + finalize)
 * may appear on the clock, and the control commit must bypass the batching
 * window via the urgent path.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { deriveWaitId } from '../src/wait-set.js';
import { driven, setup, type Rig } from './helpers.js';

function seedOneWait(rig: Rig, conversationId = 'conv-1'): string {
	const key = { parentConversationId: conversationId, parentRunId: 'run-1', toolCallId: 'tc-task-1' };
	const waitId = deriveWaitId(key);
	rig.seam.registerDelegation({ waitId, taskId: 'task-1' });
	rig.control.registerWait({ ...key, stateVersion: 1 });
	return waitId;
}

describe('release latency (gate §6.2, test clock)', () => {
	it('releases a single wait within the 250 ms budget', async () => {
		const rig = setup(); // prepareMs 30 + finalizeMs 10 on the test clock
		seedOneWait(rig);

		const result = await driven(rig.clock, rig.control.onCommittedSteer({ parentConversationId: 'conv-1', requestId: 'req-1' }));

		expect(result).not.toBeNull();
		// Exactly the two seam transactions — the controller adds zero delay.
		expect(result?.elapsedMs).toBe(40);
		expect(result?.elapsedMs).toBeLessThanOrEqual(250);
		expect(result?.released).toHaveLength(1);
		expect(result?.skipped).toHaveLength(0);

		// The single tool-result is the standard background result with the
		// SAME stable task ID (§2.5, §3 T_release).
		expect(result?.released[0]?.finalization).toEqual({
			toolCallId: 'tc-task-1',
			taskId: 'task-1',
			outcome: 'background',
			replayed: false,
		});
		expect(rig.seam.finalizedByToolCallId.size).toBe(1);
		// No stray timers: the control path never waits on a batching window.
		expect(rig.clock.pendingTimers).toBe(0);
	});

	it('forces the urgent control-plane flush, bypassing the ≤200 ms batching window', async () => {
		const rig = setup(); // windowMs 200 by default
		seedOneWait(rig);

		const result = await driven(rig.clock, rig.control.onCommittedSteer({ parentConversationId: 'conv-1' }));

		// The control commit bypasses the window entirely (urgent request +
		// flushUrgent at job start): 40 ms of seam work, not 200+ ms of batching.
		expect(result?.elapsedMs).toBe(40);
		expect(result?.elapsedMs).toBeLessThanOrEqual(250);
		expect(rig.seam.flushUrgentCalls).toBe(1);
		expect(rig.seam.prepareCalls[0]?.urgent).toBe(true);
	});

	it('releases a whole bounded wait set within the budget (three waits)', async () => {
		const rig = setup();
		for (const toolCallId of ['tc-task-1', 'tc-task-2', 'tc-task-3']) {
			const key = { parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId };
			rig.seam.registerDelegation({ waitId: deriveWaitId(key), taskId: `task:${toolCallId}` });
			rig.control.registerWait({ ...key, stateVersion: 1 });
		}

		const result = await driven(rig.clock, rig.control.onCommittedSteer({ parentConversationId: 'conv-1' }));

		// 3 × (prepare 30 + finalize 10) on the test clock.
		expect(result?.released).toHaveLength(3);
		expect(result?.elapsedMs).toBe(120);
		expect(result?.elapsedMs).toBeLessThanOrEqual(250);
	});

	it('the committed steer reaction carries reason "owner_input"', async () => {
		const rig = setup();
		seedOneWait(rig);

		const result = await driven(rig.clock, rig.control.onCommittedSteer({ parentConversationId: 'conv-1' }));

		expect(result?.reason).toBe('owner_input');
		expect(rig.seam.prepareCalls[0]?.reason).toBe('owner_input');
	});
});
