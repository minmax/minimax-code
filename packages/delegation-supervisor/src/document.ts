/**
 * The index-document projection: an incremental reducer over supervisor
 * entries that maintains the active delegation index (the `mcode.delegations`
 * document of the spec's canonical-records table).
 *
 * Invariants the reducer enforces:
 * - a document entry RESETS the projection to its committed content (it is a
 *   checkpoint, written in the SAME atomic batch as the transition it covers,
 *   so the reset can never lose a committed transition);
 * - transition entries apply on top; the document revision advances by
 *   exactly one per document entry;
 * - entry ids are deterministic, so an entry applied twice (crash replay into
 *   a rebuilt index) lands idempotently instead of corrupting state.
 *
 * The same {@link DelegationsIndex} instance serves the live supervisor
 * (apply after each commit) and recovery (apply over the whole log), so live
 * state and recovered state are built by one code path.
 *
 * @module
 */

import {
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
  type BackgroundHandle,
  type ChildState,
  type ChildTerminalPayload,
  type CompletedPayload,
  type DelegationDocumentPayload,
  type DelegationRecord,
  type ForkedPayload,
  type SpawnedPayload,
  type StopLink,
  type StopRequestedPayload,
  type WaitState,
} from './types.js';
import { spawnKeyString } from './ids.js';
import type { StoredSupervisorEntry, SupervisorEntryDraft } from './log.js';

/** Mutable working record during reduction (exposed as readonly records). */
export interface WorkingRecord {
  delegationId: string;
  key: DelegationRecord['key'];
  supervisorTaskId: string;
  childConversationId: string;
  childSubmissionId: string;
  waitId: string;
  parentDelegationId: string | null;
  forkedFromDelegationId: string | null;
  childDelegationIds: string[];
  forkDelegationIds: string[];
  supervision: DelegationRecord['supervision'];
  queues: DelegationRecord['queues'];
  epochSeed: string;
  inheritedReceipts: 'none' | 'history';
  childSpecDigest: string;
  waitState: WaitState;
  childState: ChildState;
  backgroundHandle: BackgroundHandle | null;
  detach: { readonly operationId: string; readonly reason: string } | null;
  completion: DelegationRecord['completion'];
  stops: StopLink[];
  parentAbortOps: string[];
  terminal: DelegationRecord['terminal'];
  stateVersion: number;
}

/** Deep-enough copy of a working record (arrays copied, nested objects shared). */
export function cloneWorking(record: WorkingRecord): WorkingRecord {
  return {
    ...record,
    key: record.key === null ? null : { ...record.key },
    childDelegationIds: [...record.childDelegationIds],
    forkDelegationIds: [...record.forkDelegationIds],
    queues: { ...record.queues },
    supervision: { ...record.supervision },
    completion: record.completion === null ? null : { ...record.completion },
    stops: record.stops.map((stop) => ({ ...stop })),
    parentAbortOps: [...record.parentAbortOps],
    terminal: record.terminal === null ? null : { ...record.terminal },
  };
}

/** Readonly snapshot of a working record for public views. */
export function snapshotRecord(record: WorkingRecord): DelegationRecord {
  return cloneWorking(record);
}

/**
 * Whether a `mcode.delegation.backgrounded` payload is the SEAM-SHAPED
 * prepared-outcome record (written by `@mavis/durable-seam`, the wait-outcome
 * authority: `{waitId, toolCallId, stateVersion, operationId, outcome,
 * outcomeHash}` — the §3 canonical content lives inside `outcome`) as opposed
 * to the supervisor's legacy shape (`{delegationId, ...}`, written before the
 * seam became the single writer). Exactly one writer commits this entry kind
 * per waitId — the seam — so the supervisor only PROJECTS it.
 */
export function isSeamShapedBackgroundedPayload(payload: Record<string, unknown>): boolean {
	return (
		typeof payload['outcome'] === 'object' &&
		payload['outcome'] !== null &&
		typeof payload['waitId'] === 'string'
	);
}

/**
 * Incremental index over supervisor entries. Feed it stored entries in commit
 * order — everything else (raw non-supervisor entries) is ignored, so callers
 * may hand over whole log windows.
 */
export class DelegationsIndex {
  private working = new Map<string, WorkingRecord>();
  private keyIndex = new Map<string, string>();
  /** waitId → delegationId, so seam-shaped transitions join the right record. */
  private waitIndex = new Map<string, string>();
  private revisionValue = 0;
  private appliedEntryCount = 0;

