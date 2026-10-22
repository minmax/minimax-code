#!/usr/bin/env node
// Measures the LAZY OPEN path on the new context pipeline (Ф2 "open/resume
// ≤1 s at any size"): a synthetic resume capsule + a streamed scan that keeps
// only the retained window, then `ProjectionService.fromCapsule` over the
// slice — the log is NEVER materialized; RAM holds the window alone.
//
// NOTE (round-2 review): the streamed scan is O(fixture size) — 6.5 s on a
// 12.9 GB corpus — so THE GATE for "открытие ≤1 с при любом размере" lives
// in bench-open-backend.mjs: the real indexed backend path (capsule meta row
// + range read), O(window) at any size, with the opt-in 10 GB gate. This
// bench stays as the fixed-window fold measurement over a file fixture and
// the legacy-contrast companion of bench-open.mjs (which reads and
// JSON.parses the WHOLE fixture).
//
// CORPUS: the FIXTURE jsonl. Each line becomes one frozen entry; only the
// last WINDOW lines are retained in memory — history size above the window
// costs exactly one streamed scan, which stands in for the indexed backend
// range read (SQLite would do less, so the measurement is conservative).
// The ~100 MB images corpus is the in-CI large-scale datapoint; a 10 GB
// fixture can be pointed at locally via FIXTURE (opt-in, same script).
//
// Usage: node --expose-gc scripts/bench/bench-open-resume.mjs
//        (env FIXTURE=path/to/messages.jsonl [WINDOW=200])
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const fail = (message) => {
  console.error(`bench-open-resume: ${message}`);
  process.exit(2);
};

// Type stripping loads `.ts` files but does not map the packages' `.js`
// specifiers onto them; register the mapping for this process only (same
// twist as bench-worker-commit.mjs).
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
const projectionUrl = pathToFileURL(join(packagesRoot, 'context-projection/src/index.ts')).href;

const fixture = process.env.FIXTURE;
if (!fixture) fail('FIXTURE env var is required (path to a .jsonl session file)');
const windowSize = Number(process.env.WINDOW ?? 200);
if (!Number.isInteger(windowSize) || windowSize < 1) fail(`WINDOW must be a positive integer, got "${process.env.WINDOW}"`);

const { ProjectionService } = await import(projectionUrl);
const { scanFixture, gc, rssMiB, metric } = await import('./lib/scan-fixture.mjs');

// ── Phase 1: the storage open. A real backend serves the capsule from one
// meta row and the retained slice from a range read; the streamed scan is the
// conservative stand-in for both (bounded RAM, full-file seek cost).
gc();
const rssBefore = rssMiB();
const openStarted = performance.now();
const { totalLines, lastLines } = await scanFixture(fixture, windowSize);
const scanMs = performance.now() - openStarted;

// ── Phase 2: the lazy resume. Capsule + window slice → ProjectionService.
const head = totalLines;
const sliceStart = totalLines - lastLines.length; // 0-based index of the first retained line
const entries = lastLines.map((line, index) => ({
  id: `e${sliceStart + index + 1}`,
  parentId: index === 0 ? null : `e${sliceStart + index}`,
  kind: (sliceStart + index) % 2 === 0 ? 'pi.user' : 'pi.assistant',
  payload: { text: line },
  seq: head,
  ordinal: index,
}));
const capsule = {
  head,
  firstKeptEntryId: null,
  compaction: null,
  usageAnchor: entries.at(-1)?.id ?? null,
  appliedSeq: head,
};

const foldStarted = performance.now();
const service = ProjectionService.fromCapsule(capsule, entries);
const manifest = service.manifest();
const foldMs = performance.now() - foldStarted;

const totalMs = scanMs + foldMs;
gc();
const rssAfter = rssMiB();

metric('resume.totalMs', totalMs);
metric('resume.scanMs', scanMs);
metric('resume.foldMs', foldMs);
metric('resume.rssDeltaMb', Math.max(0, rssAfter - rssBefore));
metric('resume.windowBytes', manifest.windowBytes);
metric('resume.windowEntries', manifest.segments.length);
metric('resume.entriesScanned', totalLines);
metric('resume.entriesSkipped', Math.max(0, totalLines - lastLines.length));
metric('resume.corpus', 'fixture-jsonl');
