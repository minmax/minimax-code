/**
 * Adapter between the storage worker's `Entry`/`Commit` contract and the
 * `sqlite-zstd` durable backend's `EntryDraft`/`Commit` surface.
 *
 * The two packages declare different (documented) shapes: the worker speaks
 * `Entry = { entryId, parentId, kind, payload, bytes }` and `Commit =
 * { batchId: string, seq, head: string }`, while the backend accepts
 * `EntryDraft = { id, parentId?, kind, payload }` and answers with a commit
 * whose `batchId`/`head` are branded numbers. This module is the single
 * shipped reconciliation point:
 *
 * - `toEntryDraft` maps an `Entry` onto a draft, preserving `parentId` inside
 *   the stored frame and computing the real serialized size;
 * - `entryDraftSizeBytes` measures a draft exactly as the backend will store
 *   it (UTF-8 `JSON.stringify`);
 * - `commitFromSqliteZstd` maps the backend commit onto the worker commit;
 * - `sqliteZstdStorageBackend` wraps a backend instance into the
 *   `StorageWorkerBackend` seam and guarantees the backend's uncompressed
 *   batch cap by SPLITTING oversized batches post-stringify (bisect, same
 *   single-flight call), instead of letting the backend reject a 257 KiB
 *   batch that the worker's byte window believed to be exactly 256 KiB.
 *
 * The wrapper is replay-safe across partial splits: entry ids it already
 * committed are skipped on retry, so a crash (or quarantine of the tail half)
 * never duplicates the committed prefix.
 *
 * Everything is structural: this module imports nothing from the backend
 * package, and the worker stays dependency-free.
 *
 * @module
 */

import { Buffer } from 'node:buffer';

import type { Commit, Entry, StorageWorkerBackend } from './contracts.js';
import { EntryTooLargeError } from './errors.js';

/** Default cap, mirroring `MAX_BATCH_UNCOMPRESSED_BYTES` of the backend. */
export const SQLITE_ZSTD_BATCH_CAP_BYTES = 256 * 1024;

/** Entry draft shape accepted by `SqliteZstdBackend.appendBatch`. */
export interface SqliteZstdEntryDraft {
	readonly id: string;
	/** Preserved inside the stored frame; the backend does not index it. */
	readonly parentId?: string | null;
	readonly kind: string;
	readonly payload: unknown;
}

/** Commit subset the adapter needs from the backend. */
export interface SqliteZstdCommitLike {
	readonly batchId: number | string;
	readonly seq: number;
	readonly head: number;
}

/** Structural surface of `SqliteZstdBackend` the adapter drives. */
export interface SqliteZstdBackendLike {
	appendBatch(drafts: readonly SqliteZstdEntryDraft[]): Promise<SqliteZstdCommitLike>;
	checkpoint?(): Promise<unknown> | unknown;
	/** The backend's own uncompressed batch cap, when it exposes it. */
	readonly maxBatchUncompressedBytes?: number;
}

export interface SqliteZstdAdapterOptions {
	/**
	 * Uncompressed batch cap the adapter enforces by splitting. Defaults to
	 * the backend instance's `maxBatchUncompressedBytes`, falling back to the
	 * backend default (256 KiB). `0` disables splitting (backend caps disabled
	 * too, matching its semantics).
	 */
	readonly maxBatchUncompressedBytes?: number;
}

/** Maps one worker entry onto the backend draft, preserving `parentId`. */
export function toEntryDraft(entry: Entry): SqliteZstdEntryDraft {
	return {
		id: entry.entryId,
		parentId: entry.parentId,
		kind: entry.kind,
		payload: entry.payload,
	};
}

/**
 * Serialized size of one draft, measured exactly as the backend stores it
 * (UTF-8 bytes of `JSON.stringify`), never the caller-declared `entry.bytes`.
 */
export function entryDraftSizeBytes(draft: SqliteZstdEntryDraft): number {
	return Buffer.byteLength(JSON.stringify(draft), 'utf8');
}

