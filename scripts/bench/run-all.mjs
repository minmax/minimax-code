#!/usr/bin/env node
// Runs the three session-path benchmarks (open, append, replay) against one
// JSONL fixture and prints a combined markdown summary to stdout. Each
// benchmark runs in its own child process with --expose-gc, so RSS readings
// are taken after a full GC and runs do not skew each other's heap.
//
// Usage: node scripts/bench/run-all.mjs   (env FIXTURE=path/to/messages.jsonl [ITERS=20] [REPLAY_STEPS=287])
//        node scripts/bench/run-all.mjs --check scripts/bench/thresholds.json
// With `--check`, every collected metric is compared against the threshold
// file (`<bench>.<metric>` -> maximum); the run FAILS (exit 1) when any
// metric exceeds its maximum — that is the merge-barrier mode of the CI gate.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIB = 1048576;
const CHILD_TIMEOUT_MS = 15 * 60_000;
const BENCHES = [
  { id: 'open', script: 'bench-open.mjs' },
  { id: 'append', script: 'bench-append.mjs' },
  { id: 'replay', script: 'bench-replay.mjs' },
  // Builds its own synthetic storage (no fixture dependency): the worker
  // commit path — enqueue p99, commit p95, event-loop stalls. The corpus is
  // synthetic-admission (enqueue hands over frozen entries without reading
  // the store, so it is history-size independent by construction); it gates
  // the Ф1 "append <= 1 ms p99 (enqueue frozen entry)" budget via
  // offthread.enqueueP99Ms and must not be read as a history-dependence
  // measurement.
  { id: 'worker', script: 'bench-worker-commit.mjs' },
  // Ф2 context path: the LAZY open (resume capsule + retained window slice
  // through ProjectionService.fromCapsule) — the log is never materialized;
  // gates the "open/resume <= 1 s at any size" budget (resume.totalMs) and
  // enforces the RSS budget on the lazy path (resume.rssDeltaMb), where
  // thresholds.json's comment says it belongs. bench-open.mjs above keeps
  // measuring the LEGACY materialization for contrast.
  { id: 'resume', script: 'bench-open-resume.mjs' },
  // Ф2 context path: prep — capsule → window manifest → wire-compiler body.
  // prep.p95Ms gates "prep <= 50 ms p95 at any history length";
  // prep.warmP95Ms gates the <= 5 ms warm goal (cache hits, no re-hashing);
  // prep.payloadBytes is the PROVIDER PAYLOAD byte truth (dialect-normalized
  // wire segments), gated at <= 32 MB (messages) / <= 12 MB (images).
  { id: 'prep', script: 'bench-prep.mjs' },
  // Ф3 steering hot path (steering-design-sol.md §6.1/§6.2) on REAL clocks
  // and the REAL sqlite-zstd backend: Enter → durable saved-ack
  // (steering.enterSavedAckP95Ms <= 100, P99 <= 250) and saved-ack →
  // committed release (steering.releaseP99Ms <= 250). Synthetic-admission
  // corpus, no fixture dependency; the composed in-process §6.2 span
  // (enter → release → finalized tool) is reported for contrast.
  { id: 'steering', script: 'bench-steering.mjs' },
];

const checkIndex = process.argv.indexOf('--check');
const thresholdsPath = checkIndex !== -1 ? process.argv[checkIndex + 1] : undefined;

const fixture = process.env.FIXTURE;
if (!fixture) {
  console.error('run-all: FIXTURE env var is required (path to a .jsonl session file)');
  process.exit(2);
}
let fileSize;
try {
  fileSize = statSync(fixture).size;
} catch {
  console.error(`run-all: cannot stat FIXTURE=${fixture}`);
  process.exit(2);
}

const runs = [];
for (const { id, script } of BENCHES) {
  const scriptPath = fileURLToPath(new URL(`./${script}`, import.meta.url));
  const started = performance.now();
  const child = spawnSync(process.execPath, ['--expose-gc', scriptPath], {
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * MIB,
    timeout: CHILD_TIMEOUT_MS,
  });
  if (child.error || child.status !== 0) {
    if (child.stdout) process.stdout.write(child.stdout);
    console.error(`run-all: ${script} failed: ${child.error?.message ?? `exit code ${child.status}`}`);
    if (child.stderr) console.error(child.stderr);
    process.exit(1);
  }
  // Collect "metric=value" lines (keys are prefixed with the benchmark id).
  const metrics = {};
  for (const match of (child.stdout ?? '').matchAll(/^([a-zA-Z][a-zA-Z0-9_.]*)=([^=\s].*)$/gm)) {
    metrics[match[1]] = match[2];
  }
  if (Object.keys(metrics).length === 0) {
    console.error(`run-all: ${script} produced no machine-readable metric lines`);
    process.exit(1);
  }
  runs.push({ id, script, metrics, stdout: child.stdout ?? '', wallMs: performance.now() - started });
}

