/**
 * Worker thread for the storage worker: owns the batch window policy and the
 * single-flight `appendBatch` discipline. The engine itself lives in
 * `engine.ts` (shared with `off-thread.worker.ts`, which owns the backend
 * handle instead of bridging appends back to the main thread).
 *
 * This file is loaded DIRECTLY by `node:worker_threads` (`new Worker(url)`),
 * including from TypeScript source on Node >= 22.19 where type stripping is
 * enabled by default. It therefore imports only `node:*` builtins at runtime
 * (its `./engine.ts` and `./errors.ts` imports are likewise builtin-only);
 * type-only imports are erased.
 *
 * This thread is NOT the production default: `createOffThreadStorageWorker`
 * (whose worker body owns the backend handle) is — the append bridge here
 * drags every batch across the thread boundary twice and serializes it on the
 * main thread. It remains for hosts that must keep the backend handle on the
 * creating thread (backends bound to main-thread resources, tests).
 *
 * Protocol (see `client.ts` for the main-thread side):
 *   main -> worker: { type: 'entries', entries: Entry[] }
 *                   { type: 'flush', requestId }
 *                   { type: 'checkpoint', requestId }
 *                   { type: 'checkpointResult', requestId, commit | null }
 *                   { type: 'checkpointError', requestId, error }
 *                   { type: 'appendResult', requestId, commit }
 *                   { type: 'appendError', requestId, error }
 *   worker -> main: { type: 'append', requestId, entries }
 *                   { type: 'flushResult', requestId, commit | null }
 *                   { type: 'flushError', requestId, error }
 *                   { type: 'terminalError', error }
 *                   { type: 'quarantined', entries, error }
 *
 * Errors cross as `SerializedWorkerError` shapes and are rebuilt through
 * `deserializeWorkerError`, so terminal backend refusals
 * (`OwnerLostError`, `SealedGenerationError`) and `BatchStuckError.cause`
 * keep their classification across the bridge (IC-F1-004).
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
import {
	collectTransferableBuffers,
	createBatchEngine,
	DEFAULT_WINDOW_BYTES,
	DEFAULT_WINDOW_MS,
	restoreTransferredBuffers,
} from './engine.ts';
import {
	deserializeWorkerError,
	serializeWorkerError,
	type SerializedWorkerError,
} from './errors.ts';

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
    {
      resolve(commit: Commit): void;
      reject(error: unknown): void;
      /** Buffers this thread transferred out with the batch entries. */
      plan: { buffers: ArrayBuffer[]; slots: Array<{ container: Record<string, unknown>; key: string }> };
    }
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
      onTerminal: (error) => {
        // Terminal backend refusal: tell the main thread to fail its admission
        // queue closed — new enqueues must reject, not pile into a window that
        // can never commit.
        port.postMessage({ type: 'terminalError', error: serializeWorkerError(error) });
      },
      onQuarantine: (entries, error) => {
        port.postMessage({
          type: 'quarantined',
          entries,
          error: serializeWorkerError(error),
        });
      },
    },
    (entries) => {
      const requestId = nextRequestId++;
      // Transfer buffer payloads instead of copying them (OPT-B1). The engine
      // retains the batch for retry, so on `appendError` the main thread hands
      // the buffers back through the reply's transfer list and they are
      // restored here — a retried batch never carries detached payloads.
      const plan = collectTransferableBuffers(entries);
      try {
        port.postMessage({ type: 'append', requestId, entries }, plan.buffers);
      } catch {
        // Transfer-unfriendly payload (or a dead port): fall back to cloning.
        restoreTransferredBuffers(plan);
        port.postMessage({ type: 'append', requestId, entries });
      }
      return new Promise<Commit>((resolve, reject) => {
        pendingAppends.set(requestId, { resolve, reject, plan });
      });
    },
  );

  port.on('message', (message: {
    type: string;
    requestId?: number;
    entries?: Entry[];
    commit?: Commit | null;
    error?: SerializedWorkerError;
    returnedBuffers?: ArrayBuffer[];
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
            error: serializeWorkerError(error),
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
        else {
          pendingCheckpoint.reject(
            message.error ? deserializeWorkerError(message.error) : new Error('backend.checkpoint failed'),
          );
        }
        return;
      }
      const pending = pendingAppends.get(message.requestId);
      if (!pending) return;
      pendingAppends.delete(message.requestId);
      if (message.type === 'appendResult' && message.commit) {
        pending.resolve(message.commit);
        return;
      }
      // The main thread transferred the buffers back with the rejection (same
      // collection order as this thread's plan): put them back into the
      // retained batch so a retry re-sends intact payloads.
      const returned = message.returnedBuffers;
      if (Array.isArray(returned) && returned.length === pending.plan.slots.length) {
        for (let index = 0; index < returned.length; index += 1) {
          const slot = pending.plan.slots[index]!;
          const buffer = returned[index];
          if (buffer instanceof ArrayBuffer && !buffer.detached) {
            slot.container[slot.key] = buffer;
          }
        }
      }
      pending.reject(
        message.error ? deserializeWorkerError(message.error) : new Error('backend.appendBatch failed'),
      );
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
