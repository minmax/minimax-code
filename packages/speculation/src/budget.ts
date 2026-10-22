/**
 * Speculation budget: bounded parallel speculative calls, bounded
 * outstanding tokens, and cancellation on steering-state change.
 *
 * The budget gates admission only: a refused acquisition is a value
 * (`ok: false`), not an error — skipping speculation is the normal
 * degradation path. Every acquired lease is settle-once: it ends exactly
 * once as `confirmed` (result adopted by the foreground path) or `wasted`
 * (steering change or explicit discard), which feeds the metrics counters.
 *
 * A committed steering change invalidates the whole in-flight generation:
 * `notifySteeringChanged` settles every active lease as wasted, releases
 * its reserved tokens and parallel slot, and wakes cancel listeners so the
 * executors can abort the underlying calls. Later acquisitions start in the
 * new steering epoch.
 *
 * @module
 */

import { SpeculationMetrics } from './metrics.js';
import type { SpeculationMetricsSnapshot } from './types.js';

export interface SpeculationBudgetOptions {
	/** Maximum concurrently active speculative leases. Integer ≥ 1. */
	readonly maxParallelCalls: number;
	/** Maximum sum of token reservations held by active leases. Integer ≥ 1. */
	readonly maxOutstandingTokens: number;
	/** Optional per-lease token reservation cap. Integer ≥ 1. */
	readonly maxTokensPerCall?: number;
	/** External metrics instance to feed; defaults to a private one. */
	readonly metrics?: SpeculationMetrics;
}

export type AcquireFailureReason = 'parallel-limit' | 'token-limit';

export type AcquireResult =
	| { readonly ok: true; readonly lease: SpeculationLease }
	| { readonly ok: false; readonly reason: AcquireFailureReason };

export type LeaseOutcome = 'active' | 'confirmed' | 'wasted';

export interface SteeringCancellation {
	readonly reason: 'steering-change';
	/** Epoch the cancellation switched to (post-increment value). */
	readonly steeringEpoch: number;
}

export interface SpeculationLease {
	readonly id: number;
	/** Steering epoch this lease was acquired in. */
	readonly steeringEpoch: number;
	/** Token reservation currently charged to the budget for this lease. */
	readonly accountedTokens: number;
	/** True once the lease settled (`confirmed` or `wasted`); its result cannot be adopted. */
	isSettled(): boolean;
	/** True only when a steering-state change settled this lease as wasted. */
	isCancelled(): boolean;
	/** Current settlement state. */
	outcome(): LeaseOutcome;
	/**
	 * Subscribe to steering-change cancellation; the listener runs
	 * synchronously during `notifySteeringChanged`. Returns an unsubscribe.
	 */
	onCancelled(listener: (event: SteeringCancellation) => void): () => void;
	/** Replace the token reservation with the measured actual cost. Active leases only. */
	settleTokens(actualTokens: number): void;
	/** Settle as `confirmed` (foreground adopted the speculative result). */
	confirm(): void;
	/** Settle as `wasted` (foreground will not use the result). */
	discard(): void;
}

export interface SteeringChangeReport {
	/** Number of active leases the change settled as wasted. */
	readonly cancelled: number;
	/** Epoch value after the change. */
	readonly steeringEpoch: number;
	/** Caller-supplied reason, echoed for logging. */
	readonly reason: string | undefined;
}

export interface BudgetSnapshot extends SpeculationMetricsSnapshot {
	readonly inFlight: number;
	readonly outstandingTokens: number;
	readonly steeringEpoch: number;
}

export interface SpeculationBudget {
	readonly maxParallelCalls: number;
	readonly maxOutstandingTokens: number;
	readonly maxTokensPerCall: number | undefined;
	/** Current steering epoch; increments on every steering change. */
	readonly steeringEpoch: number;
	/** Try to start one speculative execution. */
	acquire(estimatedTokens: number): AcquireResult;
	/** Cancel every active lease (wasted) and start a new steering epoch. */
	notifySteeringChanged(reason?: string): SteeringChangeReport;
	/** Metrics plus live resource usage. */
	snapshot(): BudgetSnapshot;
}

function assertPositiveInteger(name: string, value: number): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(`${name} must be an integer ≥ 1, got ${value}`);
	}
}

/**
 * Create a bounded speculation budget. Throws `RangeError` on invalid
 * limits — a misconfigured budget must fail loudly at wiring time, not
 * silently disable speculation.
 */
