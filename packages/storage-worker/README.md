# @mavis/storage-worker

Off-main-thread write batching for the durable storage backend
(`@mavis/durable-backend-sqlite-zstd`). The caller thread only writes entries
into an internal byte-bounded queue (`enqueue` resolves in well under a
millisecond); a `node:worker_threads` worker accumulates them into batches
cut by the first of **200 ms** or **256 KiB** and persists each batch with
exactly one `backend.appendBatch` call, never two in flight (single-flight).

## Usage

```ts
import { createStorageWorker } from '@mavis/storage-worker';

const worker = createStorageWorker(backend, {
  queueBytes: 8 * 1024 * 1024, // byte ceiling of uncommitted entries
  windowMs: 200,               // max time an entry waits inside a batch
  windowBytes: 256 * 1024,     // max size of one batch
});

await worker.enqueue(entry);   // queued, not yet durable
const commit = await worker.flush(); // one Commit covering everything enqueued
await worker.checkpoint();     // fail-closed barrier (drain + backend.checkpoint)
await worker.dispose();
```

## Semantics

- **enqueue** — resolves immediately while the queue is below `queueBytes`;
  the promise only means "safely queued", not "durable". Above the ceiling it
  stays pending (backpressure through the promise); entries are never dropped.
  Parked enqueues are admitted strictly in enqueue order, so batch order
  matches call order.
- **flush** — drains the queue and resolves with the `Commit` of the batch
  covering every entry whose `enqueue` resolved. Rejects if the backend fails;
  the entries stay queued and are retried on the next window tick.
- **checkpoint** — fail-closed: drains everything, then calls
  `backend.checkpoint()`. Any backend failure, worker crash, or thread exit
  propagates as an exception; unverified durability is never reported as
  success.
- **dispose** — attempts a final drain, terminates the thread, and rejects
  all later calls. Still terminates when the drain fails.

## Architecture note

The `backend` handle lives on the thread that created it (a live JS object
cannot cross threads), so `appendBatch` executes on the caller thread while
the worker thread owns the batching policy and serializes the batches. The
worker-to-main protocol (`worker.ts`/`client.ts`) is deliberately shaped so a
future backend that is *constructed inside* the worker thread can take over
the `append` side of the protocol without changing callers.

The worker entry is loaded directly by `node:worker_threads`; from source
(Node >= 22.19 type stripping) it resolves `worker.ts`, a built package
resolves the `worker.js` sibling. Bundlers that do not emit worker assets
need an explicit `workerUrl` option.

`Entry`/`Commit` follow the durable-core wave contract pinned by the task
spec (`entryId`/`parentId`/`kind`/`payload`/`bytes`, `batchId`/`seq`/`head`).
They are declared in `src/contracts.ts`: the sqlite-zstd backend package as
currently implemented ships a different shape (`EntryDraft` without
`entryId`/`parentId`/`bytes`, branded numeric commit ids), so the shared
declaration is pending reconciliation between the two packages. The worker
has no runtime dependency on any backend — a backend with a different entry
shape is adapted at the callsite of `appendBatch`.
