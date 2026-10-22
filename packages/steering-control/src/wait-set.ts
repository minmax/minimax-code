/**
 * The bounded ForegroundWaitSet registry (§2, §4 "Несколько детей").
 *
 * All delegation wait-handles blocking a parent's current tool-round live in
 * one set per (parentConversationId, parentRunId). The set is bounded:
 * registering beyond the capacity fails closed with {@link WaitSetOverflowError}.
 *
 * Every handle is a settle-once state machine `foreground → releasing →
 * settled`:
 * - `completeForeground` settles `completed` only from `foreground`;
 * - a release pass claims the handle (`releasing`) BEFORE the durable
 *   prepare, so a concurrent child completion can never produce both a
 *   foreground result and a committed background outcome;
 * - if the durable prepare is refused (stale version), the claim is rolled
 *   back and the wait stays a visible blocker.
 *
 * Settled handles move into a bounded FIFO archive so a `registerWait`
 * replay (T_spawn replay, §3) attaches to the saved outcome instead of
 * creating a second waiter.
 *
 * @module
 */

import { WaitSetOverflowError } from './errors.js';
import type {
	ActiveBlocker,
	BlockerFilter,
	WaitHandle,
	WaitKey,
	WaitOutcome,
	WaitRegistration,
} from './types.js';

/** Default capacity of one tool-round's wait set (bounded, spec §4). */
export const DEFAULT_MAX_WAITS_PER_ROUND = 16;

/** Default number of settled waits kept replayable for registerWait replays. */
export const DEFAULT_SETTLED_ARCHIVE_LIMIT = 1024;

/** Deterministic wait identity: replays of the same key join the same wait. */
export function deriveWaitId(key: WaitKey): string {
	return `wait:${key.parentConversationId}:${key.parentRunId}:${key.toolCallId}`;
}

/** Registry-internal surface: the claim/settle state machine of a wait. */
export interface InternalWaitHandle extends WaitHandle {
	/** Test-clock millisecond of the registration, for blocker ages. */
	readonly registeredAtMs: number;
	/** `foreground → releasing`; `false` when the wait already settled. */
	claimForRelease(): boolean;
	/** `releasing → foreground`; used when the durable prepare was refused. */
	unclaim(): void;
	/** True while a release pass holds the claim (between claim and settle). */
	isReleasing(): boolean;
	/** Settles exactly once from any non-settled state; wakes `outcome`. */
	settle(outcome: WaitOutcome): boolean;
}

export interface ForegroundWaitSetRegistry {
	/**
	 * Registers a wait, or attaches to the existing/settled wait of the same
	 * key (`created: false`).
	 */
	register(
		registration: WaitRegistration,
		nowMs: number,
	): { handle: InternalWaitHandle; created: boolean };
	/** Snapshot of the active (not settled) waits of a conversation, optionally scoped to one run. */
	takeReleaseSet(parentConversationId: string, parentRunId?: string): InternalWaitHandle[];
	blockers(filter: BlockerFilter | undefined, nowMs: number): ActiveBlocker[];
	activeCount(): number;
}

type WaitState = 'foreground' | 'releasing' | 'settled';

class WaitHandleImpl implements InternalWaitHandle {
	readonly waitId: string;
	readonly key: WaitKey;
	readonly delegationId: string | undefined;
	readonly registeredAtMs: number;
	private stateVersionValue: number;
	private state: WaitState = 'foreground';
	/**
	 * Child completion that arrived while a release pass held the claim; it
	 * is replayed if the release is refused and dropped if it commits.
	 */
	private pendingCompletion: { result: unknown } | undefined;
	/* Assigned inside the Promise executor below (definite assignment). */
	private resolveOutcome!: (outcome: WaitOutcome) => void;
	readonly outcome: Promise<WaitOutcome>;

	constructor(
		key: WaitKey,
		waitId: string,
		stateVersion: number,
		delegationId: string | undefined,
		registeredAtMs: number,
		private readonly onSettled: (handle: WaitHandleImpl) => void,
	) {
		this.key = key;
		this.waitId = waitId;
		this.stateVersionValue = stateVersion;
		this.delegationId = delegationId;
		this.registeredAtMs = registeredAtMs;
		this.outcome = new Promise<WaitOutcome>(resolve => {
			this.resolveOutcome = resolve;
		});
	}

	get stateVersion(): number {
		return this.stateVersionValue;
	}

	isSettled(): boolean {
		return this.state === 'settled';
	}

	isReleasing(): boolean {
		return this.state === 'releasing';
	}

	claimForRelease(): boolean {
		if (this.state !== 'foreground') return false;
		this.state = 'releasing';
		return true;
	}

	unclaim(): void {
		if (this.state !== 'releasing') return;
		this.state = 'foreground';
		// A completion that arrived inside the claim→prepare window is
		// replayed: the release was refused, so the durably-first child
		// completion wins the single outcome (§4 Гонки).
		const completion = this.pendingCompletion;
		this.pendingCompletion = undefined;
		if (completion !== undefined) {
			this.settle({ kind: 'completed', result: completion.result });
		}
	}

	settle(outcome: WaitOutcome): boolean {
		if (this.state === 'settled') return false;
		this.state = 'settled';
		// A chosen outcome supersedes any completion retained mid-release.
		this.pendingCompletion = undefined;
		this.resolveOutcome(outcome);
		this.onSettled(this);
		return true;
	}

	completeForeground(result: unknown): boolean {
		if (this.state === 'releasing') {
			// Retained for replay if the in-flight release is refused; dropped
			// if the release commits (the backgrounded outcome supersedes it,
			// the child result reaches the parent via the supervisor instead).
			this.pendingCompletion = { result };
			return false;
		}
		if (this.state !== 'foreground') return false;
		return this.settle({ kind: 'completed', result });
	}

