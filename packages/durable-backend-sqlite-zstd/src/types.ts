/**
 * Shared contract types of the `sqlite-zstd` durable backend.
 *
 * The backend is an append-only delta log: the caller supplies entry content,
 * the backend stamps the log position (`seq`, `ordinal`) atomically with the
 * write and never rewrites a committed byte.
 */

import type { CodecName } from './codec.js';

declare const seqBrand: unique symbol;

/** Sequence value an empty (fresh) database starts at; the first commit takes 1. */
export const SEQ_AT_START = 0;

/**
 * Strictly increasing sequence of one committed batch. Every entry of a batch
 * carries its batch's sequence; gaps do not occur in this backend (each commit
 * takes `head + 1`).
 */
export type Seq = number & { readonly [seqBrand]: 'sqlite-zstd.Seq' };

declare const batchIdBrand: unique symbol;

/** Primary key of one stored batch. Invariant: `batch_id === seq`. */
export type BatchId = number & { readonly [batchIdBrand]: 'sqlite-zstd.BatchId' };

/** JSON value accepted as an entry payload; anything else is rejected before a write. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Entry content supplied before the backend stamps the log position. */
export type EntryDraft = {
	/** Stable application identity, unique across the whole database. */
	readonly id: string;
	/** Application-defined discriminator (for example a `pi.*` entry kind). */
	readonly kind: string;
	/** JSON payload stored inside the batch frame. */
	readonly payload: JsonValue;
};

/** Stored entry: draft content plus the position the backend stamped it at. */
export type Entry = EntryDraft & {
	/** Sequence of the batch (commit) that appended this entry. */
	readonly seq: Seq;
	/** Zero-based position of the entry inside its batch. */
	readonly ordinal: number;
};

/** Result of one committed batch. */
export type Commit = {
	/** Sequence assigned to this commit; every entry of the batch carries it. */
	readonly seq: Seq;
	/** Primary key of the stored batch row; always equal to `seq`. */
	readonly batchId: BatchId;
	/** Number of entries stored in the batch. */
	readonly entryCount: number;
	/** Log head after the commit; equal to `seq` for this backend. */
	readonly head: Seq;
	/** Codec that compressed the batch frame. */
	readonly codec: CodecName;
	/** Byte length of the stored payload (envelope + compressed frame). */
	readonly compressedBytes: number;
	/** Byte length of the uncompressed batch JSON; the unit of `readDelta` budgets. */
	readonly uncompressedBytes: number;
};

/** Default uncompressed batch size cap: the architecture bounds a batch at 256 KiB uncompressed. */
export const MAX_BATCH_UNCOMPRESSED_BYTES = 256 * 1024;

/** Compression codec options of a backend. */
export type SqliteZstdBackendOptions = {
	/**
	 * Preferred codec for new batches. Default: `zstd` when the runtime's
	 * `node:zlib` provides it, `gzip` otherwise. Decoding always follows the
	 * per-batch envelope, so a database stays readable across codec choices.
	 */
	readonly codec?: CodecName;
	/**
	 * Reject batches whose uncompressed JSON exceeds this many bytes.
	 * Default `MAX_BATCH_UNCOMPRESSED_BYTES`; `0` disables the cap.
	 */
	readonly maxBatchUncompressedBytes?: number;
};

/** Options of {@link SqliteZstdBackend.open}. */
export type OpenDurableBackendOptions = SqliteZstdBackendOptions & {
	/**
	 * Open this exact existing generation instead of the highest one. The
	 * generation must exist; use `openNextGeneration()` to create a new one.
	 */
	readonly generation?: number;
};
