/**
 * The delegation supervisor: durable ownership of delegated children
 * (steering-design-sol.md §3 — T_spawn, T_release, T_complete, stop cascade,
 * cancelOnParentAbort supervision, R3 fork compatibility).
 *
 * Ownership model. A `task` tool call does not own the child it starts: the
 * child conversation belongs to a stable supervisor task placed at the native
 * background ownership boundary. The foreground call holds only a WAIT handle.
 * That keeps the two orthogonal state machines of §3 independent:
 *
 * ```
 * wait:  foreground --T_release--> backgrounded   (irreversible per waitId)
 *                     \-T_complete--> completed
 * child: running --> stopping --> terminal
 * ```
 *
 * Atomicity. Every transition commits as ONE atomic batch on the delta log
 * (transition entries + the updated index document). Entry ids and operation
 * ids are deterministic (see `ids.ts`), so a replayed operation recomputes the
 * ids it already committed and rejoins the recorded outcome instead of
 * creating a second executor / second completion / second stop request. The
 * document-update closures of every transition MUST mirror the entry appliers
 * of `document.ts` — the committed document checkpoint resets the projection,
 * so a closure that under-reports would erase the transition on apply.
 *
 * Delivery. `complete` chooses exactly one consumer: the foreground waiter
 * (the tool result) OR the deduplicated background reporter whose requestId is
 * `delegation:<id>:completion:<childRunId>`. The reporter's submission id is
 * derived from that requestId, so a crash + repeat returns the SAME submission
 * (§3 T_complete: the repeat of the native submit returns the same submission).
 *
 * Supervision. `cancelOnParentAbort` is stored ON the delegation, so it keeps
 * acting after an automatic detach: while the wait is foreground any parent
 * abort stops the child; after the wait is backgrounded only an EXPLICIT
 * parent Stop does (§3 "Владение", §5 "Abort после принятия ввода").
 *
 * All mutating operations are serialized through one in-process queue (the
 * single durable-writer discipline); every committed entry applies through the
 * same reducer recovery uses, so live state and recovered state cannot diverge.
 *
 * @module
 */