	refreshStateVersion(stateVersion: number): void {
		if (!Number.isFinite(stateVersion)) {
			throw new RangeError(`stateVersion must be a finite number, got ${stateVersion}`);
		}
		this.stateVersionValue = stateVersion;
	}
}

export interface WaitSetRegistryOptions {
	readonly maxWaitsPerRound: number;
	readonly settledArchiveLimit: number;
}

export function createForegroundWaitSetRegistry(
	options: WaitSetRegistryOptions,
): ForegroundWaitSetRegistry {
	if (!Number.isInteger(options.maxWaitsPerRound) || options.maxWaitsPerRound < 1) {
		throw new RangeError(`maxWaitsPerRound must be a positive integer, got ${options.maxWaitsPerRound}`);
	}
	if (!Number.isInteger(options.settledArchiveLimit) || options.settledArchiveLimit < 0) {
		throw new RangeError(`settledArchiveLimit must be a non-negative integer, got ${options.settledArchiveLimit}`);
	}

	/** conversationId → runId → waitId → handle (insertion order = wait order). */
	const rounds = new Map<string, Map<string, Map<string, WaitHandleImpl>>>();
	/** FIFO archive of settled waits, keyed by waitId, for replay attachment. */
	const settledArchive = new Map<string, WaitHandleImpl>();

	function removeFromRound(handle: WaitHandleImpl): void {
		const runs = rounds.get(handle.key.parentConversationId);
		const waits = runs?.get(handle.key.parentRunId);
		if (waits === undefined) return;
		waits.delete(handle.waitId);
		if (waits.size === 0) runs?.delete(handle.key.parentRunId);
		if (runs !== undefined && runs.size === 0) rounds.delete(handle.key.parentConversationId);
	}

	function onSettled(handle: WaitHandleImpl): void {
		removeFromRound(handle);
		settledArchive.set(handle.waitId, handle);
		while (settledArchive.size > options.settledArchiveLimit) {
			const oldest = settledArchive.keys().next();
			if (oldest.done) break;
			settledArchive.delete(oldest.value);
		}
	}

	return {
		register(registration, nowMs) {
			for (const field of [registration.parentConversationId, registration.parentRunId, registration.toolCallId]) {
				if (typeof field !== 'string' || field.length === 0) {
					throw new TypeError('registerWait: parentConversationId, parentRunId and toolCallId must be non-empty strings');
				}
			}
			if (!Number.isFinite(registration.stateVersion)) {
				throw new RangeError(`registerWait: stateVersion must be a finite number, got ${registration.stateVersion}`);
			}
			const key: WaitKey = {
				parentConversationId: registration.parentConversationId,
				parentRunId: registration.parentRunId,
				toolCallId: registration.toolCallId,
			};
			// The durable wait identity: the integrator's (spawn-fixed) when
			// provided, the derived default otherwise — the release decision is
			// keyed by whatever the wait was anchored under.
			const waitId =
				registration.waitId !== undefined && registration.waitId.length > 0
					? registration.waitId
					: deriveWaitId(key);

			let runs = rounds.get(key.parentConversationId);
			const existing = runs?.get(key.parentRunId)?.get(waitId);
			if (existing !== undefined) return { handle: existing, created: false };
			const archived = settledArchive.get(waitId);
			if (archived !== undefined) return { handle: archived, created: false };

			// Capacity is validated BEFORE any map is created, so a refused
			// registration leaves no empty conversation/run maps behind.
			const existingWaits = runs?.get(key.parentRunId);
			if (existingWaits !== undefined && existingWaits.size >= options.maxWaitsPerRound) {
				throw new WaitSetOverflowError(key.parentConversationId, key.parentRunId, options.maxWaitsPerRound);
			}

			const waits = existingWaits ?? new Map<string, WaitHandleImpl>();
			if (runs === undefined) {
				runs = new Map<string, Map<string, WaitHandleImpl>>();
				rounds.set(key.parentConversationId, runs);
			}
			if (existingWaits === undefined) {
				runs.set(key.parentRunId, waits);
			}
			const handle = new WaitHandleImpl(
				key,
				waitId,
				registration.stateVersion,
				registration.delegationId,
				nowMs,
				onSettled,
			);
			waits.set(waitId, handle);
			return { handle, created: true };
		},

		takeReleaseSet(parentConversationId, parentRunId) {
			const result: InternalWaitHandle[] = [];
			const runs = rounds.get(parentConversationId);
			if (runs === undefined) return result;
			const targets =
				parentRunId === undefined ? [...runs.values()] : [runs.get(parentRunId)];
			for (const waits of targets) {
				if (waits === undefined) continue;
				for (const handle of waits.values()) result.push(handle);
			}
			return result;
		},

		blockers(filter, nowMs) {
			const result: ActiveBlocker[] = [];
			for (const [conversationId, runs] of rounds) {
				if (filter?.parentConversationId !== undefined && filter.parentConversationId !== conversationId) {
					continue;
				}
				for (const [runId, waits] of runs) {
					if (filter?.parentRunId !== undefined && filter.parentRunId !== runId) continue;
					for (const handle of waits.values()) {
						// Settled waits are removed on settle; "releasing" ones are
						// truthfully still blocking until their outcome is final.
						result.push({
							waitId: handle.waitId,
							toolCallId: handle.key.toolCallId,
							parentConversationId: conversationId,
							parentRunId: runId,
							stateVersion: handle.stateVersion,
							delegationId: handle.delegationId,
							ageMs: nowMs - handle.registeredAtMs,
						});
					}
				}
			}
			return result;
		},

		activeCount() {
			let count = 0;
			for (const runs of rounds.values()) {
				for (const waits of runs.values()) count += waits.size;
			}
			return count;
		},
	};
}