  /** Apply a commit-ordered sequence of entries. */
  apply(entries: readonly (StoredSupervisorEntry | SupervisorEntryDraft)[]): void {
    for (const entry of entries) {
      if (!isSupervisorKind(entry.kind)) continue;
      this.appliedEntryCount += 1;
      const payload = entry.payload as Record<string, unknown>;
      switch (entry.kind) {
        case DELEGATION_DOCUMENT_KIND: {
          this.applyDocumentCheckpoint(payload as unknown as DelegationDocumentPayload, entry.id);
          break;
        }
        case KIND_SUPERVISOR_TASK:
        case KIND_CHILD_CONVERSATION: {
          // Standalone records: their content is duplicated into the
          // delegation record at spawn/fork time (the index document must be
          // self-contained); nothing extra to index here.
          break;
        }
        case KIND_SPAWNED: {
          this.applySpawned(payload as unknown as SpawnedPayload);
          break;
        }
        case KIND_BACKGROUNDED: {
          const payloadRecord = payload as unknown as Record<string, unknown>;
          if (isSeamShapedBackgroundedPayload(payloadRecord)) {
            // The seam's committed T_release decision: the supervisor
            // PROJECTS it (one entry per waitId, written by the wait-outcome
            // authority). Waits without a supervised delegation here (the
            // seam also serves direct control waits) are ignored.
            const typed = payloadRecord as unknown as {
              waitId: string;
              outcome: {
                operationId?: string;
                reason?: string;
              };
            };
            const delegationId = this.waitIndex.get(typed.waitId);
            if (delegationId === undefined) break;
            this.patch(entry.id, delegationId, (record) => {
              record.waitState = 'backgrounded';
              record.backgroundHandle = {
                kind: 'task-background',
                supervisorTaskId: record.supervisorTaskId,
                childConversationId: record.childConversationId,
                childSubmissionId: record.childSubmissionId,
              };
              record.detach = {
                operationId: typed.outcome.operationId ?? `release:${typed.waitId}`,
                reason: typed.outcome.reason ?? 'owner_input',
              };
              record.stateVersion = record.stateVersion + 1;
            });
            break;
          }
          const typed = payload as unknown as {
            delegationId: string;
            operationId: string;
            reason: string;
            backgroundHandle: BackgroundHandle;
            stateVersion: number;
          };
          this.patch(entry.id, typed.delegationId, (record) => {
            record.waitState = 'backgrounded';
            record.backgroundHandle = typed.backgroundHandle;
            record.detach = { operationId: typed.operationId, reason: typed.reason };
            record.stateVersion = typed.stateVersion;
          });
          break;
        }
        case KIND_COMPLETED: {
          const typed = payload as unknown as CompletedPayload;
          this.patch(entry.id, typed.delegationId, (record) => {
            record.waitState = record.waitState === 'backgrounded' ? 'backgrounded' : 'completed';
            record.completion = {
              childRunId: typed.childRunId,
              outcome: typed.outcome,
              delivery: typed.delivery,
              requestId: typed.requestId ?? null,
              // The reporter record lands in the same atomic batch; only a
              // foreign/incomplete log can leave it unsettled (recovery repairs).
              reportSettled: typed.delivery !== 'reporter',
            };
            if (record.childState !== 'terminal') record.childState = 'terminal';
            record.terminal ??= {
              terminal: typed.outcome.status === 'completed' ? 'completed' : 'failed',
              reason: typed.outcome.summary ?? '',
            };
            record.stateVersion = typed.stateVersion;
          });
          break;
        }
        case KIND_COMPLETION_REPORT: {
          const requestId = (payload as { readonly requestId?: unknown }).requestId;
          if (typeof requestId !== 'string') {
            throw new Error(`${entry.id}: completion-report without a string requestId`);
          }
          for (const record of this.working.values()) {
            if (record.completion?.requestId === requestId && !record.completion.reportSettled) {
              record.completion = { ...record.completion, reportSettled: true };
            }
          }
          break;
        }
        case KIND_STOP_REQUESTED: {
          const typed = payload as unknown as StopRequestedPayload;
          this.patch(entry.id, typed.delegationId, (record) => {
            record.childState = 'stopping';
            record.stateVersion = typed.stateVersion;
            const link: StopLink = {
              operationId: typed.operationId,
              rootDelegationId: typed.rootDelegationId,
              cause: typed.cause,
            };
            const known = record.stops.some(
              (stop) => stop.operationId === link.operationId && stop.rootDelegationId === link.rootDelegationId,
            );
            if (!known) record.stops.push(link);
            // A supervision-initiated cascade rooted AT this node records its
            // operation id durably, so the next parent abort derives the NEXT
            // operation id even after a restart.
            if (
              typed.delegationId === typed.rootDelegationId &&
              typed.initiator === 'supervision' &&
              !record.parentAbortOps.includes(typed.operationId)
            ) {
              record.parentAbortOps.push(typed.operationId);
            }
          });
          break;
        }
        case KIND_CHILD_TERMINAL: {
          const typed = payload as unknown as ChildTerminalPayload;
          this.patch(entry.id, typed.delegationId, (record) => {
            record.childState = 'terminal';
            record.terminal = { terminal: typed.terminal, reason: typed.reason };
            record.stateVersion = typed.stateVersion;
          });
          break;
        }
        case KIND_FORKED: {
          this.applyForked(payload as unknown as ForkedPayload);
          break;
        }
        default:
          break; // unknown supervisor kind: forward-compatible ignore
      }
    }
  }

