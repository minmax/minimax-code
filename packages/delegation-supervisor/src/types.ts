/**
 * Public types of the delegation supervisor (steering-design-sol.md §3:
 * T_spawn / ownership / supervision).
 *
 * The supervisor is the durable anchor that OWNS a delegated child
 * conversation. It sits below the `task` tool and the reactive release
 * control: the foreground `task` call only holds a wait handle; the child
 * itself is owned by a stable supervisor task placed at the native background
 * ownership boundary, so the wait can be released (auto-detach) or crash
 * without endangering the child.
 *
 * Every state transition of a delegation is committed as ONE atomic batch of
 * canonical app-entries (kinds prefixed `mcode.delegation.`) plus the updated
 * active-index document — mirroring the canonical-records table of §3. Entry
 * ids are deterministic functions of delegation identity, which is what makes
 * replays idempotent at the storage boundary (the sqlite backend's entry-id
 * primary key refuses a second copy).
 *
 * Payload shapes are TYPE ALIASES (not interfaces) on purpose: only type
 * aliases carry TypeScript's implicit index signature, which is what makes
 * them assignable to {@link JsonValue} and therefore storable as entry
 * payloads without casts.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** JSON value shapes allowed inside supervisor entry payloads. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Canonical entry kinds (§3 "Канонические записи")
// ---------------------------------------------------------------------------

/** Prefix of every supervisor-owned entry kind. */
export const DELEGATION_ENTRY_KIND_PREFIX = 'mcode.delegation.';

/** The active-index document (`mcode.delegations` in the spec table). */
export const DELEGATION_DOCUMENT_KIND = 'mcode.delegations.document';

/** Kind of the stable supervisor-task anchor (native background ownership). */
export const KIND_SUPERVISOR_TASK = 'mcode.delegation.supervisor-task';

/** Kind of the child-conversation record (fresh inbox/index/epoch identity). */
export const KIND_CHILD_CONVERSATION = 'mcode.delegation.child-conversation';

/** Kind of the delegation record written by T_spawn. */
export const KIND_SPAWNED = 'mcode.delegation.spawned';

/** Kind of the T_release outcome: the wait transitioned to backgrounded. */
export const KIND_BACKGROUNDED = 'mcode.delegation.backgrounded';

/** Kind of the T_complete outcome (child run result + delivery decision). */
export const KIND_COMPLETED = 'mcode.delegation.completed';

/**
 * Kind of the deduplicated reporter submission (background delivery of a
 * completion). Its entry id IS the durable dedup key of the reporter.
 */
export const KIND_COMPLETION_REPORT = 'mcode.delegation.completion-report';

/** Kind of one stop-request of the cascade. */
export const KIND_STOP_REQUESTED = 'mcode.delegation.stop-requested';

/** Kind of the observed terminal outcome of a supervised child. */
export const KIND_CHILD_TERMINAL = 'mcode.delegation.child-terminal';

/** Kind of the R3 fork record (fresh queue identity, inherited receipts = history). */
export const KIND_FORKED = 'mcode.delegation.forked';

// ---------------------------------------------------------------------------
// Identity shapes
// ---------------------------------------------------------------------------

/**
 * The T_spawn replay key: `(parentConversationId, parentRunId, toolCallId)`.
 * A repeated spawn under the same key joins the existing child submission
 * instead of creating a second executor.
 */
export type SpawnKey = {
  readonly parentConversationId: string;
  readonly parentRunId: string;
  readonly toolCallId: string;
};

/** Supervision policy stored with the delegation at spawn time. */
export type SupervisionPolicy = {
  /**
   * When true, the child is stopped when its parent run aborts. The link
   * survives automatic detach: while the wait is foreground any parent abort
   * stops the child, after a backgrounded detach only an EXPLICIT parent Stop
   * does (§3 "Владение", §5 "Abort после принятия ввода").
   */
  readonly cancelOnParentAbort: boolean;
};

