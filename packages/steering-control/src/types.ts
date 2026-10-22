/**
 * Public contracts of the reactive delegation control (@mavis/steering-control).
 *
 * Scope (steering-design-sol.md §2–§4): this package owns the committed-steer
 * control reaction — find the parent's {@link ForegroundWaitSet} and perform
 * the single durable release transition (T_release) — plus the bounded
 * wait-set registry, the P0–P4 control-plane serialization and the
 * effect-fence seam. It is NOT a second execution loop, not a durable writer
 * and not the permission engine:
 *
 * - the {@link DelegationControlSeam} is implemented by the integrator on top
 *   of the native durable writer (transaction-scoped admission/finalization
 *   seam, spec §3 "Обязательный seam Ф1");
 * - the {@link EffectFence} is implemented by the integrator's permission
 *   gateway; while engaged it must fail conflicting parent effects with the
 *   {@link DELEGATION_EFFECT_BLOCKED} tool-error code;
 * - child ownership (DelegationSupervisor), input acceptance/dedup
 *   (turn-system) and reporter delivery live in their own packages.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Wait identity and lifecycle
// ---------------------------------------------------------------------------

/**
 * Identity of one foreground delegation wait, fixed at `task` spawn (§3
 * T_spawn): the key the durable delegation record and every replay joins on.
 */
export interface WaitKey {
	/** Conversation of the parent that is blocked on the delegate. */
	readonly parentConversationId: string;
	/** Run of the parent whose tool-round contains the wait. */
	readonly parentRunId: string;
	/** The `task` tool-call holding the foreground promise open. */
	readonly toolCallId: string;
}

/** Registration of a foreground wait, as produced by the delegation tool. */
export interface WaitRegistration {
	readonly parentConversationId: string;
	readonly parentRunId: string;
	readonly toolCallId: string;
	/**
	 * Durable state version of the delegation record at wait creation; the
	 * release decision is CAS-checked against it by the seam (§3 T_release).
	 */
	readonly stateVersion: number;
	/** Delegation identity, when the caller already has one. */
	readonly delegationId?: string;
	/**
	 * The durable wait identity, when the spawn path already fixed one
	 * (the delegation supervisor derives `wait-<digest>` at T_spawn and
	 * anchors the SAME id with the durable seam). Defaults to
	 * {@link deriveWaitId}`(key)`; whatever is chosen here MUST be the id the
	 * wait was anchored under — the release decision is keyed by it.
	 */
	readonly waitId?: string;
}

/** The single outcome of a wait — chosen exactly once per waitId (§3). */
export type WaitOutcome =
	/** The child finished before any release: normal foreground result. */
	| { readonly kind: 'completed'; readonly result: unknown }
	/**
	 * Control-release won: the wait was durably converted to background and
	 * finalized as the one standard background tool-result.
	 */
	| {
			readonly kind: 'backgrounded';
			readonly prepared: PreparedRelease;
			readonly finalization: ToolFinalization;
	  };

/**
 * Handle of a registered foreground wait. The delegation-tool waiter awaits
 * `outcome` and returns either the child result or the standard background
 * result derived from `prepared` (same stable task ID) — nothing else may
 * finish the tool-call.
 */
export interface WaitHandle {
	/** Deterministic wait identity derived from {@link WaitKey}. */
	readonly waitId: string;
	readonly key: Readonly<WaitKey>;
	/** Current expected durable state version (refreshable after a re-read). */
	readonly stateVersion: number;
	readonly delegationId: string | undefined;
	/** Resolves exactly once, with the single chosen outcome of this wait. */
	readonly outcome: Promise<WaitOutcome>;
	/**
	 * Child completion racing the release (§4 Гонки). From `foreground` it
	 * settles the wait as `completed` and returns `true`. While a release
	 * pass holds the claim (`releasing`) the completion is retained and
	 * `false` is returned: if the durable prepare is refused, the claim
	 * rollback replays it (the child finished durably first — the single
	 * outcome becomes `completed`); if the release commits, the
	 * `backgrounded` outcome supersedes it. Either way the caller falls back
	 * to `outcome`, which always settles exactly once.
	 */
	completeForeground(result: unknown): boolean;
	/**
	 * After a stale-version refusal the integrator re-reads the durable state
	 * and refreshes the expected version, making the wait releasable again
	 * (§4 Гонки: stale token → refresh or explicit refusal, never an effect
	 * on a newer run).
	 */
	refreshStateVersion(stateVersion: number): void;
	isSettled(): boolean;
}

// ---------------------------------------------------------------------------
// Durable seam (implemented by the integrator over the native writer)
// ---------------------------------------------------------------------------

