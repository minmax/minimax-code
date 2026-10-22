/**
 * Persistence port of the delegation supervisor plus its sqlite-zstd adapter.
 *
 * The supervisor needs MULTI-ENTRY ATOMIC commits (a transition = supervisor
 * task record + child conversation record + delegation record + document, one
 * durable unit — §3 T_spawn). The storage worker's per-entry enqueue cannot
 * promise that, so the supervisor drives the delta log directly through this
 * narrow port and the sqlite-zstd backend's `appendBatch` provides the
 * all-or-nothing commit (batch row + index rows + head + resume capsule in one
 * transaction, `synchronous = FULL`).
 *
 * The port is STRUCTURAL (like `storage-worker`'s backend seam): this package
 * imports nothing from the backend package at runtime; `SqliteZstdBackend`
 * satisfies {@link DelegationLogBackend} as-is.
 *
 * @module
 */

import type { JsonValue } from './types.js';
import { DelegationRecoveryTruncatedError } from './errors.js';

/** One supervisor entry handed to the log. */
export interface SupervisorEntryDraft {
  /** Deterministic entry id (see `ids.ts`); unique across the database. */
  readonly id: string;
  readonly kind: string;
  readonly payload: JsonValue;
  /** Predecessor entry id inside the supervisor's entry chain. */
  readonly parentId?: string | null;
}

/** One stored entry read back from the log. */
export interface StoredSupervisorEntry {
  readonly id: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly seq: number;
}

/** Commit mark of one atomic transition. */
export interface DelegationLogCommit {
  readonly seq: number;
  readonly head: number;
}

/** Structural surface of a delta-log backend the supervisor drives. */
export interface DelegationLogBackend {
  /**
   * Commit ALL drafts as ONE durable unit. Never invoked with an empty array.
   * A duplicate entry id (a logic bug — replays are pre-checked) must reject
   * instead of silently skipping, so a half-applied transition is impossible
   * to miss.
   */
  appendBatch(
    drafts: readonly { readonly id: string; readonly parentId?: string | null; readonly kind: string; readonly payload: JsonValue }[],
  ): Promise<{ readonly seq: number; readonly head: number }>;
  /** Current log head (last committed sequence; 0 when empty). */
  readonly head: number;
  /**
   * Point read of one entry by id; `undefined` when never committed. Used for
   * the bounded `getDelegation` fallback (anchor at the spawn entry).
   */
  getEntry(entryId: string): { readonly id: string; readonly kind: string; readonly payload: JsonValue; readonly seq: number } | undefined;
  /**
   * Entries committed strictly after `afterSeq`, oldest first, within an
   * uncompressed byte budget, PLUS a completeness verdict: `tornTail` (a
   * corrupt batch stopped the scan) or a `nextAfterSeq` short of the head
   * means the log was NOT fully served.
   */
  readDeltaChecked(
    afterSeq: number,
    limitBytes: number,
  ): {
    readonly entries: readonly { readonly id: string; readonly kind: string; readonly payload: JsonValue; readonly seq: number }[];
    readonly nextAfterSeq: number | null;
    readonly tornTail: { readonly batchId: number; readonly reason: string } | null;
  };
  /**
   * Windowed read anchored at an entry id: from the anchor's BATCH (inclusive
   * by default) forward within a byte budget. The anchor must exist.
   */
  readDeltaFrom(
    entryId: string,
    limitBytes: number,
    options?: { readonly inclusive?: boolean },
  ): readonly { readonly id: string; readonly kind: string; readonly payload: JsonValue; readonly seq: number }[];
}

/** Persistence surface of the supervisor. */
export interface DelegationLog {
  /** Atomically commit one transition (never empty). */
  commitAtomic(drafts: readonly SupervisorEntryDraft[]): Promise<DelegationLogCommit>;
  /** Last committed sequence; 0 when empty. */
  head(): number;
  /** Point read by entry id (`undefined` when never committed). */
  getEntry(entryId: string): StoredSupervisorEntry | undefined;
  /**
   * The COMPLETE sequence of stored entries, oldest first. Rejects with
   * `DelegationRecoveryTruncatedError` when the budget, a torn tail, or a
   * concurrent writer prevented a full read — recovery must never silently
   * replay a prefix.
   */
  readAll(limitBytes: number): Promise<readonly StoredSupervisorEntry[]>;
  /**
   * Entries from the BATCH of `entryId` (inclusive by default) forward,
   * bounded by `limitBytes`; the bounded anchor read behind
   * `getDelegation`'s durable fallback.
   */
  readFrom(entryId: string, limitBytes: number, options?: { readonly inclusive?: boolean }): readonly StoredSupervisorEntry[];
}

/** Default recovery scan budget: 64 MiB of uncompressed supervisor entries. */
export const DEFAULT_RECOVERY_SCAN_BYTES = 64 * 1024 * 1024;

/** Default bounded anchor-read budget for `getDelegation` fallbacks. */
export const DEFAULT_ANCHOR_READ_BYTES = 4 * 1024 * 1024;

/**
 * Wraps a `SqliteZstdBackend` (structurally) into the {@link DelegationLog}
 * port. The backend's `appendBatch` IS the atomic multi-entry commit; its
 * entry-id primary key is the durable dedup layer under the supervisor's
 * deterministic entry ids.
 */
export function sqliteZstdDelegationLog(backend: DelegationLogBackend): DelegationLog {
  return {
    async commitAtomic(drafts) {
      if (drafts.length === 0) throw new TypeError('commitAtomic requires at least one entry');
      const commit = await backend.appendBatch(
        drafts.map((draft) => ({ id: draft.id, parentId: draft.parentId ?? null, kind: draft.kind, payload: draft.payload })),
      );
      return { seq: commit.seq, head: commit.head };
    },
    head(): number {
      return backend.head;
    },
    getEntry(entryId: string): StoredSupervisorEntry | undefined {
      return backend.getEntry(entryId);
    },
    async readAll(limitBytes: number): Promise<readonly StoredSupervisorEntry[]> {
      if (backend.head === 0) return [];
      const result = backend.readDeltaChecked(0, limitBytes);
      if (result.tornTail !== null) {
        throw new DelegationRecoveryTruncatedError(
          `batch ${result.tornTail.batchId} is corrupt (${result.tornTail.reason}); the log tail was not served`,
        );
      }
      // The scan must have reached the head: a short read means the budget cut
      // the log in the middle, and replaying that prefix would understate the
      // durable state.
      if (result.nextAfterSeq === null || result.nextAfterSeq < backend.head) {
        throw new DelegationRecoveryTruncatedError(
          `scan cursor ${String(result.nextAfterSeq)} is short of the log head ${backend.head}; raise the recovery budget`,
        );
      }
      return result.entries;
    },
    readFrom(entryId, limitBytes, options) {
      // The backend is batch-granular; `inclusive` (default) keeps the anchor's
      // batch so the anchor entry itself is always served.
      return backend.readDeltaFrom(entryId, limitBytes, options);
    },
  };
}
