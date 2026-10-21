# bench-prepare — the full circuit: projection → wire → LLM-mock

`bench-prepare.mjs` measures the Ф2 request path END TO END through the real
packages — not through a composed pipeline shortcut — and gates the two
budgets the architecture pins on it:

- **prep ≤ 50 ms p95** — the per-request payload preparation, at any history
  length;
- **payload ≤ 32 MiB** — the compiled provider body, always.

## The circuit

1. **Corpus** — `N_ENTRIES` synthetic history entries in the pi-durable
   `payload.model = [message]` convention (alternating `pi.user` /
   `pi.assistant`, ~`ENTRY_TEXT_KIB` KiB of text each). With `HEAVY_IMAGES=1`,
   `IMAGE_COUNT` (62) of them become image entries whose durable payload
   carries a ~1.5 MiB **base64 imitation inline**; the same bytes are
   published into a real CAS (`@mavis/cas`) and wrapped in the Context MMU
   (`@mavis/context-mmu`, resident budget 12 MiB, LRU eviction).
2. **Commits** — entries flow through `createStorageWorker` (bridge mode:
   batch windows on the worker thread, `appendBatch` on the caller thread via
   `sqliteZstdStorageBackend`) into a fresh temp store
   (`@mavis/durable-backend-sqlite-zstd`). Every flush is read back
   (`readDelta`) and applied to the `ProjectionService` (`@mavis/context-projection`)
   as `CommitWithEntries` — the O(new entries) incremental fold. When history
   exceeds `WINDOW`, one real `mcode.compaction` control entry is committed
   through the same path, cutting the derived window to the last `WINDOW`
   entries (this is what keeps the 10× profile's payload flat).
3. **Head open** — the measured lazy open: `openSqliteZstdBackend` +
   `readResume()` (one meta row) + `readDeltaFrom(firstKeptEntryId, …,
   inclusive)` (batch-granular, trimmed to the exact capsule start) +
   `ProjectionService.fromCapsule` with the MMU-backed residency policy
   (text pages always resident; image pages follow the MMU's LRU decision).
   Reported as the median of `OPEN_ITERS` runs.
4. **Prepare** — the per-request path: `llmContext()` through the residency
   policy, `convertEntry` per window entry (the pinned per-entry stage from
   `@mavis/convert-to-llm`), `compiledEntryToWireEntry`, then `compile()`
   (`@mavis/wire-compiler`) with the 32 MiB guard, the compiled-record
   dialect and a persistent segment cache — hashes on cache misses only, the
   runtime steady state. A separate cold + fully-hashed pass (`prep.coldMs`)
   produces the body the mock verifies.
5. **LLM-mock** — the provider is replaced by a body verification, no
   network: NDJSON line boundaries (every segment ends with LF and the
   segments cover the body exactly), per-segment sha256 re-hashing, the
   record shape of every line (a string `role`), byte stability of warm
   prepares against the hashed body, and **zero image-base64 leak** into the
   wire body (images may only appear as placeholders — the durable base64
   must never reach the wire).

## Gate

Printed to stdout and reflected in the exit code (PASS → 0, FAIL → 1,
usage/setup errors → 2):

```text
gate=PASS (prep.p95Ms=1.71 <= 50; payload.bytes=404018 <= 33554432)
gate=FAIL reason="prep.p95Ms=61.20 > 50"
```

FAIL reasons cover: `prep.p95Ms` over budget, `payload.bytes` over budget,
any llm-mock verification error, and the MMU resident budget being exceeded.

## Usage

Requires `--experimental-transform-types`: the `context-mmu` sources use
TypeScript parameter properties, which strip-only mode rejects.

Requires `--conditions=development` on a clean checkout: the packages'
`exports` map the `import` condition to built `dist/` files (gitignored, not
built by `scripts/build.mjs`), while the `development` condition resolves the
TypeScript sources. Without it the run dies with `ERR_MODULE_NOT_FOUND`
(`.../wire-compiler/node_modules/@mavis/cas/dist/cas-ref.js`).

```sh
cd src

# text corpus, 2061 entries (default profile)
node --conditions=development --experimental-transform-types --expose-gc scripts/bench/bench-prepare.mjs

# images corpus: 62 images × ~1.5 MiB base64 imitation through CAS + MMU
HEAVY_IMAGES=1 node --conditions=development --experimental-transform-types --expose-gc scripts/bench/bench-prepare.mjs

# 10× size: 20610 entries — history-length independence of prep/payload
N_ENTRIES=20610 node --conditions=development --experimental-transform-types --expose-gc scripts/bench/bench-prepare.mjs
```

All three profiles must print `gate=PASS` and exit 0.

## Metrics (`name=value` lines)

| Metric | Meaning |
| --- | --- |
| `prep.p50Ms` / `prep.p95Ms` / `prep.maxMs` | warm per-request prepare (conversion re-runs, segments served from the cache, no re-hashing); the gate consumes `prep.p95Ms` |
| `prep.coldMs` | one fully-hashed cold pass (every segment serialized + sha256'd — the degraded equivalence mode) |
| `payload.bytes` | exact byte length of the compiled NDJSON body — the wire byte truth; gate consumer |
| `payload.sha256` | digest of the verified body (stable across runs: the corpus is deterministic) |
| `head.openMs` | median lazy open: connection + capsule row + window range read + fold |
| `rss.maxMb` | peak sampled RSS across the whole circuit |
| `circuit.*` | profile label, corpus size, window/segments, images (total and in-window), commits applied, total projection fold ms |
| `mmu.*` | resident bytes/pages vs the 12 MiB budget, request-path faults, CAS fault round-trip check |
| `mock.*` | NDJSON lines, hashes re-verified, image placeholders in the body, roles seen, byte stability |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `N_ENTRIES` | `2061` | synthetic history length |
| `HEAVY_IMAGES` | unset | `1` → 62 image entries with ~1.5 MiB inline base64 each |
| `IMAGE_COUNT` / `IMAGE_KIB` | `62` / `1536` | image entry count and per-image base64 size (KiB) |
| `WINDOW` | `200` | LLM window kept after the trailing compaction commit |
| `ITERS` | `30` | warm prepare samples |
| `OPEN_ITERS` | `5` | head-open samples (median reported) |
| `ENTRY_TEXT_KIB` | `2` | text bytes per non-image entry |
| `MAX_PAYLOAD_BYTES` | `33554432` | wire budget (32 MiB) and `compile()` guard |
| `PREP_BUDGET_MS` | `50` | prep p95 gate |
| `MMU_RESIDENT_BYTES` | `12582912` | Context MMU resident budget (12 MiB) |
| `CHUNK` | `200` | entries per worker flush |
| `KEEP` | unset | `1` → keep the temp store and CAS directories (paths on stderr) |

## Notes

- The store and CAS live in `mkdtemp` directories and are removed unless
  `KEEP=1`; the corpus is fully deterministic, so `payload.sha256` is
  reproducible run to run.
- The images profile opens the backend with a 4 MiB uncompressed batch cap
  (one 1.5 MiB entry must fit a batch); every measured open reuses the same
  options because the decode cap is per-handle — under the default 256 KiB
  cap the big frames would be treated as a torn tail and refused. The text
  and 10× profiles run entirely on the default 256 KiB cap.
- The worker runs in bridge mode (batching on the worker thread, backend
  append on the caller thread). The off-thread variant is measured
  separately by `bench-worker-commit.mjs`; this bench pins the full circuit
  shape, not the thread topology.