/** Why a foreground wait is released. */
export type ReleaseReason =
	/** Committed owner input woke the control channel (§2.3). */
	| 'owner_input'
	/** Manual «В фон» quick action. */
	| 'manual_background'
	/** The 3600 s foreground fallback timer. */
	| 'timer';

/** Durable release request handed to `seam.prepareRelease` (T_release). */
export interface ReleaseRequest {
	/** Operation identity of this T_release attempt (CAS/dedupe key). */
	readonly operationId: string;
	readonly reason: ReleaseReason;
	/**
	 * `true` for control-plane commits: the writer must force a short urgent
	 * flush bypassing the normal batching window (§2 priorities).
	 */
	readonly urgent: boolean;
	readonly wait: {
		readonly waitId: string;
		readonly key: Readonly<WaitKey>;
		readonly stateVersion: number;
	};
}

/**
 * Durable, replayable result of a committed release decision (§3 T_release):
 * the transaction validated the owner-epoch/run/wait IDs and `stateVersion`,
 * chose the `backgrounded` outcome and persisted the background handle, the
 * control entry and this prepared tool-task outcome in one commit.
 */
export interface PreparedRelease {
	readonly operationId: string;
	readonly waitId: string;
	readonly key: Readonly<WaitKey>;
	readonly reason: ReleaseReason;
	readonly stateVersion: number;
	readonly urgent: boolean;
	/**
	 * Stable task ID of the original `task` call: the single tool-result is
	 * the standard background result FOR THIS ID — never a second task.
	 */
	readonly taskId: string;
	/** Durable anchor of the child, which keeps running under its supervisor. */
	readonly backgroundHandle: BackgroundHandle;
}

/** Stable ownership anchor of the still-running child (§3 Владение). */
export interface BackgroundHandle {
	readonly delegationId: string;
	readonly supervisorTaskId: string;
	readonly childConversationId: string;
}

/**
 * Acknowledgment of the native tool finalization: exactly one final
 * tool-result per `toolCallId`. A redelivered finalization (crash between the
 * release commit and the finalization commit) returns the SAME result with
 * `replayed: true` — the prepared outcome is reproduced, the child is not
 * restarted (§3 T_release, §6 gate 4).
 */
export interface ToolFinalization {
	readonly toolCallId: string;
	readonly taskId: string;
	/** Always the standard background outcome for control-release. */
	readonly outcome: 'background';
	readonly replayed: boolean;
}

/** Filter for recovery queries over durable prepared outcomes. */
export interface PreparedReleaseQuery {
	readonly parentConversationId?: string;
	readonly waitId?: string;
}

/**
 * The seam to the native durable writer (spec §3). Implemented by the
 * integrator; this package is the caller. Contracts:
 *
 * 1. `prepareRelease` resolves only AFTER the durable commit (ack after
 *    commit). It validates the owner-epoch and the expected `stateVersion`
 *    and throws {@link StaleStateVersionError} on a stale token.
 * 2. Repeating a release for an already-decided wait returns the saved
 *    prepared outcome ("повтор операции возвращает сохранённый исход").
 * 3. `finalizeTool` completes the native tool-task from the prepared outcome:
 *    one final tool-result per `toolCallId`, idempotent per `operationId`.
 * 4. `listPreparedReleases` exposes prepared-but-unfinalized outcomes so
 *    startup recovery can reproduce them (§3 recovery checklist).
 * 5. `flushUrgent`, when implemented, forces the short control-plane flush
 *    bypassing the ≤200 ms batching window; the controller calls it when a
 *    committed steer wakes the release path.
 *
 * **Stale-refusal code (fixed mapping rule).** This package classifies a
 * refused release through `isStaleStateVersionError` — the `code
 * 'STALE_STATE_VERSION'` — and ONLY that shape routes into the
 * `stale-version` branch (visible blocker, refresh-and-retry). An
 * implementation that wraps the wave-3 `@mavis/durable-seam` must therefore
 * map, before surfacing an error to this contract:
 *
 * - durable-seam `VERSION_CONFLICT` (the `stateVersion` CAS did not hold,
 *   `durable-seam/src/errors.ts` `VersionConflictError`) →
 *   `StaleStateVersionError`;
 * - durable-seam `OWNER_LOST` / `GENERATION_SEALED` (this writer lost the
 *   single-writer epoch / generation) → `StaleStateVersionError`;
 * - everything else surfaces unchanged (generic `failed`).
 *
 * `createDurableSeamControlSeam` (this package) implements exactly this
 * rule over `DurableSeam`; a hand-rolled integrator seam must reproduce it
 * (single-outcome.test.ts pins the visible semantics of the stale branch).
 */
