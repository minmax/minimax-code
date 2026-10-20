# @mavis/cas

Content-addressed blob store for the hybrid agent foundation. No external
dependencies — Node built-ins only.

## Usage

```ts
import { openCas } from '@mavis/cas';

const cas = await openCas(rootDir);
const { sha256, size } = await cas.putBytes(Buffer.from('hello'));
if (cas.has(sha256)) {
  const blob = await cas.get(sha256);
}
```

- `putBytes(buffer)` / `putFile(path)` / `putImage(path)` publish content and
  return `{ sha256, size }`. Images are stored byte-for-byte; nothing is ever
  decoded or re-encoded.
- Layout: `<rootDir>/cas/<aa>/<remaining 62 hex digits>` (`aa` = first digest
  pair), with a `<rootDir>/tmp` staging directory.
- Atomic publication: every write goes to a fresh tmp file, is fsynced, and is
  then renamed onto its final path. An interrupted write never becomes visible.
- Dedup: if the digest already exists in the store, nothing is written.
- `pathFor`, `has`, and `get` accept lowercase or uppercase 64-char hex digests
  and reject anything else (including path traversal).
