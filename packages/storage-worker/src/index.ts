/**
 * Off-main-thread write batching for the durable storage backend.
 *
 * @example
 * ```ts
 * const worker = createStorageWorker(backend);
 * for (const entry of entries) await worker.enqueue(entry); // <= 1 ms each
 * const commit = await worker.flush();
 * await worker.checkpoint(); // fail-closed durability barrier
 * await worker.dispose();
 * ```
 *
 * The `sqlite-zstd` durable backend connects through
 * `sqliteZstdStorageBackend(backend)`; to move the backend handle off the
 * calling thread entirely, use `createOffThreadStorageWorker`.
 *
 * @module
 */

export { createStorageWorker, validateEntry } from './client.js';
export {
  createBatchEngine,
  DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES,
  DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES,
  DEFAULT_WINDOW_BYTES,
  DEFAULT_WINDOW_MS,
} from './engine.js';
export { createBoundedByteQueue, type BoundedByteQueue } from './queue.js';
export {
  createOffThreadStorageWorker,
  type OffThreadBackendSpec,
} from './off-thread.js';
export {
  commitFromSqliteZstd,
  entryDraftSizeBytes,
  sqliteZstdStorageBackend,
  toEntryDraft,
  SQLITE_ZSTD_BATCH_CAP_BYTES,
  SqliteZstdAdapterStateError,
  type SqliteZstdBackendLike,
  type SqliteZstdCommitLike,
  type SqliteZstdEntryDraft,
} from './sqlite-zstd-adapter.js';
export {
  BatchStuckError,
  EntryExceedsBatchCapError,
  EntryTooLargeError,
} from './errors.js';
export type {
  Commit,
  Entry,
  StorageWorker,
  StorageWorkerBackend,
  StorageWorkerOptions,
} from './contracts.js';
