/**
 * Worker thread for the storage worker: owns the batch window policy and the
 * single-flight `appendBatch` discipline.
 *
 * This file is loaded DIRECTLY by `node:worker_threads` (`new Worker(url)`),
 * including from TypeScript source on Node >= 22.19 where type stripping is
 * enabled by default. It therefore imports only `node:*` builtins at runtime;
 * type-only imports are erased. The batching engine is exported so the window
 * and single-flight behaviour can be unit-tested in-thread without spawning a
 * thread (on the main thread `parentPort` is null and nothing is wired up).
 *
 * Protocol (see `client.ts` for the main-thread side):
 *   main -> worker: { type: 'entries', entries: Entry[] }
 *                   { type: 'flush', requestId }
 *                   { type: 'appendResult', requestId, commit }
 *                   { type: 'appendError', requestId, message }
 *   worker -> main: { type: 'append', requestId, entries }
 *                   { type: 'flushResult', requestId, commit }
 *                   { type: 'flushError', requestId, message }
 *
 * Failure policy is fail-closed, never lossy: if `appendBatch` fails, the
 * batch entries are put back at the head of the window and retried on the
 * next window tick; flush callers are rejected with the error so nobody
 * mistakes uncommitted data for durable data.
 *
 * @module
 */

import { parentPort, workerData } from 'node:worker_threads';

import type { Commit, Entry } from './contracts.js';

/** Default batch window duration (ms) — durable-core spec: <= 200 ms. */
export const DEFAULT_WINDOW_MS = 200;
/** Default batch window size (bytes) — durable-core spec: <= 256 KiB. */
export const DEFAULT_WINDOW_BYTES = 256 * 1024;

/**
 * The batch window engine: accumulates entries and hands them to `append` in
 * batches cut by the first of (window elapsed, window bytes reached, explicit
 * flush). Invariant: at most one `append` call is in flight at any time
 * (single-flight); while one batch is being persisted, the next window keeps
 * accumulating and is chained right after.
 */
export interface BatchEngine {
  /** Adds one entry to the current window, cutting the window if it is full. */
  add(entry: Entry): void;
  /**
   * Requests a durability barrier: resolves with the commit of the last batch
   * covering every entry added before this call. Rejects if persisting fails
   * (entries stay queued and are retried).
   */
  flush(): Promise<Commit>;
  /** Bytes currently sitting in the open window. */
  readonly windowBytes: number;
  /** Whether an `append` call is currently in flight. */
  readonly appending: boolean;
  /** Last commit produced by a successful batch, if any. */
  readonly lastCommit: Commit | null;
  /** Cancels timers; the engine must not be used afterwards. */
  dispose(): void;
}

export interface BatchEngineOptions {
  /** Maximum time an entry may wait inside the window. */
  windowMs: number;
  /** Window size cut: the batch flushes once it reaches this many bytes. */
  windowBytes: number;
}

interface FlushWaiter {
  resolve(commit: Commit): void;
  reject(error: unknown): void;
}