/** Maps the backend's branded numeric commit onto the worker's string commit. */
export function commitFromSqliteZstd(commit: SqliteZstdCommitLike): Commit {
	return {
		batchId: String(commit.batchId),
		seq: commit.seq,
		head: String(commit.head),
	};
}

/**
 * Wraps a `SqliteZstdBackend` (or anything structurally identical) into the
 * storage worker's backend seam. Batch appends are split, post-stringify, so
 * the backend's uncompressed cap can never reject a batch the worker already
 * accepted; a single entry that still does not fit raises
 * {@link EntryTooLargeError}, which the worker treats as poison.
 */
export function sqliteZstdStorageBackend(
	backend: SqliteZstdBackendLike,
	options: SqliteZstdAdapterOptions = {},
): StorageWorkerBackend {
	const cap = resolveCap(backend, options.maxBatchUncompressedBytes);
	// Entry ids this adapter instance already committed; makes split appends
	// idempotent under worker retries after a partial split failure.
	const committedIds = new Set<string>();

	return {
		appendBatch: async (entries: Entry[]) => {
			if (entries.length === 0) {
				// Keep the backend's empty-batch contract visible at the seam.
				throw new TypeError('batch must contain at least one entry');
			}
			const drafts = entries.map(toEntryDraft).filter((draft) => {
				// Skip ids committed by an earlier partial split: the worker retry
				// re-runs the WHOLE batch, and re-appending a committed id would
				// die on the backend's `entries.entry_id` primary key.
				return !committedIds.has(draft.id);
			});
			if (drafts.length === 0) {
				// Unreachable through the worker (a retry only re-runs a batch whose
				// previous attempt threw, and committed prefixes are tracked
				// precisely); a direct caller replaying fully-committed ids lands
				// here. Never fabricate a commit — fail loudly instead.
				throw new SqliteZstdAdapterStateError(
					`all ${entries.length} entries of the batch are already committed by this adapter`,
				);
			}
			return appendWithinUncompressedCap(backend, drafts, cap, committedIds);
		},
		checkpoint: backend.checkpoint
			? async () => {
					await backend.checkpoint();
				}
			: undefined,
	};
}

/** Raised when the adapter's replay bookkeeping is asked to do nothing. */
export class SqliteZstdAdapterStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SqliteZstdAdapterStateError';
	}
}

function resolveCap(backend: SqliteZstdBackendLike, explicit: number | undefined): number {
	if (explicit !== undefined) return explicit;
	if (backend.maxBatchUncompressedBytes !== undefined) return backend.maxBatchUncompressedBytes;
	return SQLITE_ZSTD_BATCH_CAP_BYTES;
}

/**
 * Appends drafts within the uncompressed cap, bisecting post-stringify when
 * the whole batch does not fit. Every returned commit belongs to the LAST
 * sub-batch, matching the worker's "commit of the last batch" semantics.
 *
 * Replay safety: a draft's id is recorded in `committedIds` only AFTER its
 * sub-batch committed. A failure mid-split leaves the committed prefix marked
 * and the failed suffix unmarked, so a worker retry skips exactly the prefix
 * and re-appends exactly the suffix — never the reverse (which would die on
 * the backend's entry-id primary key and mask the original error).
 */
async function appendWithinUncompressedCap(
	backend: SqliteZstdBackendLike,
	drafts: readonly SqliteZstdEntryDraft[],
	cap: number,
	committedIds: Set<string>,
): Promise<Commit> {
	if (drafts.length === 0) {
		throw new TypeError('batch must contain at least one entry');
	}
	const serializedBytes = Buffer.byteLength(JSON.stringify(drafts), 'utf8');
	if (cap <= 0 || serializedBytes <= cap) {
		const commit = commitFromSqliteZstd(await backend.appendBatch(drafts));
		for (const draft of drafts) committedIds.add(draft.id);
		return commit;
	}
	if (drafts.length === 1) {
		throw new EntryTooLargeError(drafts[0].id, serializedBytes, cap);
	}
	const midpoint = drafts.length >> 1;
	await appendWithinUncompressedCap(backend, drafts.slice(0, midpoint), cap, committedIds);
	return appendWithinUncompressedCap(backend, drafts.slice(midpoint), cap, committedIds);
}
