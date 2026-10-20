/**
 * Worker thread for the storage worker: owns the batch window policy and the
 * single-flight `appendBatch` discipline. The engine itself lives in
 * `engine.ts` (shared with `off-thread.worker.ts`, which owns the backend
 * handle instead of bridging appends back to the main thread).
 *
 * This file is loaded DIRECTLY by `node:worker_threads` (`new Worker(url)`),
 * including from TypeScript source on Node >= 22.19 where type stripping is
 * enabled by default. It therefore imports only `node:*` builtins at runtime
 * (its `./engine.ts` import is likewise builtin-only); type-only imports are
 * erased.
 *
 * Protocol (see `client.ts` for the main-thread side):
 *   main -> worker: { type: 'entries', entries: Entry[] }
 *                   { type: 'flush', requestId }
 *                   { type: 'checkpoint', requestId }
 *                   { type: 'checkpointResult', requestId, commit | null }
 *                   { type: 'checkpointError', requestId, message }
 *                   { type: 'appendResult', requestId, commit }
 *                   { type: 'appendError', requestId, message, errorName? }
 *   worker -> main: { type: 'append', requestId, entries }
 *                   { type: 'flushResult', requestId, commit | null }
 *                   { type: 'flushError', requestId, message, errorName? }
 *                   { type: 'quarantined', entries, message, errorName? }
 *
 * The backend handle always stays on the thread that created it; the worker
 * initiates each append and the main thread sees exactly one
 * `backend.appendBatch` invocation per batch. (To move the backend INTO the
 * thread, use `createOffThreadStorageWorker` instead.)
 *
 * @module
 */

import { parentPort, workerData } from 'node:worker_threads';

import type { Commit, Entry } from './contracts.js';
import { createBatchEngine, DEFAULT_WINDOW_BYTES, DEFAULT_WINDOW_MS } from './engine.ts';

// The engine is the package's public batching surface; keep it reachable from
// this module too (index.ts re-exports from here for backwards compat).
export {
  createBatchEngine,
  DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES,
  DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES,
  DEFAULT_WINDOW_BYTES,
  DEFAULT_WINDOW_MS,
} from './engine.ts';

function startWorkerThread(
  port: NonNullable<typeof parentPort>,
  options: {
    windowMs: number;
    windowBytes: number;
    maxConsecutiveFlushFailures?: number;
  },
): void {
  let nextRequestId = 0;
  const pendingAppends = new Map<
    number,
    { resolve(commit: Commit): void; reject(error: unknown): void }
  >();
  const pendingCheckpoints = new Map<
    number,
    { resolve(commit: Commit | null): void; reject(error: unknown): void }
  >();

  const engine = createBatchEngine(
    {
      windowMs: options.windowMs,
      windowBytes: options.windowBytes,
      maxConsecutiveFlushFailures: options.maxConsecutiveFlushFailures,
      checkpoint: () => {
        const requestId = nextRequestId++;
        return new Promise<Commit | null>((resolve, reject) => {
          pendingCheckpoints.set(requestId, { resolve, reject });
          port.postMessage({ type: 'checkpoint', requestId });
        });
      },
      onQuarantine: (entries, error) => {
        port.postMessage({
          type: 'quarantined',
          entries,
          message: error.message,
          errorName: error.name,
        });
      },
    },
    (entries) => {
      const requestId = nextRequestId++;
      return new Promise<Commit>((resolve, reject) => {
        pendingAppends.set(requestId, { resolve, reject });
        port.postMessage({ type: 'append', requestId, entries });
      });
    },
  );

  port.on('message', (message: {
    type: string;
    requestId?: number;
    entries?: Entry[];
    commit?: Commit | null;
    message?: string;
    errorName?: string;
    errorEntryId?: unknown;
  }) => {
    if (message.type === 'entries' && Array.isArray(message.entries)) {
      for (const entry of message.entries) engine.add(entry);
      return;
    }
    if (message.type === 'flush') {
      engine
        .flush()
        .then((commit) =>
          port.postMessage({ type: 'flushResult', requestId: message.requestId, commit }),
        )
        .catch((error: unknown) =>
          port.postMessage({
            type: 'flushError',
            requestId: message.requestId,
            message: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : undefined,
          }),
        );
      return;
    }
    if (
      (message.type === 'appendResult' || message.type === 'appendError' ||
        message.type === 'checkpointResult' || message.type === 'checkpointError') &&
      typeof message.requestId === 'number'
    ) {
      if (message.type === 'checkpointResult' || message.type === 'checkpointError') {
        const pendingCheckpoint = pendingCheckpoints.get(message.requestId);
        if (!pendingCheckpoint) return;
        pendingCheckpoints.delete(message.requestId);
        if (message.type === 'checkpointResult') pendingCheckpoint.resolve(message.commit ?? null);
        else pendingCheckpoint.reject(new Error(message.message ?? 'backend.checkpoint failed'));
        return;
      }
      const pending = pendingAppends.get(message.requestId);
      if (!pending) return;
      pendingAppends.delete(message.requestId);
      if (message.type === 'appendResult' && message.commit) pending.resolve(message.commit);
      else {
        const text = message.message ?? 'backend.appendBatch failed';
        const rebuilt = new Error(text);
        if (message.errorName === 'EntryTooLargeError' || message.errorName === 'BatchStuckError') {
          rebuilt.name = message.errorName;
        }
        if (message.errorEntryId !== undefined) {
          (rebuilt as { entryId?: unknown }).entryId = message.errorEntryId;
        }
        pending.reject(rebuilt);
      }
    }
  });
}

const port = parentPort;
if (port) {
  const data = workerData as {
    windowMs?: number;
    windowBytes?: number;
    maxConsecutiveFlushFailures?: number;
  } | undefined;
  startWorkerThread(port, {
    windowMs: data?.windowMs ?? DEFAULT_WINDOW_MS,
    windowBytes: data?.windowBytes ?? DEFAULT_WINDOW_BYTES,
    maxConsecutiveFlushFailures: data?.maxConsecutiveFlushFailures,
  });
}
