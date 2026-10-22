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

import { BatchStuckError, isTerminalBridgeErrorName } from './errors.ts';
import type { Commit, Entry } from './contracts.js';

/** Default batch window duration (ms) — durable-core spec: <= 200 ms. */
export const DEFAULT_WINDOW_MS = 200;
/** Default batch window size (bytes) — durable-core spec: <= 256 KiB. */
export const DEFAULT_WINDOW_BYTES = 256 * 1024;
/**
 * Default fraction of the window held back at the size cut, as a divisor of
 * `windowBytes` (16 -> the engine cuts at 15/16 of the window). A window cut
 * at EXACTLY the backend cap splits guaranteed in half whenever the declared
 * `entry.bytes` under-reports the true serialized size (draft wrappers, JSON
 * escaping) — two fsyncs where one was intended. The reserve keeps the normal
 * path at one fsync; the post-stringify split in the sqlite-zstd adapter
 * remains the correctness net behind it.
 */
export const DEFAULT_WINDOW_BYTES_RESERVE_DIVISOR = 16;
/**
 * Default uncompressed-size cap of one backend batch. Mirrors
 * `MAX_BATCH_UNCOMPRESSED_BYTES` of `@mavis/durable-backend-sqlite-zstd`
 * (the worker stays dependency-free, so the value is pinned here and verified
 * by the sqlite-zstd adapter against the backend instance).
 */
export const DEFAULT_MAX_BATCH_UNCOMPRESSED_BYTES = 256 * 1024;
/** Default consecutive same-composition failures before a batch is quarantined. */
export const DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES = 3;
/**
 * How many quarantined entries keep their payload in memory (per buffer — the
 * engine's and each host's). Beyond it, the oldest dead letters are evicted to
 * metadata-only stubs: an unbounded quarantine buffer would let a poison
 * flood grow the heap without limit (DS-B4).
 */
export const QUARANTINED_PAYLOAD_LIMIT = 1000;
/** Total quarantined records (payloads + metadata stubs) kept per buffer. */
export const QUARANTINED_METADATA_LIMIT = 4000;
/**
 * `kind` of the metadata dead-letter entry the off-thread worker drops into
 * the same backend log for every quarantine event (SW-03): a crash then loses
 * at most the payload of the in-memory stub, never the fact that entries were
 * buried. Log readers filter this kind out of application deltas.
 */
export const DEAD_LETTER_ENTRY_KIND = 'storage-worker.dead-letter';

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
  /**
   * Bytes held back at the size cut so serialization overhead cannot push a
   * full window past the backend cap. Default: `windowBytes /
   * DEFAULT_WINDOW_BYTES_RESERVE_DIVISOR`. `0` restores exact cutting.
   */
  windowBytesReserve?: number;
  /**
   * Notified (in-thread) when the backend refuses writes terminally
   * (`OwnerLostError`, `SealedGenerationError`). The engine then fails CLOSED:
   * no retry (a stale writer can never win), no quarantine (committable
   * entries are not buried over a backend-level refusal), every flush rejects
   * with the backend error and new entries are ignored. The host uses this
   * hook to fail its admission queue with the same error.
   */
  onTerminal?: (error: Error) => void;
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

