/**
 * `@mavis/delegation-supervisor` — durable ownership of delegated children.
 *
 * Implements the supervision layer of `steering-design-sol.md` §3:
 *
 * - {@link DelegationSupervisor.spawnDelegation} — atomic T_spawn keyed by
 *   `(parentConversationId, parentRunId, toolCallId)`; replays join the
 *   existing child submission;
 * - {@link DelegationSupervisor.complete} — T_complete with exactly one
 *   delivery: the foreground consumer or the deduplicated background reporter
 *   (`requestId = delegation:<id>:completion:<childRunId>`), replay-safe
 *   across crashes;
 * - {@link DelegationSupervisor.detachToBackground} — the T_release outcome:
 *   the one irreversible foreground → backgrounded wait transition;
 * - {@link DelegationSupervisor.stop} — subtree stop cascades with
 *   operation-id deduplication;
 * - {@link DelegationSupervisor.parentAborted} — `cancelOnParentAbort`
 *   supervision that survives automatic detach (explicit Stop only, then);
 * - {@link DelegationSupervisor.forkChild} — R3 fork branches with fresh
 *   inbox/index/epoch identity and inherited receipts recorded as history.
 *
 * Persistence: every transition is ONE atomic batch of canonical
 * `mcode.delegation.*` entries plus the index document, committed through the
 * {@link DelegationLog} port; `sqliteZstdDelegationLog` adapts the
 * `sqlite-zstd` durable backend structurally (no runtime dependency).
 *
 * @example
 * ```ts
 * const supervisor = await DelegationSupervisor.open({
 *   log: sqliteZstdDelegationLog(backend),
 * });
 * const spawn = await supervisor.spawnDelegation({
 *   parentConversationId: 'conv-parent',
 *   parentRunId: 'run-1',
 *   toolCallId: 'tool-1',
 *   childSpec: { prompt: 'explore the repo' },
 * });
 * spawn.wait.promise.then((result) => {
 *   if (result.kind === 'backgrounded') finishToolCallWithBackgroundResult(result.backgroundHandle);
 *   else finishToolCallWithFinalResult(result.outcome);
 * });
 * ```
 *
 * @module
 */

export { DelegationSupervisor } from './supervisor.js';
export type {
  CompleteRequest,
  DelegationSupervisorOptions,
  DetachRequest,
  ForkRequest,
  ParentAbortedRequest,
  RecordChildTerminalRequest,
  SpawnDelegationRequest,
  StopRequest,
} from './supervisor.js';
export { sqliteZstdDelegationLog, DEFAULT_ANCHOR_READ_BYTES, DEFAULT_RECOVERY_SCAN_BYTES } from './log.js';
export type {
  DelegationLog,
  DelegationLogBackend,
  DelegationLogCommit,
  StoredSupervisorEntry,
  SupervisorEntryDraft,
} from './log.js';
export { DelegationsIndex, isSupervisorKind, cloneWorking, snapshotRecord } from './document.js';
export {
  DELEGATION_DOCUMENT_KIND,
  DELEGATION_ENTRY_KIND_PREFIX,
  KIND_BACKGROUNDED,
  KIND_CHILD_CONVERSATION,
  KIND_CHILD_TERMINAL,
  KIND_COMPLETED,
  KIND_COMPLETION_REPORT,
  KIND_FORKED,
  KIND_SPAWNED,
  KIND_STOP_REQUESTED,
  KIND_SUPERVISOR_TASK,
} from './types.js';
export {
  canonicalJson,
  childSpecDigest,
  backgroundedEntryId,
  childConversationEntryId,
  childTerminalEntryId,
  completionReportEntryId,
  completionRequestId,
  completionSubmissionId,
  completedEntryId,
  deriveForkIdentity,
  deriveSpawnIdentity,
  detachOperationId,
  documentEntryId,
  forkedEntryId,
  parentAbortOperationId,
  spawnedEntryId,
  spawnKeyString,
  stopOperationId,
  stopRequestedEntryId,
  supervisorTaskEntryId,
} from './ids.js';
export {
  DelegationAlreadyCompletedError,
  DelegationKeyConflictError,
  DelegationNotForegroundError,
  DelegationNotFoundError,
  DelegationParentMismatchError,
  DelegationRecoveryTruncatedError,
  DelegationTerminalConflictError,
  DelegationVersionConflictError,
  DelegationSupervisorError,
  SupervisorClosedError,
} from './errors.js';
export type {
  BackgroundHandle,
  ChildConversationPayload,
  ChildQueues,
  ChildSpec,
  ChildTerminalPayload,
  ChildTerminalResult,
  CompletedPayload,
  CompletionDelivery,
  CompletionReportPayload,
  CompletionResult,
  DelegationDocumentPayload,
  DelegationOutcome,
  DelegationRecord,
  DelegationView,
  DelegationWait,
  DelegationWaitResult,
  DetachResult,
  ForkedPayload,
  ForkResult,
  JsonValue,
  ParentAbortOutcome,
  ParentAbortResult,
  RecoveryReport,
  SpawnDelegationResult,
  SpawnedPayload,
  SpawnKey,
  StopInitiator,
  StopLink,
  StopOutcome,
  StopRequestedPayload,
  StopResult,
  SupervisorTaskPayload,
  SupervisionPolicy,
  WaitState,
  ChildState,
} from './types.js';