  /** Committed document revision seen so far (0 = no document entry yet). */
  get revision(): number {
    return this.revisionValue;
  }

  /** Number of supervisor entries applied (diagnostics/recovery report). */
  get appliedEntries(): number {
    return this.appliedEntryCount;
  }

  /** Live records (treat as readonly; snapshot via {@link snapshotRecord}). */
  records(): ReadonlyMap<string, WorkingRecord> {
    return this.working;
  }

  /** Delegation id owning a spawn key string, if indexed. */
  keyOwner(keyString: string): string | undefined {
    return this.keyIndex.get(keyString);
  }

  /**
   * Register a record recovered from the durable entries (bounded anchor
   * replay of a delegation that aged out of the document tail) into the live
   * index, so later operations observe consistent state.
   */
  adopt(record: WorkingRecord): void {
    if (this.working.has(record.delegationId)) return;
    this.working.set(record.delegationId, record);
    if (record.key !== null) this.keyIndex.set(spawnKeyString(record.key), record.delegationId);
    this.waitIndex.set(record.waitId, record.delegationId);
  }

  /** RequestIds of committed reporter deliveries whose report entry is missing. */
  unsettledReporterRequestIds(): string[] {
    const unsettled: string[] = [];
    for (const record of this.working.values()) {
      if (record.completion !== null && !record.completion.reportSettled && record.completion.requestId !== null) {
        unsettled.push(record.completion.requestId);
      }
    }
    return unsettled;
  }

  // -------------------------------------------------------------------------

  /**
   * Seed the index DIRECTLY from a committed document payload (the recovery
   * fast path): no continuity check, the payload IS the state at that
   * revision. Used to restore from the latest `mcode.delegations.document`
   * entry found by point reads, so recovery never scans foreign history.
   */
  resetFromCheckpoint(payload: DelegationDocumentPayload, entryId: string): void {
    if (payload.revision <= this.revisionValue) {
      throw new Error(`${entryId}: refusing to rewind the index from revision ${payload.revision} to ${this.revisionValue}`);
    }
    this.working = new Map();
    this.keyIndex = new Map();
    this.waitIndex = new Map();
    for (const record of payload.delegations) {
      const mutable = workingFromCommitted(record);
      this.working.set(record.delegationId, mutable);
      if (record.key !== null) this.keyIndex.set(spawnKeyString(record.key), record.delegationId);
      this.waitIndex.set(record.waitId, record.delegationId);
    }
    this.revisionValue = payload.revision;
  }

  private applyDocumentCheckpoint(payload: DelegationDocumentPayload, entryId: string): void {
    if (payload.revision !== this.revisionValue + 1) {
      throw new Error(
        `${entryId}: document revision ${payload.revision} does not follow ${this.revisionValue}; ` +
          'the supervisor log is inconsistent',
      );
    }
    this.resetFromCheckpoint(payload, entryId);
  }

