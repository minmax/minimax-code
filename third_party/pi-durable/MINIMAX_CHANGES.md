# MiniMax local changes for pi-durable and chord

This directory (`third_party/pi-durable`, plus its sibling `third_party/chord`) vendors two packages from the `pi` monorepo as source so MiniMax can integrate and patch the durable runtime and its typed host runtime without waiting on upstream release cadence.

- `third_party/pi-durable` ← upstream `packages/durable` (imported name: `@minimax/local/pi-durable`)
- `third_party/chord` ← upstream `packages/chord` (imported name: `@minimax/local/chord`)

## Upgrade policy

Upstream is never upgraded without a deliberate rebase. Do not bump the pin, copy newer sources over this tree, or cherry-pick upstream commits casually; any re-import must consciously re-apply the local changes listed below, refresh this pin, and be reviewed as a separate change.

## Import baseline

- Upstream: `https://github.com/earendil-works/pi.git`
- Ref: base commit recorded from `git -C /Users/pavel.karataev/projects/agents/pi rev-parse HEAD`
- Commit: `48c8f322844087ff6cd80885f093ad44557647d1`
- Commit date: 2026-10-20 15:09:25 +0200 (`feat(chord): exclusive SQLite operations and a replicated connection wrapper`)
- Imported at: 2026-10-20

The copied trees are byte-identical to upstream at that commit (verified with `diff -rq`), except for the local changes below.

## Local patch ledger

Baseline import; no upstream source files are changed.

- `pi-durable/package.json`: `name` changed from `@earendil-works/pi-durable` to `@minimax/local/pi-durable`.
- `chord/package.json`: `name` changed from `@earendil-works/chord` to `@minimax/local/chord`.
- Both renames exist only to avoid colliding with pi's npm publication. Dependency declarations still reference the upstream internal names (`@earendil-works/*`) on purpose.
- `../../tsconfig.base.json` (repository `src/tsconfig.base.json`): created for this vendor import, content identical to the upstream `pi` root `tsconfig.base.json`, because both vendored `tsconfig.build.json` files extend `../../tsconfig.base.json`.

### 2026-10-21 — removed the `test` scripts (MiniMax-specific glue, not upstream material)

- Affected: `pi-durable/package.json` (`test` script: `vitest --run && PI_DURABLE_DOCUMENT_RETENTION_MS=0 vitest --run && npm run test:workers` removed), `chord/package.json` (`test` script: `vitest --run` removed).
- Reason: both suites require the full upstream monorepo that this distribution does not vendor — `test/telemetry-sqlite.test.ts` imports `../../telemetry/src/testing/index.ts` (no `third_party/telemetry` exists), pi-durable tests import `../../ai/src/api/*.ts` (no `third_party/ai`; see "TypeScript paths left dangling on purpose") and resolve `@earendil-works/pi-codemode` (declared, not vendored) — and chord's `test/context.test.ts` calls `addLink`, which the vendored `@earendil-works/pi-telemetry@1.3.0` spans do not implement. Their suites are excluded from this distribution's verification per `src/AGENTS.md` ("Their test suites are not part of this distribution's verification"); keeping the scripts only made the workspace-wide `pnpm -r test` fail (`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @minimax/local/chord@1.3.0`).
- Failure counts at removal time: chord 3 files / 2 tests failed of 50 files / 548; pi-durable 45 files / 632 tests failed of 70 files / 1170.
- `pi-durable`'s `test:workers` script is kept — `pnpm -r test` never invokes it.
- Validation: `pnpm -r test` green across all workspace packages (2026-10-21); `node scripts/run-vitest-suite.mjs status-contract|policy|sandbox` green.

## Required from the integrator

Dependency declarations were left untouched; the integrator must resolve them on the next step. Both packages declare `engines: node >=22.19.0`.

### pi-durable (`@minimax/local/pi-durable`)

Internal (pi monorepo packages, not on npm as resolvable workspace deps here):

- `@earendil-works/chord` `1.3.0` — vendored here as `third_party/chord` (`@minimax/local/chord`); needs an alias/override
- `@earendil-works/pi-ai` `1.3.0`
- `@earendil-works/pi-codemode` `1.3.0`
- `@earendil-works/pi-telemetry` `1.3.0`

External:

- `@silvia-odwyer/photon` `0.3.3`
- `diff` `8.0.4`
- `typebox` `1.3.27`

External devDependencies (test/build only):

- `@cloudflare/vitest-plugin` `1.4.4`
- `shx` `0.3.4`
- `vitest` `4.1.11`

### chord (`@minimax/local/chord`)

Internal:

- `@earendil-works/pi-telemetry` `1.3.0`

External:

- `typebox` `1.3.27`

External devDependencies (test/build only):

- `@types/ws` `8.18.2`
- `shx` `0.3.4`
- `vitest` `4.1.11`
- `ws` `8.21.0`

### TypeScript paths left dangling on purpose

`pi-durable/tsconfig.build.json` maps `@earendil-works/chord` to `../chord/dist/index.d.ts` (resolves to `third_party/chord` and requires its built `dist`) and `@earendil-works/pi-ai` to `../ai/dist/index.d.ts` (dangling — no `third_party/ai` exists). The integrator decides how internal `@earendil-works/*` imports resolve (aliases, overrides, or workspace links); these declarations were not rewritten.

For future changes, add one entry per MiniMax patch with reason, affected package, whether the change is generic upstream material or MiniMax-specific glue, and validation commands and results.
