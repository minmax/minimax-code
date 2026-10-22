#!/usr/bin/env node
// Measures the LAZY OPEN through the REAL sqlite-zstd backend (the indexed
// path the Ф2 "open/resume ≤1 s at any size" budget belongs to):
//
//   open(directory)            — one SQLite connection + light consistency
//                                check; NO batch decoding;
//   readResume()               — the durable capsule: ONE meta-row read;
//   readDeltaFrom(anchor, …)   — the retained window: batch-granular range
//                                read from the anchor's seq; nothing before
//                                the window is decoded;
//   ProjectionService.fromCapsule(capsule, slice) — fold of the window only.
//
// The cost is O(window) reads over an indexed store — history size above the
// window costs the open() consistency check alone. This is the bench the
// round-2 review demanded: bench-open-resume.mjs streams the WHOLE JSONL
// fixture (O(size) — it measured 6.5 s on a 12.9 GB corpus), this one does
// not touch anything outside the window.
//
// CORPUS: a synthetic durable store built by this script (or STORE=<dir> for
// a previously built one; ids must be `e{n}`, 1-based). Entries are ~4 KiB
// messages up to TARGET_MB/TARGET_GB total payload — the giant scales are
// opt-in (`TARGET_GB=10 node scripts/bench/bench-open-backend.mjs`).
//
// Usage: node --expose-gc scripts/bench/bench-open-backend.mjs
//        (env [STORE=dir] [TARGET_MB=64 | TARGET_GB] [WINDOW=200] [KEEP=1])
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const fail = (message) => {
  console.error(`bench-open-backend: ${message}`);
  process.exit(2);
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const packagesRoot = fileURLToPath(new URL('../../packages', import.meta.url));
const backendUrl = pathToFileURL(join(packagesRoot, 'durable-backend-sqlite-zstd/src/index.ts')).href;
const projectionUrl = pathToFileURL(join(packagesRoot, 'context-projection/src/index.ts')).href;

const { openSqliteZstdBackend } = await import(backendUrl);
const { ProjectionService } = await import(projectionUrl);
const { gc, rssMiB, metric } = await import('./lib/scan-fixture.mjs');

const windowSize = Number(process.env.WINDOW ?? 200);
if (!Number.isInteger(windowSize) || windowSize < 1) fail(`WINDOW must be a positive integer, got "${process.env.WINDOW}"`);
const targetBytes = process.env.TARGET_GB !== undefined
  ? Math.round(Number(process.env.TARGET_GB) * 1024 ** 3)
  : Math.round(Number(process.env.TARGET_MB ?? 64) * 1048576);
if (!Number.isFinite(targetBytes) || targetBytes <= 0) fail('TARGET_MB/TARGET_GB must be positive');

// ── Corpus: reuse the store, or build it in place when it is fresh/empty.
// NOT measured. ids are `e{n}` (1-based), one entry per index.
let storeDir = process.env.STORE;
let builtBytes = 0;
let builtEntries = 0;
let builtBatches = 0;
if (storeDir === undefined) {
  storeDir = mkdtempSync(join(tmpdir(), 'bench-open-backend-'));
}
{
  const filler = 'w'.repeat(4096 - 64);
  const builder = openSqliteZstdBackend(storeDir);
  if (builder.head === 0) {
    let batch = [];
    let batchBytes = 0;
    let index = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      await builder.appendBatch(batch);
      builtBatches += 1;
      batch = [];
      batchBytes = 0;
    };
    while (builtBytes < targetBytes) {
      index += 1;
      const draft = {
        id: `e${index}`,
        parentId: index === 1 ? null : `e${index - 1}`,
        kind: index % 2 === 0 ? 'pi.assistant' : 'pi.user',
        payload: { text: `${index} ${filler}` },
      };
      batch.push(draft);
      builtBytes += filler.length + 64;
      builtEntries += 1;
      batchBytes += filler.length + 64;
      if (batchBytes >= 200 * 1024) await flush(); // stay under the 256 KiB batch cap
    }
    await flush();
    await builder.checkpoint();
  }
  builder.close(); // releases the writer ownership marker before the measured open
}

