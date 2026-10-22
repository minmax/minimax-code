# @mavis/durable-seam

The mandatory steering seam (Ф1 of the steering design): **transaction-scoped
composition over the wave-1 durable storage contract**
(`@mavis/durable-backend-sqlite-zstd`, the append-only `sessions.gN.db` entry
log with atomic batch commits, indexed point reads, and single-writer
owner-epoch fencing).

The seam exists because the storage contract composes entries atomically, but
admission and finalization need NAMED atomic compositions. A pair of
independent `submit()` / `write()` calls is never a `T_accept`; this package
is the place where those compositions live.

## Primitives

| Primitive | Transition | Composition |
| --- | --- | --- |
| `acceptOwnerInput({conversationId, requestId, content, whenBusy})` | `T_accept` | ONE commit: submission entry + receipt entry (`mcode.owner-input.received`) + delivery-index update → `{submissionId, inputEntryId, commitSeq}` |
| `openForegroundWait({waitId, toolCallId, ...})` | wait anchor | ONE commit: the foreground wait the release/completion transitions act on |
| `prepareRelease({waitId, expectedVersion})` | `T_release` (phase 1) | ONE commit: `mcode.delegation.backgrounded` control entry carrying the replayable prepared outcome, under a `stateVersion` CAS |
| `finalizeTool({toolCallId, outcome})` | `T_complete` | ONE commit: the single tool-result of the `toolCallId`; completes a foreground wait in the same commit |

Guarantees:

- **Dedup.** The key is `(conversationId, requestId)`. Entry ids are derived
  deterministically (`mcode:receipt:<hash>`, `mcode:submission:<hash>`), so
  dedup is a point read through the entry log's index — durable across
  restarts, no seam-private table. The compared payload is the FULL call —
  `content` together with `whenBusy`, `actor`, and `route` — so a repeat that
  changes the routing wish under an accepted key is a conflict, not a replay.
  Same payload → the original `{submissionId, inputEntryId, commitSeq}` with
  `status: 'replayed'` and no second commit. Any difference →
  `REQUEST_ID_CONFLICT`.
- **Backpressure.** An input whose canonical JSON exceeds the admission
  budget — `min(maxInputBytes, port batch budget − seam overhead)` — is
  refused with `INPUT_TOO_LARGE` BEFORE any durable attempt (the "big paste"
  edge case); the client keeps the text. Oversized payloads that must be
  accepted go through a CAS reference (out of scope here).
- **CAS.** Every wait transition takes `expectedVersion`. `stateVersion`
  starts at 1 and advances once per durable transition; a stale expectation is
  a `VERSION_CONFLICT` carrying the current version. Owner-epoch loss surfaces
  as `OWNER_LOST` (fencing re-checked inside every backend commit).
- **Exactly-once anchors.** A `waitId` anchors one delegation tool-round: a
  duplicate `openForegroundWait` with a different tool call or conversation is
  a `WAIT_ID_CONFLICT`, a repeat of the same identity replays — including a
  wait that already went terminal, judged from its deterministic entries.
  The anchor is exclusive in BOTH directions: a `toolCallId` anchors at most
  one wait (a second `waitId` over an anchored tool call is a
  `WAIT_ID_CONFLICT`), and a finalized tool call cannot anchor a new wait
  (`TOOL_RESULT_CONFLICT`) — otherwise two waits could race for the single
  outcome slot of `T_complete`. `prepareRelease` refuses a foreground wait
  whose tool call is already finalized for the same reason.
- **Crash between phases.** `backgrounded` is irreversible for a `waitId`. A
  crash after `prepareRelease` and before finalization leaves a pending
  prepared outcome (`listPendingPrepared()`); the restarted process finalizes
  with the stored outcome verbatim — same outcome replays the original commit
  (reporting the same wait view as the original commit), any other outcome is
  a `TOOL_RESULT_CONFLICT`. A `toolCallId` is finalized exactly once, ever.
- **Bounded projection.** The active registry (and therefore the snapshot
  riding every commit) holds only foreground waits and backgrounded-not-yet-
  finalized waits plus active deliveries. Terminal waits and settled inputs
  LEAVE the projection — their durable state lives in the entries — so the
  snapshot never grows with history and every commit stays far below the
  storage batch cap.

## What this package is NOT

- No inbox of its own: dedup and replay live in the entry log's index.
- No SQL: the core speaks only the `DurableLogPort`; `sqliteZstdDurableLogPort`
  adapts the wave-1 backend (type-only import — nothing loads the backend at
  runtime), and a test double stands in for other logs.
- No execution loop and no supervision policy: it records transitions and
  prepared outcomes; acting on them stays with the runtime layers.

## State machines

```text
wait:   foreground --T_release--> backgrounded --finalize--> (leaves projection)
             \----T_complete----> (leaves projection)
input:  accepted (delivery active) --settleDelivery--> terminal (index only)
```

`getWait`/`listWaits`/`waitByToolCallId` are projections of ACTIVE waits; a
terminal wait's durable state is its entries and stays reachable through the
idempotent primitives (a repeat `prepareRelease`/`openForegroundWait` is
answered from the deterministic entries).

## Entry kinds

All app records are plain entries of the storage contract:

| Kind | Meaning |
| --- | --- |
| `mcode.owner-input.submission` | native input submission record (dedup anchor) |
| `mcode.owner-input.received` | immutable receipt: ids, route, `whenBusy`, `contentHash`, content. No `model`, no `head`, no `edits` — it never shifts the model boundary |
| `mcode.delegation.wait-opened` | foreground wait anchor |
| `mcode.delegation.backgrounded` | T_release decision: control entry + prepared background outcome. THE canonical record of the wait outcome — this seam is its single writer; the delegation supervisor projects it (its index document is a different kind) and its reducer joins these entries by waitId. The prepared outcome carries the release `operationId` (§3: "один переход с одним operationId/CAS"), deterministic `release:<waitId>` when the caller omits one. Legacy pre-unification flat `{delegationId, …}` entries of the same kind are skipped on replay (not seam decisions) |
| `mcode.delegation.tool-result` | T_complete: the one tool result of a `toolCallId` |
| `mcode.input-delivery.settled` | terminal removal from the bounded active delivery index |
| `mcode.seam.snapshot` | bounded active-state snapshot shipped inside every seam commit |

## Recovery

Every seam commit carries the active-state snapshot (waits, pending prepared
outcomes, active deliveries — bounded by active objects; terminal records
leave). On open, recovery probes the snapshot chain via deterministic ids
(`mcode:seam:snapshot:<revision>`) with O(log revisions) point reads, seeds
the registry, and replays only the forward delta after it. A log without
snapshots recovers by full replay and lands on the same registry.

## Tests

```sh
pnpm test            # from the package directory
```

Covers: atomic rollback (injected crash before commit; owner-epoch refusal on
the real backend), restart recovery (close/reopen, prepared-outcome
reproduction across two restarts), dedup and `REQUEST_ID_CONFLICT` (in-process
and across restarts, including `whenBusy`/`actor`/`route` as payload), CAS
conflicts, terminal-wait refusals, exactly-once tool results, wait-identity
conflicts, `INPUT_TOO_LARGE` backpressure derived from the storage batch cap,
bounded snapshots under sustained history (in-memory and a 16 KiB-capped real
backend over 120 open+finalize cycles), and the O(log revisions) snapshot
probe observed through a counting port.
