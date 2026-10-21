# @mavis/speculation

Speculative pipeline skeleton (F5 groundwork). No speculative execution ships
in this package: it is the classification, permission pre-decision, budget and
metrics plumbing the later pipeline consumes.

## Contents

- **Tool classifier** (`src/classifier.ts`) — the 38 canonical builtin tools
  mapped to `speculatable-read-only` / `effectful` / `interactive`. The
  default table is derived from the tool descriptions in
  `packages/agent-tools`; callers can pass the live registry as a descriptor
  list and/or override individual names. Unknown tools fail closed to
  `effectful`.
- **Permission pre-decision** (`src/pre-decision.ts`) — the
  `PermissionPreDecision` seam with the contract that an `ask` verdict is
  never substituted by an automatic decision: composition is
  strictest-wins (`deny` > `ask` > `allow`) and the decision → execution-mode
  mapping always routes `ask` to the real permission prompt.
- **Speculation budget** (`src/budget.ts`) — bounds on parallel speculative
  calls and outstanding tokens; a committed steering change
  (`notifySteeringChanged`) cancels every in-flight lease (settles it as
  wasted, releases reservations, wakes cancel listeners) and starts a new
  steering epoch.
- **Metrics** (`src/metrics.ts`) — the `speculated` / `confirmed` / `wasted`
  counters with the settle-once invariant `confirmed + wasted ≤ speculated`.

## Tests

```sh
pnpm test        # package-local vitest run
pnpm typecheck
```

The package-local `vitest.config.ts` keeps the suite runnable before the
files are registered in `test/vitest-suites.json`; the repository gate keeps
using the root config.