import {
  backgroundedEntryId,
  childConversationEntryId,
  childSpecDigest,
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
import {
  DEFAULT_ANCHOR_READ_BYTES,
  DEFAULT_RECOVERY_SCAN_BYTES,
  type DelegationLog,
  type DelegationLogCommit,
  type StoredSupervisorEntry,
  type SupervisorEntryDraft,
} from './log.js';
import {
  DelegationsIndex,
  cloneWorking,
  entriesRelatingTo,
  isSupervisorKind,
  snapshotRecord,
  type WorkingRecord,
} from './document.js';
import {
  DelegationAlreadyCompletedError,
  DelegationKeyConflictError,
  DelegationNotForegroundError,
  DelegationNotFoundError,
  DelegationParentMismatchError,
  DelegationRecoveryTruncatedError,
  DelegationTerminalConflictError,
  DelegationVersionConflictError,
  SupervisorClosedError,
} from './errors.js';
import {
  DELEGATION_DOCUMENT_KIND,
  KIND_BACKGROUNDED,
  KIND_CHILD_CONVERSATION,
  KIND_CHILD_TERMINAL,
  KIND_COMPLETED,
  KIND_COMPLETION_REPORT,
  KIND_FORKED,
  KIND_SPAWNED,
  KIND_STOP_REQUESTED,
  KIND_SUPERVISOR_TASK,
  type BackgroundHandle,
  type ChildConversationPayload,
  type ChildSpec,
  type ChildTerminalResult,
  type CompletedPayload,
  type CompletionReportPayload,
  type CompletionResult,
  type DelegationDocumentPayload,
  type DelegationOutcome,
  type DelegationView,
  type DelegationWait,
  type DelegationWaitResult,
  type DetachResult,
  type ForkedPayload,
  type ForkResult,
  type JsonValue,
  type ParentAbortOutcome,
  type ParentAbortResult,
  type RecoveryReport,
  type SpawnDelegationResult,
  type SpawnedPayload,
  type SpawnKey,
  type StopInitiator,
  type StopOutcome,
  type StopRequestedPayload,
  type StopResult,
  type SupervisorTaskPayload,
} from './types.js';

/** Options of {@link DelegationSupervisor.open}. */
export interface DelegationSupervisorOptions {
  /** The persistence port (see `log.ts`). */
  readonly log: DelegationLog;
  /** Recovery full-scan budget, uncompressed bytes. Default 64 MiB. */
  readonly recoveryScanBytes?: number;
  /** Bounded anchor-read budget of the `getDelegation` fallback. Default 4 MiB. */
  readonly anchorReadBytes?: number;
  /**
   * How many TERMINAL delegations the index document keeps for cheap replay
   * reads; older terminals remain readable from the entries. Default 64.
   */
  readonly maxTerminalRecords?: number;
}

/** Request of {@link DelegationSupervisor.spawnDelegation}. */
export interface SpawnDelegationRequest {
  readonly parentConversationId: string;
  readonly parentRunId: string;
  readonly toolCallId: string;
  /** Description of the child; replay with a different spec conflicts. */
  readonly childSpec: ChildSpec;
}

/** Request of {@link DelegationSupervisor.detachToBackground}. */
export interface DetachRequest {
  readonly delegationId: string;
  /** Why the wait is released (owner input, timer, manual background). */
  readonly reason: string;
  /** Replay identity of the release operation; derived when omitted. */
  readonly operationId?: string;
  /** Optimistic guard against a stale coordinator. */
  readonly expectedStateVersion?: number;
}

/** Request of {@link DelegationSupervisor.complete}. */
export interface CompleteRequest {
  readonly delegationId: string;
  /** Child run that produced the outcome; part of the result identity. */
  readonly childRunId: string;
  readonly outcome: DelegationOutcome;
  /** Optimistic guard against a stale supervisor task. */
  readonly expectedStateVersion?: number;
}

/** Request of {@link DelegationSupervisor.stop}. */
export interface StopRequest {
  /** Root of the subtree to stop (the node itself included). */
  readonly rootDelegationId: string;
  readonly cause?: string;
  readonly initiator?: StopInitiator;
  /** Replay identity of the cascade; derived from the root when omitted. */
  readonly operationId?: string;
  readonly expectedStateVersion?: number;
}

/** Request of {@link DelegationSupervisor.parentAborted}. */
export interface ParentAbortedRequest {
  readonly parentConversationId: string;
  /** Limit the abort to one parent run; omit for the whole conversation. */
  readonly parentRunId?: string;
  /**
   * True for an EXPLICIT user Stop (cascades even over automatically detached
   * children); false for a run failure/abort without a committed release.
   */
  readonly explicitStop: boolean;
}

/** Request of {@link DelegationSupervisor.forkChild}. */
export interface ForkRequest {
  /** Delegation whose child conversation is forked (R3). */
  readonly delegationId: string;
  readonly reason?: string;
}

/** Request of {@link DelegationSupervisor.recordChildTerminal}. */
export interface RecordChildTerminalRequest {
  readonly delegationId: string;
  readonly terminal: 'stopped' | 'failed' | 'completed';
  readonly reason: string;
}

/** Deferred foreground waiter registered for one waitId. */
interface Waiter {
  readonly waitId: string;
  readonly delegationId: string;
  readonly promise: Promise<DelegationWaitResult>;
  resolve(result: DelegationWaitResult): void;
  reject(error: unknown): void;
  isSettled(): boolean;
}

/**
 * Durable owner of delegated child conversations. Open with
 * {@link DelegationSupervisor.open} — opening performs recovery.
 */
export class DelegationSupervisor {
  private readonly log: DelegationLog;
  private readonly recoveryScanBytes: number;
  private readonly anchorReadBytes: number;
  private readonly maxTerminalRecords: number;

  private readonly index = new DelegationsIndex();
  private readonly waiters = new Map<string, Waiter>();
  private queueTail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private lastSupervisorEntryId: string | null = null;

  private recoveryReportValue: RecoveryReport = {
    mode: 'entry-replay',
    replayedEntries: 0,
    documentRevision: 0,
    reMaterializedWaits: [],
    stoppingWithoutTerminal: [],
    repairedReporterSubmissions: [],
  };

  private constructor(log: DelegationLog, options: DelegationSupervisorOptions) {
    this.log = log;
    this.recoveryScanBytes = options.recoveryScanBytes ?? DEFAULT_RECOVERY_SCAN_BYTES;
    this.anchorReadBytes = options.anchorReadBytes ?? DEFAULT_ANCHOR_READ_BYTES;
    this.maxTerminalRecords = options.maxTerminalRecords ?? 64;
  }

  /**
   * Open the supervisor over a log: replay every supervisor entry, rebuild the
   * index document, re-materialize foreground waits, and repair committed
   * reporter completions whose submission record is missing (§3 recovery
   * checklist). Recovery work is proportional to supervisor entries.
   */
  static async open(options: DelegationSupervisorOptions): Promise<DelegationSupervisor> {
    const supervisor = new DelegationSupervisor(options.log, options);
    await supervisor.enqueue(() => supervisor.recover());
    return supervisor;
  }

  /** The recovery report of the opening pass. */
  get recovery(): RecoveryReport {
    return this.recoveryReportValue;
  }

  /** Current committed revision of the index document (live, not open-time). */
  get documentRevision(): number {
    return this.index.revision;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Records of delegations whose child is still running or stopping. */
  listActive(): DelegationView[] {
    const active: DelegationView[] = [];
    for (const record of this.index.records().values()) {
      if (record.childState !== 'terminal') active.push(snapshotRecord(record));
    }
    return active;
  }

  /** All indexed records (active plus the bounded terminal tail). */
  listIndexed(): DelegationView[] {
    return [...this.index.records().values()].map((record) => snapshotRecord(record));
  }

  /**
   * One delegation: from the live index, or (bounded) replayed from the
   * durable entries when it aged out of the index tail.
   */
  async getDelegation(delegationId: string): Promise<DelegationView | undefined> {
    const live = this.index.records().get(delegationId);
    if (live !== undefined) return snapshotRecord(live);
    const record = this.replaySingle(delegationId);
    return record === undefined ? undefined : snapshotRecord(record);
  }

  /** The (re-materializable) foreground wait registered under a waitId. */
  getWait(waitId: string): DelegationWait | undefined {
    const waiter = this.waiters.get(waitId);
    return waiter === undefined ? undefined : { id: waiter.waitId, promise: waiter.promise };
  }

  // ---------------------------------------------------------------------------
  // T_spawn
  // ---------------------------------------------------------------------------

  /**
   * Atomically spawn a delegation: supervisor task (native background
   * ownership boundary) + child conversation + delegation record + foreground
   * wait, one commit (§3 T_spawn). A replay under the same
   * `(parentConversationId, parentRunId, toolCallId)` key joins the existing
   * child submission and returns the same ids — never a second executor. A
   * replay with a different child spec conflicts.
   */
  async spawnDelegation(request: SpawnDelegationRequest): Promise<SpawnDelegationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const key: SpawnKey = {
        parentConversationId: request.parentConversationId,
        parentRunId: request.parentRunId,
        toolCallId: request.toolCallId,
      };
      const identity = deriveSpawnIdentity(key);
      const digest = childSpecDigest(request.childSpec);

      const existingId = this.index.keyOwner(spawnKeyString(key));
      let existing = existingId !== undefined ? this.requireRecord(existingId, 'spawn replay') : undefined;
      if (existing === undefined) {
        // Durable replay: the deterministic spawn entry can exist even when the
        // record aged out of the bounded terminal tail (§3 T_spawn — the
        // replay MUST join the prior child submission unconditionally).
        if (this.log.getEntry(spawnedEntryId(identity.delegationId)) !== undefined) {
          existing = this.replaySingle(identity.delegationId);
        }
      }
      if (existing !== undefined) {
        if (existing.childSpecDigest !== digest) {
          throw new DelegationKeyConflictError(spawnKeyString(key));
        }
        return {
          delegationId: existing.delegationId,
          supervisorTaskId: existing.supervisorTaskId,
          childConversationId: existing.childConversationId,
          childSubmissionId: existing.childSubmissionId,
          waitId: existing.waitId,
          stateVersion: existing.stateVersion,
          replayed: true,
          wait: this.materializeWait(existing),
        } satisfies SpawnDelegationResult;
      }

      // Validate the supervision-tree link before any write.
      const parentDelegationId = request.childSpec.parentDelegationId ?? null;
      if (parentDelegationId !== null) {
        const parent = this.index.records().get(parentDelegationId);
        if (parent === undefined || parent.childConversationId !== key.parentConversationId) {
          throw new DelegationParentMismatchError(parentDelegationId, key.parentConversationId);
        }
      }

      const supervision = {
        cancelOnParentAbort: request.childSpec.supervision?.cancelOnParentAbort ?? true,
      } as const;

      const spawnedPayload: SpawnedPayload = {
        delegationId: identity.delegationId,
        key,
        supervisorTaskId: identity.supervisorTaskId,
        childConversationId: identity.childConversationId,
        childSubmissionId: identity.childSubmissionId,
        waitId: identity.waitId,
        queues: identity.queues,
        epochSeed: identity.epochSeed,
        supervision,
        parentDelegationId,
        stateVersion: 1,
        childSpecDigest: digest,
      };
      const supervisorTaskPayload: SupervisorTaskPayload = {
        supervisorTaskId: identity.supervisorTaskId,
        delegationId: identity.delegationId,
        ownershipBoundary: 'native-background',
      };
      const childConversationPayload: ChildConversationPayload = {
        childConversationId: identity.childConversationId,
        delegationId: identity.delegationId,
        supervisorTaskId: identity.supervisorTaskId,
        queueForkPolicy: 'initial',
        queues: identity.queues,
        epochSeed: identity.epochSeed,
        inheritedReceipts: 'none',
      };

      // Mirror of the reducer's KIND_SPAWNED applier, over a clone, for the
      // committed document checkpoint (see the module docblock).
      const drafts = this.withDocumentUpdate(
        [
          { id: supervisorTaskEntryId(identity.supervisorTaskId), kind: KIND_SUPERVISOR_TASK, payload: supervisorTaskPayload },
          { id: childConversationEntryId(identity.childConversationId), kind: KIND_CHILD_CONVERSATION, payload: childConversationPayload },
          { id: spawnedEntryId(identity.delegationId), kind: KIND_SPAWNED, payload: spawnedPayload },
        ],
        (records) => {
          const record: WorkingRecord = workingFromSpawned(spawnedPayload);
          records.set(record.delegationId, record);
          if (parentDelegationId !== null) {
            const parent = records.get(parentDelegationId);
            if (parent !== undefined && !parent.childDelegationIds.includes(record.delegationId)) {
              parent.childDelegationIds.push(record.delegationId);
            }
          }
        },
      );

      await this.commitTransition(drafts);
      const record = this.requireRecord(identity.delegationId, 'spawn');
      return {
        delegationId: record.delegationId,
        supervisorTaskId: record.supervisorTaskId,
        childConversationId: record.childConversationId,
        childSubmissionId: record.childSubmissionId,
        waitId: record.waitId,
        stateVersion: record.stateVersion,
        replayed: false,
        wait: this.materializeWait(record),
      } satisfies SpawnDelegationResult;
    });
  }

  // ---------------------------------------------------------------------------
  // T_release (the supervisor side of the foreground release / auto-detach)
  // ---------------------------------------------------------------------------

  /**
   * Release the foreground wait: one irreversible transition per waitId, one
   * committed background outcome (§3 T_release). The waiter resolves with the
   * background handle AFTER the commit; the native tool-finalizer turns it
   * into the standard background tool result. A replay of the same operation
   * returns the recorded outcome; a completion that already won the race is
   * reported as `released: false` ("already-completed") — a release can never
   * overwrite a chosen outcome.
   */
  async detachToBackground(request: DetachRequest): Promise<DetachResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const record = this.requireRecord(request.delegationId, 'detach');
      this.assertVersion(record, request.expectedStateVersion);
      const operationId = request.operationId ?? detachOperationId(request.delegationId);

      if (record.waitState === 'backgrounded') {
        if (record.detach?.operationId === operationId) {
          return {
            released: true,
            delegationId: record.delegationId,
            operationId,
            backgroundHandle: record.backgroundHandle,
            stateVersion: record.stateVersion,
            replayed: true,
          } satisfies DetachResult;
        }
        throw new DelegationNotForegroundError(record.delegationId, record.waitState, operationId);
      }
      if (record.waitState === 'completed') {
        return {
          released: false,
          delegationId: record.delegationId,
          reason: 'already-completed' as const,
          operationId,
          backgroundHandle: null,
          stateVersion: record.stateVersion,
          replayed: false,
        } satisfies DetachResult;
      }
      if (record.waitState === 'none') {
        throw new DelegationNotForegroundError(record.delegationId, record.waitState, operationId);
      }

      const backgroundHandle: BackgroundHandle = {
        kind: 'task-background',
        supervisorTaskId: record.supervisorTaskId,
        childConversationId: record.childConversationId,
        childSubmissionId: record.childSubmissionId,
      };
      const stateVersion = record.stateVersion + 1;
      const drafts = this.withDocumentUpdate(
        [
          {
            id: backgroundedEntryId(record.delegationId),
            kind: KIND_BACKGROUNDED,
            payload: {
              delegationId: record.delegationId,
              waitId: record.waitId,
              operationId,
              reason: request.reason,
              backgroundHandle,
              stateVersion,
            },
          },
        ],
        (records) => {
          const next = cloneWorking(records.get(record.delegationId)!);
          next.waitState = 'backgrounded';
          next.backgroundHandle = backgroundHandle;
          next.detach = { operationId, reason: request.reason };
          next.stateVersion = stateVersion;
          records.set(next.delegationId, next);
        },
      );
      await this.commitTransition(drafts);

      this.waiters.get(record.waitId)?.resolve({
        kind: 'backgrounded',
        delegationId: record.delegationId,
        reason: request.reason,
        backgroundHandle,
      });

      return {
        released: true,
        delegationId: record.delegationId,
        operationId,
        backgroundHandle,
        stateVersion,
        replayed: false,
      } satisfies DetachResult;
    });
  }

  // ---------------------------------------------------------------------------
  // T_complete
  // ---------------------------------------------------------------------------

  /**
   * Commit the child outcome and the delivery decision (§3 T_complete): the
   * foreground consumer when the wait is still foreground, otherwise the
   * deduplicated reporter with the stable requestId
   * `delegation:<id>:completion:<childRunId>`. Repeating the same completion
   * (also after a crash + recovery) returns the SAME delivery and submission;
   * a completion under a different childRunId is refused — it is new work
   * (task_append), not a duplicate of the first completion.
   */
  async complete(request: CompleteRequest): Promise<CompletionResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const record = this.requireRecord(request.delegationId, 'complete');
      this.assertVersion(record, request.expectedStateVersion);

      if (record.completion !== null) {
        if (record.completion.childRunId === request.childRunId) {
          return {
            delegationId: record.delegationId,
            childRunId: record.completion.childRunId,
            delivery: record.completion.delivery,
            requestId: record.completion.requestId,
            submissionId:
              record.completion.requestId === null ? null : completionSubmissionId(record.completion.requestId),
            stateVersion: record.stateVersion,
            replayed: true,
          } satisfies CompletionResult;
        }
        throw new DelegationAlreadyCompletedError(record.delegationId, record.completion.childRunId, request.childRunId);
      }

      const delivery = record.waitState === 'foreground' ? ('foreground' as const) : ('reporter' as const);
      const requestId = delivery === 'reporter' ? completionRequestId(record.delegationId, request.childRunId) : null;
      const submissionId = requestId === null ? null : completionSubmissionId(requestId);
      const stateVersion = record.stateVersion + 1;

      const completedPayload: CompletedPayload = {
        delegationId: record.delegationId,
        childRunId: request.childRunId,
        outcome: request.outcome,
        delivery,
        requestId,
        stateVersion,
      };
      const drafts: SupervisorEntryDraft[] = [
        {
          id: completedEntryId(record.delegationId, request.childRunId),
          kind: KIND_COMPLETED,
          payload: completedPayload,
        },
      ];
      if (delivery === 'reporter' && requestId !== null && submissionId !== null) {
        // The reporter submission record commits in the SAME atomic batch, so
        // the deduplicated delivery cannot lose its durable identity.
        const reportPayload: CompletionReportPayload = {
          requestId,
          submissionId,
          delegationId: record.delegationId,
          childRunId: request.childRunId,
          outcome: request.outcome,
        };
        drafts.push({ id: completionReportEntryId(requestId), kind: KIND_COMPLETION_REPORT, payload: reportPayload });
      }
      const allDrafts = this.withDocumentUpdate(drafts, (records) => {
        const next = cloneWorking(records.get(record.delegationId)!);
        next.waitState = next.waitState === 'backgrounded' ? 'backgrounded' : 'completed';
        next.completion = {
          childRunId: request.childRunId,
          outcome: request.outcome,
          delivery,
          requestId,
          // The reporter submission record commits in the SAME atomic batch,
          // so the committed document already counts it as settled.
          reportSettled: true,
        };
        if (next.childState !== 'terminal') next.childState = 'terminal';
        next.terminal ??= {
          terminal: request.outcome.status === 'completed' ? 'completed' : 'failed',
          reason: request.outcome.summary ?? '',
        };
        next.stateVersion = stateVersion;
        records.set(next.delegationId, next);
      });
      await this.commitTransition(allDrafts);

      if (delivery === 'foreground') {
        this.waiters.get(record.waitId)?.resolve({
          kind: 'completed',
          delegationId: record.delegationId,
          delivery: 'foreground',
          childRunId: request.childRunId,
          outcome: request.outcome,
        });
      }

      return {
        delegationId: record.delegationId,
        childRunId: request.childRunId,
        delivery,
        requestId,
        submissionId,
        stateVersion,
        replayed: false,
      } satisfies CompletionResult;
    });
  }

  // ---------------------------------------------------------------------------
  // Stop cascade
  // ---------------------------------------------------------------------------

  /**
   * Stop a delegation and its whole subtree: one stop-request entry per node,
   * one shared operationId, deduplicated by operation id AND by child state —
   * a node already stopping/terminal is never re-requested, and a replay of
   * the same operation commits nothing (§4 "Вложенность", §5 "Stop
   * одновременно с detach/completion").
   */
  async stop(request: StopRequest): Promise<StopResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const root = this.requireRecord(request.rootDelegationId, 'stop');
      this.assertVersion(root, request.expectedStateVersion);
      const cause = request.cause ?? 'user';
      const initiator = request.initiator ?? 'owner';
      const operationId =
        request.operationId ??
        stopOperationId(
          root.delegationId,
          root.stops.filter((stop) => stop.rootDelegationId === root.delegationId).length,
        );
      const replayCandidate = root.stops.some(
        (stop) => stop.operationId === operationId && stop.rootDelegationId === root.delegationId,
      );

      const cascade = this.buildStopCascade({
        rootDelegationId: root.delegationId,
        operationId,
        cause,
        initiator,
      });
      if (cascade.requestedAny) {
        await this.commitTransition(this.withDocumentUpdate(cascade.drafts, cascade.mutateRecords));
      }
      return {
        rootDelegationId: root.delegationId,
        operationId,
        outcomes: cascade.outcomes,
        replayed: !cascade.requestedAny && replayCandidate,
      } satisfies StopResult;
    });
  }

  /**
   * Parent-side abort/stop applied through the stored supervision links
   * (`cancelOnParentAbort`). With `explicitStop: false` (a run failed or was
   * aborted without a committed release) only children whose wait is STILL
   * foreground are stopped; backgrounded children keep running. An explicit
   * parent Stop cascades over detached children too — the supervision link
   * survives the automatic detach (§3 "Владение", §5 edge table).
   */
  async parentAborted(request: ParentAbortedRequest): Promise<ParentAbortResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const outcomes: ParentAbortOutcome[] = [];
      const targets = [...this.index.records().values()].filter((record) => {
        if (record.key === null) return false;
        if (record.key.parentConversationId !== request.parentConversationId) return false;
        return request.parentRunId === undefined || record.key.parentRunId === request.parentRunId;
      });
      // Deterministic order for stable reports and stable derived operation ids.
      targets.sort((left, right) => compareStrings(left.delegationId, right.delegationId));

      const drafts: SupervisorEntryDraft[] = [];
      const mutations: Array<(records: Map<string, WorkingRecord>) => void> = [];
      for (const target of targets) {
        if (target.childState === 'terminal') {
          outcomes.push({ delegationId: target.delegationId, action: 'skipped', skippedBecause: 'terminal' });
          continue;
        }
        if (!target.supervision.cancelOnParentAbort) {
          outcomes.push({ delegationId: target.delegationId, action: 'skipped', skippedBecause: 'policy-off' });
          continue;
        }
        if (!request.explicitStop && target.waitState !== 'foreground') {
          outcomes.push({
            delegationId: target.delegationId,
            action: 'skipped',
            skippedBecause: target.waitState === 'completed' ? 'completed' : 'backgrounded',
          });
          continue;
        }
        const operationId = parentAbortOperationId(target.delegationId, target.parentAbortOps.length);
        const cascade = this.buildStopCascade({
          rootDelegationId: target.delegationId,
          operationId,
          cause: request.explicitStop ? 'parent-stop' : 'parent-abort',
          initiator: 'supervision',
        });
        drafts.push(...cascade.drafts);
        mutations.push(cascade.mutateRecords);
        // Parent-abort outcomes are reported without the cascade depth (the
        // coordinator addresses delegations, not tree positions).
        outcomes.push(
          ...cascade.outcomes.map((outcome): ParentAbortOutcome => {
            if (outcome.action === 'stop-requested') return { delegationId: outcome.delegationId, action: 'stop-requested' };
            return {
              delegationId: outcome.delegationId,
              action: 'skipped',
              skippedBecause: outcome.skippedBecause ?? 'already-stopping',
            };
          }),
        );
        // The cascade's mirroring mutation records the supervision-rooted
        // operation id on the root (parentAbortOps), matching the reducer's
        // KIND_STOP_REQUESTED applier, so the committed document checkpoint
        // carries it and the NEXT abort derives the NEXT operation id.
      }

      if (drafts.length > 0) {
        await this.commitTransition(
          this.withDocumentUpdate(drafts, (records) => {
            for (const mutate of mutations) mutate(records);
          }),
        );
      }
      return {
        parentConversationId: request.parentConversationId,
        parentRunId: request.parentRunId ?? null,
        explicitStop: request.explicitStop,
        outcomes,
      } satisfies ParentAbortResult;
    });
  }

  // ---------------------------------------------------------------------------
  // Child lifecycle observation
  // ---------------------------------------------------------------------------

  /**
   * Record the observed terminal outcome of a supervised child
   * (`stopping --> terminal`). Idempotent for the same outcome; a
   * contradicting outcome conflicts. The foreground wait of a terminal child
   * resolves with the terminal outcome as its final foreground delivery.
   */
  async recordChildTerminal(request: RecordChildTerminalRequest): Promise<ChildTerminalResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const record = this.requireRecord(request.delegationId, 'recordChildTerminal');
      if (record.terminal !== null) {
        if (record.terminal.terminal === request.terminal) {
          return {
            delegationId: record.delegationId,
            terminal: request.terminal,
            stateVersion: record.stateVersion,
            replayed: true,
          } satisfies ChildTerminalResult;
        }
        throw new DelegationTerminalConflictError(record.delegationId, record.terminal.terminal, request.terminal);
      }
      if (record.completion !== null && completionStatusOf(record.completion.outcome) !== request.terminal) {
        throw new DelegationTerminalConflictError(
          record.delegationId,
          completionStatusOf(record.completion.outcome),
          request.terminal,
        );
      }

      const stateVersion = record.stateVersion + 1;
      const drafts = this.withDocumentUpdate(
        [
          {
            id: childTerminalEntryId(record.delegationId),
            kind: KIND_CHILD_TERMINAL,
            payload: {
              delegationId: record.delegationId,
              terminal: request.terminal,
              reason: request.reason,
              stateVersion,
            },
          },
        ],
        (records) => {
          const next = cloneWorking(records.get(record.delegationId)!);
          next.childState = 'terminal';
          next.terminal = { terminal: request.terminal, reason: request.reason };
          next.stateVersion = stateVersion;
          records.set(next.delegationId, next);
        },
      );
      await this.commitTransition(drafts);

      this.waiters.get(record.waitId)?.resolve({
        kind: 'completed',
        delegationId: record.delegationId,
        delivery: 'foreground',
        childRunId: record.completion?.childRunId ?? null,
        outcome: {
          status: request.terminal === 'completed' ? 'completed' : 'failed',
          summary: request.reason,
        },
      });

      return {
        delegationId: record.delegationId,
        terminal: request.terminal,
        stateVersion,
        replayed: false,
      } satisfies ChildTerminalResult;
    });
  }

  // ---------------------------------------------------------------------------
  // R3 fork compatibility
  // ---------------------------------------------------------------------------

  /**
   * Fork a delegation's child conversation (R3): the fork branch gets its OWN
   * conversation, inbox, delivery index, delegation index, and epoch seed —
   * inherited receipt entries are recorded as HISTORY, never as pending
   * commands (§5 "R3 fork и /rewind"). The source delegation is unchanged.
   */
  async forkChild(request: ForkRequest): Promise<ForkResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const source = this.requireRecord(request.delegationId, 'fork');
      const forkIndex = source.forkDelegationIds.length;
      const identity = deriveForkIdentity(source.delegationId, forkIndex);
      const payload: ForkedPayload = {
        forkDelegationId: identity.forkDelegationId,
        fromDelegationId: source.delegationId,
        childConversationId: identity.childConversationId,
        supervisorTaskId: identity.supervisorTaskId,
        childSubmissionId: `childsub-${identity.forkDelegationId}`,
        waitId: `wait-${identity.forkDelegationId}`,
        queues: identity.queues,
        epochSeed: identity.epochSeed,
        supervision: { ...source.supervision },
        parentDelegationId: source.parentDelegationId,
        forkIndex,
        childSpecDigest: source.childSpecDigest,
        stateVersion: 1,
      };
      const supervisorTaskPayload: SupervisorTaskPayload = {
        supervisorTaskId: identity.supervisorTaskId,
        delegationId: identity.forkDelegationId,
        ownershipBoundary: 'native-background',
      };
      const childConversationPayload: ChildConversationPayload = {
        childConversationId: identity.childConversationId,
        delegationId: identity.forkDelegationId,
        supervisorTaskId: identity.supervisorTaskId,
        queueForkPolicy: 'initial',
        queues: identity.queues,
        epochSeed: identity.epochSeed,
        inheritedReceipts: 'history',
      };
      const drafts = this.withDocumentUpdate(
        [
          { id: supervisorTaskEntryId(identity.supervisorTaskId), kind: KIND_SUPERVISOR_TASK, payload: supervisorTaskPayload },
          { id: childConversationEntryId(identity.childConversationId), kind: KIND_CHILD_CONVERSATION, payload: childConversationPayload },
          { id: forkedEntryId(identity.forkDelegationId), kind: KIND_FORKED, payload },
        ],
        (records) => {
          const record: WorkingRecord = {
            delegationId: payload.forkDelegationId,
            key: null,
            supervisorTaskId: payload.supervisorTaskId,
            childConversationId: payload.childConversationId,
            childSubmissionId: payload.childSubmissionId,
            waitId: payload.waitId,
            parentDelegationId: payload.parentDelegationId,
            forkedFromDelegationId: payload.fromDelegationId,
            childDelegationIds: [],
            forkDelegationIds: [],
            supervision: { ...payload.supervision },
            queues: { ...payload.queues },
            epochSeed: payload.epochSeed,
            inheritedReceipts: 'history',
            childSpecDigest: payload.childSpecDigest,
            waitState: 'none',
            childState: 'running',
            backgroundHandle: null,
            detach: null,
            completion: null,
            stops: [],
            parentAbortOps: [],
            terminal: null,
            stateVersion: payload.stateVersion,
          };
          records.set(record.delegationId, record);
          const nextSource = cloneWorking(records.get(source.delegationId)!);
          if (!nextSource.forkDelegationIds.includes(record.delegationId)) {
            nextSource.forkDelegationIds.push(record.delegationId);
          }
          records.set(nextSource.delegationId, nextSource);
        },
      );
      await this.commitTransition(drafts);
      return {
        forkDelegationId: payload.forkDelegationId,
        fromDelegationId: payload.fromDelegationId,
        childConversationId: payload.childConversationId,
        supervisorTaskId: payload.supervisorTaskId,
        queues: payload.queues,
        epochSeed: payload.epochSeed,
        forkIndex,
        stateVersion: payload.stateVersion,
      } satisfies ForkResult;
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Close the supervisor: reject every pending foreground wait (callers must
   * not hang) and stop accepting transitions. The LOG is owned by the caller
   * and stays open.
   */
  async dispose(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.values()) {
      if (!waiter.isSettled()) waiter.reject(new SupervisorClosedError());
    }
    this.waiters.clear();
    await this.queueTail;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Recovery pass (runs once inside the open serialization). */
  private async recover(): Promise<void> {
    // Fast path: the latest index document IS the committed state (every
    // transition batch ends with its document entry), so recovery restores
    // from ONE point-read payload plus O(log revisions) probe reads — never a
    // scan of foreign history (§3: work proportional to active objects).
    const revision = this.findLatestDocumentRevision();
    let mode: RecoveryReport['mode'];
    let replayedEntries = 0;
    if (revision > 0) {
      const document = this.log.getEntry(documentEntryId(revision));
      if (document === undefined || document.kind !== DELEGATION_DOCUMENT_KIND) {
        // Deterministic id found by the probes cannot disappear; a wrong kind
        // means the log was written by something else entirely.
        throw new DelegationRecoveryTruncatedError(`document revision ${revision} is missing or has a foreign kind`);
      }
      this.index.resetFromCheckpoint(document.payload as DelegationDocumentPayload, document.id);
      this.lastSupervisorEntryId = document.id;
      mode = 'document-checkpoint';
    } else {
      // Fallback for logs without any document entry (the supervisor never
      // committed here, or a hand-crafted fixture): bounded full replay. A
      // foreign-heavy log can still exhaust the budget in this mode — loud
      // failure beats silently missing supervisor entries.
      const all = await this.log.readAll(this.recoveryScanBytes);
      const supervisorEntries = all.filter((entry) => isSupervisorKind(entry.kind));
      this.index.apply(supervisorEntries);
      const last = supervisorEntries[supervisorEntries.length - 1];
      if (last !== undefined) this.lastSupervisorEntryId = last.id;
      replayedEntries = supervisorEntries.length;
      mode = 'entry-replay';
    }

    // §3 recovery checklist: completion without reporter settlement is repaired
    // under the SAME requestId (the durable dedup key), so the repeat of the
    // native submit keeps returning the same submission. A report entry that
    // is already durable is never re-emitted (its id would collide).
    const repairDrafts: SupervisorEntryDraft[] = [];
    const repaired: string[] = [];
    for (const requestId of this.index.unsettledReporterRequestIds()) {
      if (this.log.getEntry(completionReportEntryId(requestId)) !== undefined) continue;
      const record = [...this.index.records().values()].find(
        (candidate) => candidate.completion?.requestId === requestId,
      );
      if (record === undefined || record.completion === null || record.completion.requestId !== requestId) continue;
      repairDrafts.push({
        id: completionReportEntryId(requestId),
        kind: KIND_COMPLETION_REPORT,
        payload: {
          requestId,
          submissionId: completionSubmissionId(requestId),
          delegationId: record.delegationId,
          childRunId: record.completion.childRunId,
          outcome: record.completion.outcome,
        } satisfies CompletionReportPayload,
      });
      repaired.push(requestId);
    }
    if (repairDrafts.length > 0) {
      await this.commitTransition(
        this.withDocumentUpdate(repairDrafts, (records) => {
          for (const record of records.values()) {
            if (
              record.completion !== null &&
              !record.completion.reportSettled &&
              record.completion.requestId !== null &&
              repaired.includes(record.completion.requestId)
            ) {
              record.completion = { ...record.completion, reportSettled: true };
            }
          }
        }),
      );
    }

    // Re-materialize waits from committed state: FOREGROUND waits become live
    // pending waiters; decided states (backgrounded/completed/none) are not
    // pre-materialized — a late handle request materializes them on demand
    // with the recorded outcome, so no never-resolving waiters accumulate.
    const reMaterialized: string[] = [];
    const stopping: string[] = [];
    for (const record of [...this.index.records().values()].sort((left, right) =>
      compareStrings(left.delegationId, right.delegationId),
    )) {
      if (record.childState === 'stopping') stopping.push(record.delegationId);
      if (record.waitState === 'foreground') {
        this.materializeWait(record);
        reMaterialized.push(record.waitId);
      }
    }

    this.recoveryReportValue = {
      mode,
      replayedEntries,
      documentRevision: this.index.revision,
      reMaterializedWaits: reMaterialized,
      stoppingWithoutTerminal: stopping,
      repairedReporterSubmissions: repaired,
    };
  }

  /**
   * The latest committed document revision, found by POINT READS only:
   * exponential probing over the deterministic entry id
   * `mcode.delegations.document:<revision>` followed by a binary search.
   * O(log revisions) single-batch decodes — foreign history is never scanned.
   * Returns 0 when no document entry exists at all.
   */
  private findLatestDocumentRevision(): number {
    if (this.log.getEntry(documentEntryId(1)) === undefined) return 0;
    let known = 1;
    let probe = 2;
    while (this.log.getEntry(documentEntryId(probe)) !== undefined) {
      known = probe;
      probe *= 2;
      if (!Number.isSafeInteger(probe)) break; // paranoia; unreachable in practice
    }
    let absent = probe;
    while (absent - known > 1) {
      const mid = known + Math.floor((absent - known) / 2);
      if (this.log.getEntry(documentEntryId(mid)) !== undefined) known = mid;
      else absent = mid;
    }
    return known;
  }

  /**
   * Build the stop-cascade drafts, outcomes, and the MIRRORING document
   * mutation for one operation rooted at `rootDelegationId`. The cascade
   * visits every node of the subtree exactly once (visited set), skips nodes
   * already stopping/terminal or already covered by this operation id, and
   * produces one stop-request entry per requested node.
   */
  private buildStopCascade(input: {
    rootDelegationId: string;
    operationId: string;
    cause: string;
    initiator: StopInitiator;
  }): {
    drafts: SupervisorEntryDraft[];
    outcomes: StopOutcome[];
    requestedAny: boolean;
    mutateRecords: (records: Map<string, WorkingRecord>) => void;
  } {
    const drafts: SupervisorEntryDraft[] = [];
    const outcomes: StopOutcome[] = [];
    const visited = new Set<string>();
    const frontier: Array<{ readonly id: string; readonly depth: number }> = [{ id: input.rootDelegationId, depth: 0 }];
    while (frontier.length > 0) {
      const next = frontier.shift();
      if (next === undefined) break;
      if (visited.has(next.id)) continue;
      // A frontier id missing from the index (an evicted child still listed by
      // its parent) gets one bounded durable-recovery attempt before the walk
      // gives up on it.
      let record = this.index.records().get(next.id);
      if (record === undefined) record = this.replaySingle(next.id);
      if (record === undefined) continue;
      visited.add(next.id);
      for (const childId of record.childDelegationIds) frontier.push({ id: childId, depth: next.depth + 1 });

      if (record.childState !== 'running' || record.stops.some((stop) => stop.operationId === input.operationId)) {
        outcomes.push({
          delegationId: record.delegationId,
          action: 'skipped',
          skippedBecause: record.childState === 'terminal' ? 'terminal' : 'already-stopping',
          depth: next.depth,
        });
        continue;
      }
      const stateVersion = record.stateVersion + 1;
      const payload: StopRequestedPayload = {
        delegationId: record.delegationId,
        rootDelegationId: input.rootDelegationId,
        operationId: input.operationId,
        cause: input.cause,
        initiator: input.initiator,
        depth: next.depth,
        stateVersion,
      };
      drafts.push({
        id: stopRequestedEntryId(record.delegationId, input.operationId),
        kind: KIND_STOP_REQUESTED,
        payload,
      });
      outcomes.push({ delegationId: record.delegationId, action: 'stop-requested', depth: next.depth });
    }

    // Mirror of the reducer's KIND_STOP_REQUESTED applier for the committed
    // document checkpoint (see the module docblock).
    const mutations = new Map<
      string,
      { stateVersion: number; operationId: string; rootDelegationId: string; cause: string; isRoot: boolean; isSupervision: boolean }
    >();
    for (const draft of drafts) {
      const payload = draft.payload as StopRequestedPayload;
      mutations.set(payload.delegationId, {
        stateVersion: payload.stateVersion,
        operationId: payload.operationId,
        rootDelegationId: payload.rootDelegationId,
        cause: payload.cause,
        isRoot: payload.delegationId === payload.rootDelegationId,
        isSupervision: payload.initiator === 'supervision',
      });
    }
    const mutateRecords = (records: Map<string, WorkingRecord>): void => {
      for (const [delegationId, mutation] of mutations) {
        const current = records.get(delegationId);
        if (current === undefined) continue;
        const next = cloneWorking(current);
        next.childState = 'stopping';
        next.stateVersion = mutation.stateVersion;
        if (!next.stops.some((stop) => stop.operationId === mutation.operationId)) {
          next.stops.push({
            operationId: mutation.operationId,
            rootDelegationId: mutation.rootDelegationId,
            cause: mutation.cause,
          });
        }
        if (mutation.isRoot && mutation.isSupervision && !next.parentAbortOps.includes(mutation.operationId)) {
          next.parentAbortOps.push(mutation.operationId);
        }
        records.set(delegationId, next);
      }
    };
    return { drafts, outcomes, requestedAny: drafts.length > 0, mutateRecords };
  }

  /**
   * Compose a transition batch: `transitionDrafts` plus the index-document
   * entry covering the SAME revision of the records. `mutate` receives a CLONE
   * of the live record map to derive the committed document content; the live
   * index is only updated AFTER the commit succeeds (by re-applying the
   * committed entries through the reducer), so a failed commit leaves no
   * in-memory residue.
   */
  private withDocumentUpdate(
    transitionDrafts: SupervisorEntryDraft[],
    mutate: (records: Map<string, WorkingRecord>) => void,
  ): SupervisorEntryDraft[] {
    const cloned = new Map<string, WorkingRecord>();
    for (const [id, record] of this.index.records()) cloned.set(id, cloneWorking(record));
    mutate(cloned);
    // Bound the terminal tail: durable entries remain the truth for evicted
    // terminals (readable via the bounded anchor replay).
    const terminal = [...cloned.values()].filter((record) => record.childState === 'terminal');
    if (terminal.length > this.maxTerminalRecords) {
      const evict = terminal
        .slice(0, terminal.length - this.maxTerminalRecords)
        .map((record) => record.delegationId);
      for (const id of evict) cloned.delete(id);
    }
    const revision = this.index.revision + 1;
    const documentPayload: DelegationDocumentPayload = {
      revision,
      delegations: [...cloned.values()]
        .map((record) => snapshotRecord(record))
        .sort((left, right) => compareStrings(left.delegationId, right.delegationId)),
    };
    return [...transitionDrafts, { id: documentEntryId(revision), kind: DELEGATION_DOCUMENT_KIND, payload: documentPayload }];
  }

  private async commitTransition(drafts: SupervisorEntryDraft[]): Promise<DelegationLogCommit> {
    const chained = drafts.map((draft, position) => ({
      id: draft.id,
      kind: draft.kind,
      payload: draft.payload,
      parentId: position === 0 ? this.lastSupervisorEntryId : (drafts[position - 1]?.id ?? null),
    }));
    const commit = await this.log.commitAtomic(chained);
    this.lastSupervisorEntryId = chained[chained.length - 1]?.id ?? this.lastSupervisorEntryId;
    // Apply the committed entries through the SAME reducer recovery uses, so
    // the live index is provably the replay of the log.
    this.index.apply(
      chained.map((draft): StoredSupervisorEntry => ({ id: draft.id, kind: draft.kind, payload: draft.payload, seq: commit.seq })),
    );
    return commit;
  }

  private requireRecord(delegationId: string, operation: string): WorkingRecord {
    const record = this.index.records().get(delegationId);
    if (record !== undefined) return record;
    const recovered = this.replaySingle(delegationId);
    if (recovered !== undefined) return recovered;
    throw new DelegationNotFoundError(delegationId);
  }

  /**
   * Bounded anchor replay for a delegation that aged out of the document
   * tail: read from its own spawn/fork entry forward, keep ONLY the entries
   * relating to this delegation (document checkpoints may legitimately not
   * contain it anymore), rebuild through a scratch index, and adopt the
   * result into the live index.
   *
   * Tree repair: a child link lives in the CHILD's spawned payload, which the
   * relating-filter excludes — so the adopted record is re-linked by
   * re-discovering `parentDelegationId` references from the same window and
   * recursively replaying those children. Without this, a re-adopted parent
   * would look childless and stop cascades would silently skip the subtree.
   */
  private replaySingle(delegationId: string): WorkingRecord | undefined {
    const anchorId = this.log.getEntry(spawnedEntryId(delegationId))
      ? spawnedEntryId(delegationId)
      : this.log.getEntry(forkedEntryId(delegationId))
        ? forkedEntryId(delegationId)
        : null;
    if (anchorId === null) return undefined;
    const window = this.log.readFrom(anchorId, this.anchorReadBytes, { inclusive: true });
    const scratch = new DelegationsIndex();
    scratch.apply(entriesRelatingTo(window, delegationId));
    const record = scratch.records().get(delegationId);
    if (record === undefined) return undefined;
    this.index.adopt(record);

    // Discover tree children: their spawned entries name this delegation as
    // parentDelegationId. Recursion terminates — each id is adopted into the
    // index at most once.
    const childIds = window
      .filter((entry) => entry.kind === KIND_SPAWNED)
      .map((entry) => entry.payload as SpawnedPayload)
      .filter((payload) => payload.parentDelegationId === delegationId)
      .map((payload) => payload.delegationId);
    for (const childId of childIds) {
      if (childId !== delegationId && !this.index.records().has(childId)) this.replaySingle(childId);
    }
    const merged = new Set([...record.childDelegationIds, ...childIds]);
    merged.delete(delegationId);
    record.childDelegationIds = [...merged];
    return record;
  }

  private assertVersion(record: WorkingRecord, expected: number | undefined): void {
    if (expected !== undefined && expected !== record.stateVersion) {
      throw new DelegationVersionConflictError(record.delegationId, expected, record.stateVersion);
    }
  }

  /**
   * The wait handle of a record: the live pending waiter when one exists, a
   * fresh pending one for a still-foreground wait, or an immediately-resolved
   * waiter carrying the recorded outcome (replay of a prepared outcome).
   */
  private materializeWait(record: WorkingRecord): DelegationWait {
    const existing = this.waiters.get(record.waitId);
    if (existing !== undefined) return { id: existing.waitId, promise: existing.promise };
    const waiter = createWaiter(record.waitId, record.delegationId);
    this.waiters.set(record.waitId, waiter);
    const recorded = recordedWaitResult(record);
    if (recorded !== null) waiter.resolve(recorded);
    return { id: waiter.waitId, promise: waiter.promise };
  }

  /** Serialized execution: one durable-writer queue for every transition. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(operation, operation);
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertOpen(): void {
    if (this.closed) throw new SupervisorClosedError();
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function createWaiter(waitId: string, delegationId: string): Waiter {
  let settleResolve!: (result: DelegationWaitResult) => void;
  let settleReject!: (error: unknown) => void;
  const promise = new Promise<DelegationWaitResult>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });
  // A caller that detaches (stops awaiting) before resolution must not turn a
  // deliberate rejection into an unhandled-rejection noise.
  promise.catch(() => {});
  let settled = false;
  return {
    waitId,
    delegationId,
    promise,
    resolve(result) {
      if (settled) return;
      settled = true;
      settleResolve(result);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      settleReject(error);
    },
    isSettled: () => settled,
  };
}

/**
 * The committed outcome a re-materialized wait resolves with immediately:
 * a backgrounded wait replays its handle, a completed/terminal one replays
 * its delivery. A still-foreground wait without any decision stays pending.
 */
