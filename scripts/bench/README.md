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
# All three benches, markdown summary to stdout
FIXTURE=/path/to/messages.jsonl node scripts/bench/run-all.mjs

# Individual benches
FIXTURE=/path/to/messages.jsonl node --expose-gc scripts/bench/bench-open.mjs
FIXTURE=/path/to/messages.jsonl node --expose-gc scripts/bench/bench-append.mjs
FIXTURE=/path/to/messages.jsonl node --expose-gc scripts/bench/bench-replay.mjs
```

`--expose-gc` is optional for the individual scripts (they use `global.gc` when
available); `run-all.mjs` always passes it so RSS readings are taken after a
full GC and benches run in isolated child processes.

### Environment

| Variable       | Default | Applies to                       |
| -------------- | ------- | -------------------------------- |
| `FIXTURE`      | —       | all; path to a `.jsonl` session file (required) |
| `ITERS`        | `20`    | `bench-append` (and so `run-all`); append iterations |
| `REPLAY_STEPS` | `287`   | `bench-replay` (and so `run-all`); stringify steps |

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
never writes to the original. Per `src/AGENTS.md`, do not commit real
sessions, logs, or account data to the repository — keep fixtures outside it;
a synthetic fixture (any JSONL, e.g. records with `message.content` text
blocks) is enough for smoke runs.
