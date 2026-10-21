/**
 * One outcome per waitId (§3: the transaction picks exactly one outcome —
 * `completed` or `backgrounded` — and it is irreversible for this waitId;
 * §4 Гонки: repeating an operation returns the saved outcome).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { deriveWaitId } from '../src/wait-set.js';
import type { WaitHandle } from '../src/types.js';
import { driven, setup, type Rig } from './helpers.js';

function register(rig: Rig, toolCallId: string, stateVersion = 1): WaitHandle {
	const key = { parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId };
	rig.seam.registerDelegation({ waitId: deriveWaitId(key), taskId: `task:${toolCallId}`, stateVersion });
	return rig.control.registerWait({ ...key, stateVersion });
}

function steer(rig: Rig): Promise<unknown> {
	return driven(rig.clock, rig.control.onCommittedSteer({ parentConversationId: 'conv-1' }));
}

function outcomeResolutionCount(handle: { outcome: Promise<unknown> }): () => number {
	let resolutions = 0;
	void handle.outcome.then(() => {
		resolutions += 1;
	});
	return () => resolutions;
}

describe('single outcome per waitId', () => {
	it('child completion wins: steer afterwards finds nothing to detach', async () => {
		const rig = setup();
		const handle = register(rig, 'tc-1');
		const count = outcomeResolutionCount(handle);

		expect(handle.completeForeground({ summary: 'child done' })).toBe(true);
		// Idempotent: the second completion is refused, the outcome is kept.
		expect(handle.completeForeground({ summary: 'late duplicate' })).toBe(false);

		const result = (await steer(rig)) as Awaited<ReturnType<Rig['control']['onCommittedSteer']>>;
		expect(result).toBeNull(); // no detach needed — normal result path (§2.3)
		expect(rig.seam.prepareCalls).toHaveLength(0);
		expect(rig.seam.finalizeCalls).toHaveLength(0);

		const outcome = await handle.outcome;
		expect(outcome).toEqual({ kind: 'completed', result: { summary: 'child done' } });
		expect(count()).toBe(1);
		expect(rig.control.blockers({ parentConversationId: 'conv-1' })).toHaveLength(0);
		// The saved outcome is replay-stable via the deterministic waitId.
		expect(handle.waitId).toBe(
			deriveWaitId({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1' }),
		);
	});

	it('release wins: duplicate steer is a no-op and the outcome resolves once', async () => {
		const rig = setup();
		const handle = register(rig, 'tc-1');
		const count = outcomeResolutionCount(handle);

		const first = (await steer(rig)) as Awaited<ReturnType<Rig['control']['onCommittedSteer']>>;
		expect(first?.released).toHaveLength(1);
		const second = (await steer(rig)) as Awaited<ReturnType<Rig['control']['onCommittedSteer']>>;
		expect(second).toBeNull(); // already released — one detach per wait (§5)

		// Exactly one prepare and one durable tool-result for the wait.
		expect(rig.seam.prepareCalls).toHaveLength(1);
		expect(rig.seam.finalizeCalls).toHaveLength(1);
		expect(rig.seam.finalizedByToolCallId.size).toBe(1);

		const outcome = await handle.outcome;
		expect(outcome.kind).toBe('backgrounded');
		expect(count()).toBe(1);
	});

	it('registerWait replay attaches to the saved outcome, including a settled wait', async () => {
		const rig = setup();
		const original = register(rig, 'tc-1');
		await steer(rig); // released

		const replay = rig.control.registerWait({
			parentConversationId: 'conv-1',
			parentRunId: 'run-1',
			toolCallId: 'tc-1',
			stateVersion: 1,
		});
		expect(replay).toBe(original); // same handle — attach, not a second waiter
		const outcome = await replay.outcome;
		expect(outcome.kind).toBe('backgrounded'); // saved outcome is returned
		// Still exactly one durable tool-result.
		expect(rig.seam.finalizeCalls).toHaveLength(1);
	});

	it('concurrent steers release each wait exactly once', async () => {
		const rig = setup();
		const handle1 = register(rig, 'tc-1');
		const handle2 = register(rig, 'tc-2');

		const [first, second] = (await Promise.all([steer(rig), steer(rig)])) as [
			Awaited<ReturnType<Rig['control']['onCommittedSteer']>>,
			Awaited<ReturnType<Rig['control']['onCommittedSteer']>>,
		];

		// The pass is serialized: one releases the whole set, the other finds
		// nothing; across both results every wait appears exactly once.
		const releasedIds = [
			...(first?.released ?? []).map(record => record.waitId),
			...(second?.released ?? []).map(record => record.waitId),
		].sort();
		expect(releasedIds).toEqual([
			deriveWaitId({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1' }),
			deriveWaitId({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-2' }),
		]);
		expect(rig.seam.finalizedByToolCallId.size).toBe(2);
		expect((await handle1.outcome).kind).toBe('backgrounded');
		expect((await handle2.outcome).kind).toBe('backgrounded');
	});

	it('stale stateVersion is an explicit refusal; refresh then retry releases', async () => {
		const rig = setup();
		// Durable record is at version 9; the registering side saw only 7.
		const key = { parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1' };
		rig.seam.registerDelegation({ waitId: deriveWaitId(key), taskId: 'task-1', stateVersion: 9 });
		const handle = rig.control.registerWait({ ...key, stateVersion: 7 });

		const refused = (await steer(rig)) as Awaited<ReturnType<Rig['control']['onCommittedSteer']>>;
		expect(refused?.released).toHaveLength(0);
		expect(refused?.skipped).toEqual([
			{
				waitId: deriveWaitId(key),
				toolCallId: 'tc-1',
				status: 'stale-version',
				error: expect.stringContaining('stateVersion'),
			},
		]);
		// Nothing durable happened; the wait stays a visible blocker.
		expect(rig.seam.prepareCalls[0]?.wait.stateVersion).toBe(7);
		expect(rig.seam.finalizedByToolCallId.size).toBe(0);
		expect(rig.control.blockers({ parentConversationId: 'conv-1' })).toHaveLength(1);

		// Integrator re-reads the durable state and refreshes the expectation.
		handle.refreshStateVersion(9);
		const retried = (await steer(rig)) as Awaited<ReturnType<Rig['control']['onCommittedSteer']>>;
		expect(retried?.released).toHaveLength(1);
	});
});
