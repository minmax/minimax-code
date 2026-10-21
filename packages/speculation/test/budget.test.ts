/**
 * Budget tests: admission limits (parallel calls, outstanding tokens),
 * metrics accounting and steering-change cancellation of in-flight leases.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { createSpeculationBudget } from '../src/budget.js';
import { SpeculationMetrics } from '../src/metrics.js';
import type {
	SpeculationBudgetOptions,
	SpeculationLease,
	SteeringCancellation,
} from '../src/budget.js';

function expectRangeError(name: keyof SpeculationBudgetOptions, value: number): void {
	const options: SpeculationBudgetOptions = {
		maxParallelCalls: 2,
		maxOutstandingTokens: 100,
		maxTokensPerCall: 10,
		// Deliberate override of one limit with an invalid value.
		[name]: value,
	};
	expect(() => createSpeculationBudget(options)).toThrow(RangeError);
}

function expectLease(result: ReturnType<ReturnType<typeof createSpeculationBudget>['acquire']>): SpeculationLease {
	if (!result.ok) throw new Error(`acquire refused: ${String(result.reason)}`);
	return result.lease;
}

describe('budget construction', () => {
	it('rejects non-positive or fractional limits', () => {
		expectRangeError('maxParallelCalls', 0);
		expectRangeError('maxParallelCalls', -1);
		expectRangeError('maxParallelCalls', 1.5);
		expectRangeError('maxOutstandingTokens', 0);
		expectRangeError('maxTokensPerCall', 0);
	});

	it('rejects non-positive token estimates on acquire', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 2, maxOutstandingTokens: 100 });
		expect(() => budget.acquire(0)).toThrow(RangeError);
	});

	it('starts at epoch 0 with empty counters', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 2, maxOutstandingTokens: 100 });
		expect(budget.snapshot()).toEqual({
			speculated: 0,
			confirmed: 0,
			wasted: 0,
			inFlight: 0,
			outstandingTokens: 0,
			steeringEpoch: 0,
		});
	});
});

describe('parallel-call limit', () => {
	it('refuses acquisitions beyond the limit and frees slots on confirm', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 2, maxOutstandingTokens: 1000 });
		const first = expectLease(budget.acquire(10));
		expectLease(budget.acquire(10));
		expect(budget.acquire(10)).toEqual({ ok: false, reason: 'parallel-limit' });
		first.confirm();
		expect(budget.acquire(10).ok).toBe(true);
	});

	it('frees slots on discard as well', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 1, maxOutstandingTokens: 1000 });
		const first = expectLease(budget.acquire(10));
		expect(budget.acquire(10)).toEqual({ ok: false, reason: 'parallel-limit' });
		first.discard();
		expect(budget.acquire(10).ok).toBe(true);
	});
});

describe('token limits', () => {
	it('refuses acquisitions exceeding the outstanding-token budget', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 8, maxOutstandingTokens: 100 });
		expectLease(budget.acquire(60));
		expect(budget.acquire(50)).toEqual({ ok: false, reason: 'token-limit' });
		// 60 + 40 fits exactly.
		expect(budget.acquire(40).ok).toBe(true);
	});

	it('refuses single leases above the per-call cap', () => {
		const budget = createSpeculationBudget({
			maxParallelCalls: 4,
			maxOutstandingTokens: 1000,
			maxTokensPerCall: 50,
		});
		expectLease(budget.acquire(50));
		expect(budget.acquire(51)).toEqual({ ok: false, reason: 'token-limit' });
	});

	it('reaccounts reservations via settleTokens', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 4, maxOutstandingTokens: 100 });
		const first = expectLease(budget.acquire(40));
		first.settleTokens(90);
		expect(budget.snapshot().outstandingTokens).toBe(90);
		expect(budget.acquire(20)).toEqual({ ok: false, reason: 'token-limit' });
		first.confirm();
		expect(budget.snapshot().outstandingTokens).toBe(0);
		expect(budget.acquire(20).ok).toBe(true);
	});
});

describe('metrics', () => {
	it('counts speculated, confirmed and wasted with settle-once semantics', () => {
		const metrics = new SpeculationMetrics();
		const budget = createSpeculationBudget({
			maxParallelCalls: 4,
			maxOutstandingTokens: 1000,
			metrics,
		});
		const leases = [budget.acquire(10), budget.acquire(10), budget.acquire(10)].map(expectLease);
		expect(budget.snapshot().speculated).toBe(3);

		leases[0]!.confirm();
		leases[1]!.discard();
		// Settle-once: a second transition must not double-count.
		leases[0]!.discard();
		leases[1]!.confirm();

		const snapshot = budget.snapshot();
		expect(snapshot.confirmed).toBe(1);
		expect(snapshot.wasted).toBe(1);
		expect(snapshot.confirmed + snapshot.wasted).toBeLessThanOrEqual(snapshot.speculated);
		expect(snapshot.inFlight).toBe(1);
		// The externally supplied instance observes the same counters.
		expect(metrics.snapshot()).toEqual({
			speculated: snapshot.speculated,
			confirmed: snapshot.confirmed,
			wasted: snapshot.wasted,
		});
	});

	it('returns frozen snapshots', () => {
		const metrics = new SpeculationMetrics();
		metrics.incSpeculated();
		expect(Object.isFrozen(metrics.snapshot())).toBe(true);
	});
});

describe('steering-change cancellation', () => {
	it('cancels every in-flight lease, releases reservations and wakes listeners', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 2, maxOutstandingTokens: 100 });
		const leases = [budget.acquire(30), budget.acquire(40)].map(expectLease);
		const events: SteeringCancellation[] = [];
		for (const lease of leases) lease.onCancelled(event => events.push(event));

		const report = budget.notifySteeringChanged('user steer');

		expect(report).toEqual({ cancelled: 2, steeringEpoch: 1, reason: 'user steer' });
		for (const lease of leases) {
			expect(lease.isSettled()).toBe(true);
			expect(lease.isCancelled()).toBe(true);
			expect(lease.outcome()).toBe('wasted');
		}
		// Listeners fire exactly once per lease, with the new epoch.
		expect(events).toHaveLength(2);
		expect(
			events.every(event => event.reason === 'steering-change' && event.steeringEpoch === 1),
		).toBe(true);

		const snapshot = budget.snapshot();
		expect(snapshot.inFlight).toBe(0);
		expect(snapshot.outstandingTokens).toBe(0);
		expect(snapshot.wasted).toBe(2);
		expect(snapshot.confirmed).toBe(0);
	});

	it('lets speculation resume in the new steering epoch', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 1, maxOutstandingTokens: 100 });
		const first = expectLease(budget.acquire(30));
		budget.notifySteeringChanged();
		expect(budget.steeringEpoch).toBe(1);

		const next = expectLease(budget.acquire(30));
		expect(next.steeringEpoch).toBe(1);
		expect(next.isCancelled()).toBe(false);
		next.confirm();
		expect(budget.snapshot().confirmed).toBe(1);
		expect(first.isCancelled()).toBe(true);
	});

	it('keeps confirm and discard as no-ops after cancellation (settle-once)', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 1, maxOutstandingTokens: 100 });
		const lease = expectLease(budget.acquire(30));
		budget.notifySteeringChanged();

		lease.confirm();
		lease.discard();
		const snapshot = budget.snapshot();
		expect(snapshot.confirmed).toBe(0);
		expect(snapshot.wasted).toBe(1);
	});

	it('bumps the epoch with nothing in flight and leaves metrics untouched', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 1, maxOutstandingTokens: 100 });
		const report = budget.notifySteeringChanged();
		expect(report).toEqual({ cancelled: 0, steeringEpoch: 1, reason: undefined });
		expect(budget.snapshot()).toMatchObject({ speculated: 0, confirmed: 0, wasted: 0 });
	});

	it('supports unsubscribe from cancel listeners', () => {
		const budget = createSpeculationBudget({ maxParallelCalls: 1, maxOutstandingTokens: 100 });
		const lease = expectLease(budget.acquire(30));
		const events: SteeringCancellation[] = [];
		const off = lease.onCancelled(event => events.push(event));
		off();
		budget.notifySteeringChanged();
		expect(events).toHaveLength(0);
	});
});
