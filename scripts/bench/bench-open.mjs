#!/usr/bin/env node
// Measures the full open path of a JSONL session fixture: read the whole file
// from disk, then JSON.parse every line (the "materialize everything" load).
// Standalone: node builtins only, no repository build required.
//
// Usage: node --expose-gc bench-open.mjs   (env FIXTURE=path/to/messages.jsonl)
// Numbers are printed to stdout as machine-readable "metric=value" lines.
import { readFileSync, statSync } from 'node:fs';

import { startStallMonitor } from './lib/stall.mjs';

const MIB = 1048576;
const fail = (message) => {
  console.error(`bench-open: ${message}`);
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

const gc = globalThis.gc;
if (gc) gc();
const rssBefore = process.memoryUsage().rss / MIB;

// Event-loop stall sampling spans the whole measured path: the Ф1 gate is
// "open without freezing the stream", so stalls are part of the result.
const stall = startStallMonitor();

// Phase 1: raw disk read (includes UTF-8 decode).
const t0 = performance.now();
const raw = readFileSync(fixture, 'utf8');
const readMs = performance.now() - t0;

// Phase 2: split into lines and parse every record (readEnvelopesStrict-style).
const t1 = performance.now();
const records = [];
let parseErrors = 0;
let lines = 0;
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  lines++;
  try {
    records.push(JSON.parse(line));
  } catch {
    parseErrors++;
  }
}
const parseMs = performance.now() - t1;
stall.stop();

if (records.length === 0) fail(`no records parsed from FIXTURE=${fixture}; is it a JSONL file?`);
if (gc) gc();
const rssAfter = process.memoryUsage().rss / MIB;

console.log(`bench-open: fixture=${fixture} size=${(fileSize / MIB).toFixed(1)}MB`);
console.log(`open.fixture=${fixture}`);
console.log(`open.fileSizeMb=${(fileSize / MIB).toFixed(1)}`);
console.log(`open.lines=${lines}`);
console.log(`open.records=${records.length}`);
console.log(`open.parseErrors=${parseErrors}`);
console.log(`open.readMs=${readMs.toFixed(1)}`);
console.log(`open.parseMs=${parseMs.toFixed(1)}`);
console.log(`open.totalMs=${(readMs + parseMs).toFixed(1)}`);
console.log(`open.stallP99Ms=${stall.percentileMs(0.99).toFixed(1)}`);
console.log(`open.stallMaxMs=${stall.maxMs().toFixed(1)}`);
console.log(`open.rssBeforeMb=${rssBefore.toFixed(1)}`);
console.log(`open.rssAfterMb=${rssAfter.toFixed(1)}`);
console.log(`open.rssDeltaMb=${(rssAfter - rssBefore).toFixed(1)}`);
