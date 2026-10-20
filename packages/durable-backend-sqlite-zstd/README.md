# @mavis/durable-backend-sqlite-zstd

Durable delta-log storage backend: immutable compressed entry batches in
SQLite. The fifth backend beside Memory/JSONL/SQLite/DO, written against the
durable storage seam of the hybrid agent foundation.

## Contract

```ts
const backend = SqliteZstdBackend.open(directory);            // sessions.g<max>.db, creates g1
const commit = await backend.appendBatch(entries);            // one durable commit
const delta = backend.readDelta(commit.seq, limitBytes);      // windowed read past a sequence
await backend.checkpoint();                                   // flush the open batch
const next = SqliteZstdBackend.openNextGeneration(directory); // sessions.g<max+1>.db, seals older
await backend.close();
```

- `appendBatch(entries)` — stores the batch as ONE compressed frame
  (`codec.ts` envelope + frame), one `batches` row, one index row per entry
  (`entries.entry_id -> (seq, ordinal, batch_id)`), and the new `head`, all in
  ONE transaction on a WAL journal with `synchronous = FULL`. Once the returned
  `Commit` resolves, later reads observe the batch; the sequence is
  `head + 1`, strictly monotonic across reopen.
- `readDelta(afterSeq, limitBytes)` — entries of committed batches with
  `seq > afterSeq`, oldest first. `limitBytes` budgets uncompressed batch
  bytes; batches are atomic units, and the first batch past `afterSeq` is
  always returned so a reader cannot stall. A torn batch (checksum failure,
  malformed content, entry index disagreeing with the payload) ends the scan:
  the intact prefix is returned and the torn tail is never served.
- `stage(entries)` / `checkpoint()` — the open (in-memory) batch of the
  append-batching layer; `checkpoint()` flushes it through the same atomic
  path. `close()` and `seal()` flush a non-empty open batch first.
- Generations — a database opens as `sessions.gN.db`. Opening `N + 1` seals
  every older generation: live handles reject writes with
  `SealedGenerationError`, and their files lose their write bits, preserved
  byte-for-byte. Sealed generations stay readable.

## Frame format

`'MZS1' | codec id (1 byte) | one compressed frame`

The zstd codec uses `node:zlib`'s built-in Zstandard (Node >= 22.15 / 23.8)
with the frame checksum flag set, so decompression verifies an XXH64 content
checksum; gzip (CRC32) is the runtime fallback behind the same `Codec`
interface. Decoding follows the per-batch envelope codec id, so a database
written by either codec stays readable in every runtime. See `./codec`.

## Schema

```sql
meta(key, value)                       -- 'format' = 'sqlite-zstd.v1', 'head'
batches(batch_id PK, created_ms, compressed, payload BLOB)
entries(entry_id PK, seq, ordinal, batch_id)   -- log index, ordered (seq, ordinal)
```

`batch_id === seq`: one commit is one batch. The uncompressed batch size is
capped at 256 KiB by default (`maxBatchUncompressedBytes`), matching the
architecture's batch bound; the batching layer splits larger appends.
