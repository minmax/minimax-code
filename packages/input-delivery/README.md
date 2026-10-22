# @mavis/input-delivery

Input delivery status for the hybrid agent: the committed-state projection of
owner-input lines (node `mcode-input-delivery-status`,
steering-design-sol.md §2/§3/§7). One user line is ONE row; the receipt entry
(`mcode.owner-input.received`) and the placed entry
(`mcode.owner-input.placed`) merge into that row, joined by `inputEntryId`.
Technical control entries (`mcode.delegation.*`, the receipt itself) never
become rows of their own — their facts (delegation binding, blockers) are
absorbed into the row they belong to.

Runtime-dependency-free: facts enter through `register`/`transition` calls,
the package holds no durable state and no payload text. Content lives in the
durable receipt; durable deduplication lives in the native submissions keyed
by `(conversationId, requestId)`. The durable counterpart of the in-memory
active index is the `mcode.input-delivery` document of the steering contract.

## Usage

```ts
import { createDeliveryIndex } from '@mavis/input-delivery';

const index = createDeliveryIndex(); // options: { maxTerminalRetained?: number }

// Enter: the client draws the optimistic row (not yet a committed fact).
index.register('in_1', {
  requestId: 'req-1',
  conversationId: 'conv-parent',
  target: { conversationId: 'conv-parent', kind: 'parent' },
  whenBusy: 'steer',
});

// Committed facts only — the projection never guesses:
index.transition('in_1', 'saved', {
  submissionId: 'sub_1',
  receiptEntryId: 'r1',
  delegationId: 'dlg_1',
  childConversationId: 'conv-child',
  commitSeq: 7,
});
index.transition('in_1', 'admitted', { inputEntryId: 'in-entry-1', commitSeq: 9 });
index.transition('in_1', 'answered', { commitSeq: 12 });

index.get('in_1'); // terminal tombstone: { state: 'answered', active: false, ... }
index.active();    // the row left the bounded active index at the terminal transition
```

## Semantics

- States: `saving → saved/queued → admitted → answered`, or terminal
  `withdrawn` / `unanswered` / `failed`. Every state other than `saving`
  folds a COMMITTED fact; `admitted` asserts the placed entry entered the
  context exactly once and does not promise an answer. Replaying the same
  state is an idempotent no-op (identical facts only — a replay that
  introduces or changes a delegation/child binding is a conflict);
  contradicting facts (wrong join key, rebound delegation, non-advancing
  `commitSeq`) throw `DeliveryIndexError`. Transitions are ATOMIC on
  failure: a rejected fact never mutates the row — its stored `commitSeq`
  watermark, blocker and bindings included — so the corrected retry of the
  same committed fact is accepted, not dismissed as stale forever.
- Fail-closed state machine: `admitted → withdrawn` does not exist (an
  admitted input is part of the context and never becomes "undelivered" —
  its answer may still end `unanswered`); `withdrawn` is reachable only from
  `saved`/`queued` (native `submission.abort()` retracts pending work only);
  terminal states are final.
- One row per input: `get`/`active()` return projections of input lines,
  never of entries. Entry ids of receipts and placements are not addressable
  as rows.
- Quick actions as data: each projection carries the actions available NOW
  (`background` «В фон», `stop-delegate` «Остановить делегата», `withdraw`
  «Отозвать», `copy-to-child` «Копия ребёнку», `task-query`/`task-output`
  log navigation), each with an explicit target (delegation, conversation or
  input) and the localized product label. Availability rules: `withdraw`
  only before admission; «В фон» only while the wait may still be foreground;
  `copy-to-child` survives admission on purpose (it creates a NEW linked
  child submission); delegation-bound actions require a committed
  `delegationId`; `saving` and terminal rows offer no actions. The label of
  «Остановить дерево» (`stop-tree`) is declared in the action vocabulary for
  completeness, but the per-input derivation never emits it: a subtree stop
  targets the delegation tree and belongs to the delegation supervisor's
  stop-cascade surface.
- Snapshots are deep-frozen: `get`/`active()` hand out immutable projections
  (nested targets, actions and history records included), so a consumer can
  never reach into the internal row state.
- Bounded by construction: terminal rows leave the active index in the
  committing transition. A small LRU of tombstones (default 64,
  `maxTerminalRetained`) keeps recent terminal rows addressable for late
  `get`s; evicted ids throw `unknown-input`. Re-registering a terminal id is
  rejected — the durable submissions remain the only dedup authority.