// ── The measured lazy open: connection + capsule row + window range + fold.
gc();
const rssBefore = rssMiB();
const started = performance.now();

const backend = openSqliteZstdBackend(storeDir);
const openMs = performance.now() - started;
const head = backend.head;
if (head < windowSize) fail(`store has ${head} entries, WINDOW=${windowSize} needs more (build with a bigger TARGET_MB)`);

const capsuleStarted = performance.now();
const storageCapsule = backend.readResume();
const capsuleMs = performance.now() - capsuleStarted;
if (storageCapsule === null) fail('store has no resume capsule (nothing committed?)');

// Entry ids are `e{n}` (1-based, one entry per index) — the built store
// counts them itself; a reused store must say how many it has.
const totalEntries = builtEntries > 0 ? builtEntries : Number(process.env.ENTRY_COUNT ?? 0);
if (!Number.isInteger(totalEntries) || totalEntries < windowSize) {
  fail(`store entry count unknown or too small (${totalEntries}); pass ENTRY_COUNT for STORE reuse`);
}
const anchorId = `e${totalEntries - windowSize + 1}`;
const rangeStarted = performance.now();
const slice = backend.readDeltaFrom(anchorId, 512 * 1048576, { inclusive: true });
const rangeMs = performance.now() - rangeStarted;
if (slice.length < windowSize) fail(`range read served ${slice.length} entries, expected ${windowSize}`);

const foldStarted = performance.now();
const capsule = {
  head: storageCapsule.head,
  firstKeptEntryId: null,
  compaction: null,
  usageAnchor: slice.at(-1)?.id ?? null,
  appliedSeq: storageCapsule.head,
};
const service = ProjectionService.fromCapsule(capsule, slice);
const manifest = service.manifest();
const foldMs = performance.now() - foldStarted;

const totalMs = performance.now() - started;
backend.close();
gc();
const rssAfter = rssMiB();

metric('resume-backend.totalMs', totalMs);
metric('resume-backend.openMs', openMs);
metric('resume-backend.capsuleMs', capsuleMs);
metric('resume-backend.rangeMs', rangeMs);
metric('resume-backend.foldMs', foldMs);
metric('resume-backend.rssDeltaMb', Math.max(0, rssAfter - rssBefore));
metric('resume-backend.windowBytes', manifest.windowBytes);
metric('resume-backend.windowEntries', manifest.segments.length);
metric('resume-backend.head', storageCapsule.head);
metric('resume-backend.storePayloadMb', Number(((builtBytes || targetBytes) / 1048576).toFixed(1)));
metric('resume-backend.batches', builtBatches);
metric('resume-backend.corpus', 'synthetic-durable-store');

// Self-gate for the opt-in giant step (performance.yml, label `perf:giant`):
// GATE_TOTAL_MS=1000 GATE_RSS_MB=500 enforces the Ф2 budgets on the measured
// path directly.
const gateTotalMs = Number(process.env.GATE_TOTAL_MS ?? 0);
if (Number.isFinite(gateTotalMs) && gateTotalMs > 0 && totalMs > gateTotalMs) {
  console.error(`bench-open-backend: GATE FAILED — resume-backend.totalMs ${totalMs.toFixed(1)} > ${gateTotalMs}`);
  process.exit(1);
}
const gateRssMb = Number(process.env.GATE_RSS_MB ?? 0);
const rssDelta = Math.max(0, rssAfter - rssBefore);
if (Number.isFinite(gateRssMb) && gateRssMb > 0 && rssDelta > gateRssMb) {
  console.error(`bench-open-backend: GATE FAILED — resume-backend.rssDeltaMb ${rssDelta.toFixed(1)} > ${gateRssMb}`);
  process.exit(1);
}

if (process.env.KEEP !== '1' && process.env.STORE === undefined) {
  rmSync(storeDir, { recursive: true, force: true });
}
