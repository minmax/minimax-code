#!/usr/bin/env node
// Simulates the append path of a growing session: every append re-reads and
// re-parses the whole history from disk, structuredClones it twice (history +
// semantic snapshots), then appends one ~20 KB record line. Repeats ITERS
// times over a temp copy so the per-append cost degradation is visible as the
// file grows. The original fixture is never modified.
//
// Usage: node --expose-gc bench-append.mjs   (env FIXTURE=..., ITERS=20)
// FIXTURE is optional: when unset, the newest messages.jsonl under the durable
// session root (~/.minimax/v2/sessions) is used so the bench runs standalone;
// set FIXTURE explicitly for a reproducible measurement.
import { closeSync, copyFileSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { startStallMonitor } from './lib/stall.mjs';

const MIB = 1048576;
const APPEND_BYTES = 20 * 1024; // typical truncated toolResult payload size
const fail = (message) => {
  console.error(`bench-append: ${message}`);
  process.exit(2);
};

const SESSIONS_ROOT = join(homedir(), '.minimax', 'v2', 'sessions');

// Newest session transcript under the durable session root; the standalone
// default when the caller does not pin FIXTURE to a specific file.
const findDefaultFixture = () => {
  let found = [];
  try {
    found = readdirSync(SESSIONS_ROOT, { recursive: true });
  } catch {
    return undefined;
  }
  let best;
  let bestMtimeMs = -1;
  for (const rel of found) {
    if (basename(rel) !== 'messages.jsonl') continue;
    const full = join(SESSIONS_ROOT, rel);
    let mtimeMs;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > bestMtimeMs || (mtimeMs === bestMtimeMs && full < best)) {
      best = full;
      bestMtimeMs = mtimeMs;
    }
  }
  return best;
};

const fixture = process.env.FIXTURE ?? findDefaultFixture();
if (!fixture) fail(`FIXTURE env var is required (path to a .jsonl session file); no default found under ${SESSIONS_ROOT}`);
let fileSize;
try {
  fileSize = statSync(fixture).size;
} catch {
  fail(`cannot stat FIXTURE=${fixture}`);
}
const iters = Number(process.env.ITERS ?? 20);
if (!Number.isInteger(iters) || iters <= 0) fail(`ITERS must be a positive integer, got "${process.env.ITERS}"`);

// One appended record per iteration; the id placeholder keeps lines distinct.
const filler = JSON.stringify({
  message_id: 'msg-bench-append',
  turn_id: 't-bench-append',
  message: {
    role: 'toolResult',
    toolCallId: 'call_bench_append',
    toolName: 'bash',
    content: [{ type: 'text', text: 'x'.repeat(APPEND_BYTES - 160) }],
    timestamp: 0,
  },
});

const stall = startStallMonitor();
const gc = globalThis.gc;
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const percentile = (values, quantile) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
};
const samples = [];
let tmp;
try {
  tmp = join(tmpdir(), `bench-append-${process.pid}-${Date.now()}.jsonl`);
  copyFileSync(fixture, tmp);
  for (let i = 0; i < iters; i++) {
    // Full read + parse of the current history (the suspected append prelude).
    const t0 = performance.now();
    const data = readFileSync(tmp, 'utf8');
    const t1 = performance.now();
    const records = [];
    for (const line of data.split('\n')) {
      if (line.trim()) records.push(JSON.parse(line));
    }
    const t2 = performance.now();
    // Two full-history clones, as readSnapshot + captureSemanticSnapshot do.
    const snapshot = structuredClone(records);
    const t3 = performance.now();
    const semantic = structuredClone(records);
    const t4 = performance.now();
    if (snapshot.length !== records.length || semantic.length !== records.length) {
      throw new Error('structuredClone size mismatch');
    }
    // The append itself: one ~20 KB line at the end of the file.
    const line = `${filler.replace('msg-bench-append', `msg-bench-append-${i}`)}\n`;
    const fd = openSync(tmp, 'a');
    writeSync(fd, line);
    closeSync(fd);
    const t5 = performance.now();
    samples.push({
      i: i + 1,
      sizeMb: Buffer.byteLength(data) / MIB,
      readMs: t1 - t0,
      parseMs: t2 - t1,
      cloneMs: t3 - t2 + (t4 - t3),
      appendMs: t5 - t4,
      totalMs: t5 - t0,
    });
    if (gc) gc();
  }
} finally {
  stall.stop();
  if (tmp) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup of the temp copy
    }
  }
}

const first = samples[0];
const last = samples[samples.length - 1];
const middle = samples[Math.floor(iters / 2)];
console.log(`bench-append: fixture=${fixture} iters=${iters} start=${first.sizeMb.toFixed(1)}MB end=${last.sizeMb.toFixed(1)}MB`);
console.log('iteration |   size MB | read ms | parse ms | clone x2 ms | append ms | total ms');
const row = (s) =>
  console.log(
    `${String(s.i).padStart(9)} | ${s.sizeMb.toFixed(1).padStart(9)} | ${s.readMs.toFixed(0).padStart(7)} |` +
      ` ${s.parseMs.toFixed(0).padStart(8)} | ${s.cloneMs.toFixed(0).padStart(11)} |` +
      ` ${s.appendMs.toFixed(1).padStart(9)} | ${s.totalMs.toFixed(0).padStart(8)}`,
  );
row(first);
if (middle !== first && middle !== last) row(middle);
row(last);

// Machine-readable summary; per-iteration totals are listed separately.
console.log(`append.iters=${iters}`);
console.log(`append.lineKb=${(APPEND_BYTES / 1024).toFixed(1)}`);
console.log(`append.startSizeMb=${first.sizeMb.toFixed(1)}`);
console.log(`append.endSizeMb=${last.sizeMb.toFixed(1)}`);
console.log(`append.readMsMean=${mean(samples.map((s) => s.readMs)).toFixed(1)}`);
console.log(`append.parseMsMean=${mean(samples.map((s) => s.parseMs)).toFixed(1)}`);
console.log(`append.cloneMsMean=${mean(samples.map((s) => s.cloneMs)).toFixed(1)}`);
console.log(`append.totalMsMean=${mean(samples.map((s) => s.totalMs)).toFixed(1)}`);
console.log(`append.appendP99Ms=${percentile(samples.map((s) => s.appendMs), 0.99).toFixed(2)}`);
console.log(`append.stallP99Ms=${stall.percentileMs(0.99).toFixed(1)}`);
console.log(`append.stallMaxMs=${stall.maxMs().toFixed(1)}`);
console.log(`append.totalFirstMs=${first.totalMs.toFixed(1)}`);
console.log(`append.totalLastMs=${last.totalMs.toFixed(1)}`);
console.log(`append.degradationX=${(last.totalMs / first.totalMs).toFixed(2)}`);
for (const s of samples) console.log(`append.iter.${String(s.i).padStart(3, '0')}.totalMs=${s.totalMs.toFixed(1)}`);