/** Fresh queue identity of a child conversation (R3: never inherited). */
export type ChildQueues = {
  readonly inboxId: string;
  readonly deliveryIndexId: string;
  readonly delegationIndexId: string;
};

// ---------------------------------------------------------------------------
// Child spec (spawn input)
// ---------------------------------------------------------------------------

/** Caller-supplied description of the child to own. Freeform on purpose. */
export type ChildSpec = {
  /** Working prompt handed to the child conversation, when one exists. */
  readonly prompt?: string;
  /** Supervision policy; defaults to `{ cancelOnParentAbort: true }`. */
  readonly supervision?: Partial<SupervisionPolicy>;
  /**
   * Delegation id of the parent node in the supervision tree, when the new
   * delegation is itself a child of another delegation (parent → child →
   * grandchild). The supervisor validates that the referenced delegation's
   * child conversation IS `parentConversationId`.
   */
  readonly parentDelegationId?: string | null;
  /** Additional caller-defined properties (model, cwd, tools, ...). */
  readonly [key: string]: JsonValue | undefined;
};

// ---------------------------------------------------------------------------
// Entry payloads (durable records)
// ---------------------------------------------------------------------------

export type SupervisorTaskPayload = {
  readonly supervisorTaskId: string;
  readonly delegationId: string;
  /** Fixed marker: the ownership boundary this anchor is placed at. */
  readonly ownershipBoundary: 'native-background';
};

export type ChildConversationPayload = {
  readonly childConversationId: string;
  readonly delegationId: string;
  readonly supervisorTaskId: string;
  /** R3 fork policy: app queue documents start empty on a new child. */
  readonly queueForkPolicy: 'initial';
  readonly queues: ChildQueues;
  /** Seed of the child conversation's own single-writer epoch namespace. */
  readonly epochSeed: string;
  /** `none` at spawn; a fork records `history` for inherited receipts. */
  readonly inheritedReceipts: 'none' | 'history';
};

export type SpawnedPayload = {
  readonly delegationId: string;
  readonly key: SpawnKey;
  readonly supervisorTaskId: string;
  readonly childConversationId: string;
  /** Stable id of the child execution submission; replays join it. */
  readonly childSubmissionId: string;
  readonly waitId: string;
  /** Fresh queue identity of the child conversation (duplicated from the
   * child-conversation record so the index document is self-contained). */
  readonly queues: ChildQueues;
  readonly epochSeed: string;
  readonly supervision: SupervisionPolicy;
  readonly parentDelegationId: string | null;
  /** Optimistic version of the delegation record; bumped per transition. */
  readonly stateVersion: number;
  /** Digest of the canonical child spec; replay with another spec conflicts. */
  readonly childSpecDigest: string;
};

/** The background handle returned by a released foreground wait. */
export type BackgroundHandle = {
  readonly kind: 'task-background';
  readonly supervisorTaskId: string;
  readonly childConversationId: string;
  readonly childSubmissionId: string;
};

export type BackgroundedPayload = {
  readonly delegationId: string;
  readonly waitId: string;
  readonly operationId: string;
  readonly reason: string;
  readonly backgroundHandle: BackgroundHandle;
  readonly stateVersion: number;
};

export type DelegationOutcome = {
  readonly status: 'completed' | 'failed';
  readonly summary?: string;
  readonly payload?: JsonValue;
};

export type CompletedPayload = {
  readonly delegationId: string;
  readonly childRunId: string;
  readonly outcome: DelegationOutcome;
  readonly delivery: CompletionDelivery;
  /** Reporter requestId; `null` for foreground delivery. */
  readonly requestId: string | null;
  readonly stateVersion: number;
};

export type CompletionReportPayload = {
  readonly requestId: string;
  readonly submissionId: string;
  readonly delegationId: string;
  readonly childRunId: string;
  readonly outcome: DelegationOutcome;
};

