#!/usr/bin/env node
// Simulates per-turn payload assembly over a fully loaded session history:
// each of the 287 steps JSON.stringify's the entire message array, matching
// the "rebuild the full request payload every turn" behavior. Prints p50/p95
// per-step times.
//
// Usage: node --expose-gc bench-replay.mjs   (env FIXTURE=..., REPLAY_STEPS=287)
import { readFileSync, statSync } from 'node:fs';

const MIB = 1048576;
const fail = (message) => {
  console.error(`bench-replay: ${message}`);
  process.exit(2);
};

const fixture = process.env.FIXTURE;
if (!fixture) fail('FIXTURE env var is required (path to a .jsonl session file)');
let fileSize;
try {
  fileSize = statSync(fixture).size;
} catch {
  fail(`cannot stat FIXTURE=${fixture}`);
}
const steps = Number(process.env.REPLAY_STEPS ?? 287);
if (!Number.isInteger(steps) || steps <= 0) fail(`REPLAY_STEPS must be a positive integer, got "${process.env.REPLAY_STEPS}"`);

// Load the full history once (the open path this bench sits on top of).
const raw = readFileSync(fixture, 'utf8');
const history = [];
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  try {
    history.push(JSON.parse(line));
  } catch {
    // skip malformed lines; replay measures stringify, not parse
  }
}
if (history.length === 0) fail(`no records parsed from FIXTURE=${fixture}; is it a JSONL file?`);
const historyBytes = Buffer.byteLength(raw);

const gc = globalThis.gc;
if (gc) gc();

// One step == one "turn": serialize the entire history as the request payload.
const timesMs = [];
let payloadBytes = 0;
for (let i = 0; i < steps; i++) {
  const t0 = performance.now();
  const payload = JSON.stringify(history);
  timesMs.push(performance.now() - t0);
  payloadBytes = Buffer.byteLength(payload);
}
if (gc) gc();
const rssAfter = process.memoryUsage().rss / MIB;

const sorted = [...timesMs].sort((a, b) => a - b);
// Nearest-rank percentile over the sorted per-step samples.
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const meanMs = timesMs.reduce((a, b) => a + b, 0) / timesMs.length;

console.log(`bench-replay: fixture=${fixture} steps=${steps} history=${(historyBytes / MIB).toFixed(1)}MB`);
console.log(`replay.steps=${steps}`);
console.log(`replay.messages=${history.length}`);
console.log(`replay.historyMb=${(historyBytes / MIB).toFixed(1)}`);
console.log(`replay.fileSizeMb=${(fileSize / MIB).toFixed(1)}`);
console.log(`replay.payloadMb=${(payloadBytes / MIB).toFixed(1)}`);
console.log(`replay.p50Ms=${percentile(50).toFixed(1)}`);
console.log(`replay.p95Ms=${percentile(95).toFixed(1)}`);
console.log(`replay.meanMs=${meanMs.toFixed(1)}`);
console.log(`replay.minMs=${sorted[0].toFixed(1)}`);
console.log(`replay.maxMs=${sorted[sorted.length - 1].toFixed(1)}`);
console.log(`replay.rssAfterMb=${rssAfter.toFixed(1)}`);
