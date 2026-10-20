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
 * @module
 */

export { createStorageWorker } from './client.js';
export { createBatchEngine, DEFAULT_WINDOW_BYTES, DEFAULT_WINDOW_MS } from './worker.js';
export { createBoundedByteQueue, type BoundedByteQueue } from './queue.js';
export type {
  Commit,
  Entry,
  StorageWorker,
  StorageWorkerBackend,
  StorageWorkerOptions,
} from './contracts.js';