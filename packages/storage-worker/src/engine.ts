/**
 * Batch window engine of the storage worker: accumulates entries and hands
 * them to `append` in batches cut by the first of (window elapsed, window
 * bytes reached, explicit flush). Invariant: at most one `append` call is in
 * flight at any time (single-flight); while one batch is being persisted, the
 * next window keeps accumulating and is chained right after.
 *
 * This module imports only `node:*` builtins at runtime (type-only imports
 * are erased), so it is loadable by raw Node inside `node:worker_threads`
 * worker bodies — both `worker.ts` and `off-thread.worker.ts` run it there.
 *
 * Failure policy is fail-closed, never lossy: if `appendBatch` fails, the
 * batch entries are put back at the head of the window and retried on the
 * next window tick; flush callers are rejected with the error so nobody
 * mistakes uncommitted data for durable data. Two terminal exceptions: a
 * single entry that cannot fit into any batch (poison) and a batch that kept
 * failing `maxConsecutiveFlushFailures` times with the same composition are
 * QUARANTINED — reported through `onQuarantine`, never retried — so a
 * wedging entry cannot block every entry behind it.
 *
 * `append` is never called with an empty batch: the backend contract rejects
 * empty batches, and a flush with an empty window and no previous commit goes
 * through the `checkpoint` hook (the liveness probe) instead.
 *
 * @module
 */

import { BatchStuckError } from './errors.ts';
import type { Commit, Entry } from './contracts.js';

/** Default batch window duration (ms) — durable-core spec: <= 200 ms. */
export const DEFAULT_WINDOW_MS = 200;
/** Default batch window size (bytes) — durable-core spec: <= 256 KiB. */
export const DEFAULT_WINDOW_BYTES = 256 * 1024;
/**
 * Default uncompressed-size cap of one backend batch. Mirrors
 * `MAX_BATCH_UNCOMPRESSED_BYTES` of `@mavis/durable-backend-sqlite-zstd`
 * (the worker stays dependency-free, so the value is pinned here and verified
 * by the sqlite-zstd adapter against the backend instance).
 */
export const DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES = 256 * 1024;
/** Default consecutive same-composition failures before a batch is quarantined. */
export const DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES = 3;

export interface BatchEngine {
  /** Adds one entry to the current window, cutting the window if it is full. */
  add(entry: Entry): void;
  /**
   * Requests a durability barrier: resolves with the commit of the last batch
   * covering every entry added before this call, or `null` when there was
   * nothing to commit. Rejects if persisting fails.
   */
  flush(): Promise<Commit | null>;
  /** Bytes currently sitting in the open window. */
  readonly windowBytes: number;
  /** Whether an `append` call is currently in flight. */
  readonly appending: boolean;
  /** Last commit produced by a successful batch, if any. */
  readonly lastCommit: Commit | null;
  /** Entries quarantined as dead letters, in quarantine order. */
  readonly quarantined: readonly Entry[];
  /** Cancels timers; the engine must not be used afterwards. */
  dispose(): void;
}

export interface BatchEngineOptions {
  /** Maximum time an entry may wait inside the window. */
  windowMs: number;
  /** Window size cut: the batch flushes once it reaches this many bytes. */
  windowBytes: number;
  /**
   * Liveness probe and empty-flush barrier: called when a flush arrives while
   * the window is empty and nothing was ever committed. Returns the commit of
   * the flushed open batch, or `null` when the backend held nothing.
   */
  checkpoint?: () => Promise<Commit | null>;
  /** Consecutive same-composition failures tolerated before quarantine. Default: 3. */
  maxConsecutiveFlushFailures?: number;
  /** Notified (in-thread) whenever entries are quarantined as dead letters. */
  onQuarantine?: (entries: Entry[], error: Error) => void;
  /**
   * Notified (in-thread) after every successful batch append with the batch's
   * byte size — the hook a host without a per-batch round trip uses to release
   * admission-queue bytes (see the off-thread worker).
   */
  onCommit?: (bytes: number) => void;
}

interface FlushWaiter {
  resolve(commit: Commit | null): void;
  reject(error: unknown): void;
}

