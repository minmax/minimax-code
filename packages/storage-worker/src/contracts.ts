/**
 * Public contracts of the storage worker.
 *
 * `Entry`/`Commit` below are the durable-core wave contract, pinned verbatim
 * by the storage-worker task spec:
 *
 *   Entry  = { entryId: string; parentId: string | null; kind: string;
 *              payload: unknown; bytes: number }
 *   Commit = { batchId: string; seq: number; head: string }
 *
 * The spec named `@mavis/durable-backend-sqlite-zstd` as the package that
 * would declare these types. The backend package as actually implemented
 * ships a different shape: its `appendBatch` takes `EntryDraft`
 * (`{ id, kind, payload }`, no `entryId`/`parentId`/`bytes`) and its `Commit`
 * carries branded numeric `batchId`/`seq`/`head` plus extra fields. Until the
 * two packages are reconciled on one shared declaration, the pinned shapes
 * are declared here so this package compiles and tests standalone; moving to
 * a shared declaration later is a one-line change in this file plus a re-export.
 *
 * The worker never depends on any backend at runtime — it only forwards
 * entries to whichever `StorageWorkerBackend` handle it was given.
 *
 * @module
 */

/** One record to persist; `bytes` drives the byte-bounded queue and batch windows. */
export interface Entry {
  /** Stable application identity, unique across the whole database. */
  entryId: string;
  /** Log position of the predecessor entry, `null` for the first entry. */
  parentId: string | null;
  /** Application-defined discriminator (for example a `pi.*` entry kind). */
  kind: string;
  /** JSON-serializable payload stored inside the batch frame. */
  payload: unknown;
  /** Serialized size of the entry in bytes; the unit of queue/window budgets. */
  bytes: number;
}

/** Result of one committed batch, as produced by `backend.appendBatch`. */
export interface Commit {
  /** Primary key of the stored batch. */
  batchId: string;
  /** Strictly increasing sequence of this commit. */
  seq: number;
  /** Log head after the commit. */
  head: string;
}

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