export function createSpeculationBudget(options: SpeculationBudgetOptions): SpeculationBudget {
	assertPositiveInteger('maxParallelCalls', options.maxParallelCalls);
	assertPositiveInteger('maxOutstandingTokens', options.maxOutstandingTokens);
	if (options.maxTokensPerCall !== undefined) {
		assertPositiveInteger('maxTokensPerCall', options.maxTokensPerCall);
	}
	const metrics = options.metrics ?? new SpeculationMetrics();

	let steeringEpoch = 0;
	let nextLeaseId = 1;
	let inFlight = 0;
	let outstandingTokens = 0;

	interface LeaseRecord {
		readonly id: number;
		readonly acquiredEpoch: number;
		cancelListeners: Set<(event: SteeringCancellation) => void>;
		accountedTokens: number;
		outcome: LeaseOutcome;
		cancellation: SteeringCancellation | undefined;
	}

	const active = new Set<LeaseRecord>();

	function release(record: LeaseRecord): void {
		active.delete(record);
		inFlight -= 1;
		outstandingTokens -= record.accountedTokens;
	}

	function settleAsWasted(record: LeaseRecord, cancellation?: SteeringCancellation): void {
		// Settle-once: the first transition wins, later calls are no-ops.
		if (record.outcome !== 'active') return;
		record.outcome = 'wasted';
		record.cancellation = cancellation;
		release(record);
		metrics.incWasted();
		if (cancellation !== undefined) {
			for (const listener of record.cancelListeners) listener(cancellation);
		}
	}

	function acquire(estimatedTokens: number): AcquireResult {
		assertPositiveInteger('estimatedTokens', estimatedTokens);
		if (inFlight + 1 > options.maxParallelCalls) {
			return { ok: false, reason: 'parallel-limit' };
		}
		if (
			options.maxTokensPerCall !== undefined &&
			estimatedTokens > options.maxTokensPerCall
		) {
			return { ok: false, reason: 'token-limit' };
		}
		if (outstandingTokens + estimatedTokens > options.maxOutstandingTokens) {
			return { ok: false, reason: 'token-limit' };
		}
		const record: LeaseRecord = {
			id: nextLeaseId,
			acquiredEpoch: steeringEpoch,
			cancelListeners: new Set(),
			accountedTokens: estimatedTokens,
			outcome: 'active',
			cancellation: undefined,
		};
		nextLeaseId += 1;
		active.add(record);
		inFlight += 1;
		outstandingTokens += estimatedTokens;
		metrics.incSpeculated();

		const lease: SpeculationLease = {
			id: record.id,
			steeringEpoch: record.acquiredEpoch,
			get accountedTokens() {
				return record.accountedTokens;
			},
			isSettled: () => record.outcome !== 'active',
			isCancelled: () => record.cancellation !== undefined,
			outcome: () => record.outcome,
			onCancelled(listener) {
				record.cancelListeners.add(listener);
				return () => {
					record.cancelListeners.delete(listener);
				};
			},
			settleTokens(actualTokens: number) {
				assertPositiveInteger('actualTokens', actualTokens);
				if (record.outcome !== 'active') return;
				outstandingTokens += actualTokens - record.accountedTokens;
				record.accountedTokens = actualTokens;
			},
			confirm() {
				if (record.outcome !== 'active') return;
				record.outcome = 'confirmed';
				release(record);
				metrics.incConfirmed();
			},
			discard() {
				settleAsWasted(record);
			},
		};
		return { ok: true, lease };
	}

	function notifySteeringChanged(reason?: string): SteeringChangeReport {
		const toCancel = [...active];
		steeringEpoch += 1;
		for (const record of toCancel) {
			settleAsWasted(record, { reason: 'steering-change', steeringEpoch });
		}
		return { cancelled: toCancel.length, steeringEpoch, reason };
	}

	return {
		maxParallelCalls: options.maxParallelCalls,
		maxOutstandingTokens: options.maxOutstandingTokens,
		maxTokensPerCall: options.maxTokensPerCall,
		get steeringEpoch() {
			return steeringEpoch;
		},
		acquire,
		notifySteeringChanged,
		snapshot(): BudgetSnapshot {
			return {
				...metrics.snapshot(),
				inFlight,
				outstandingTokens,
				steeringEpoch,
			};
		},
	};
}