export type StopRequestedPayload = {
  readonly delegationId: string;
  /** Root of the cascade this request belongs to (dedup scope). */
  readonly rootDelegationId: string;
  readonly operationId: string;
  readonly cause: string;
  readonly initiator: StopInitiator;
  /** Depth of the node below the cascade root (0 = the root itself). */
  readonly depth: number;
  readonly stateVersion: number;
};

export type StopInitiator = 'owner' | 'supervision' | 'recovery';

export type ChildTerminalPayload = {
  readonly delegationId: string;
  readonly terminal: 'stopped' | 'failed' | 'completed';
  readonly reason: string;
  readonly stateVersion: number;
};

export type ForkedPayload = {
  readonly forkDelegationId: string;
  readonly fromDelegationId: string;
  readonly childConversationId: string;
  readonly supervisorTaskId: string;
  readonly childSubmissionId: string;
  readonly waitId: string;
  readonly queues: ChildQueues;
  readonly epochSeed: string;
  /** Forks start detached: no foreground wait belongs to a fork branch. */
  readonly supervision: SupervisionPolicy;
  readonly parentDelegationId: string | null;
  readonly forkIndex: number;
  readonly childSpecDigest: string;
  readonly stateVersion: number;
};

/** One indexed delegation (active, or a bounded terminal-tail record). */
export type DelegationRecord = {
  readonly delegationId: string;
  /** Spawn key; `null` for fork branches (the key belongs to the original). */
  readonly key: SpawnKey | null;
  readonly supervisorTaskId: string;
  readonly childConversationId: string;
  readonly childSubmissionId: string;
  readonly waitId: string;
  readonly parentDelegationId: string | null;
  /** Delegation this branch was forked from (R3), if any. */
  readonly forkedFromDelegationId: string | null;
  /** Direct children in the supervision tree (nested delegations). */
  readonly childDelegationIds: readonly string[];
  /** Fork branches created from this delegation. */
  readonly forkDelegationIds: readonly string[];
  readonly supervision: SupervisionPolicy;
  readonly queues: ChildQueues;
  readonly epochSeed: string;
  readonly inheritedReceipts: 'none' | 'history';
  readonly childSpecDigest: string;
  /** wait: foreground --T_release--> backgrounded; T_complete --> completed. */
  readonly waitState: WaitState;
  /** child: running --> stopping --> terminal. */
  readonly childState: ChildState;
  readonly backgroundHandle: BackgroundHandle | null;
  /** The committed detach (T_release) operation, for idempotent replays. */
  readonly detach: { readonly operationId: string; readonly reason: string } | null;
  readonly completion: {
    readonly childRunId: string;
    readonly outcome: DelegationOutcome;
    readonly delivery: CompletionDelivery;
    readonly requestId: string | null;
    /** Set once the reporter submission is durably recorded. */
    readonly reportSettled: boolean;
  } | null;
  /** Stop cascades that touched this node, for operation-id dedup. */
  readonly stops: readonly StopLink[];
  /** Parent-abort cascades rooted at this node (operation-id derivation). */
  readonly parentAbortOps: readonly string[];
  readonly terminal: { readonly terminal: 'stopped' | 'failed' | 'completed'; readonly reason: string } | null;
  readonly stateVersion: number;
};

export type WaitState = 'foreground' | 'backgrounded' | 'completed' | 'none';
export type ChildState = 'running' | 'stopping' | 'terminal';
export type CompletionDelivery = 'foreground' | 'reporter';

export type StopLink = {
  readonly operationId: string;
  readonly rootDelegationId: string;
  readonly cause: string;
};

/** Payload of the active-index document entry. */
export type DelegationDocumentPayload = {
  /** Monotonic revision; each committed transition bumps it by exactly one. */
  readonly revision: number;
  /** Index records (active plus a bounded terminal tail). */
  readonly delegations: readonly DelegationRecord[];
};

