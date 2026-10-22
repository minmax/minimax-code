/**
 * Test doubles for the steering-control suite: a deterministic manual test
 * clock and a contract-faithful in-memory fake of DelegationControlSeam.
 *
 * All latency assertions in this suite are measured on the TEST CLOCK (the
 * acceptance gates of steering-design-sol.md §6 are clock-based budgets, not
 * wall-clock flukes): the fake seam advances the shared TestClock instead of
 * using real timers, so `elapsedMs` values are exact and reproducible.
 *
 * @module
 */

import { createReactiveControl } from '../src/reactive-control.js';
import type { ReactiveDelegationControl } from '../src/types.js';
import { StaleStateVersionError } from '../src/errors.js';
import type {
	DelegationControlSeam,
	EffectFence,
	FenceEngageRequest,
	PreparedRelease,
	PreparedReleaseQuery,
	ReleaseRequest,
	ToolFinalization,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Deterministic test clock
// ---------------------------------------------------------------------------

/**
 * Manual clock: time only moves via advance()/runToEnd(), firing due timer
 * callbacks in order. Promises chained on sleep() settle as microtasks, so a
 * test drives: start op → clock.runToEnd() → await op.
 */
export class TestClock {
	private currentMs = 0;
	private readonly timers: Array<{ at: number; fn: () => void }> = [];

	now(): number {
		return this.currentMs;
	}

	sleep(ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		return new Promise<void>(resolve => {
			this.timers.push({ at: this.currentMs + ms, fn: resolve });
		});
	}

	advance(ms: number): void {
		this.currentMs += ms;
		this.fireDue();
	}

	/** Fires every pending timer (earliest first), however far in the future. */
	runToEnd(): void {
		let guard = 0;
		while (this.timers.length > 0 && guard < 10_000) {
			guard += 1;
			this.timers.sort((a, b) => a.at - b.at);
			const timer = this.timers.shift();
			if (timer === undefined) break;
			if (timer.at > this.currentMs) this.currentMs = timer.at;
			timer.fn();
		}
	}

	get pendingTimers(): number {
		return this.timers.length;
	}

	private fireDue(): void {
		// Timers may schedule more timers while firing; loop until stable.
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (let index = 0; index < this.timers.length; ) {
				const timer = this.timers[index];
				if (timer !== undefined && timer.at <= this.currentMs) {
					this.timers.splice(index, 1);
					timer.fn();
					progressed = true;
				} else {
					index += 1;
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Fake durable seam
// ---------------------------------------------------------------------------

export interface FakeDelegationRecord {
	readonly waitId: string;
	readonly taskId: string;
	readonly delegationId: string;
	readonly supervisorTaskId: string;
	readonly childConversationId: string;
	stateVersion: number;
}

export interface FakeSeamOptions {
	clock: TestClock;
	/** Non-urgent commit batching window (spec default ≤200 ms). */
	windowMs?: number;
	/** Durable T_release transaction time on the test clock. */
	prepareMs?: number;
	/** Native tool finalization time on the test clock. */
	finalizeMs?: number;
	/** Whether the fake exposes flushUrgent (default true). */
	withFlushUrgent?: boolean;
}

/** In-memory DelegationControlSeam plus the test surface used by the suite. */
export interface FakeSeam extends DelegationControlSeam {
	prepareRelease(request: ReleaseRequest): Promise<PreparedRelease>;
	finalizeTool(prepared: PreparedRelease): Promise<ToolFinalization>;
	listPreparedReleases(query?: PreparedReleaseQuery): Promise<readonly PreparedRelease[]>;
	flushUrgent?(): Promise<void>;

	// ---- test surface -------------------------------------------------------
	/** Durable delegation records the supervisor/spawn would have committed. */
	registerDelegation(seed: {
		waitId: string;
		taskId: string;
		delegationId?: string;
		supervisorTaskId?: string;
		childConversationId?: string;
		stateVersion?: number;
	}): FakeDelegationRecord;
	delegations: Map<string, FakeDelegationRecord>;
	/** Durable prepared outcomes, keyed by operationId (survives "restarts"). */
	readonly preparedStore: Map<string, PreparedRelease>;
	/** Durable tool results, keyed by toolCallId — the single-result invariant. */
	readonly finalizedByToolCallId: Map<string, ToolFinalization>;
	readonly prepareCalls: readonly ReleaseRequest[];
	readonly finalizeCalls: readonly PreparedRelease[];
	readonly flushUrgentCalls: number;
	/**
	 * When set, the NEXT matching finalizeTool never resolves (simulated
	 * process death mid-release) and disarms itself afterwards.
	 */
	hangFinalize: ((prepared: PreparedRelease) => boolean) | undefined;
}

export function createFakeSeam(options: FakeSeamOptions): FakeSeam {
	const { clock } = options;
	const windowMs = options.windowMs ?? 200;
	const prepareMs = options.prepareMs ?? 30;
	const finalizeMs = options.finalizeMs ?? 10;
	const withFlushUrgent = options.withFlushUrgent ?? true;

	const delegations = new Map<string, FakeDelegationRecord>();
	const preparedStore = new Map<string, PreparedRelease>();
	const finalizedByOperationId = new Map<string, ToolFinalization>();
	const finalizedByToolCallId = new Map<string, ToolFinalization>();
	const prepareCalls: ReleaseRequest[] = [];
	const finalizeCalls: PreparedRelease[] = [];
	let flushUrgentCalls = 0;

	// Shared batching window: non-urgent commits queue behind it; urgent ones
	// (control-plane, request.urgent) bypass it entirely.
	let windowWaiters: Array<() => void> | null = null;
	function passBatchWindow(): Promise<void> {
		let waiters = windowWaiters;
		if (waiters === null) {
			waiters = [];
			windowWaiters = waiters;
			void clock.sleep(windowMs).then(() => {
				const closing = windowWaiters;
				windowWaiters = null;
				for (const release of closing ?? []) release();
			});
		}
		const queue = waiters;
		return new Promise<void>(resolve => {
			queue.push(resolve);
		});
	}

	function savedOutcomeFor(waitId: string): PreparedRelease | undefined {
		for (const prepared of preparedStore.values()) {
			if (prepared.waitId === waitId) return prepared;
		}
		return undefined;
	}

	const seam: FakeSeam = {
		async prepareRelease(request) {
			prepareCalls.push(request);
			const record = delegations.get(request.wait.waitId);
			if (record === undefined) {
				throw new Error(`fake seam: unknown delegation ${request.wait.waitId}`);
			}
			if (record.stateVersion !== request.wait.stateVersion) {
				throw new StaleStateVersionError(
					`wait ${request.wait.waitId}: durable stateVersion ${record.stateVersion}, request has ${request.wait.stateVersion}`,
				);
			}
			// Repeated release returns the saved outcome ("повтор операции
			// возвращает сохранённый исход").
			const saved = savedOutcomeFor(request.wait.waitId);
			if (saved !== undefined) return saved;
			if (!request.urgent) await passBatchWindow();
			await clock.sleep(prepareMs);
			const prepared: PreparedRelease = {
				operationId: request.operationId,
				waitId: request.wait.waitId,
				key: { ...request.wait.key },
				reason: request.reason,
				stateVersion: request.wait.stateVersion,
				urgent: request.urgent,
				taskId: record.taskId,
				backgroundHandle: {
					delegationId: record.delegationId,
					supervisorTaskId: record.supervisorTaskId,
					childConversationId: record.childConversationId,
				},
			};
			preparedStore.set(prepared.operationId, prepared);
			return prepared;
		},

		async finalizeTool(prepared) {
			finalizeCalls.push(prepared);
			const done = finalizedByOperationId.get(prepared.operationId);
			if (done !== undefined) {
				// Idempotent redelivery after a crash: same result, replayed flag.
				return { ...done, replayed: true };
			}
			// Read through the seam object so tests can arm/clear the hook.
			if (seam.hangFinalize?.(prepared) === true) {
				seam.hangFinalize = undefined; // the process died once; a retry survives
				return new Promise<ToolFinalization>(() => {});
			}
			await clock.sleep(finalizeMs);
			if (finalizedByToolCallId.has(prepared.key.toolCallId)) {
				throw new Error(`fake seam: second tool-result for ${prepared.key.toolCallId}`);
			}
			const finalization: ToolFinalization = {
				toolCallId: prepared.key.toolCallId,
				taskId: prepared.taskId,
				outcome: 'background',
				replayed: false,
			};
			finalizedByOperationId.set(prepared.operationId, finalization);
			finalizedByToolCallId.set(finalization.toolCallId, finalization);
			return finalization;
		},

		async listPreparedReleases(query) {
			const result: PreparedRelease[] = [];
			for (const prepared of preparedStore.values()) {
				// Only prepared-but-unfinalized outcomes are recoverable state.
				if (finalizedByOperationId.has(prepared.operationId)) continue;
				if (query?.waitId !== undefined && prepared.waitId !== query.waitId) continue;
				if (
					query?.parentConversationId !== undefined &&
					prepared.key.parentConversationId !== query.parentConversationId
				) {
					continue;
				}
				result.push(prepared);
			}
			return result;
		},

		registerDelegation(seed) {
			const record: FakeDelegationRecord = {
				waitId: seed.waitId,
				taskId: seed.taskId,
				delegationId: seed.delegationId ?? `delegation:${seed.waitId}`,
				supervisorTaskId: seed.supervisorTaskId ?? `supervisor:${seed.taskId}`,
				childConversationId: seed.childConversationId ?? `child:${seed.taskId}`,
				stateVersion: seed.stateVersion ?? 1,
			};
			delegations.set(record.waitId, record);
			return record;
		},

		delegations,
		preparedStore,
		finalizedByToolCallId,
		prepareCalls,
		finalizeCalls,
		hangFinalize: undefined,

		get flushUrgentCalls(): number {
			return flushUrgentCalls;
		},
	};

	if (withFlushUrgent) {
		seam.flushUrgent = async () => {
			flushUrgentCalls += 1;
		};
	}
	return seam;
}

// ---------------------------------------------------------------------------
// Fake effect fence
// ---------------------------------------------------------------------------

export interface FakeFence extends EffectFence {
	readonly engagements: readonly FenceEngageRequest[];
	/** Makes the next engage() report a gateway failure. */
	failNext(): void;
}

export function createFakeFence(): FakeFence {
	const engagements: FenceEngageRequest[] = [];
	let failing = false;
	return {
		engagements,
		failNext() {
			failing = true;
		},
		async engage(request) {
			engagements.push(request);
			if (failing) {
				failing = false;
				return { status: 'failed', error: 'gateway unavailable' };
			}
			return { status: 'engaged' };
		},
	};
}

// ---------------------------------------------------------------------------
// Combined rig
// ---------------------------------------------------------------------------

export interface Rig {
	clock: TestClock;
	seam: FakeSeam;
	control: ReactiveDelegationControl;
	fence: FakeFence;
}

/**
 * Drives `pending` to settlement on the TEST CLOCK: control-plane scheduling
 * is microtask-based while seam work is timer-based, so the driver
 * alternates microtask draining and timer firing until the promise settles.
 * A promise that never settles (simulated crash) exhausts the guard and the
 * caller observes it via a race, as in the crash-recovery tests.
 */
export function driven<T>(clock: TestClock, pending: Promise<T>): Promise<T> {
	let settled = false;
	const watched = pending.then(
		value => {
			settled = true;
			return value;
		},
		error => {
			settled = true;
			throw error;
		},
	);
	void (async () => {
		for (let guard = 0; !settled && guard < 10_000; guard += 1) {
			// eslint-disable-next-line no-await-in-loop
			await pumpMicrotasks();
			clock.runToEnd();
		}
	})();
	return watched;
}

function createControl(
	seam: FakeSeam,
	clock: TestClock,
	fence: FakeFence,
	options: { maxWaitsPerRound?: number } = {},
): ReactiveDelegationControl {
	return createReactiveControl(seam, {
		clock: () => clock.now(),
		effectFence: fence,
		maxWaitsPerRound: options.maxWaitsPerRound,
	});
}

/** Standard rig: shared test clock across seam and control. */
export function setup(options: { maxWaitsPerRound?: number; withFlushUrgent?: boolean } = {}): Rig {
	const clock = new TestClock();
	const fence = createFakeFence();
	const seam = createFakeSeam({ clock, withFlushUrgent: options.withFlushUrgent });
	const control = createControl(seam, clock, fence, options);
	return { clock, seam, control, fence };
}

/** A few microtask ticks, for control-plane scheduling without real timers. */
export async function pumpMicrotasks(times = 8): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		// eslint-disable-next-line no-await-in-loop
		await Promise.resolve();
	}
}

/**
 * Waits (microtask-only) until the predicate holds. Everything in this suite
 * — control-plane scheduling, driven timers — progresses via microtasks, so
 * plain microtask waiting is enough to reach a state like "prepare committed".
 */
export async function until(predicate: () => boolean, guard = 10_000): Promise<void> {
	let index = 0;
	while (!predicate() && index < guard) {
		index += 1;
		// eslint-disable-next-line no-await-in-loop
		await Promise.resolve();
	}
	if (!predicate()) {
		throw new Error('until: condition not met within the microtask guard');
	}
}