/**
 * Terminal backend refusals (`OwnerLostError`, `SealedGenerationError`) are
 * neither retried nor quarantined — they break the engine, fail-closed. The
 * check inlines `instanceof Error` so TypeScript narrows the caught value.
 */

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
  const windowBytesReserve =
    options.windowBytesReserve ?? Math.floor(options.windowBytes / DEFAULT_WINDOW_BYTES_RESERVE_DIVISOR);
  if (!Number.isFinite(windowBytesReserve) || windowBytesReserve < 0 || windowBytesReserve > options.windowBytes) {
    throw new RangeError(
      `windowBytesReserve must be a non-negative number not above windowBytes, got ${windowBytesReserve}`,
    );
  }
  // Size-cut threshold below the nominal window: a full window then survives
  // moderate serialization inflation without a post-stringify split.
  const sizeCutBytes = Math.max(1, options.windowBytes - windowBytesReserve);

  let window: Entry[] = [];
  let openWindowBytes = 0;
  let windowTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let appending = false;
  let trivialInFlight = false;
  let disposed = false;
  /** Set by a terminal backend refusal; the engine fails closed from then on. */
  let brokenError: Error | null = null;
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
    if (disposed || brokenError || appending || trivialInFlight || flushWaiters.length === 0) return;
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
    // Bounded, loop-push retention (DS-B4): no spread (a quarantine batch can
    // exceed the frame-call stack), no unbounded payload memory.
    appendBoundedQuarantine(quarantined, batch);
    lastFailureSignature = null;
    failureStreak = 0;
    options.onQuarantine?.(batch, error);
    for (const waiter of flushWaiters.splice(0)) waiter.reject(error);
  }

  async function cut(): Promise<void> {
    if (appending || disposed || brokenError || window.length === 0) return;
    appending = true;
    const batch = takeWindow();
    let poisonSurvivorsPending = false;
    try {
      lastCommit = await append(batch);
    } catch (error) {
      if (error instanceof Error && isTerminalBridgeErrorName(error.name)) {
        // OwnerLostError / SealedGenerationError: the backend refused writes
        // for good. Retrying can never succeed and quarantining would bury
        // committable entries over a backend-level refusal — fail CLOSED
        // instead: the batch returns to the window, the engine is broken, and
        // every flush (current and future) rejects with the backend error.
        window = [...batch, ...window];
        openWindowBytes += batch.reduce((total, entry) => total + entry.bytes, 0);
        brokenError = error;
        if (windowTimer) {
          clearTimeout(windowTimer);
          windowTimer = null;
        }
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        for (const waiter of flushWaiters.splice(0)) waiter.reject(error);
        options.onTerminal?.(error);
        return;
      }
      if (error instanceof Error && isPoisonError(error)) {
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
          poisonSurvivorsPending = true;
        } else {
          // No id (or the whole batch is poison): quarantine the batch as one.
          quarantine(batch, error);
          return;
        }
        // The `finally` below clears `appending` first; the survivors then get
        // their timer and flush settling at the tail of this function.
      } else {
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
      }
    } finally {
      appending = false;
    }
    if (poisonSurvivorsPending) {
      // Survivors of a poison split were restored to the window while this cut
      // was still `appending`; only now can they get a timer and settle flush
      // waiters (both no-op while an append is in flight).
      ensureWindowTimer();
      drainForFlushWaiters();
      return;
    }
    lastFailureSignature = null;
    failureStreak = 0;
    options.onCommit?.(batch.reduce((total, entry) => total + entry.bytes, 0));
    // Chain the next cut immediately when the window filled up while we were
    // appending; otherwise make sure whatever is left still flushes on time
    // and settle any flush barrier.
    if (openWindowBytes >= sizeCutBytes) void cut();
    else ensureWindowTimer();
    drainForFlushWaiters();
  }

  return {
    add(entry: Entry): void {
      // A broken engine is fail-closed: the host was notified through
      // `onTerminal` and must have stopped admitting; entries past that point
      // are ignored rather than accumulated into a window that can never
      // commit.
      if (disposed || brokenError) return;
      window.push(entry);
      openWindowBytes += entry.bytes;
      ensureWindowTimer();
      if (openWindowBytes >= sizeCutBytes) void cut();
    },
    flush(): Promise<Commit | null> {
      if (brokenError) return Promise.reject(brokenError);
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

function isQuarantineStub(entry: Entry): boolean {
  return (
    (entry.payload as { deadLetterPayloadEvicted?: unknown } | null)?.deadLetterPayloadEvicted ===
    true
  );
}

/**
 * Appends quarantined entries to an in-memory dead-letter buffer under a
 * memory bound (DS-B4): pushes in a plain loop (a quarantine batch can exceed
 * the frame-call stack, so no spread), evicts the oldest payloads to
 * metadata-only stubs past {@link QUARANTINED_PAYLOAD_LIMIT}, and drops the
 * oldest stubs entirely past {@link QUARANTINED_METADATA_LIMIT}. The durable
 * record of a quarantine is the dead-letter entry (off-thread path) and the
 * host's `onQuarantined` callback — this buffer is only the caller-side mirror.
 */
export function appendBoundedQuarantine(buffer: Entry[], incoming: readonly Entry[]): void {
  for (const entry of incoming) buffer.push(entry);
  if (buffer.length > QUARANTINED_METADATA_LIMIT) {
    buffer.splice(0, buffer.length - QUARANTINED_METADATA_LIMIT);
  }
  let livePayloads = 0;
  for (const entry of buffer) {
    if (!isQuarantineStub(entry)) livePayloads += 1;
  }
  for (let index = 0; index < buffer.length && livePayloads > QUARANTINED_PAYLOAD_LIMIT; index += 1) {
    const entry = buffer[index]!;
    if (isQuarantineStub(entry)) continue;
    buffer[index] = {
      ...entry,
      payload: { deadLetterPayloadEvicted: true, bytes: entry.bytes },
      bytes: 0,
    };
    livePayloads -= 1;
  }
}

let deadLetterSequence = 0;

/**
 * Builds the metadata dead-letter entry for one quarantine event (SW-03): a
 * small, payload-free record the off-thread worker drops into the same backend
 * log under {@link DEAD_LETTER_ENTRY_KIND}. The full payloads stay with the
 * caller (in-memory buffer + `onQuarantined`); the durable record preserves
 * WHO was buried and WHY — enough to audit and re-materialize from upstream.
 */
export function buildDeadLetterEntry(entries: readonly Entry[], error: Error): Entry {
  deadLetterSequence += 1;
  const first = entries[0];
  return {
    entryId: `dl:${deadLetterSequence}:${first?.entryId ?? 'unknown'}`,
    parentId: null,
    kind: DEAD_LETTER_ENTRY_KIND,
    payload: {
      error: { name: error.name, message: error.message },
      entries: entries.map((entry) => ({ entryId: entry.entryId, kind: entry.kind, bytes: entry.bytes })),
    },
    // Metadata-only: dead letters do not charge the byte budgets.
    bytes: 0,
  };
}

/**
 * Ownership plan for one `postMessage` of entries whose payloads carry plain
 * `ArrayBuffer`s (OPT-B1): the buffers are TRANSFERRED instead of copied, and
 * the recorded slots let the sender put them back when the post failed or the
 * receiving side rejected the append (the engine retains failed batches for
 * retry — detached buffers there would corrupt the retry). Payloads without
 * plain ArrayBuffers — the JSON-normal case — produce an empty plan and behave
 * exactly like a plain post. Depth-limited: deep payloads keep clone semantics.
 */
export interface TransferPlan {
  readonly buffers: ArrayBuffer[];
  readonly slots: Array<{ container: Record<string, unknown>; key: string }>;
}

const TRANSFER_SCAN_DEPTH_LIMIT = 8;

export function collectTransferableBuffers(entries: readonly Entry[]): TransferPlan {
  const buffers: ArrayBuffer[] = [];
  const slots: Array<{ container: Record<string, unknown>; key: string }> = [];
  const seenBuffers = new Set<ArrayBuffer>();
  const seenObjects = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > TRANSFER_SCAN_DEPTH_LIMIT || value === null || typeof value !== 'object') return;
    if (value instanceof ArrayBuffer) return; // bare buffers have no writable slot; only container properties do
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (item instanceof ArrayBuffer) {
          if (!seenBuffers.has(item) && !item.detached) {
            seenBuffers.add(item);
            buffers.push(item);
            slots.push({ container: value as unknown as Record<string, unknown>, key: String(index) });
          }
          continue;
        }
        visit(item, depth + 1);
      }
      return;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key];
      if (child instanceof ArrayBuffer) {
        if (!seenBuffers.has(child) && !child.detached) {
          seenBuffers.add(child);
          buffers.push(child);
          slots.push({ container: value as Record<string, unknown>, key });
        }
        continue;
      }
      visit(child, depth + 1);
    }
  };

  for (const entry of entries) {
    if (entry.payload instanceof ArrayBuffer) {
      if (!seenBuffers.has(entry.payload) && !entry.payload.detached) {
        seenBuffers.add(entry.payload);
        buffers.push(entry.payload);
        slots.push({ container: entry as unknown as Record<string, unknown>, key: 'payload' });
      }
      continue;
    }
    visit(entry.payload, 1);
  }
  return { buffers, slots };
}

/** Puts transferred buffers back into their original payload slots. */
export function restoreTransferredBuffers(plan: TransferPlan): void {
  for (let index = 0; index < plan.slots.length; index += 1) {
    const slot = plan.slots[index]!;
    const buffer = plan.buffers[index];
    if (buffer !== undefined) slot.container[slot.key] = buffer;
  }
}
