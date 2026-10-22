/**
 * Public contracts of the storage worker.
 *
 * `Entry`/`Commit` are the durable-core wave contract and are declared ONCE,
 * type-only, in `@mavis/durable-core` (`packages/durable-core`); this module
 * re-exports them. The field-by-field reconciliation with the sqlite-zstd
 * backend's richer (branded, `id`-keyed) dictionary is fixed in that single
 * declaration too. The runtime translation between the dictionaries stays in
 * `sqlite-zstd-adapter.ts` — the only bridge between the two.
 *
 * The import below is type-only: the worker never depends on any backend (or
 * on anything else) at runtime — it only forwards entries to whichever
 * `StorageWorkerBackend` handle it was given.
 *
 * @module
 */

import type { Commit, Entry } from '../../durable-core/src/index.js';

export type { Commit, Entry };

/**
 * The persistence surface the worker drives. `appendBatch` must persist the
 * whole batch as ONE durable unit and is always invoked with at most one call
 * in flight (single-flight, see `createStorageWorker`).
 *
 * `appendBatch` is never invoked with an empty array: the backend contract
 * (`durable-backend-sqlite-zstd`) rejects empty batches, and a flush with
 * nothing to lose goes through {@link StorageWorkerBackend.checkpoint} instead.
 */
export interface StorageWorkerBackend {
  appendBatch(entries: Entry[]): Promise<Commit>;
  /**
   * Forces the backend to flush any open batch it still holds (WAL/fsync
   * barrier in the sqlite-zstd backend). May report the flushed open batch's
   * commit when the backend produced one, or `undefined`/`void` when nothing
   * was staged. Optional: a backend without an open batch concept can omit
   * it. Doubles as the liveness probe of a trivial flush (empty window,
   * nothing ever committed): a sealed or closed backend must throw here so
   * the lost write surface is noticed instead of silently flushed nothing.
   */
  checkpoint?(): Commit | null | void | Promise<Commit | null | void>;
}

/** Batch-window tuning. Defaults match the durable-core spec. */
export interface StorageWorkerOptions {
  /**
   * Byte ceiling of the not-yet-committed entry queue held on the caller
   * thread. `enqueue` applies promise-based backpressure instead of dropping
   * entries once the ceiling is reached. Default: 8 MiB.
   */
  queueBytes?: number;
  /** Maximum time an entry may wait inside a batch window. Default: 200 ms. */
  windowMs?: number;
  /** Batch window size cut: batches flush once they reach this size. Default: 256 KiB. */
  windowBytes?: number;
  /**
   * Explicit URL of the worker entry script. Defaults to the `worker.js`
   * sibling of this module, falling back to `worker.ts` when the package runs
   * from source (vitest, tsx).
   */
  workerUrl?: URL | string;
  /**
   * Uncompressed-size cap of one backend batch, in bytes. Entries whose
   * `bytes` exceed it are rejected at admission (they could never be part of
   * a committable batch), and the append path splits batches that serialize
   * above it. Must not exceed the backend's own cap
   * (`MAX_BATCH_UNCOMPRESSED_BYTES` in `durable-backend-sqlite-zstd`). The
   * default mirrors that backend: 256 KiB.
   */
  maxBatchUncompressedBytes?: number;
  /**
   * How many consecutive failures of the exact same batch composition are
   * tolerated before the batch is quarantined and its flush rejects with a
   * terminal {@link BatchStuckError}. Default: 3.
   */
  maxConsecutiveFlushFailures?: number;
  /**
   * Called on the caller thread whenever entries are quarantined (a single
   * entry above the cap, or a batch stuck after repeated failures).
   * Quarantined entries are never retried; their `enqueue` promises already
   * resolved ("safely queued"), so this callback — the `quarantined` handle
   * field, and the rejecting `flush` are the terminal report.
   */
  onQuarantined?: (entries: readonly Entry[], error: Error) => void;
  /**
   * Extra `execArgv` for the spawned worker thread — for example
   * `['--import', 'tsx']` when the backend factory module of an off-thread
   * worker is TypeScript source. Default: inherit.
   */
  workerExecArgv?: readonly string[];
}

