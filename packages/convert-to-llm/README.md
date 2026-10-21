# @mavis/convert-to-llm

Per-entry conversion of durable entries into provider-format records — the
memoizable stage of the wire compiler (architecture node `pi-convert-to-llm`,
adapt decision; final-architecture.md §1.2, §2).

## Why per-entry

The superseded `mcode-outbound-projection` normalized the whole history on
every request (O(history), and its reminder mutation broke provider
prompt-cache bytes). Here every entry converts independently and
deterministically, so the wire compiler can memoize results by:

```
cacheKey = `${entryId}@${dialect.name}#v${dialect.normalizerVersion}`
```

Normalizations from the mcode outbound path are preserved as per-entry rules
of the built-in `minimax-m3` dialect: thinking blocks are cut, text blocks
join, tool-call deltas project to provider `tool_calls`, `toolResult`
messages become `tool` records, images become deterministic placeholders.

## Contracts implemented

- **Per-entry conversion** — `convertEntry(entry, dialect)` returns a
  `CompiledEntry | null`; identical inputs give byte-identical records.
- **Audit/control exclusion** (steering D+C, node `mcode-input-delivery-status`)
  — kinds prefixed `mcode.` never reach the provider payload, except the two
  model-visible control kinds: `mcode.owner-input.placed` and
  `mcode.system-reminder`.
- **Placed entry exactly once** — repeated placements of the same
  `inputEntryId` (crash between the admission commit and the delivery-index
  update) dedup, first log occurrence wins.
- **Reminder tails** (node `mcode-system-reminder`) — reminder records are
  positioned strictly AFTER the stable cache prefix; stored user messages are
  never mutated. Embedded `<system-reminder>` blocks split out of user text
  deterministically (`entryId#reminder:N`).
- **Immediate-send batching** — entries sharing
  `hostMetadata.immediateSendBatchId` merge into one user record at the first
  member's position (`outbound-message-normalizer` semantics).

`DurableEntry` mirrors `Entry` from `@mavis/durable-backend-sqlite-zstd`;
`Segment` mirrors the context-projection segment shape (`{entryId, byteLen,
kind}`). `CompiledEntry.byteLen` measures the serialized provider record (the
wire segment body); the projection's `Segment.byteLen` measures the raw
stored payload — both are kept available because budgeting (byte guard) and
compilation (segment bytes) answer different questions. The contract types
are declared locally on purpose: wave-2 packages do not link each other in
`node_modules` until the integrator registers them (wave-1 precedent,
`storage-worker/src/contracts.ts`).

## API

| Export | Role |
|---|---|
| `convertEntry(entry, dialect?)` | Per-entry stage; `null` for audit/control, reset boundaries, undecodable or content-less entries |
| `convertEntryTails(entry, dialect?)` | Reminder blocks split out of a user entry (dedicated reminder entries return `[]`) |
| `convertBatch(entries, dialect?)` | Merge a batch group into one user record |
| `assemblePayload(entries, opts?)` | Ordered payload: stable prefix first, reminder tails last, with `AssembleStats` |
| `serializeCompiledEntry(record)` | Fixed-key-order JSON body; `byteLen` measures exactly this |
| `MINIMAX_M3_DIALECT`, `compileKey`, `compileBatchKey` | Dialect identity and cache keys |
| `isAuditControlKind`, `isVisibleControlKind`, `isPlacedEntryKind`, `isReminderEntryKind` | Kind policy predicates |
| `extractReminderBlocks`, `splitUserReminders`, `buildReminderTail` | Reminder mechanics |

## Rule-change discipline

Any change to a dialect rule MUST bump `Dialect.normalizerVersion`. Cache
keys include the version, so a bump invalidates only the rule change and
never mixes bytes from two rule sets.

## Tests

```sh
pnpm test        # or: npx vitest run --config vitest.config.ts
pnpm typecheck
```

Coverage mirrors the acceptance criteria: determinism (byte-identical records
over repeated assembly), placed-entry dedup, tail positioning after the
prefix (prefix bytes stable as reminders grow), audit exclusion, batching.
