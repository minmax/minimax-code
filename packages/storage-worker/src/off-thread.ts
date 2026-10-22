/**
 * Off-thread storage worker: THE production write path. The backend handle
 * lives on a dedicated worker thread, so the whole durable write path — batch
 * serialization, compression, the SQLite fsync — executes OFF the caller's
 * main thread. The caller only pays for the byte-bounded queue and message
 * passing. (`createStorageWorker` keeps the backend on the creating thread
 * and bridges every batch across twice — use it only when the handle cannot
 * move.)
 *
 * Difference from `createStorageWorker`: instead of a backend instance (which
 * always stays on the creating thread) this takes a backend FACTORY SPEC —
 * `{ module, exportName, args }` — that the worker thread loads and invokes
 * there. The module specifier must be loadable by the thread: a built `dist`
 * path, a plain-JS factory, or TypeScript source when the package runs on a
 * runtime with type stripping (`workerExecArgv: ['--import', 'tsx']` loads it
 * through tsx).
 *
 * The queue/window/poison contract is identical to `createStorageWorker`:
 * byte-bounded admission, 200 ms / 256 KiB windows, single-flight appends,
 * terminal quarantine instead of eternal retries. Quarantined entries are
 * additionally recorded durably: the worker drops a metadata dead-letter
 * entry (`storage-worker.dead-letter` kind) into the same backend log for
 * every quarantine event, so a crash cannot erase the fact of the quarantine
 * (the payloads stay with the caller: bounded in-memory buffer + callback).
 *
 * @example
 * ```ts
 * const worker = await createOffThreadStorageWorker({
 *   module: '@mavis/durable-backend-sqlite-zstd',
 *   exportName: 'openSqliteZstdBackend',
 *   args: [dataRoot],
 * });
 * await worker.enqueue(entry);
 * await worker.checkpoint();
 * await worker.dispose();
 * ```
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

import type { Commit, Entry, StorageWorker, StorageWorkerOptions } from './contracts.js';
import { deserializeWorkerError, serializeWorkerError, type SerializedWorkerError } from './errors.js';
import { validateEntry } from './client.js';
import { createBoundedByteQueue } from './queue.js';
import { appendBoundedQuarantine, collectTransferableBuffers, restoreTransferredBuffers } from './engine.js';
import {
  DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES,
  DEFAULT_WINDOW_BYTES,
  DEFAULT_WINDOW_MS,
} from './worker.js';

const DEFAULT_QUEUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES = 3;

/** Identifies a backend constructed ON the worker thread. */
export interface OffThreadBackendSpec {
  /** Module specifier the worker thread imports (URL, path, or package name). */
  readonly module: string;
  /** Name of the async/sync factory function the module must export. */
  readonly exportName: string;
  /** Arguments passed to the factory. */
  readonly args?: readonly unknown[];
}

type MainToWorkerMessage =
  | { type: 'entries'; entries: Entry[] }
  | { type: 'flush'; requestId: number }
  | { type: 'checkpoint'; requestId: number }
  | { type: 'dispose' };

type WorkerToMainMessage =
  | { type: 'ready' }
  | { type: 'readyError'; message: string }
  | { type: 'flushResult'; requestId: number; commit: Commit | null }
  | { type: 'flushError'; requestId: number; error: SerializedWorkerError }
  | { type: 'checkpointResult'; requestId: number }
  | { type: 'checkpointError'; requestId: number; error: SerializedWorkerError }
  | { type: 'committed'; bytes: number }
  | { type: 'terminalError'; error: SerializedWorkerError }
  | { type: 'quarantined'; entries: Entry[]; error: SerializedWorkerError }
  | { type: 'disposed' };

interface PendingFlush {
  resolve(commit: Commit | null): void;
  reject(error: unknown): void;
}

interface PendingCheckpoint {
  resolve(): void;
  reject(error: unknown): void;
}

function defaultOffThreadWorkerUrl(): URL {
  const built = new URL('off-thread.worker.js', import.meta.url);
  if (existsSync(built)) return built;
  return new URL('off-thread.worker.ts', import.meta.url);
}

