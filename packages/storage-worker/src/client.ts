/**
 * Main-thread side of the storage worker.
 *
 * `createStorageWorker(backend)` returns a handle whose `enqueue` only writes
 * to an internal byte-bounded queue (sub-millisecond) while a worker thread
 * owns the batch-window policy. Entries are pumped to the worker thread; the
 * worker cuts them into batches (<= 200 ms / <= 256 KiB, single-flight) and
 * asks this thread to run `backend.appendBatch` — exactly one call per batch,
 * never two in flight. The backend handle itself always stays on the thread
 * that created it. (To move the backend off this thread entirely, see
 * `createOffThreadStorageWorker`.)
 *
 * Admission is terminal for entries that can never be persisted: an entry
 * whose `bytes` exceed the backend batch cap is rejected by `enqueue`
 * immediately instead of wedging the retry loop forever.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

import { EntryExceedsBatchCapError } from './errors.js';
import type {
  Commit,
  Entry,
  StorageWorker,
  StorageWorkerBackend,
  StorageWorkerOptions,
} from './contracts.js';
import { createBoundedByteQueue } from './queue.js';
import {
  DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES,
  DEFAULT_WINDOW_BYTES,
  DEFAULT_WINDOW_MS,
} from './worker.js';

const DEFAULT_QUEUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES = 3;

// Messages this thread posts to the worker: entry pump, flush requests, and
// the replies to the worker's append/checkpoint requests (the backend runs
// here).
type ClientToWorkerMessage =
  | { type: 'entries'; entries: Entry[] }
  | { type: 'flush'; requestId: number }
  | { type: 'checkpoint'; requestId: number }
  | { type: 'appendResult'; requestId: number; commit: Commit }
  | { type: 'appendError'; requestId: number; message: string; errorName?: string; errorEntryId?: unknown }
  | { type: 'checkpointResult'; requestId: number; commit: Commit | null }
  | { type: 'checkpointError'; requestId: number; message: string };

// Messages the worker posts to this thread: batch append requests, quarantine
// reports, and the replies to flush requests.
type WorkerToMainMessage =
  | { type: 'append'; requestId: number; entries: Entry[] }
  | { type: 'flushResult'; requestId: number; commit: Commit | null }
  | { type: 'flushError'; requestId: number; message: string; errorName?: string }
  | { type: 'quarantined'; entries: Entry[]; message: string; errorName?: string };

interface PendingFlush {
  resolve(commit: Commit | null): void;
  reject(error: unknown): void;
}

function defaultWorkerUrl(): URL {
  // Built layout ships worker.js next to the compiled client; running from
  // source (vitest, tsx, Node type stripping) falls back to worker.ts.
  const built = new URL('worker.js', import.meta.url);
  if (existsSync(built)) return built;
  return new URL('worker.ts', import.meta.url);
}

/** Rebuilds a terminal-class error from its protocol wire shape. */
function rehydrateError(message: string, errorName: string | undefined): Error {
  if (errorName === 'EntryTooLargeError' || errorName === 'BatchStuckError') {
    const rebuilt = new Error(message);
    rebuilt.name = errorName;
    return rebuilt;
  }
  return new Error(message);
}

/** Admission validation shared by both worker clients (main-side backends and off-thread hosts). */
export function validateEntry(entry: Entry, queueBytes: number, batchCapBytes: number): void {
  if (entry === null || typeof entry !== 'object') {
    throw new TypeError('entry must be an object');
  }
  if (typeof entry.entryId !== 'string' || entry.entryId.length === 0) {
    throw new TypeError('entry.entryId must be a non-empty string');
  }
  if (entry.parentId !== null && typeof entry.parentId !== 'string') {
    throw new TypeError('entry.parentId must be a string or null');
  }
  if (typeof entry.kind !== 'string' || entry.kind.length === 0) {
    throw new TypeError('entry.kind must be a non-empty string');
  }
  if (!Number.isFinite(entry.bytes) || entry.bytes < 0) {
    throw new TypeError(`entry.bytes must be a non-negative finite number, got ${entry.bytes}`);
  }
  if (entry.bytes > queueBytes) {
    throw new RangeError(
      `entry.bytes (${entry.bytes}) exceeds the queue ceiling (queueBytes=${queueBytes}); ` +
        'it could never be admitted',
    );
  }
  // Terminal at admission: an entry above the batch cap can never be part of
  // a committable batch, so queueing it would only wedge the retry loop.
  if (entry.bytes > batchCapBytes) {
    throw new EntryExceedsBatchCapError(entry.entryId, entry.bytes, batchCapBytes);
  }
}