/** Terminal (non-retryable) append errors are classified by preserved name. */
function isPoisonError(error: unknown): boolean {
  return error instanceof Error && error.name === 'EntryTooLargeError';
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
  const maxConsecutiveFlushFailures =
    options.maxConsecutiveFlushFailures ?? DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES;
  if (!Number.isInteger(maxConsecutiveFlushFailures) || maxConsecutiveFlushFailures < 1) {
    throw new RangeError(
      `maxConsecutiveFlushFailures must be a positive integer, got ${maxConsecutiveFlushFailures}`,
    );
  }

  let window: Entry[] = [];
  let openWindowBytes = 0;
  let windowTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let appending = false;
  let trivialInFlight = false;
  let disposed = false;
  let lastCommit: Commit | null = null;
  let lastFailureSignature: string | null = null;
  let failureStreak = 0;
  const quarantined: Entry[] = [];
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
   * non-empty window; with an empty window, resolves the waiters with the
   * last commit once everything is drained, or — when nothing was ever
   * committed — goes through the checkpoint probe instead of appending an
   * empty batch (the backend rejects empty batches by contract).
   */
  function drainForFlushWaiters(): void {
    if (disposed || appending || trivialInFlight || flushWaiters.length === 0) return;
    if (window.length > 0) {
      void cut();
      return;
    }
    if (!lastCommit) {
      void trivialFlush();
      return;
    }
    for (const waiter of flushWaiters.splice(0)) waiter.resolve(lastCommit);
  }

  /** Empty-window flush: probe the backend, never append an empty batch. */
  async function trivialFlush(): Promise<void> {
    trivialInFlight = true;
    try {
      const produced = options.checkpoint ? await options.checkpoint() : null;
      if (produced) lastCommit = produced;
    } catch (error) {
      trivialInFlight = false;
      for (const waiter of flushWaiters.splice(0)) waiter.reject(error);
      return;
    }
    trivialInFlight = false;
    if (disposed) return;
    if (window.length > 0) {
      // Entries arrived while probing: settle through the normal cut path,
      // which will resolve (or reject) the waiters on its own.
      drainForFlushWaiters();
      return;
    }
    // Nothing arrived: settle the barrier with whatever the probe produced.
    for (const waiter of flushWaiters.splice(0)) waiter.resolve(lastCommit);
  }

  /** Removes the batch from the retry path forever and reports it. */
  function quarantine(batch: Entry[], error: Error): void {
    quarantined.push(...batch);
    lastFailureSignature = null;
    failureStreak = 0;
    options.onQuarantine?.(batch, error);
    for (const waiter of flushWaiters.splice(0)) waiter.reject(error);
    // Whatever is left of the window still deserves its timer.
    ensureWindowTimer();
  }

  async function cut(): Promise<void> {
    if (appending || disposed || window.length === 0) return;
    appending = true;
    const batch = takeWindow();
    try {
      lastCommit = await append(batch);
    } catch (error) {
      if (isPoisonError(error)) {
        // ONE entry can never fit: quarantine only the offender (by id, the
        // field survives the thread bridge) and put the rest of the batch
        // back, so committable neighbors are not buried with the poison.
        const poisonedId = (error as { readonly entryId?: unknown }).entryId;
        const offender =
          typeof poisonedId === 'string' ? batch.filter((entry) => entry.entryId === poisonedId) : [];
        const survivors = offender.length > 0 ? batch.filter((entry) => entry.entryId !== poisonedId) : [];
        if (offender.length > 0 && survivors.length > 0) {
          quarantine(offender, error);
          window = [...survivors, ...window];
          openWindowBytes += survivors.reduce((total, entry) => total + entry.bytes, 0);
          drainForFlushWaiters();
          return;
        }
        // No id (or the whole batch is poison): quarantine the batch as one.
        quarantine(batch, error);
        return;
      }
      const signature = batch.map((entry) => entry.entryId).join('\u0000');
      failureStreak = signature === lastFailureSignature ? failureStreak + 1 : 1;
      lastFailureSignature = signature;
      if (failureStreak >= maxConsecutiveFlushFailures) {
        quarantine(
          batch,
          new BatchStuckError(
            batch.map((entry) => entry.entryId),
            failureStreak,
            error,
          ),
        );
        return;
      }
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
    lastFailureSignature = null;
    failureStreak = 0;
    options.onCommit?.(batch.reduce((total, entry) => total + entry.bytes, 0));
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
    flush(): Promise<Commit | null> {
      if (disposed) return Promise.reject(new Error('storage worker engine is disposed'));
      return new Promise<Commit | null>((resolve, reject) => {
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
    get quarantined(): readonly Entry[] {
      return quarantined;
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