export interface DelegationControlSeam {
	prepareRelease(request: ReleaseRequest): Promise<PreparedRelease>;
	finalizeTool(prepared: PreparedRelease): Promise<ToolFinalization>;
	listPreparedReleases(query?: PreparedReleaseQuery): Promise<readonly PreparedRelease[]>;
	flushUrgent?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Release results
// ---------------------------------------------------------------------------

/** Per-wait result of one release pass over a ForegroundWaitSet. */
export type WaitReleaseStatus =
	/** Decision committed, tool finalized as the single background result. */
	| 'released'
	/** The wait already settled (completed or released) — saved outcome attached. */
	| 'already-final'
	/** Stale `stateVersion`/epoch: explicit refusal, wait stays foreground. */
	| 'stale-version'
	/** Seam failure; the wait keeps its previous state (see per-status docs). */
	| 'failed';

/** One wait's outcome inside a {@link ReleaseResult}. */
export interface WaitReleaseRecord {
	readonly waitId: string;
	readonly toolCallId: string;
	readonly status: WaitReleaseStatus;
	/** Set for `released`: operation ID of the committed T_release. */
	readonly operationId?: string;
	/** Set for `released`. */
	readonly prepared?: PreparedRelease;
	/** Set for `released`. */
	readonly finalization?: ToolFinalization;
	/** Set for `already-final`: the saved single outcome of the wait. */
	readonly outcome?: WaitOutcome;
	/** Set for `stale-version` / `failed`. */
	readonly error?: string;
}

/** Result of releasing one parent ForegroundWaitSet for a committed steer. */
export interface ReleaseResult {
	readonly reason: Extract<ReleaseReason, 'owner_input'>;
	readonly parentConversationId: string;
	/** Waits durably released by this pass, in set order. */
	readonly released: readonly WaitReleaseRecord[];
	/** Waits skipped by this pass (already final, stale, or failed). */
	readonly skipped: readonly WaitReleaseRecord[];
	/** Effect-fence engagement after the release, when a fence is wired. */
	readonly fence?: FenceEngagement;
	/**
	 * Test-clock milliseconds from `onCommittedSteer` entry to the committed
	 * release — the measurable side of acceptance gate §6.2 (saved-ack →
	 * committed release, budget ≤250 ms). Fence engagement is excluded: the
	 * release is committed at this point.
	 */
	readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Committed steer input
// ---------------------------------------------------------------------------

/**
 * A steer already durably accepted by the turn-system (receipt committed,
 * §2.2). The controller only sees committed input — acceptance, dedup and
 * whenBusy/followUp discrimination happened upstream.
 */
export interface CommittedSteer {
	readonly parentConversationId: string;
	readonly requestId?: string;
	readonly submissionId?: string;
	/**
	 * When present, only the waitset of this run is released; when absent,
	 * every active delegation wait of the conversation is.
	 */
	readonly parentRunId?: string;
}

// ---------------------------------------------------------------------------
// Effect fence (implemented by the integrator's permission gateway)
// ---------------------------------------------------------------------------

/** Tool-error code the gateway returns for fenced conflicting effects (§4). */
export const DELEGATION_EFFECT_BLOCKED = 'DELEGATION_EFFECT_BLOCKED';

/** One released delegation referenced by an engaged fence. */
export interface DelegationFenceRef {
	readonly waitId: string;
	readonly toolCallId: string;
	readonly taskId: string;
	readonly delegationId: string;
}

/** Fence engagement request issued right after a committed release. */
export interface FenceEngageRequest {
	readonly parentConversationId: string;
	readonly reason: ReleaseReason;
	readonly refs: readonly DelegationFenceRef[];
}

export interface FenceEngagement {
	readonly status: 'engaged' | 'failed';
	/** Set for `failed`. */
	readonly error?: string;
}

/**
 * Effect-fence seam (§4 "Эффекты после автоматического detach"). The
 * implementation belongs to the integrator (permission engine gateway):
 * while engaged, new conflicting parent effects must be refused immediately
 * (never parked until the child finishes) with a standard tool-error carrying
 * {@link DELEGATION_EFFECT_BLOCKED}, the task IDs and a way forward.
 *
 * **Disengagement owner.** The fence is lifted after a PROVEN child
 * terminal fact — never after a stop signal (§5: "fence снимается после
 * доказанного завершения, не после отправки сигнала"). The owner of that
 * proof is the delegation supervisor: its terminal transitions
 * (`complete` / `recordChildTerminal`) call {@link EffectFence.disengage}
 * after the terminal commit. This package never disengages on its own: a
 * released wait keeps its fence until the supervised child reaches a
 * terminal fact, so parent effects stay serialized for exactly as long as
 * the child can still produce conflicting effects.
 */
export interface EffectFence {
	engage(request: FenceEngageRequest): Promise<FenceEngagement>;
	/**
	 * Lift the fence entries of delegations that reached a PROVEN terminal
	 * fact. Called by the delegation supervisor after the terminal commit;
	 * advisory semantics like {@link engage}: a failure is reported by the
	 * caller and never rolls back the committed terminal transition.
	 * Implementations decide per conversation when the LAST ref of a
	 * conversation lifts that conversation's fence.
	 */
	disengage?(request: FenceDisengageRequest): Promise<FenceDisengagement>;
}

/** One released delegation whose fence entry may be lifted (terminal child). */
export interface FenceDisengageRef {
	readonly waitId: string;
	readonly toolCallId: string | null;
	readonly delegationId: string;
}

/** Disengagement request issued after a proven child terminal fact. */
export interface FenceDisengageRequest {
	readonly parentConversationId: string;
	/** Why the fence lifts (`child_completed` / `child_stopped` / `child_failed`). */
	readonly reason: 'child_completed' | 'child_stopped' | 'child_failed';
	readonly refs: readonly FenceDisengageRef[];
}

export interface FenceDisengagement {
	readonly status: 'disengaged' | 'failed';
	/** Set for `failed`. */
	readonly error?: string;
}

// ---------------------------------------------------------------------------
// Control surface
// ---------------------------------------------------------------------------

/** A delegation wait still blocking its parent's tool-round. */
export interface ActiveBlocker {
	readonly waitId: string;
	readonly toolCallId: string;
	readonly parentConversationId: string;
	readonly parentRunId: string;
	readonly stateVersion: number;
	readonly delegationId: string | undefined;
	/** Test-clock age of the wait, for TUI status lines. */
	readonly ageMs: number;
}

export interface BlockerFilter {
	readonly parentConversationId?: string;
	readonly parentRunId?: string;
}

/** Failure of one prepared-outcome reproduction during recovery. */
export interface RecoverFailure {
	readonly operationId: string;
	readonly waitId: string | undefined;
	readonly error: string;
}

export interface RecoveryReport {
	/** Prepared outcomes reproduced as the single final tool-result. */
	readonly finalized: readonly ToolFinalization[];
	readonly failed: readonly RecoverFailure[];
	/** Fence re-engagements (one per affected conversation), when wired. */
	readonly fence: readonly FenceEngagement[];
}

export interface ReactiveControlOptions {
	/**
	 * Bound of one ForegroundWaitSet (all delegation waits blocking one
	 * tool-round). Registering beyond the bound fails closed with
	 * {@link WaitSetOverflowError} — never a silent drop.
	 */
	readonly maxWaitsPerRound?: number;
	/** How many settled waits stay replayable for `registerWait` replays. */
	readonly settledArchiveLimit?: number;
	/** Test-clock override (acceptance gates are measured on test clocks). */
	readonly clock?: () => number;
	readonly effectFence?: EffectFence;
	/** Durable operation identity for a T_release attempt. */
	readonly makeOperationId?: (waitId: string) => string;
}

/** The reactive delegation control of steering-design-sol.md §2.3. */
export interface ReactiveDelegationControl {
	/**
	 * Reaction to a committed parent steer (§2.3): finds the parent's
	 * ForegroundWaitSet and releases it with `reason="owner_input"`. Returns
	 * `null` when nothing is active — the child already finished or the wait
	 * was released earlier, so the normal result path applies and no detach
	 * is needed.
	 */
	onCommittedSteer(steer: CommittedSteer): Promise<ReleaseResult | null>;
	/**
	 * Registers a foreground delegation wait (parent side of T_spawn).
	 * Registering the same key again is a replay: it attaches to the existing
	 * wait — including a settled one, whose saved outcome is returned — and
	 * never creates a second waiter.
	 */
	registerWait(registration: WaitRegistration): WaitHandle;
	/** Delegation waits currently blocking their parent tool-rounds. */
	blockers(filter?: BlockerFilter): readonly ActiveBlocker[];
	/**
	 * Startup/crash recovery (§3): finalizes every prepared outcome that lost
	 * its finalization commit — reproducing the prepared outcome instead of
	 * restarting the child — and re-engages the effect fence for them.
	 */
	recover(): Promise<RecoveryReport>;
}