export function createStorageWorker(
  backend: StorageWorkerBackend,
  options: StorageWorkerOptions = {},
): StorageWorker {
  if (typeof backend?.appendBatch !== 'function') {
    throw new TypeError('backend must provide appendBatch(entries): Promise<Commit>');
  }
  const queueBytes = options.queueBytes ?? DEFAULT_QUEUE_BYTES;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
  const maxBatchUncompressedBytes =
    options.maxBatchUncompressedBytes ?? DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES;
  const maxConsecutiveFlushFailures =
    options.maxConsecutiveFlushFailures ?? DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES;

  const queue = createBoundedByteQueue(queueBytes);
  const worker = new Worker(options.workerUrl ?? defaultWorkerUrl(), {
    workerData: { windowMs, windowBytes, maxConsecutiveFlushFailures },
    execArgv: options.workerExecArgv === undefined ? undefined : [...options.workerExecArgv],
  });

  let closed = false;
  let broken: Error | null = null;
  let pumpScheduled = false;
  let nextRequestId = 0;
  let lastCommit: Commit | null = null;
  const queued: Entry[] = [];
  const quarantinedEntries: Entry[] = [];
  const pendingFlushes = new Map<number, PendingFlush>();

  function failAll(error: Error): void {
    broken = error;
    for (const flush of pendingFlushes.values()) flush.reject(error);
    pendingFlushes.clear();
    queue.failAll(error);
  }

  function pump(): void {
    if (pumpScheduled || queued.length === 0 || broken) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      sendNow();
    });
  }

  function sendNow(): void {
    if (queued.length === 0) return;
    const chunk = queued.splice(0);
    if (!post({ type: 'entries', entries: chunk })) {
      // The entries could not be handed to the thread. Put them back at the
      // head of the queue (byte accounting still counts them as uncommitted)
      // and fail closed: flush/checkpoint reject so nobody mistakes the data
      // for durable, and it stays recoverable instead of being dropped.
      queued.unshift(...chunk);
      failAll(new Error('storage worker thread is not accepting entries'));
    }
  }

  /** Returns false when the message could not be handed to the thread. */
  function post(message: ClientToWorkerMessage): boolean {
    try {
      worker.postMessage(message);
      return true;
    } catch {
      // The thread can terminate between dispose() and an in-flight callback;
      // dropped replies there are expected, that state was already failed.
      return false;
    }
  }

  function flushInternal(): Promise<Commit | null> {
    if (broken) return Promise.reject(broken);
    if (closed) return Promise.reject(new Error('storage worker is disposed'));
    sendNow();
    if (broken) return Promise.reject(broken); // pump may have failed closed
    const requestId = nextRequestId++;
    return new Promise<Commit | null>((resolve, reject) => {
      pendingFlushes.set(requestId, { resolve, reject });
      post({ type: 'flush', requestId });
    });
  }

  worker.on('message', (raw: WorkerToMainMessage) => {
    if (raw.type === 'append') {
      const { requestId, entries } = raw;
      const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
      void Promise.resolve()
        .then(() => backend.appendBatch(entries))
        .then((commit) => {
          lastCommit = commit;
          post({ type: 'appendResult', requestId, commit });
          // Release only on success: a failed batch is retained by the worker
          // for retry, so its bytes must keep counting against the ceiling.
          queue.release(bytes);
        })
        .catch((error: unknown) => {
          post({
            type: 'appendError',
            requestId,
            message: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : undefined,
            errorEntryId: (error as { readonly entryId?: unknown } | null)?.entryId,
          });
        });
      return;
    }
    if (raw.type === 'checkpoint') {
      const { requestId } = raw;
      void Promise.resolve()
        .then(() => backend.checkpoint?.())
        .then((produced) => {
          // An empty-window flush rides on this probe; a commit it produced
          // becomes the worker's lastCommit just like a batch commit would.
          if (produced) lastCommit = produced;
          post({ type: 'checkpointResult', requestId, commit: produced ?? null });
        })
        .catch((error: unknown) => {
          post({
            type: 'checkpointError',
            requestId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    if (raw.type === 'quarantined') {
      // Dead letters leave the retry path for good: release their bytes back
      // to the admission queue so they cannot wedge backpressure forever.
      const bytes = raw.entries.reduce((total, entry) => total + entry.bytes, 0);
      quarantinedEntries.push(...raw.entries);
      queue.release(bytes);
      options.onQuarantined?.(raw.entries, rehydrateError(raw.message, raw.errorName));
      return;
    }
    // flushResult/flushError carry request ids issued by this thread;
    // appendResult/appendError carry worker-issued ids — never mixed.
    if (raw.type === 'flushResult' || raw.type === 'flushError') {
      const flush = pendingFlushes.get(raw.requestId);
      if (!flush) return;
      pendingFlushes.delete(raw.requestId);
      if (raw.type === 'flushResult') {
        if (raw.commit) lastCommit = raw.commit;
        flush.resolve(raw.commit);
      } else {
        flush.reject(rehydrateError(raw.message, raw.errorName));
      }
    }
  });

  worker.on('error', (error: Error) => {
    failAll(new Error(`storage worker thread crashed: ${error.message}`));
  });
  worker.on('exit', (code: number) => {
    if (!closed) failAll(new Error(`storage worker thread exited unexpectedly (code ${code})`));
  });

  return {
    enqueue(entry: Entry): Promise<void> {
      if (broken) return Promise.reject(broken);
      if (closed) return Promise.reject(new Error('storage worker is disposed'));
      try {
        validateEntry(entry, queueBytes, maxBatchUncompressedBytes);
      } catch (error) {
        return Promise.reject(error);
      }
      return queue.reserve(entry, (admitted) => {
        queued.push(admitted);
        pump();
      });
    },

    flush(): Promise<Commit | null> {
      return flushInternal();
    },

    async checkpoint(): Promise<void> {
      // Fail-closed barrier: everything queued must be committed first, then
      // the backend must confirm its own open-batch flush. Any failure (or a
      // dead worker thread) propagates — never report unverified durability.
      // A `null` commit means the drain took the empty-window path, which
      // already probed `backend.checkpoint` through the bridge; after a real
      // batch commit the explicit barrier call is still required here.
      const commit = await flushInternal();
      if (commit !== null && backend.checkpoint) await backend.checkpoint();
    },

    get quarantined(): readonly Entry[] {
      return quarantinedEntries;
    },

    async dispose(): Promise<void> {
      try {
        // Final drain BEFORE marking closed so the flush below is allowed to
        // run; its failure still propagates (fail-closed) after teardown.
        // Skipped when nothing is uncommitted — dispose never pokes the
        // backend with an empty batch just to produce a commit.
        if (queue.pendingBytes > 0) await flushInternal();
      } finally {
        closed = true;
        queue.failAll(new Error('storage worker is disposed'));
        for (const flush of pendingFlushes.values()) {
          flush.reject(new Error('storage worker is disposed'));
        }
        pendingFlushes.clear();
        await worker.terminate();
      }
    },
  };
}
