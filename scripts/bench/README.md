# Session-path performance benches

Standalone Node scripts (only `node:*` builtins; no repository build, no
dependencies) that measure the session-file hot paths of the hybrid agent:

- **open** — full load of a session file: raw disk read plus `JSON.parse` of
  every line (the "materialize everything" behavior).
- **append** — the per-append cost of a growing session: every append re-reads
  and re-parses the whole history, `structuredClone`s it twice (history and
  semantic snapshots), then writes one ~20 KB record line.
- **replay** — per-turn payload assembly over a loaded history: each of 287
  "turns" `JSON.stringify`s the entire message array.

The measurement logic follows the ad-hoc profilers in
`hybrid-plans/profiling/measure-*.js`, packaged as repeatable scripts.

## Usage

```sh
# Build the synthetic fixture corpus (never real sessions)
node scripts/bench/build-fixtures.mjs messages --out /tmp/bench-fixtures            # 5.1 MB / 2061 messages
node scripts/bench/build-fixtures.mjs images   --out /tmp/bench-fixtures            # ~100 MB of image blocks
node scripts/bench/build-fixtures.mjs giant    --out /tmp/bench-fixtures            # 1 GiB scaling row
node scripts/bench/build-fixtures.mjs giant    --target-gb 10 --out /tmp/bench-fixtures  # Ф1 10 GiB row (~50 s, opt-in)

# Worker commit path, BOTH execution modes (bridge + off-thread)
node scripts/bench/bench-worker-commit.mjs

# All four benches, markdown summary to stdout, thresholds enforced
FIXTURE=/path/to/messages.jsonl node scripts/bench/run-all.mjs --check scripts/bench/thresholds.json

# Individual benches
FIXTURE=/path/to/messages.jsonl node --expose-gc scripts/bench/bench-open.mjs
FIXTURE=/path/to/images.jsonl node --conditions=development --experimental-transform-types --expose-gc scripts/bench/bench-prep.mjs
# ^ Ф2 prep bench: loads the packages' TypeScript sources (`development`
#   condition) and the Context MMU (`transform-types`: parameter properties) —
#   `run-all.mjs` passes both flags to every child automatically.
FIXTURE=/path/to/messages.jsonl node --expose-gc scripts/bench/bench-append.mjs
FIXTURE=/path/to/messages.jsonl node --expose-gc scripts/bench/bench-replay.mjs
node --expose-gc scripts/bench/bench-worker-commit.mjs   # worker commit path, own synthetic store
```

The `worker` bench drives the REAL storage worker + sqlite-zstd backend from
TypeScript sources (Node type stripping plus an in-process `.js -> .ts`
resolve hook), measuring enqueue p99, commit p95, and caller-thread
event-loop stalls.

## Threshold gate

`run-all.mjs --check <thresholds.json>` compares every collected metric
against its maximum (`thresholds.json` for the messages corpus,
`thresholds.images.json` for the ~100 MB image corpus — see the file comment
for the one deliberate difference) and exits 1 on any violation. This is the
merge barrier wired into `.github/workflows/performance.yml`
(`bench-gates` job).

`--expose-gc` is optional for the individual scripts (they use `global.gc` when
available); `run-all.mjs` always passes it so RSS readings are taken after a
full GC and benches run in isolated child processes.

### Environment

| Variable       | Default | Applies to                       |
| -------------- | ------- | -------------------------------- |
| `FIXTURE`      | newest `messages.jsonl` under `~/.minimax/v2/sessions` (`bench-append` only) | all; path to a `.jsonl` session file |
| `ITERS`        | `20`    | `bench-append` (and so `run-all`); append iterations |
| `REPLAY_STEPS` | `287`   | `bench-replay` (and so `run-all`); stringify steps |
| `BATCHES`      | `200`   | `bench-worker-commit`; committed batches |
| `ENTRY_KB`     | `64`    | `bench-worker-commit`; entry payload size |
| `MMU_RESIDENT_BYTES` | `262144` | `bench-prep`; Context-MMU budget behind the prep bench's residency overlay (at the images corpus's 64 KiB images this keeps exactly 4 pages resident — the architecture's ≤4-resident shape; resident pages ride the measured payload as data URLs) |

Every bench also reports event-loop stall metrics (`<bench>.stallP99Ms`,
`<bench>.stallMaxMs`) sampled across the measured path.

## Output format

Every script prints numbers to stdout as machine-readable `metric=value`
lines, prefixed with the bench id so `run-all.mjs` can collect them:

```text
open.readMs=41.7
open.parseMs=318.2
open.rssDeltaMb=176.4
append.totalFirstMs=512.3
append.degradationX=1.21
replay.p50Ms=88.4
replay.p95Ms=105.1
```

`bench-append.mjs` also prints a human-readable per-iteration table
(read / parse / clone ×2 / append / total ms) plus per-iteration
`append.iter.NNN.totalMs` lines, and reports `degradationX` — the ratio of the
last iteration's total ms to the first, i.e. how much a single append slows
down as the history grows. `bench-replay.mjs` reports nearest-rank p50/p95
(and mean/min/max) per-step `JSON.stringify` times and the serialized payload
size.

`run-all.mjs` renders all collected metrics as markdown tables, a headline
cross-bench table, and repeats the raw `metric=value` block at the end for
scripting.

## Fixtures

`FIXTURE` must be a JSONL file with one JSON record per line (a session
`messages.jsonl`). `bench-append.mjs` copies the fixture to a temp file and
never writes to the original; when `FIXTURE` is unset it benchmarks the newest
`messages.jsonl` under the durable session root, so a real session is picked up
without configuration. Per `src/AGENTS.md`, do not commit real
sessions, logs, or account data to the repository — keep fixtures outside it;
a synthetic fixture (any JSONL, e.g. records with `message.content` text
blocks) is enough for smoke runs.