const pick = (id, key) => runs.find((r) => r.id === id)?.metrics[`${id}.${key}`] ?? 'n/a';
const markdownTable = (rows) => ['| metric | value |', '| --- | --- |', ...rows.map(([k, v]) => `| \`${k}\` | ${v} |`)].join('\n');
const fence = '`'.repeat(3);

const lines = [];
lines.push('# Session-path benches: open / append / replay / resume / prep');
lines.push('');
lines.push(`- fixture: \`${fixture}\` (${(fileSize / MIB).toFixed(1)} MB)`);
lines.push(`- node: \`${process.version}\`, ITERS: \`${process.env.ITERS ?? '20'}\`, REPLAY_STEPS: \`${process.env.REPLAY_STEPS ?? '287'}\``);
lines.push('');

for (const run of runs) {
  lines.push(`## ${run.id} — \`${run.script}\` (wall ${(run.wallMs / 1000).toFixed(1)}s)`);
  lines.push('');
  const perIteration = [];
  const mainRows = [];
  for (const [key, value] of Object.entries(run.metrics)) {
    if (/^append\.iter\.\d+\.totalMs$/.test(key)) perIteration.push([key, value]);
    else mainRows.push([key, value]);
  }
  lines.push(markdownTable(mainRows));
  if (perIteration.length > 0) {
    lines.push('');
    lines.push(`Per-iteration append totals (${perIteration.length} samples):`);
    lines.push('');
    lines.push(perIteration.map(([k, v]) => `- \`${k}\` = ${v}`).join('\n'));
  }
  lines.push('');
  lines.push('<details><summary>raw output</summary>');
  lines.push('');
  lines.push(fence);
  lines.push(run.stdout.trimEnd());
  lines.push(fence);
  lines.push('');
  lines.push('</details>');
  lines.push('');
}

// Headline cross-benchmark numbers, echoed once in one place.
lines.push('## Headline');
lines.push('');
lines.push(
  markdownTable([
    ['open.readMs', pick('open', 'readMs')],
    ['open.parseMs', pick('open', 'parseMs')],
    ['open.rssDeltaMb', pick('open', 'rssDeltaMb')],
    ['append.totalFirstMs', pick('append', 'totalFirstMs')],
    ['append.totalLastMs', pick('append', 'totalLastMs')],
    ['append.degradationX', pick('append', 'degradationX')],
    ['replay.p50Ms', pick('replay', 'p50Ms')],
    ['replay.p95Ms', pick('replay', 'p95Ms')],
    ['resume.totalMs', pick('resume', 'totalMs')],
    ['resume.rssDeltaMb', pick('resume', 'rssDeltaMb')],
    ['prep.p95Ms', pick('prep', 'p95Ms')],
    ['prep.warmP95Ms', pick('prep', 'warmP95Ms')],
    ['prep.payloadBytes', pick('prep', 'payloadBytes')],
  ]),
);

// Threshold gate (--check <thresholds.json>): every collected metric is
// compared against its maximum; any violation fails the run. This is the
// merge-barrier form of the perf gates.
let gateFailed = false;
if (thresholdsPath !== undefined) {
  const allMetrics = {};
  for (const run of runs) Object.assign(allMetrics, run.metrics);
  const thresholds = JSON.parse(readFileSync(thresholdsPath, 'utf8'));
  lines.push('## Threshold gate');
  lines.push('');
  const gateRows = [];
  for (const [key, max] of Object.entries(thresholds)) {
    if (key === 'comment') continue;
    const raw = allMetrics[key];
    const value = raw === undefined ? undefined : Number(raw);
    if (value === undefined || !Number.isFinite(value)) {
      gateFailed = true;
      gateRows.push([`gate.${key}`, `FAIL (metric missing)`]);
      console.log(`gate.${key}=FAIL metric missing`);
      continue;
    }
    if (value <= max) {
      gateRows.push([`gate.${key}`, `PASS (${value} <= ${max})`]);
      console.log(`gate.${key}=PASS ${value}<=${max}`);
    } else {
      gateFailed = true;
      gateRows.push([`gate.${key}`, `FAIL (${value} > ${max})`]);
      console.log(`gate.${key}=FAIL ${value}>${max}`);
    }
  }
  console.log(`gate.passed=${!gateFailed}`);
  lines.push(markdownTable(gateRows));
  lines.push('');
}
lines.push('');
lines.push('## Machine-readable');
lines.push('');
lines.push(fence);
for (const run of runs) for (const [key, value] of Object.entries(run.metrics)) lines.push(`${key}=${value}`);
lines.push(fence);
console.log(lines.join('\n'));

if (gateFailed) {
  console.error('run-all: threshold gate FAILED');
  process.exit(1);
}