/** Handle returned by `createStorageWorker`. */
export interface StorageWorker {
  /**
   * Queues an entry for durable persistence. Resolves in well under a
   * millisecond while the queue is below its byte ceiling — the entry is only
   * written to the internal queue, never persisted synchronously. When the
   * ceiling is reached the returned promise stays pending (backpressure)
   * until committed bytes free room; the entry itself is never dropped.
   *
   * Rejects without queueing when the entry is invalid or can never be
   * persisted (larger than the batch cap) — admission failures are terminal,
   * not retried.
   *
   * The promise says "safely queued", not "durable" — await `flush()` or
   * `checkpoint()` for durability.
   */
  enqueue(entry: Entry): Promise<void>;
  /**
   * Drains the queue and waits for the batch covering every entry whose
   * `enqueue` has resolved. Resolves with that batch's commit, or `null`
   * when there was nothing to commit (empty queue; the durability barrier
   * then comes from `checkpoint()`), so a caller is never tempted to mistake
   * a fabricated commit for a real one. Rejects if the backend is
   * unavailable — entries stay queued and are retried, until the batch is
   * declared stuck (see `maxConsecutiveFlushFailures`).
   */
  flush(): Promise<Commit | null>;
  /**
   * Fail-closed durability barrier: drains everything, then calls
   * `backend.checkpoint()`. Throws whenever the backend cannot confirm
   * durability (worker gone, `appendBatch` failing, `checkpoint` throwing).
   */
  checkpoint(): Promise<void>;
  /**
   * Entries removed from the retry queue as dead letters: a single entry
   * above the batch cap, or a batch that failed too many consecutive times
   * with the same composition. Quarantined entries are never retried.
   */
  readonly quarantined: readonly Entry[];
  /**
   * Stops the worker: drains what is queued, terminates the thread, and
   * rejects all later calls. Rejects (after still terminating) if the final
   * drain fails, so a lost tail is never reported as success.
   */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Checkpoint policy: interrupted effects (SE-SW-002)
// ---------------------------------------------------------------------------

/**
 * Outcome label for a tool call whose effect could not be confirmed
 * (`final-architecture.md` checkpoint policy: "Прерванный вызов получает
 * TOOL_OUTCOME_UNKNOWN без автоповтора").
 *
 * Contract:
 * - A call is interrupted when its completion cannot be observed — aborted
 *   mid-flight, or the durability barrier between the committed intent and
 *   the recorded result failed. The effect MAY or MAY NOT have taken place.
 * - An interrupted call is NEVER retried automatically: re-running an effect
 *   with an unconfirmed outcome risks a double effect. A next attempt is only
 *   allowed as an explicit recovery decision (see
 *   `RunToolEffectOptions.allowAfterUnknownOutcome` in `checkpoint-policy.ts`).
 */
export const TOOL_OUTCOME_UNKNOWN = 'tool-outcome-unknown';

/** Terminal outcomes of one tool call under the checkpoint policy. */
export type ToolOutcome = 'completed' | 'failed' | typeof TOOL_OUTCOME_UNKNOWN;

/**
 * Discriminated result of one tool effect driven through the checkpoint
 * barrier (`createCheckpointBarrier`):
 * - `completed` — the effect ran to completion and reported a value;
 * - `failed` — the effect itself reported a definitive failure (`error`);
 *   nothing was retried;
 * - {@link TOOL_OUTCOME_UNKNOWN} — the call was interrupted after the
 *   durability barrier; the effect's outcome is unconfirmed and auto-retry is
 *   forbidden (see {@link TOOL_OUTCOME_UNKNOWN}).
 */
export type ToolEffectOutcome<A = unknown> =
  | { readonly outcome: 'completed'; readonly value: A }
  | { readonly outcome: 'failed'; readonly error: Error }
  | { readonly outcome: typeof TOOL_OUTCOME_UNKNOWN };
