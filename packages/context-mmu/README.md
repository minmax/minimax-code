# @mavis/context-mmu

Context MMU for the hybrid agent: decides which pages (CAS-backed blobs,
typically images) live as resident bytes and which are represented in the
model context only by a deterministic digest placeholder. No runtime
dependencies — the `CasStore` is injected against the wave-1 contract
(type-only import, erased at runtime), so any structurally compatible store
works.

## Usage

```ts
import { openCas } from '@mavis/cas';
import { createMMU } from '@mavis/context-mmu';

const cas = await openCas(rootDir);
const mmu = createMMU(cas, { maxResidentBytes: 12 * 1024 * 1024 });

const handle = mmu.page({ sha256, mime: 'image/png', bytes, width: 640, height: 480 });
const where = mmu.admit(handle); // 'resident' | 'digest'

// The context carries only the placeholder; scripts get the bytes:
const placeholder = mmu.pages.digest(handle); // '[image sha256:ab12… 640x480 image/png — recall(handle) чтобы увидеть]'
const original = await mmu.pages.read(handle);
```

## Semantics

- `page(ref)` creates a handle; it never makes the page resident. In-hand
  `bytes` are verified against `ref.sha256` and published to the CAS on the
  first `fault` (deduplicated); a ref without `bytes` must already exist in
  the store. `pageFile(path, meta)` stores a file verbatim and binds the
  handle to its resolved path for coherence.
- `admit(handle)` is the explicit residency decision and returns whether the
  page joined the resident set or must stay digest-only (larger than the
  budget). It is synchronous: residency is budget accounting, the byte buffer
  is hydrated lazily by `fault`.
- Budget: LRU by bytes, default 12 MiB. Eviction is batched — an over-budget
  admission drains the resident set to `maxResidentBytes * batchEvictRatio`
  (default 0.75), so the tail page is not evicted and re-faulted every turn.
  Unpinned residency always stays within the budget.
- Pins: `pin(handle, turns)` protects a page from eviction for `turns` turns
  (default 4); turns advance via `advanceTurn()`. `unpin(handle)` ends the
  pin but keeps a one-turn grace (`unpinGraceTurns`) so an intra-turn unpin
  cannot thrash. Pins are caller contracts: an all-pinned resident set may
  exceed the budget.
- `fault(handle)` returns the original bytes and never changes residency.
  `release(handle)` frees the slot and buffered bytes; every later use of the
  handle rejects (release itself is idempotent).
- `digest(handle)` renders the deterministic placeholder
  `[image sha256:ab12… WxH mime — recall(handle) чтобы увидеть]` — a pure
  function of the page identity, stable across handles, turns and MMU
  instances (`WxH` collapses to `?x?` when dimensions are unknown).
- `watch(paths)` attaches `fs.watch` (files are watched through their parent
  directory, so rename-style saves are seen; directories are non-recursive).
  When a watched file changes, every live page bound to it is marked `stale`
  and replaced by a diff handle — `replacedBy` on the stale handle, carrying
  `previousSha256` of the version it replaced — which inherits the stale
  page's resident slot. Stale handles are dead: `fault`/`admit`/`digest` on
  them reject, so an outdated image can never silently re-enter a context.
  A deleted file marks its pages stale without a replacement.
- `stats()` reports the resident count and budgeted bytes; `statusOf()`
  exposes a handle's lifecycle status.
- `mmu.pages` is the `ctx.pages` contract handed to codemode/scripts:
  `read(handle)` / `digest(handle)` — the only observation channels, so page
  bytes reach the caller without entering the model context.

The `PathWatcher` class (fs.watch subscriptions with per-path debouncing and
reference counting) is exported on its own for reuse.
