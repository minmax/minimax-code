/**
 * The bounded ForegroundWaitSet (§2, §4 "Несколько детей"): a committed steer
 * releases the whole set of delegation waits blocking the parent's tool-round;
 * the set is bounded and overflows fail closed; another long (non-delegation)
 * tool in the same round is never faked — release touches only registered
 * delegation waits.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { WaitSetOverflowError } from '../src/errors.js';
import { deriveWaitId } from '../src/wait-set.js';
import { driven, setup, type Rig } from './helpers.js';

function keyOf(toolCallId: string, conversationId = 'conv-1', runId = 'run-1') {
	return { parentConversationId: conversationId, parentRunId: runId, toolCallId };
}

function register(
	rig: Rig,
	toolCallId: string,
	conversationId = 'conv-1',
	runId = 'run-1',
): string {
	const key = keyOf(toolCallId, conversationId, runId);
	rig.seam.registerDelegation({ waitId: deriveWaitId(key), taskId: `task:${toolCallId}` });
	rig.control.registerWait({ ...key, stateVersion: 1 });
	return deriveWaitId(key);
}

function steer(rig: Rig, conversationId = 'conv-1', runId?: string) {
	const pending = rig.control.onCommittedSteer(
		runId === undefined ? { parentConversationId: conversationId } : { parentConversationId: conversationId, parentRunId: runId },
	);
	return driven(rig.clock, pending);
}

describe('ForegroundWaitSet', () => {
	it('releases all delegation waits of the tool-round as one bounded set', async () => {
		const rig = setup();
		const ids = ['tc-task-1', 'tc-task-2', 'tc-task-3'].map(id => register(rig, id));

		const result = await steer(rig);

		expect(result?.released.map(record => record.waitId).sort()).toEqual([...ids].sort());
		expect(result?.skipped).toHaveLength(0);
		// Each wait got its own prepared outcome and its own task ID.
		const taskIds = result?.released.map(record => record.prepared?.taskId).sort();
		expect(taskIds).toEqual(['task:tc-task-1', 'task:tc-task-2', 'task:tc-task-3']);
		expect(rig.seam.finalizedByToolCallId.size).toBe(3);
		expect(rig.control.blockers()).toHaveLength(0);
	});

	it('never fakes another long tool in the same round', async () => {
		const rig = setup();
		// Only the delegation `task` is a registered wait. A sibling bash tool
		// blocks the same round but belongs to the native steering boundary —
		// it is not registered and therefore not touched by the release.
		const taskWaitId = register(rig, 'tc-task-1');

		const result = await steer(rig);

		expect(result?.released.map(record => record.toolCallId)).toEqual(['tc-task-1']);
		expect(result?.released.map(record => record.waitId)).toEqual([taskWaitId]);
		// No tool-result was produced for the foreign tool call.
		expect([...rig.seam.finalizedByToolCallId.keys()]).toEqual(['tc-task-1']);
		// The delegation blocker is gone from blockers(); any REMAINING
		// blocker is the sibling tool, which the caller's own tool-round view
		// reports (this package's blockers() covers delegation waits only).
		expect(rig.control.blockers({ parentConversationId: 'conv-1' })).toHaveLength(0);
	});

	it('overflow of the bounded set fails closed with an explicit error', () => {
		const rig = setup({ maxWaitsPerRound: 2 });
		register(rig, 'tc-1');
		register(rig, 'tc-2');
		const key = keyOf('tc-3');
		rig.seam.registerDelegation({ waitId: deriveWaitId(key), taskId: 'task:tc-3' });

		expect(() => rig.control.registerWait({ ...key, stateVersion: 1 })).toThrow(WaitSetOverflowError);
		// The existing waits are untouched by the refused registration.
		expect(rig.control.blockers()).toHaveLength(2);
	});

	it('scopes the released set to the steer conversation', async () => {
		const rig = setup();
		const convA = register(rig, 'tc-a1', 'conv-A');
		const convB = register(rig, 'tc-b1', 'conv-B');

		const result = await steer(rig, 'conv-A');

		expect(result?.parentConversationId).toBe('conv-A');
		expect(result?.released.map(record => record.waitId)).toEqual([convA]);
		expect(rig.control.blockers({ parentConversationId: 'conv-B' }).map(b => b.waitId)).toEqual([convB]);
	});

	it('scopes the released set to the steer run when one is given', async () => {
		const rig = setup();
		const current = register(rig, 'tc-1', 'conv-1', 'run-2');
		const stale = register(rig, 'tc-0', 'conv-1', 'run-1');

		const result = await steer(rig, 'conv-1', 'run-2');

		expect(result?.released.map(record => record.waitId)).toEqual([current]);
		expect(result?.released.some(record => record.waitId === stale)).toBe(false);
		expect(rig.control.blockers({ parentConversationId: 'conv-1' })).toHaveLength(1);
	});

	it('steer for an unknown conversation detaches nothing', async () => {
		const rig = setup();
		register(rig, 'tc-1');

		const result = await steer(rig, 'conv-other');

		expect(result).toBeNull();
		expect(rig.seam.prepareCalls).toHaveLength(0);
	});

	it('blockers() reports active waits with their state version and age', async () => {
		const rig = setup();
		register(rig, 'tc-1', 'conv-1', 'run-1');
		rig.clock.advance(15);
		register(rig, 'tc-2', 'conv-1', 'run-1');
		rig.clock.advance(10);

		const blockers = rig.control.blockers({ parentConversationId: 'conv-1', parentRunId: 'run-1' });
		expect(blockers).toHaveLength(2);
		const ages = Object.fromEntries(blockers.map(blocker => [blocker.toolCallId, blocker.ageMs]));
		expect(ages['tc-1']).toBe(25);
		expect(ages['tc-2']).toBe(10);
		expect(blockers.every(blocker => blocker.stateVersion === 1)).toBe(true);
	});
});

describe('effect fence after release', () => {
	it('engages the fence with the released delegation refs after a committed release', async () => {
		const rig = setup();
		register(rig, 'tc-1');

		const result = await steer(rig);

		expect(result?.fence).toEqual({ status: 'engaged' });
		expect(rig.fence.engagements).toHaveLength(1);
		const engagement = rig.fence.engagements[0];
		expect(engagement?.parentConversationId).toBe('conv-1');
		expect(engagement?.reason).toBe('owner_input');
		expect(engagement?.refs).toEqual([
			{
				waitId: deriveWaitId(keyOf('tc-1')),
				toolCallId: 'tc-1',
				taskId: 'task:tc-1',
				delegationId: `delegation:${deriveWaitId(keyOf('tc-1'))}`,
			},
		]);
		// The released wait is settled: the parent may answer, but conflicting
		// effects now hit DELEGATION_EFFECT_BLOCKED at the gateway (§4).
		expect(rig.control.blockers({ parentConversationId: 'conv-1' })).toHaveLength(0);
	});

	it('a failed fence engagement is reported but never rewrites the release', async () => {
		const rig = setup();
		register(rig, 'tc-1');
		rig.fence.failNext();

		const result = await steer(rig);

		expect(result?.released).toHaveLength(1); // release stands
		expect(result?.fence).toEqual({ status: 'failed', error: 'gateway unavailable' });
		// The durable outcome exists and the single tool-result is written.
		expect(rig.seam.finalizedByToolCallId.size).toBe(1);
	});
});
