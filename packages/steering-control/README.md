# @mavis/steering-control

Reactive delegation control for foreground steering — the
`mcode-reactive-delegation-control` node of `steering-design-sol.md` (§2,
§7). When a committed parent steer wakes the control channel, this package
finds the parent's `ForegroundWaitSet` and performs the single durable
release transition (`T_release`), so the parent's tool-round ends with the
one standard background tool-result and native steering admits the input —
while the child keeps running with its original rights and budget.

Not a second execution loop: the durable writer, the permission gateway, the
delegation supervisor and the turn-system live in their own packages. This
package is the caller of two integrator seams.

## API

```ts
import { createReactiveControl } from '@mavis/steering-control';

const control = createReactiveControl(seam, { effectFence, clock, maxWaitsPerRound });

control.onCommittedSteer(steer);   // → Promise<ReleaseResult | null>
control.registerWait(registration); // → WaitHandle
control.blockers(filter?);          // → ActiveBlocker[]
control.recover();                  // → Promise<RecoveryReport> (startup)
```

- `onCommittedSteer` reacts to a steer whose receipt is already committed
  (acceptance, dedup and `whenBusy` discrimination happened upstream in the
  turn-system). It releases the parent's active wait set with
  `reason="owner_input"` and returns `null` when nothing is active (the child
  finished first — the normal result path, no detach needed).
- `registerWait` is the parent side of `T_spawn`. Registering the same key
  `(parentConversationId, parentRunId, toolCallId)` again is a replay: it
  attaches to the same `WaitHandle`, including a settled one whose saved
  outcome is returned. The waiter awaits `handle.outcome` — exactly one
  outcome per waitId, `completed` or `backgrounded`.
- `blockers()` lists delegation waits still blocking their tool-rounds (the
  TUI names the remaining blocker). Non-delegation long tools are never
  registered here and are never faked by a release; the caller's own
  tool-round view reports them.
- `recover()` reproduces prepared-but-unfinalized outcomes after a crash
  between the release commit and the finalization commit.

## Seams (implemented by the integrator)

**`DelegationControlSeam`** — the transaction-scoped bridge to the native
durable writer (§3, "обязательный seam Ф1"):

- `prepareRelease` is `T_release`: validate owner-epoch / run-wait IDs /
  `stateVersion` (throw `StaleStateVersionError` when stale), choose the
  `backgrounded` outcome, persist background handle + control entry +
  replayable prepared outcome — and resolve only AFTER the commit.
- `finalizeTool` is the native tool finalizer: exactly one final tool-result
  per `toolCallId` — the standard background result with the SAME stable task
  ID; idempotent per `operationId` (`replayed: true` on redelivery).
- `listPreparedReleases` exposes prepared-but-unfinalized outcomes for
  bounded startup recovery (never a full-history scan).
- `flushUrgent` (optional) forces the short control-plane flush bypassing the
  ≤200 ms batching window.

**`EffectFence`** — the permission-gateway half of the post-detach effect
fence (§4): after a release the controller engages it; while engaged the
gateway must refuse new conflicting parent effects immediately with the
`DELEGATION_EFFECT_BLOCKED` tool-error (plus task IDs and a way forward),
never by parking the effect until the child finishes. Disengagement after
proven child completion / safe stop is the supervisor's concern.

## Guarantees covered by the suite

- **Release ≤250 ms** (gate §6.2, test clock): `elapsedMs` on the release
  result measures saved-ack → committed release; the control path adds no
  timers and bypasses the batching window (`urgent` request + `flushUrgent`).
- **One outcome per waitId**: settle-once state machine
  (`foreground → releasing → settled`); the claim happens before the durable
  prepare, duplicate steers are no-ops, replays get the saved outcome. A child
  completion refused inside the claim→prepare window is replayed if the
  release is refused and superseded if it commits — `outcome` always settles.
- **Failed finalization never wedges anything**: the committed prepared
  outcome stays registered; the next steer or `recover()` retries the
  idempotent finalization (same `operationId`, no child restart). The wait is
  never rolled back to foreground after its release decision committed, and
  every control-plane job completes.
- **Bounded wait set**: one set per tool-round, capacity fails closed with
  `WaitSetOverflowError`.
- **Crash mid-release**: recovery reproduces the prepared outcome once
  (`replayed` on redelivery), never restarts the child, re-engages the fence.
- **Priorities P0–P4**: queued cancel/permission preempts queued lower lanes;
  a running atomic job is never interrupted.

## Package wiring (integrator)

The package is not yet registered in the repository plumbing; the integrator
owns: `pnpm-workspace.yaml`, `packageRoots` in `release/extraction.json`,
`pnpm gen:tsconfig` (export paths), `test/vitest-suites.json` and
`node scripts/source-inventory.mjs --write`. Local iteration:
`pnpm --filter @mavis/steering-control test` or
`../../node_modules/.bin/vitest run --config vitest.config.ts`.