export function createBatchEngine(
  options: BatchEngineOptions,
  append: (entries: Entry[]) => Promise<Commit>,
): BatchEngine {
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new RangeError(`windowMs must be a positive finite number, got ${options.windowMs}`);
  }
  if (!Number.isFinite(options.windowBytes) || options.windowBytes <= 0) {
    throw new RangeError(
      `windowBytes must be a positive finite number, got ${options.windowBytes}`,
    );
  }

  let window: Entry[] = [];
  let openWindowBytes = 0;
  let windowTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let appending = false;
  let disposed = false;
  let lastCommit: Commit | null = null;
  const flushWaiters: FlushWaiter[] = [];

  function ensureWindowTimer(): void {
    if (disposed || appending || windowTimer || retryTimer || window.length === 0) return;
    windowTimer = setTimeout(() => {
      windowTimer = null;
      void cut();
    }, options.windowMs);
  }

  function takeWindow(): Entry[] {
    const batch = window;
    window = [];
    openWindowBytes = 0;
    if (windowTimer) {
      clearTimeout(windowTimer);
      windowTimer = null;
    }
    return batch;
  }

  /**
   * Makes progress toward draining the queue for flush waiters: cuts a
   * non-empty window, persists one empty batch when no commit exists yet, or
   * resolves the waiters with the last commit once everything is drained.
   */
  function drainForFlushWaiters(): void {
    if (disposed || appending || flushWaiters.length === 0) return;
    if (window.length > 0) {
      void cut();
      return;
    }
    if (!lastCommit) {
      void cut(true);
      return;
    }
    for (const waiter of flushWaiters.splice(0)) waiter.resolve(lastCommit);
  }

  async function cut(force = false): Promise<void> {
    if (appending || disposed) return;
    if (window.length === 0 && !force) return;
    appending = true;
    const batch = takeWindow();
    try {
      lastCommit = await append(batch);
    } catch (error) {
      // Put the batch back at the head so retry order matches enqueue order
      // (entries may have been added while the failed append was in flight),
      // then retry after one window tick. Flush callers learn about the
      // failure immediately (fail-closed); the data itself stays queued.
      window = [...batch, ...window];
      openWindowBytes += batch.reduce((total, entry) => total + entry.bytes, 0);
      if (retryTimer) clearTimeout(retryTimer);
      // Retry after one window tick, so a dead backend is probed at the same
      // cadence batches would normally flow.
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void cut();
      }, options.windowMs);
      for (const waiter of flushWaiters.splice(0)) waiter.reject(error);
      return;
    } finally {
      appending = false;
    }
    // Chain the next cut immediately when the window filled up while we were
    // appending; otherwise make sure whatever is left still flushes on time
    // and settle any flush barrier.
    if (openWindowBytes >= options.windowBytes) void cut();
    else ensureWindowTimer();
    drainForFlushWaiters();
  }

  return {
    add(entry: Entry): void {
      if (disposed) return;
      window.push(entry);
      openWindowBytes += entry.bytes;
      ensureWindowTimer();
      if (openWindowBytes >= options.windowBytes) void cut();
    },
    flush(): Promise<Commit> {
      if (disposed) return Promise.reject(new Error('storage worker engine is disposed'));
      return new Promise<Commit>((resolve, reject) => {
        flushWaiters.push({ resolve, reject });
        drainForFlushWaiters();
      });
    },
    get windowBytes(): number {
      return openWindowBytes;
    },
    get appending(): boolean {
      return appending;
    },
    get lastCommit(): Commit | null {
      return lastCommit;
    },
    dispose(): void {
      disposed = true;
      if (windowTimer) {
        clearTimeout(windowTimer);
        windowTimer = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
  };
}

/**
 * Thread body: wires the batch engine to the main-thread backend bridge.
 * `appendBatch` itself always executes on the thread that owns the backend
 * handle; the worker initiates the call and serializes batches so the main
 * thread sees exactly one `backend.appendBatch` invocation per batch.
 */
function startWorkerThread(
  port: NonNullable<typeof parentPort>,
  options: BatchEngineOptions,
): void {
  let nextRequestId = 0;
  const pendingAppends = new Map<
    number,
    { resolve(commit: Commit): void; reject(error: unknown): void }
  >();

  const engine = createBatchEngine(options, (entries) => {
    const requestId = nextRequestId++;
    return new Promise<Commit>((resolve, reject) => {
      pendingAppends.set(requestId, { resolve, reject });
      port.postMessage({ type: 'append', requestId, entries });
    });
  });

  port.on('message', (message: {
    type: string;
    requestId?: number;
    entries?: Entry[];
    commit?: Commit;
    message?: string;
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
          }),
        );
      return;
    }
    if (
      (message.type === 'appendResult' || message.type === 'appendError') &&
      typeof message.requestId === 'number'
    ) {
      const pending = pendingAppends.get(message.requestId);
      if (!pending) return;
      pendingAppends.delete(message.requestId);
      if (message.type === 'appendResult' && message.commit) pending.resolve(message.commit);
      else pending.reject(new Error(message.message ?? 'backend.appendBatch failed'));
    }
  });
}

const port = parentPort;
if (port) {
  const data = workerData as { windowMs?: number; windowBytes?: number } | undefined;
  startWorkerThread(port, {
    windowMs: data?.windowMs ?? DEFAULT_WINDOW_MS,
    windowBytes: data?.windowBytes ?? DEFAULT_WINDOW_BYTES,
  });
}
