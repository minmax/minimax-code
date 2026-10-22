# @mavis/wire-compiler

Context-as-Bytes wire compiler for the hybrid agent: every frozen log entry is
deterministically compiled into a `Buffer` segment, and a request body is the
single `Buffer.concat` of the segments of the current window manifest — never a
`JSON.stringify` over the whole message array.

## API

```ts
import { compile, createLruSegmentCache, MINIMAX_M3_DIALECT } from '@mavis/wire-compiler';

const { body, totalBytes, segments } = compile(
  [{ entryId: 'msg-1' }, { entryId: 'msg-2' }], // window manifest, in order
  entries,                                      // frozen log entries by id
  { maxBytes: 64 * 1024 * 1024, dialect: MINIMAX_M3_DIALECT },
);
```

- `compile(manifest, entries, opts)` — walks the manifest in order, resolves
  each `entryId`, serializes the entry independently, and concatenates the
  segments. Returns the `body` (newline-delimited JSON, one normalized entry
  per line), its exact `totalBytes`, and a per-entry `segments` breakdown
  (`bytes`, `sha256`, `cacheHit`) that callers publish back into their
  `[{entryId, segOff, len, hash}]` manifest. The `sha256` is computed on
  every cache MISS (so a first compile can publish a manifest directly) and
  skipped on warm hits — `undefined` there, unless `opts.requireHashes`
  forces re-hashing (the degraded mode's hash verification). The warm path
  pays no O(payload) hashing.
- Per-entry stage ownership — the per-entry conversion stage is OWNED by
  `@mavis/convert-to-llm` (`convertEntry` → `CompiledEntry`;
  `serializeCompiledEntry` is its pinned serialization). `src/contracts.ts`
  pins that contract for this package: `compiledEntryToWireEntry` maps a
  record onto the frozen-entry shape, `compiledRecordDialect()` compiles
  records into segments BYTE-IDENTICAL to `serializeCompiledEntry` (+ the
  trailing newline), and `compiledEntrySegment(record)` returns those bytes
  directly. The identity is unconditional: stored tool-call arguments strings
  travel through the bridge verbatim (no parse/stringify round trip), so even
  non-canonical or non-JSON stored text compiles to the pinned bytes. The
  bridge test (`test/unit/bridge.test.ts`) pins the durable-entry →
  convert-to-llm → wire-segment equality.
- Budget guard — `totalBytes > opts.maxBytes` aborts with `WireBudgetExceeded`
  carrying `totalBytes`, `maxBytes`, and the exact per-entry `breakdown`. The
  guard is arithmetic over segment lengths (no serialization work), so an
  oversized body is rejected before anything is sent.
- Per-entry stages are cached LRU under the key
  `(dialect.name, dialect.normalizerVersion, entryId)`. Pass an isolated
  `createLruSegmentCache(capacity)` via `opts.cache`, or omit it to share the
  module-level default (capacity `DEFAULT_SEGMENT_CACHE_CAPACITY`).

## Dialects

A `WireDialect` owns the mapping "frozen entry → wire JSON value" for one
provider family (`name` + `normalizerVersion` + pure `normalizeEntry`). The
bundled `minimax-m3` dialect (normalizer version `1`) strips `thinking` blocks
and reduces images to placeholder links: inline base64 `image` blocks become a
deterministic `cas://sha256/<digest>#<size>` reference of the decoded bytes,
and `image_ref` blocks keep their stored link as placeholder text — the wire
body never carries image bytes. Tool definitions are reduced to
`name`/`description`/`parameters` with a fixed key order: extra fields a
provider definition may carry (for example `strict`) are intentionally dropped
at this dialect's wire boundary — a provider that needs them ships its own
dialect or a normalizer version bump. An entry kind the dialect does not know
raises `WireCompilerError` instead of serializing.

Changing normalize rules means shipping a bumped `normalizerVersion`: only that
dialect's segments recompile, every other dialect's cached segments stay valid.

## Correctness contract

- **Determinism** — the same entry always compiles to byte-identical segment
  bytes; a warm-cache compile equals a cold-cache compile byte-for-byte.
- **Frozen entries** — an `entryId` never maps to different content. This is
  the durable-log guarantee the cache correctness rests on; violating it
  corrupts the cache like any memoization of mutable input.
- **Derived state** — the cache is evictable and rebuildable; it is never a
  second source of truth.
