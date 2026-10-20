/**
 * Main-thread side of the storage worker.
 *
 * `createStorageWorker(backend)` returns a handle whose `enqueue` only writes
 * to an internal byte-bounded queue (sub-millisecond) while a worker thread
 * owns the batch-window policy. Entries are pumped to the worker thread; the
 * worker cuts them into batches (<= 200 ms / <= 256 KiB, single-flight) and
 * asks this thread to run `backend.appendBatch` — exactly one call per batch,
 * never two in flight. The backend handle itself always stays on the thread
 * that created it.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

import type {
  Commit,
  Entry,
  StorageWorker,
  StorageWorkerBackend,
  StorageWorkerOptions,
} from './contracts.js';
import { createBoundedByteQueue } from './queue.js';
import { DEFAULT_WINDOW_BYTES, DEFAULT_WINDOW_MS } from './worker.js';

const DEFAULT_QUEUE_BYTES = 8 * 1024 * 1024;

// Messages this thread posts to the worker: entry pump, flush requests, and
// the replies to the worker's append requests (the backend runs here).
type ClientToWorkerMessage =
  | { type: 'entries'; entries: Entry[] }
  | { type: 'flush'; requestId: number }
  | { type: 'appendResult'; requestId: number; commit: Commit }
  | { type: 'appendError'; requestId: number; message: string };

// Messages the worker posts to this thread: batch append requests and the
// replies to flush requests.
type WorkerToMainMessage =
  | { type: 'append'; requestId: number; entries: Entry[] }
  | { type: 'flushResult'; requestId: number; commit: Commit }
  | { type: 'flushError'; requestId: number; message: string };

interface PendingFlush {
  resolve(commit: Commit): void;
  reject(error: unknown): void;
}

function defaultWorkerUrl(): URL {
  // Built layout ships worker.js next to the compiled client; running from
  // source (vitest, tsx, Node type stripping) falls back to worker.ts.
  const built = new URL('worker.js', import.meta.url);
  if (existsSync(built)) return built;
  return new URL('worker.ts', import.meta.url);
}

function validateEntry(entry: Entry, queueBytes: number): void {
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

  const queue = createBoundedByteQueue(queueBytes);
  const worker = new Worker(options.workerUrl ?? defaultWorkerUrl(), {
    workerData: { windowMs, windowBytes },
  });

  let closed = false;
  let broken: Error | null = null;
  let pumpScheduled = false;
  let nextRequestId = 0;
  let lastCommit: Commit | null = null;
  const queued: Entry[] = [];
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

  function flushInternal(): Promise<Commit> {
    if (broken) return Promise.reject(broken);
    if (closed) return Promise.reject(new Error('storage worker is disposed'));
    sendNow();
    if (broken) return Promise.reject(broken); // pump may have failed closed
    const requestId = nextRequestId++;
    return new Promise<Commit>((resolve, reject) => {
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
          });
        });
      return;
    }
    // flushResult/flushError carry request ids issued by this thread;
    // appendResult/appendError carry worker-issued ids — never mixed.
    if (raw.type === 'flushResult' || raw.type === 'flushError') {
      const flush = pendingFlushes.get(raw.requestId);
      if (!flush) return;
      pendingFlushes.delete(raw.requestId);
      if (raw.type === 'flushResult') {
        lastCommit = raw.commit;
        flush.resolve(raw.commit);
      } else {
        flush.reject(new Error(raw.message));
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
        validateEntry(entry, queueBytes);
      } catch (error) {
        return Promise.reject(error);
      }
      return queue.reserve(entry, (admitted) => {
        queued.push(admitted);
        pump();
      });
    },

    flush(): Promise<Commit> {
      return flushInternal();
    },

    async checkpoint(): Promise<void> {
      // Fail-closed barrier: everything queued must be committed first, then
      // the backend must confirm its own open-batch flush. Any failure (or a
      // dead worker thread) propagates — never report unverified durability.
      await flushInternal();
      if (backend.checkpoint) await backend.checkpoint();
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
