# @mavis/cas

Content-addressed blob store for the hybrid agent foundation. No external
dependencies — Node built-ins only.

## Usage

```ts
import { openCas } from '@mavis/cas';

const cas = await openCas(rootDir);
const { sha256, size } = await cas.putBytes(new TextEncoder().encode('hello'));
if (await cas.hasAsync(sha256)) {
  const blob = await cas.get(sha256);
}
```

- `putBytes(data)` / `putFile(path)` / `putBase64(base64)` publish content and
  return `{ sha256, size }`. `putBytes` accepts any `Uint8Array` (including
  `Buffer` views). `putBase64` decodes in aligned chunks, so the whole decoded
  payload is never materialized; decoding is lenient (it mirrors
  `Buffer.from(base64, 'base64')`) and the digest covers the decoded bytes.
- `putImage(path)` was removed: it was an exact alias of `putFile` (images were
  always stored byte-for-byte, never decoded or re-encoded). Use `putFile`.
- Layout: `<rootDir>/cas/<aa>/<remaining 62 hex digits>` (`aa` = first digest
  pair), with a `<rootDir>/tmp` staging directory.
- Atomic publication: every write goes to a fresh tmp file and lands on its
  final path with an exclusive hard link (`EEXIST` loses against an existing
  blob). Concurrent publications of the same digest are safe — both writers
  produce byte-identical content, so "last writer wins" is unobservable.
  On filesystems without hard links the commit falls back to an atomic rename.
- Orphan cleanup: tmp files stranded by crashed publishers (e.g. `kill -9`)
  are swept on `openCas` after a one-hour grace period; race losers remove
  their tmp file immediately.
- Integrity on read: `get`/`getStream` hash the bytes they serve and fail when
  they no longer match the digest (corrupted, truncated, or substituted files),
  optionally also checking `expectedSize`.
- Dedup: if the digest already exists in the store, nothing is written.
- Durability: by default a publication pays the fsync pair (tmp file + shard
  directory). Pass `{ durability: false }` per call or per store
  (`openCas(root, { durability: false })`) for bulk imports of re-derivable
  data to skip both fsyncs.
- `putFile` reads the source in a single pass (copy and hash together). Only a
  pass torn by a concurrent source rewrite takes a second pass, and a source
  that keeps changing fails the publication instead of storing a mix.
- `pathFor`, `has`, `hasAsync`, `get`, and `getStream` accept lowercase or
  uppercase 64-char hex digests and reject anything else (including path
  traversal).
- Existence probes: `hasAsync` (async `stat`) is the normal probe. The legacy
  synchronous `has` remains for callers that cannot await; it blocks the event
  loop and must not be used in hot paths.
- Resolution: the `development` export condition points at the TypeScript
  source (`./src/index.ts`), so source runtimes resolve the package without a
  build; the `import` condition keeps pointing at `./dist/index.js` for built
  artifacts.
