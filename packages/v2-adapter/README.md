# @mavis/v2-adapter

Read-only streaming reader for legacy mcode v2 session directories
(`messages.jsonl` canonical history; see `hybrid-plans/facts/facts-mcode.md`
section 5.2). The adapter never writes to the source session and never holds
the whole history in memory: files are streamed one line at a time, so the
100 MB picture-heavy sessions with multi-megabyte base64 lines import with
memory bounded by the largest single line up to `MAX_LINE_BYTES` (64 MiB by
default; a longer line fails with `V2SessionFormatError` instead of being
materialized).

## API

```ts
import { openV2Session } from '@mavis/v2-adapter';

const reader = openV2Session(sessionDir); // resolves <sessionDir>/messages.jsonl

// Stream envelopes in file order (async callbacks apply backpressure).
// Default policy is strict: the first malformed line rejects the read with
// `V2SessionFormatError` (1-based PHYSICAL line number). `formatErrors:
// 'skip'` reports each bad line to `onFormatError` and continues.
await reader.readEnvelopes((envelope) => { ... });

// One-pass snapshot: bytes and non-empty lines are counted by the same scan
// (no separate stat() race), and every record is validated — a broken file
// reports `malformedLines > 0` instead of passing silently. Pass
// `{ validate: false }` for a cheap size/line count of a known-good file.
await reader.stats(); // => { bytes, lines, malformedLines }

// Import into a new-generation sink. Image externalization is ON by default:
// inline base64 `image` blocks are stored in the CAS and the block becomes
// `{ type: 'image_ref', blob }`. `cas: null` keeps every image inline; `cas`
// also accepts a store instance or a CAS root directory string (blobs then
// land in `<root>/cas/<aa>/<62hex>`, the `resolveCasDirPath` layout).
const stats = await reader.importTo(
  { putEntry: async (envelope) => { ... } },
  {
    onImage: async (base64) => {
      // CAS integration point: store the decoded bytes, return the canonical
      // reference built by `casSpillRef(digest, size)` — the
      // `cas://sha256/<64 lowercase hex>#<size in bytes>` descriptor — or
      // `undefined` to keep the block inline. A descriptor `parseCasSpillRef`
      // rejects is treated exactly like a decline (inline + counter).
      return casSpillRef(sha256, size);
    },
  },
);
```

An `image` content block whose hook returns a canonical descriptor is
imported as `{ type: 'image_ref', blob: <descriptor> }`; `undefined` keeps
the block inline. `ImportStats` reports `bytes`, `lines` (records consumed by
this run), `envelopes`, `imageBlocks`, `imagesMigrated`, `imagesInline`, and
`lastLine` — the resume cursor to pass back as `resumeAfterLine` after an
interrupted import. The counters always satisfy
`imageBlocks === imagesMigrated + imagesInline`. Targets may implement an
optional `putEntries(batch)` sink to receive ordered batches (`batchSize`
option) instead of one call per record.

Envelope lines are validated against the canonical shape (exact key set
`message_id`/`turn_id`/`message`/`turn_config`/`history_artifact`, message_id
matching `msg-.+` or digits); violations throw `V2SessionFormatError` naming
the file and the physical line number, and JSON parse failures never leak the
line payload into the diagnostic. `turn_config` and `history_artifact` pass
through as opaque records.

## CAS externalization policies

Externalization never degrades silently; every issue is reported to the
optional `onIssue` listener (`CasImportIssue`):

- **CAS unavailable** (the `@mavis/cas` package or the store root cannot be
  opened): the import fails with `CasSpillError` unless the caller passes the
  explicit `casUnavailable: 'keep-inline'` policy, which reports a
  `cas-unavailable` issue and keeps every image inline.
- **Fatal store errors** (`ENOSPC`, `EDQUOT`, `EACCES`, `EPERM`, `EROFS`,
  `EIO` from `putBytes`): the import fails with `CasSpillError` — silently
  absorbing the blob into the history log would be the worse outcome.
- **Other store errors**: a `store-error` issue is reported and the block
  degrades to inline by the documented tolerant policy.
- **Non-canonical base64**: the payload is kept inline verbatim (a lenient
  decode would distort the bytes and misstate the size in the reference) and
  an `invalid-base64` issue is reported.
- **Non-canonical hook descriptors**: a custom `onImage` that returns
  anything `parseCasSpillRef` rejects yields an `invalid-blob-ref` issue and
  an inline block.

Repeated identical payloads reuse a bounded base64→reference cache, so
duplicate images are hashed and stored once. The reference format is pinned
by `casSpillRef`/`parseCasSpillRef` in this package and synchronized with
`@mavis/agent-tools` `truncation/cas-spill`; if either side changes it,
update both.

## Repository registration (one-time, outside this package)

The package is self-contained but not yet wired into the distribution
gates. Registering it requires the standard steps from `src/AGENTS.md`:
add `packages/v2-adapter` to `pnpm-workspace.yaml` and `packageRoots` in
`release/extraction.json`, run `pnpm gen:tsconfig`, regenerate
`release/public-source.json` via `node scripts/source-inventory.mjs --write`,
and add `packages/v2-adapter/test/unit/*.test.ts` to a group in
`test/vitest-suites.json`. Until then, verify locally with:

- `src/node_modules/.bin/vitest run` from `src/packages/v2-adapter`
- `src/node_modules/.bin/tsc -p src/packages/v2-adapter/tsconfig.json`
  from `src/`
