# @mavis/context-compaction

Context compaction for long agent sessions: a semantic port of the pi v1.3
compaction core (`portSemantics` — own module, pi behaviors preserved, not a
copy) laid over the durable, append-only entry log.

## Contract

```ts
const outcome = await compact({ entries, summarizer, tokenBudget });
if (outcome !== null) await session.append([outcome.draft]);   // mcode.compaction

const scheduler = createBackgroundCompactionScheduler({
  budgets: { tokenBudget: 200_000, byteBudget: 8 << 20 },
  session, summarizer,
});
const { level, job } = scheduler.notify();   // after every commit
if (level === 'blocking') await job;         // ≥ 90% of a budget

const { result } = await runWithOverflowRecovery({
  attempt: () => turn(),
  compact: () => scheduler.runBlocking(),
  failedAttemptEntryIds: () => attemptEntryIds,
  appendEntry: (draft) => session.append([draft]),
});
```

## Semantics (ported from pi v1.3)

- **Cut points** — the cut may land only at `user`, `assistant`, or `custom`
  messages, NEVER at a `toolResult` (it must follow its tool call). Walking
  backwards from the newest entry, the first boundary crossing
  `keepRecentTokens` (default 20000) snaps forward to the closest valid cut
  point, so trailing tool results keep their assistant tool call even when
  they overflow the budget alone.
- **Split turn** — when the cut lands mid-turn, TWO summaries are generated
  (history + turn prefix) and merged with the exact glue
  `"\n\n---\n\n**Turn Context (split turn):**\n\n"`. A split turn with an
  empty history falls back to the previous checkpoint's summary.
- **Durable checkpoint** — the outcome is a draft of one append-only entry,
  kind `mcode.compaction`, carrying `summary`, `firstKeptEntryId`, the
  FROZEN `systemMessage`, and token accounting. Nothing is ever rewritten or
  deleted: projection derives the short window from the log, the original
  entries stay readable byte-for-byte. `firstKeptEntryId` always names a
  CONTEXT-VISIBLE entry (a cut is never parked on audit/control bookkeeping):
  the projection fold resolves the id against visible segments only, so an
  invisible id could never be applied and would wedge the session at that seq.
  The id resolves to a RAW LOG POSITION: everything appended before that
  position leaves the window — including entries a previous checkpoint had
  kept visible (a kept tail precedes its summary in the log) — and only the
  WINNING checkpoint contributes its summary, so a checkpoint named by a
  later checkpoint's `firstKeptEntryId` projects empty. Only an
  `mcode.compaction` KIND can freeze the system prompt; a compaction-shaped
  payload on any other entry kind is inert bookkeeping. The usage tracker's
  incremental counters mirror exactly these rules (raw-index kept filter,
  previous-checkpoint exclusion, kind-checked freeze).
- **Overflow recovery** — an overflow failure compacts once and retries the
  attempt EXACTLY once. A second failure records a `mcode.context_edit`
  omission entry hiding the failed attempt's entries and propagates.
- **Scheduler** — double trigger (tokens: usage anchor + `chars/4` of the
  trailing messages, image = 4800 characters; bytes: Σ UTF-8 byte lengths of
  the PROJECTED WINDOW — kept entries, the winning checkpoint payload and
  the active system prompt). Both axes are maintained INCREMENTALLY
  (`WindowUsageTracker`: O(delta) per appended entry, per-entry estimates
  memoized and pruned back to the live window after every ingest — O(window)
  memory, `notify()` never re-reads or re-stringifies the log), and the
  byte axis RESETS when a checkpoint cuts the window: audit/control
  bookkeeping (`mcode.owner-input.received` and friends) contributes
  nothing, and entries behind a checkpoint leave the axis instead of
  re-firing blocking forever. The provider-payload byte truth is the wire
  compiler's `CompiledBody.totalBytes`; this window axis is the conservative
  trigger. 75% of any budget -> background compaction; 90% -> blocking (the
  caller awaits the returned job). Control-plane priorities P0–P4: the
  background job holds the writer gate ONLY for the final append, at P4 —
  the summarizer runs with no writer held, and every queued urgent commit
  (P0–P3) is granted first.
- **≤ 90% target (best effort)** — with `tokenBudget` set, `keepRecentTokens`
  is clamped (`resolveKeepRecentTokens`) so the requested kept tail plus a
  summary headroom (default 2048 tokens) stays within 90% of the budget.
  The clamp is a REQUEST: cut granularity is one turn and the never-on-
  toolResult invariant wins over the clamp, so a kept tail ending in a giant
  trailing tool result can overshoot 90% (pi behaves the same).
  `CompactionOutcome.estimatedTokensAfter` reports the honest measured
  estimate either way, and a usage anchor behind a checkpoint or omission is
  treated as stale (pure re-estimate) instead of inflating the trigger.
- **Summarizer seam** — the summary backend is an injected
  `async (prompt: string) => string`; `serializeConversation` flattens the
  conversation for it (tool results truncated to 2000 characters, thinking
  excluded).

## Entry kinds

| Kind | Payload |
| --- | --- |
| `mcode.message` | a `CompactionMessage` |
| `mcode.system` | `{ text }` — the frozen system prompt |
| `mcode.compaction` | `CompactionEntryPayload` (summary, firstKeptEntryId, frozen systemMessage, …) |
| `mcode.context_edit` | `{ action: 'omission', targetIds, reason }` — hides targets from projection |

Payloads are plain JSON, structurally compatible with `EntryDraft` of
`@mavis/durable-backend-sqlite-zstd`; as with the storage worker's pinned
contract, the shapes are declared locally so this package compiles and tests
without importing the backend. Generated entry ids use `randomUUID`, so they
stay unique across process restarts.

## Layout

- `src/estimate.ts` — `chars/4` estimation, usage anchor, manifest bytes, trigger evaluation
- `src/cut-point.ts` — the never-on-toolResult cut point
- `src/project.ts` — omission + compaction projection of the raw log
- `src/serialize.ts` — summarizer serialization and prompts
- `src/compact.ts` — the compaction pipeline and split-turn merge
- `src/overflow.ts` — exactly-once overflow recovery and omissions
- `src/gate.ts` — P0–P4 priority writer gate
- `src/scheduler.ts` — BackgroundCompactionScheduler (75% / 90%, double trigger)