// ---------------------------------------------------------------------------
// API results
// ---------------------------------------------------------------------------

/** Result of {@link DelegationSupervisor.spawnDelegation}. */
export type SpawnDelegationResult = {
  readonly delegationId: string;
  readonly supervisorTaskId: string;
  readonly childConversationId: string;
  /** Stable child execution submission: replays join the same id. */
  readonly childSubmissionId: string;
  readonly waitId: string;
  readonly stateVersion: number;
  /** True when the key was already spawned (this call only rejoined it). */
  readonly replayed: boolean;
  /** The foreground wait handle; see {@link DelegationWait}. */
  readonly wait: DelegationWait;
};

/**
 * The foreground wait of a delegation. The promise resolves EXACTLY ONCE,
 * after the winning transition committed:
 * - `backgrounded` — the wait was released (T_release / auto-detach) and the
 *   caller must finish the tool call with the standard background result;
 * - `completed` — the child outcome is the final tool result (foreground
 *   consumer delivery, or the replayed prepared outcome after recovery).
 */
export type DelegationWait = {
  readonly id: string;
  readonly promise: Promise<DelegationWaitResult>;
};

export type DelegationWaitResult =
  | {
      readonly kind: 'backgrounded';
      readonly delegationId: string;
      readonly reason: string;
      readonly backgroundHandle: BackgroundHandle;
    }
  | {
      readonly kind: 'completed';
      readonly delegationId: string;
      readonly delivery: CompletionDelivery;
      readonly childRunId: string | null;
      readonly outcome: DelegationOutcome;
    };

/** Result of {@link DelegationSupervisor.detachToBackground}. */
export type DetachResult = {
  /** False when completion won the race (`already-completed`). */
  readonly released: boolean;
  readonly delegationId: string;
  /** Why the release was skipped, when `released` is false. */
  readonly reason?: 'already-completed';
  readonly operationId: string;
  readonly backgroundHandle: BackgroundHandle | null;
  readonly stateVersion: number;
  /** True when the transition was already committed (idempotent replay). */
  readonly replayed: boolean;
};

/** Result of {@link DelegationSupervisor.complete}. */
export type CompletionResult = {
  readonly delegationId: string;
  readonly childRunId: string;
  readonly delivery: CompletionDelivery;
  /** `delegation:<id>:completion:<childRunId>` for reporter delivery. */
  readonly requestId: string | null;
  /** Stable reporter submission id; every repeat returns the same one. */
  readonly submissionId: string | null;
  readonly stateVersion: number;
  /** True when the completion was already committed (idempotent replay). */
  readonly replayed: boolean;
  /**
   * Effect-fence disengagement attempted after the proven terminal fact
   * (§4); `undefined` when no fence is wired or the parent conversation is
   * unknown (fork branches).
   */
  readonly fence?: FenceDisengagement;
};

/** One node of a stop cascade. */
export type StopOutcome = {
  readonly delegationId: string;
  /** `stop-requested` — a stop-request entry was (re)played for the node. */
  readonly action: 'stop-requested' | 'skipped';
  readonly skippedBecause?: 'already-stopping' | 'terminal';
  readonly depth: number;
};

/** Result of {@link DelegationSupervisor.stop}. */
export type StopResult = {
  readonly rootDelegationId: string;
  readonly operationId: string;
  readonly outcomes: readonly StopOutcome[];
  /** True when this exact operation was already committed (replay). */
  readonly replayed: boolean;
};

/** Result of {@link DelegationSupervisor.parentAborted} for one delegation. */
export type ParentAbortOutcome = {
  readonly delegationId: string;
  readonly action: 'stop-requested' | 'skipped';
  readonly skippedBecause?: 'policy-off' | 'backgrounded' | 'completed' | 'already-stopping' | 'terminal';
};

