/**
 * Storage port of the durable seam.
 *
 * The seam core speaks ONLY this port — a minimal, structural projection of
 * the wave-1 pi-durable storage contract
 * (`packages/durable-backend-sqlite-zstd/src/types.ts`): atomic batch
 * appends, indexed point reads, windowed delta reads, and an authoritative
 * log head. The seam never touches SQL, never opens files, and never reaches
 * around the port; `sqlite-zstd-port.ts` adapts the real backend, and tests
 * adapt an in-memory log.
 *
 * Every `appendBatch` of a conforming port is ONE durable commit: either all
 * entries of the batch become visible at `seq` with the head advanced, or
 * none of them do (rollback), and a lost single-writer ownership fails the
 * append instead of racing the new owner.
 *
 * @module
 */

import type { JsonValue } from './types.js';

/** Entry content supplied to the port before the position is stamped. */
export type PortEntryDraft = {
	/** Deterministic entry id (see `ids.ts`); unique across the log. */
	readonly id: string;
	/** App discriminator — one of `SEAM_ENTRY_KINDS`. */
	readonly kind: string;
	/** JSON payload stored inside the batch. */
	readonly payload: JsonValue;
};

/** Stored entry: draft content plus the position the port stamped it at. */
export type PortEntry = PortEntryDraft & {
	/** Sequence of the batch (commit) that appended this entry. */
	readonly seq: number;
	/** Zero-based position of the entry inside its batch. */
	readonly ordinal: number;
};

/** Result of one committed batch. */
export type PortCommit = {
	/** Sequence assigned to this commit (the seam's `commitSeq`). */
	readonly seq: number;
	/** Log head after the commit. */
	readonly head: number;
	/** Entries stored in the batch. */
	readonly entryCount: number;
};

/** Result of a windowed delta read with an explicit verdict. */
export type PortDelta = {
	/** Intact entries of complete batches, oldest first. */
	readonly entries: readonly PortEntry[];
	/** Cursor for the next window; null when the scan ended at the log end. */
	readonly nextAfterSeq: number | null;
	/** Set when the scan stopped on a corrupt batch; null on a clean end. */
	readonly tornTail: { readonly batchId: number; readonly reason: string } | null;
};

/**
 * The storage surface the seam composes over. Implementations must uphold
 * the wave-1 contract: batch-atomic appends under single-writer fencing,
 * `entry_id`-unique point reads, and monotonic heads.
 */
export interface DurableLogPort {
	/**
	 * Commit ALL entries as ONE durable batch; resolves after the commit is
	 * durable (WAL `synchronous = FULL` in the reference adapter). Rejecting
	 * leaves the log untouched — the atomic-rollback property the seam's
	 * exactly-once guarantees rest on.
	 */
	appendBatch(entries: readonly PortEntryDraft[]): Promise<PortCommit>;
	/** Point read by entry id through the log index; `undefined` if absent. */
	getEntry(entryId: string): PortEntry | undefined;
	/**
	 * Entries of batches with `seq > afterSeq`, oldest first, within a byte
	 * budget; reports a torn tail explicitly instead of confusing it with the
	 * end of the log.
	 */
	readDeltaChecked(afterSeq: number, limitBytes: number): PortDelta;
	/** Last committed sequence; `0` for an empty log. */
	head(): number;
	/**
	 * Uncompressed byte cap of ONE batch the port can durably commit, or
	 * `null` when the port does not bound batches. The seam uses it to derive
	 * the explicit admission budget for owner inputs (backpressure BEFORE a
	 * durable attempt instead of an opaque batch-cap failure at commit time).
	 */
	maxBatchBytes?(): number | null;
}
