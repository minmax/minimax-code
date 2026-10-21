# @mavis/context-projection

Derived context view over the durable delta log: one manifest fold, one
incremental projector, one resume capsule. Types only — `Entry`/`Commit` are
imported from `@mavis/durable-backend-sqlite-zstd`'s `src/types.ts` (the
module the wave-1 contract pins); this package never opens a database.
The types are imported from the workspace-relative source file rather than
through the package specifier: the specifier's `import` condition resolves
to `dist/index.js`, which does not exist until the integrator builds the
workspace (and whose `index.ts` would also drag `backend.ts` into the
program). Switching to the specifier is a two-line change once `dist/`
exists.

## Contract

```ts
const manifest = buildProjection(entries);          // one left fold, log order, no leaf→root walk

const projector = new ProjectionService();          // optional: { residency: ResidencyPolicy }
const applied = projector.apply({ ...commit, entries }); // folds ONLY this commit's entries
applied.delta;                                      // derived view of the new entries alone
applied.rebuilt;                                    // true iff a control entry rewrote the derived view

projector.manifest();                               // structurally equal to buildProjection(all entries)
projector.capsule();                                // { head, firstKeptEntryId, compaction, usageAnchor, appliedSeq }
ProjectionService.fromCapsule(capsule, slice);      // lazy open: fold ONLY the retained slice
await projector.llmContext();                       // LLM-visible pages, faults non-resident ones
```

- **Fold semantics** — LLM-visible entries append one segment each
  (`{ entryId, byteLen, kind }`, `byteLen` = UTF-8 bytes of the canonical JSON
  payload); every entry advances `head` and the `(seq, ordinal)` watermark;
  the last LLM-visible entry id becomes the `usageAnchor`. The fold rejects
  any input that does not strictly advance in log order — ascending
  `(seq, ordinal)` with ordinals contiguous within each batch (a slice may
  start mid-batch, e.g. a resume from a capsule).
- **Kind filter** — entries whose kind starts with `mcode.` are audit/control
  and never become segments. `mcode.compaction`
  (`{ summary, firstKeptEntryId }`) cuts every segment before
  `firstKeptEntryId` and records the mark. `mcode.context_edit` carries ONE
  of two variants (anything else is rejected, never silently ignored): the
  cross-package omission format `{ action: "omission", targetIds }` — what
  `@mavis/context-compaction` writes — hides its targets (targets already
  gone stay gone), and the local strict prune `{ removedEntryIds }` removes
  exactly those segments, rejecting unknown ids.
- **Incrementality** — `apply()` folds just the incoming batch into the
  cached state (head-keyed cache, the pi-durable `da866ada1`) — control kinds
  included: their fold operates on the cached segments alone, so a control
  commit NEVER re-folds the history and NOTHING but the derived window is
  retained (RAM is bounded by the window, not by session length; a pinned
  test asserts the service holds no raw log). `apply()` is atomic on
  failure: a rejected commit leaves the cached state untouched, so the
  corrected commit can be retried at the same sequence. One shared fold step
  makes incremental application identical to `buildProjection` over the
  whole log, and the test suite pins that equivalence.
- **windowBytes** — the manifest carries `windowBytes` = Σ segment
  `byteLen`, maintained incrementally (O(delta) per commit; a compaction
  subtracts the cut prefix and RESETS the axis). This is the byte truth the
  compaction trigger's byte axis consumes — NOT the raw-log sum, and not the
  provider payload size (the wire compiler's `CompiledBody.totalBytes`).
- **Resume** — the capsule is the whole resume state (≤ a few hundred
  bytes; it carries the compaction mark, so the summary survives without
  re-reading the checkpoint entry): read it, range-read the retained slice
  `firstKeptEntryId … head`, and `ProjectionService.fromCapsule(capsule,
  slice)` folds exactly that. No full-log replay. Any slice/capsule
  inconsistency (wrong start, stale head or anchor) throws before a service
  is built.
- **Context MMU** — the projection stores handles, not content. Without a
  policy every page is resident and `fault()` resolves locally; a
  `ResidencyPolicy { resident, onFault }` demotes pages and materializes them
  on demand.

The service retains NO raw entries — control commits fold incrementally
through the same `foldEntry` step, so there is nothing to trim; memory is
bounded by the window at all times.

`apply()` takes the backend `Commit` enriched with its batch entries
(`CommitWithEntries`): the backend commit is a write result and does not
carry the entries the fold needs, while the caller of `appendBatch` already
holds both.
