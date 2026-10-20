#!/usr/bin/env node
// Runs the three session-path benchmarks (open, append, replay) against one
// JSONL fixture and prints a combined markdown summary to stdout. Each
// benchmark runs in its own child process with --expose-gc, so RSS readings
// are taken after a full GC and runs do not skew each other's heap.
//
// Usage: node scripts/bench/run-all.mjs   (env FIXTURE=path/to/messages.jsonl [ITERS=20] [REPLAY_STEPS=287])
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIB = 1048576;
const CHILD_TIMEOUT_MS = 15 * 60_000;
const BENCHES = [
  { id: 'open', script: 'bench-open.mjs' },
  { id: 'append', script: 'bench-append.mjs' },
  { id: 'replay', script: 'bench-replay.mjs' },
];

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
lines.push('# Session-path benches: open / append / replay');
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
  ]),
);
lines.push('');
lines.push('## Machine-readable');
lines.push('');
lines.push(fence);
for (const run of runs) for (const [key, value] of Object.entries(run.metrics)) lines.push(`${key}=${value}`);
lines.push(fence);
console.log(lines.join('\n'));