  private applySpawned(payload: SpawnedPayload): void {
    if (this.working.has(payload.delegationId)) return; // idempotent replay of the same entry
    const record: WorkingRecord = {
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
    this.working.set(payload.delegationId, record);
    this.keyIndex.set(spawnKeyString(payload.key), payload.delegationId);
    this.waitIndex.set(payload.waitId, payload.delegationId);
    // Link the parent in the supervision tree (the committed document carries
    // the same link; this keeps non-document logs consistent too).
    if (payload.parentDelegationId !== null) {
      const parent = this.working.get(payload.parentDelegationId);
      if (parent !== undefined && !parent.childDelegationIds.includes(payload.delegationId)) {
        parent.childDelegationIds.push(payload.delegationId);
      }
    }
  }

  private applyForked(payload: ForkedPayload): void {
    if (this.working.has(payload.forkDelegationId)) return; // idempotent replay
    const record: WorkingRecord = {
      delegationId: payload.forkDelegationId,
      key: null, // the spawn key belongs to the original delegation
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
      // R3: inherited receipt entries are HISTORY, never pending commands; the
      // fork's own inbox/index/epoch identity starts empty.
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
    this.working.set(payload.forkDelegationId, record);
    this.waitIndex.set(payload.waitId, payload.forkDelegationId);
    const source = this.working.get(payload.fromDelegationId);
    if (source !== undefined && !source.forkDelegationIds.includes(payload.forkDelegationId)) {
      source.forkDelegationIds.push(payload.forkDelegationId);
    }
  }

  /**
   * Apply a transition patch to a live record. A transition for an unknown
   * delegation means an inconsistent log — refuse to guess rather than
   * silently dropping the transition.
   */
  private patch(entryId: string, delegationId: string, apply: (record: WorkingRecord) => void): void {
    const record = this.working.get(delegationId);
    if (record === undefined) {
      throw new Error(`${entryId}: transition for unknown delegation ${delegationId}`);
    }
    apply(record);
  }
}

/** Whether an entry kind belongs to the supervisor. */
export function isSupervisorKind(kind: string): boolean {
  return kind.startsWith(DELEGATION_ENTRY_KIND_PREFIX) || kind === DELEGATION_DOCUMENT_KIND;
}

/**
 * The transition entries that RELATE to one delegation, excluding document
 * checkpoints. This is the replay feed for a delegation that aged out of the
 * document tail: its record is rebuilt purely from its own transitions, which
 * is always possible because every transition payload names its delegation —
 * directly, or (seam-shaped T_release entries) through `waitIds`, the wait
 * identities the caller already knows belong to this delegation.
 */
export function entriesRelatingTo(
  entries: readonly (StoredSupervisorEntry | SupervisorEntryDraft)[],
  delegationId: string,
  waitIds?: ReadonlySet<string>,
): Array<StoredSupervisorEntry | SupervisorEntryDraft> {
  return entries.filter((entry) => {
    if (entry.kind === DELEGATION_DOCUMENT_KIND) return false;
    if (entry.kind === KIND_SUPERVISOR_TASK || entry.kind === KIND_CHILD_CONVERSATION) {
      return (entry.payload as Record<string, unknown>)['delegationId'] === delegationId;
    }
    const payload = entry.payload as Record<string, unknown>;
    if (
      payload['delegationId'] === delegationId ||
      payload['forkDelegationId'] === delegationId ||
      payload['fromDelegationId'] === delegationId
    ) {
      return true;
    }
    // The seam's backgrounded entry carries no delegationId — join by waitId.
    if (entry.kind === KIND_BACKGROUNDED && waitIds !== undefined && isSeamShapedBackgroundedPayload(payload)) {
      const waitId = payload['waitId'];
      return typeof waitId === 'string' && waitIds.has(waitId);
    }
    return false;
  });
}

/** Convert a committed document record back into a mutable working record. */
function workingFromCommitted(record: DelegationRecord): WorkingRecord {
  return {
    delegationId: record.delegationId,
    key: record.key === null ? null : { ...record.key },
    supervisorTaskId: record.supervisorTaskId,
    childConversationId: record.childConversationId,
    childSubmissionId: record.childSubmissionId,
    waitId: record.waitId,
    parentDelegationId: record.parentDelegationId,
    forkedFromDelegationId: record.forkedFromDelegationId,
    childDelegationIds: [...record.childDelegationIds],
    forkDelegationIds: [...record.forkDelegationIds],
    supervision: { ...record.supervision },
    queues: { ...record.queues },
    epochSeed: record.epochSeed,
    inheritedReceipts: record.inheritedReceipts,
    childSpecDigest: record.childSpecDigest,
    waitState: record.waitState,
    childState: record.childState,
    backgroundHandle: record.backgroundHandle === null ? null : { ...record.backgroundHandle },
    detach: record.detach === null ? null : { ...record.detach },
    completion: record.completion === null ? null : { ...record.completion },
    stops: record.stops.map((stop) => ({ ...stop })),
    parentAbortOps: [...record.parentAbortOps],
    terminal: record.terminal === null ? null : { ...record.terminal },
    stateVersion: record.stateVersion,
  };
}