/** Result of {@link DelegationSupervisor.parentAborted}. */
export type ParentAbortResult = {
  readonly parentConversationId: string;
  readonly parentRunId: string | null;
  readonly explicitStop: boolean;
  readonly outcomes: readonly ParentAbortOutcome[];
};

/** Result of {@link DelegationSupervisor.forkChild}. */
export type ForkResult = {
  readonly forkDelegationId: string;
  readonly fromDelegationId: string;
  readonly childConversationId: string;
  readonly supervisorTaskId: string;
  readonly queues: ChildQueues;
  readonly epochSeed: string;
  readonly forkIndex: number;
  readonly stateVersion: number;
};

/** Result of {@link DelegationSupervisor.recordChildTerminal}. */
export type ChildTerminalResult = {
  readonly delegationId: string;
  readonly terminal: 'stopped' | 'failed' | 'completed';
  readonly stateVersion: number;
  /** True when the same terminal was already committed (replay). */
  readonly replayed: boolean;
  /**
   * Effect-fence disengagement attempted after the proven terminal fact
   * (§4); `undefined` when no fence is wired or the parent conversation is
   * unknown (fork branches).
   */
  readonly fence?: FenceDisengagement;
};

/** Read-only view of a delegation record (projection or durable replay). */
export type DelegationView = DelegationRecord;

// ---------------------------------------------------------------------------
// Effect fence disengagement (steering-design-sol.md §4/§5)
// ---------------------------------------------------------------------------

/**
 * One delegation whose fence entry may be lifted: the child reached a PROVEN
 * terminal fact (never a mere stop signal — §5 "fence снимается после
 * доказанного завершения, не после отправки сигнала").
 */
export type FenceDisengageRef = {
  readonly delegationId: string;
  readonly waitId: string;
  readonly toolCallId: string | null;
};

/**
 * Request the supervisor issues on a terminal transition so the integrator's
 * permission gateway can lift the parent's effect-fence entries.
 */
export type FenceDisengageRequest = {
  readonly parentConversationId: string;
  readonly reason: 'child_completed' | 'child_stopped' | 'child_failed';
  readonly refs: readonly FenceDisengageRef[];
};

/** Advisory result of a disengage call (never rolls back the terminal). */
export type FenceDisengagement = {
  readonly status: 'disengaged' | 'failed';
  readonly error?: string;
};

/**
 * Structural surface the supervisor calls after committing a child terminal
 * fact. Implemented by the integrator's permission gateway (the engage side
 * lives in `@mavis/steering-control`'s `EffectFence.disengage`); failures are
 * reported, never thrown into the terminal transition.
 */
export interface EffectFenceDisengage {
  disengage(request: FenceDisengageRequest): Promise<FenceDisengagement>;
}

// ---------------------------------------------------------------------------
// Recovery (§3 "recovery до следующего parent generation")
// ---------------------------------------------------------------------------

/** Report of the recovery pass performed at supervisor open. */
export type RecoveryReport = {
  /**
   * How the state was restored: `document-checkpoint` — from the latest
   * committed index document by O(log) point reads (foreign history is never
   * scanned); `entry-replay` — bounded full replay, only for logs without any
   * document entry.
   */
  readonly mode: 'document-checkpoint' | 'entry-replay';
  /** Number of supervisor entries replayed (0 in checkpoint mode). */
  readonly replayedEntries: number;
  /** Revision of the rebuilt index document (0 when the log was empty). */
  readonly documentRevision: number;
  /** Wait ids re-materialized from committed foreground state. */
  readonly reMaterializedWaits: readonly string[];
  /** Delegations in `stopping` without a terminal outcome (pending work). */
  readonly stoppingWithoutTerminal: readonly string[];
  /**
   * Completed delegations whose reporter submission was missing from the log
   * (crash window between the completion commit and the reporter record in a
   * split design); recovery re-emitted them under the SAME requestId.
   */
  readonly repairedReporterSubmissions: readonly string[];
};
