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