/** Resolves a module specifier that is a filesystem path into a URL string. */
function normalizeModuleSpecifier(module: string): string {
  // Absolute or relative filesystem paths survive `new Worker` better as
  // file URLs: the worker's module resolution base differs from the caller's.
  if (module.startsWith('.') || module.startsWith('/')) {
    try {
      return pathToFileURL(module).href;
    } catch {
      return module;
    }
  }
  return module;
}

export async function createOffThreadStorageWorker(
  backend: OffThreadBackendSpec,
  options: StorageWorkerOptions = {},
): Promise<StorageWorker> {
  if (backend === null || typeof backend !== 'object') {
    throw new TypeError('backend must be an OffThreadBackendSpec');
  }
  if (typeof backend.module !== 'string' || backend.module.length === 0) {
    throw new TypeError('backend.module must be a non-empty module specifier');
  }
  if (typeof backend.exportName !== 'string' || backend.exportName.length === 0) {
    throw new TypeError('backend.exportName must be a non-empty export name');
  }
  const queueBytes = options.queueBytes ?? DEFAULT_QUEUE_BYTES;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
  const maxBatchUncompressedBytes =
    options.maxBatchUncompressedBytes ?? DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES;
  const maxConsecutiveFlushFailures =
    options.maxConsecutiveFlushFailures ?? DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES;

  const queue = createBoundedByteQueue(queueBytes);
  const worker = new Worker(options.workerUrl ?? defaultOffThreadWorkerUrl(), {
    workerData: {
      windowMs,
      windowBytes,
      maxConsecutiveFlushFailures,
      backend: {
        module: normalizeModuleSpecifier(backend.module),
        exportName: backend.exportName,
        args: backend.args ?? [],
      },
    },
    execArgv: options.workerExecArgv === undefined ? undefined : [...options.workerExecArgv],
  });

  let closed = false;
  /** Set BEFORE the final drain starts; admission rejects while it holds. */
  let closing = false;
  let broken: Error | null = null;
  let pumpScheduled = false;
  let nextRequestId = 0;
  const queued: Entry[] = [];
  const quarantinedEntries: Entry[] = [];
  const pendingFlushes = new Map<number, PendingFlush>();
  const pendingCheckpoints = new Map<number, PendingCheckpoint>();
  const disposedResolvers: Array<() => void> = [];

  const ready = new Promise<void>((resolve, reject) => {
    const onReady = (raw: WorkerToMainMessage): void => {
      if (raw.type === 'ready') {
        cleanup();
        resolve();
      } else if (raw.type === 'readyError') {
        cleanup();
        reject(new Error(`off-thread storage backend failed to start: ${raw.message}`));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new Error(`off-thread storage worker crashed during startup: ${error.message}`));
    };
    const onExit = (code: number): void => {
      cleanup();
      reject(new Error(`off-thread storage worker exited during startup (code ${code})`));
    };
    function cleanup(): void {
      worker.off('message', onReady);
      worker.off('error', onError);
      worker.off('exit', onExit);
    }
    worker.on('message', onReady);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });

  function failAll(error: Error): void {
    broken = error;
    for (const flush of pendingFlushes.values()) flush.reject(error);
    pendingFlushes.clear();
    for (const checkpoint of pendingCheckpoints.values()) checkpoint.reject(error);
    pendingCheckpoints.clear();
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
    // Buffer payloads transfer instead of copying (OPT-B1); on a failed post
    // they are restored before the entries go back to the queue head.
    const plan = collectTransferableBuffers(chunk);
    if (!post({ type: 'entries', entries: chunk }, plan.buffers)) {
      restoreTransferredBuffers(plan);
      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        queued.unshift(chunk[index]!);
      }
      failAll(new Error('off-thread storage worker is not accepting entries'));
    }
  }

  function post(message: MainToWorkerMessage, transferList?: ArrayBuffer[]): boolean {
    try {
      worker.postMessage(message, transferList);
      return true;
    } catch {
      return false;
    }
  }

  function flushInternal(): Promise<Commit | null> {
    if (broken) return Promise.reject(broken);
    if (closed) return Promise.reject(new Error('off-thread storage worker is disposed'));
    sendNow();
    if (broken) return Promise.reject(broken);
    const requestId = nextRequestId++;
    return new Promise<Commit | null>((resolve, reject) => {
      pendingFlushes.set(requestId, { resolve, reject });
      post({ type: 'flush', requestId });
    });
  }

  worker.on('message', (raw: WorkerToMainMessage) => {
    if (raw.type === 'flushResult' || raw.type === 'flushError') {
      const flush = pendingFlushes.get(raw.requestId);
      if (!flush) return;
      pendingFlushes.delete(raw.requestId);
      if (raw.type === 'flushResult') flush.resolve(raw.commit);
      else flush.reject(deserializeWorkerError(raw.error));
      return;
    }
    if (raw.type === 'checkpointResult' || raw.type === 'checkpointError') {
      const checkpoint = pendingCheckpoints.get(raw.requestId);
      if (!checkpoint) return;
      pendingCheckpoints.delete(raw.requestId);
      if (raw.type === 'checkpointResult') checkpoint.resolve();
      else checkpoint.reject(deserializeWorkerError(raw.error));
      return;
    }
    if (raw.type === 'committed') {
      // Mirror of client.ts's release-on-success: the off-thread host has no
      // per-batch append round trip, so the worker reports committed bytes.
      queue.release(raw.bytes);
      return;
    }
    if (raw.type === 'terminalError') {
      // The backend refused writes terminally (owner lost, generation sealed):
      // fail the whole handle closed (IC-F1-004).
      failAll(deserializeWorkerError(raw.error));
      return;
    }
    if (raw.type === 'quarantined') {
      const bytes = raw.entries.reduce((total, entry) => total + entry.bytes, 0);
      appendBoundedQuarantine(quarantinedEntries, raw.entries);
      queue.release(bytes);
      options.onQuarantined?.(raw.entries, deserializeWorkerError(raw.error));
      return;
    }
    if (raw.type === 'disposed') {
      for (const resolve of disposedResolvers.splice(0)) resolve();
    }
  });
  worker.on('error', (error: Error) => {
    failAll(new Error(`off-thread storage worker crashed: ${error.message}`));
  });
  worker.on('exit', (code: number) => {
    if (!closed) failAll(new Error(`off-thread storage worker exited unexpectedly (code ${code})`));
  });

  await ready;

  return {
    enqueue(entry: Entry): Promise<void> {
      if (broken) return Promise.reject(broken);
      // Final state first (stable "disposed" wording after teardown), then the
      // in-flight drain state (SW-02).
      if (closed) return Promise.reject(new Error('off-thread storage worker is disposed'));
      if (closing) {
        return Promise.reject(
          new Error('off-thread storage worker is disposing: the final drain is in progress'),
        );
      }
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
      if (broken) throw broken;
      if (closed) throw new Error('off-thread storage worker is disposed');
      await flushInternal();
      if (broken) throw broken;
      const requestId = nextRequestId++;
      await new Promise<void>((resolve, reject) => {
        pendingCheckpoints.set(requestId, { resolve, reject });
        post({ type: 'checkpoint', requestId });
      });
    },

    get quarantined(): readonly Entry[] {
      return quarantinedEntries;
    },

    async dispose(): Promise<void> {
      // Mark closing BEFORE the drain (SW-02): concurrent enqueues reject
      // immediately instead of slipping entries past the final flush, and the
      // drain re-checks the pump queue afterwards so an entry admitted by an
      // in-flight backpressure release is still flushed, never silently lost.
      closing = true;
      let drainError: Error | null = null;
      try {
        while ((queue.pendingBytes > 0 || queued.length > 0) && broken === null) {
          try {
            await flushInternal();
          } catch (error) {
            drainError = error instanceof Error ? error : new Error(String(error));
            break;
          }
        }
      } finally {
        closed = true;
        queue.failAll(new Error('off-thread storage worker is disposed'));
        for (const flush of pendingFlushes.values()) {
          flush.reject(new Error('off-thread storage worker is disposed'));
        }
        pendingFlushes.clear();
        for (const checkpoint of pendingCheckpoints.values()) {
          checkpoint.reject(new Error('off-thread storage worker is disposed'));
        }
        pendingCheckpoints.clear();
        // Give the thread a grace period to close its backend handle (release
        // locks, flush open batches) before the hard terminate.
        const disposedAck = new Promise<void>((resolve) => {
          disposedResolvers.push(resolve);
        });
        post({ type: 'dispose' });
        await Promise.race([disposedAck, delay(1_000)]);
        await worker.terminate();
      }
      if (drainError !== null) throw drainError;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