function recordedWaitResult(record: WorkingRecord): DelegationWaitResult | null {
  if (record.completion !== null) {
    return {
      kind: 'completed',
      delegationId: record.delegationId,
      delivery: record.completion.delivery,
      childRunId: record.completion.childRunId,
      outcome: record.completion.outcome,
    };
  }
  if (record.waitState === 'backgrounded' && record.backgroundHandle !== null && record.detach !== null) {
    return {
      kind: 'backgrounded',
      delegationId: record.delegationId,
      reason: record.detach.reason,
      backgroundHandle: record.backgroundHandle,
    };
  }
  if (record.terminal !== null) {
    return {
      kind: 'completed',
      delegationId: record.delegationId,
      delivery: 'foreground',
      childRunId: null,
      outcome: {
        status: record.terminal.terminal === 'completed' ? 'completed' : 'failed',
        summary: record.terminal.reason,
      },
    };
  }
  return null;
}

function workingFromSpawned(payload: SpawnedPayload): WorkingRecord {
  return {
    delegationId: payload.delegationId,
    key: { ...payload.key },
    supervisorTaskId: payload.supervisorTaskId,
    childConversationId: payload.childConversationId,
    childSubmissionId: payload.childSubmissionId,
    waitId: payload.waitId,
    parentDelegationId: payload.parentDelegationId,
    forkedFromDelegationId: null,
    childDelegationIds: [],
    forkDelegationIds: [],
    supervision: { ...payload.supervision },
    queues: { ...payload.queues },
    epochSeed: payload.epochSeed,
    inheritedReceipts: 'none',
    childSpecDigest: payload.childSpecDigest,
    waitState: 'foreground',
    childState: 'running',
    backgroundHandle: null,
    detach: null,
    completion: null,
    stops: [],
    parentAbortOps: [],
    terminal: null,
    stateVersion: payload.stateVersion,
  };
}

function completionStatusOf(outcome: DelegationOutcome): 'stopped' | 'failed' | 'completed' {
  return outcome.status === 'completed' ? 'completed' : 'failed';
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
