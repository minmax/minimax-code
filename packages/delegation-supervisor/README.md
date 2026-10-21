# @mavis/delegation-supervisor

Durable ownership of delegated child conversations for the hybrid agent — the
supervision layer of `steering-design-sol.md` §3 (T_spawn / ownership /
supervision). A foreground `task` call never owns the child it starts: the
child conversation belongs to a stable **supervisor task** placed at the
native background ownership boundary, while the foreground call holds only a
**wait handle**. That keeps the two state machines independent:

```text
wait:  foreground --T_release--> backgrounded   (irreversible per waitId)
                    \-T_complete--> completed
child: running --> stopping --> terminal
```

## API

```ts
import { DelegationSupervisor, sqliteZstdDelegationLog } from '@mavis/delegation-supervisor';

const supervisor = await DelegationSupervisor.open({ log: sqliteZstdDelegationLog(backend) });

// T_spawn — atomic: supervisor task + child conversation + delegation record
// + foreground wait, one durable batch.
const spawn = await supervisor.spawnDelegation({
  parentConversationId, parentRunId, toolCallId,
  childSpec: { prompt: 'explore the repo', supervision: { cancelOnParentAbort: true } },
});
spawn.wait.promise.then((result) => {
  // 'backgrounded' → finish the tool call with the standard background result;
  // 'completed' → the child outcome IS the final tool result.
});

// T_release — the one irreversible wait transition (auto-detach / manual).
await supervisor.detachToBackground({ delegationId, reason: 'owner-input' });

// T_complete — exactly one delivery: the foreground consumer, or the
// deduplicated background reporter.
await supervisor.complete({ delegationId, childRunId, outcome });

// Stop cascades and supervision.
await supervisor.stop({ rootDelegationId });
await supervisor.parentAborted({ parentConversationId, explicitStop: false });
await supervisor.recordChildTerminal({ delegationId, terminal: 'stopped', reason });

// R3 fork compatibility.
await supervisor.forkChild({ delegationId });
```

## Guarantees

**Atomic T_spawn with replay.** The spawn key is
`(parentConversationId, parentRunId, toolCallId)`. A replay under the same key
joins the existing child submission (same `delegationId`, `childConversationId`,
`childSubmissionId`, `waitId` — the same live wait handle) instead of creating a
second executor; a replay with a different child spec raises
`DELEGATION_KEY_CONFLICT`. All ids are deterministic functions of the key
(`ids.ts`), so the ids survive crashes without counters or clocks.

**Exactly-one completion delivery.** `complete` chooses the foreground consumer
while the wait is foreground, otherwise the deduplicated reporter with the
stable `requestId = delegation:<id>:completion:<childRunId>` and a submission id
derived from it. The completion and the reporter record commit in ONE batch, and
the entry ids are deterministic — repeating the completion (also after a crash
and recovery) returns the same submission and writes nothing. A completion under
a different `childRunId` is refused: it is new work (`task_append`), not a
duplicate of the first result.

**Stop cascades with operation-id dedup.** `stop` walks the supervision subtree
breadth-first (visited set) and commits one `mcode.delegation.stop-requested`
entry per RUNNING node, all under one shared `operationId`. Nodes already
stopping/terminal are skipped, a replay of the same operation commits nothing,
and a fresh cascade derives the NEXT operation id from the committed cascade
count — so replays can never be swallowed and new cascades can never collide.

**cancelOnParentAbort survives the auto-detach.** The supervision policy is
stored ON the delegation at spawn. While the wait is foreground, any parent
abort stops the child (`cause: 'parent-abort'`). After a backgrounded detach, a
plain parent abort does NOT stop the child; an explicit parent Stop
(`explicitStop: true`) still does (`cause: 'parent-stop'`) — the stored link, not
a live promise. Children spawned with `cancelOnParentAbort: false` (explicitly
background tasks) survive even the explicit Stop. A completion always wins over
a stop: it is saved and delivered by the wait state.

**R3 fork compatibility.** `forkChild` creates a new delegation branch with its
OWN conversation, inbox id, delivery index id, delegation index id, and epoch
seed; the fork's record marks inherited receipts as `history` (never pending
commands) and starts detached (`waitState: 'none'`), so its completion is
reporter-delivered.

**Recovery.** Recovery is proportional to ACTIVE state, not to history length.
Every transition batch ends with its index-document entry, so `open` restores
from the LATEST document found by O(log revisions) point reads over the
deterministic entry id `mcode.delegations.document:<revision>` (exponential
probe + binary search) plus ONE payload decode — foreign entries sharing the
log are never scanned (`mode: 'document-checkpoint'` in the recovery report).
Logs without any document entry fall back to a bounded full replay
(`mode: 'entry-replay'`). After restore, `open` re-materializes foreground
waits (decided waits are materialized on demand with their recorded outcome and
create no idle waiters), reports `stopping`-without-terminal as pending work,
and repairs a committed reporter completion whose submission record is missing —
under the SAME requestId.

Records that aged out of the bounded terminal tail stay reachable: `getDelegation`
and every operation on an evicted record re-adopt it by bounded anchor replay
(only the delegation's own transition entries, from its spawn/fork entry
forward), re-discovering tree children from their durable spawned payloads so a
re-adopted parent never looks childless to a stop cascade. Spawn replays check
the deterministic spawn entry id durably before writing, so a replay joins the
prior child submission unconditionally — even after eviction.

## Persistence

Every transition is ONE atomic batch of canonical `mcode.delegation.*` entries
plus the updated `mcode.delegations` index document, committed through the
narrow {@link DelegationLog} port. `sqliteZstdDelegationLog` adapts the
`sqlite-zstd` durable backend structurally (no runtime dependency on the
backend package): the backend's `appendBatch` is the atomic multi-entry commit,
its entry-id primary key is the durable dedup layer under the deterministic
entry ids, and its single-writer epoch fencing guards the whole log.

The index document keeps active delegations plus a bounded terminal tail
(`maxTerminalRecords`, default 64); older terminals stay readable through the
bounded anchor replay (`getDelegation` re-applies only the delegation's own
transition entries from its spawn/fork entry forward). All mutating operations
are serialized through one in-process queue — the single durable-writer
discipline; the committed entries are re-applied through the same reducer
recovery uses, so live and recovered state cannot diverge.

## Scope notes

- This package is the supervision anchor, not the tool executor: the native
  tool finalizer turns the delivered outcome/background handle into the one
  tool result; the reactive release control drives `detachToBackground`.
- Payloads must stay JSON-serializable and small enough for the backend's
  256 KiB batch cap; large child payloads belong in CAS with references.
- Fork branches are independent supervision roots: stopping a delegation does
  not implicitly stop its forks (a fork is a deliberate new continuation).
