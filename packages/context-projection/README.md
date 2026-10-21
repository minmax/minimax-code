# @mavis/context-projection

Derived context view over the durable delta log: one manifest fold, one
incremental projector, one resume capsule. Types only — `Entry`/`Commit` are
imported from `@mavis/durable-backend-sqlite-zstd`'s `src/types.ts` (the
module the wave-1 contract pins); this package never opens a database.
Until the backend's `backend.ts` passes this strict typecheck (a pre-existing
wave-1 issue), the types are imported from the source file directly rather
than through the package specifier, whose `index.ts` would drag `backend.ts`
into the program.

## Contract

```ts
const manifest = buildProjection(entries);          // one left fold, log order, no leaf→root walk

const projector = new ProjectionService();          // optional: { residency: ResidencyPolicy }
const applied = projector.apply({ ...commit, entries }); // folds ONLY this commit's entries
applied.delta;                                      // derived view of the new entries alone
applied.rebuilt;                                    // true iff a control entry forced a full refold

projector.manifest();                               // structurally equal to buildProjection(all entries)
projector.capsule();                                // { head, firstKeptEntryId, usageAnchor, appliedSeq }
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
  `firstKeptEntryId` and records the mark; `mcode.context_edit`
  (`{ removedEntryIds }`) prunes segments. Unknown ids are rejected.
- **Incrementality** — `apply()` folds just the incoming batch into the
  cached state (head-keyed cache, the pi-durable `da866ada1` idea); a full
  refold of the retained log happens ONLY on `mcode.compaction` /
  `mcode.context_edit`. `apply()` is atomic on failure: a rejected commit
  leaves the retained log and the cached state untouched, so the corrected
  commit can be retried at the same sequence and later rebuilds never fold a
  failed batch. One shared fold step makes incremental application identical
  to `buildProjection` over the whole log, and the test suite pins that
  equivalence.
- **Resume** — the capsule is the whole resume state: read it, then project
  the slice from `firstKeptEntryId` to `head`. No leaf→root traversal.
- **Context MMU** — the projection stores handles, not content. Without a
  policy every page is resident and `fault()` resolves locally; a
  `ResidencyPolicy { resident, onFault }` demotes pages and materializes them
  on demand.

The service retains every applied entry in memory so a control commit can
refold the full log; trimming the retained log at compaction boundaries is
left to a later wave.

`apply()` takes the backend `Commit` enriched with its batch entries
(`CommitWithEntries`): the backend commit is a write result and does not
carry the entries the fold needs, while the caller of `appendBatch` already
holds both.
