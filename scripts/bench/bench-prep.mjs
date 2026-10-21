#!/usr/bin/env node
// Measures the PREP stage of the new context path (Ф2 "prep ≤50 ms p95 at
// any history length; goal ≤5 ms warm"): resume capsule → window manifest →
// wire-compiler body.
//
//   prep.p95Ms     — cold-cache compiles: every window segment serialized
//                    and hashed fresh (the worst realistic turn: evicted or
//                    first-seen segments). Gates at ≤50 ms p95.
//   prep.warmP95Ms — the steady state: 100% cache hits, cached Buffer
//                    segments reused AS-IS, no per-segment sha256 on the hot
//                    path (hashing is a cache-miss/manifest-publication
//                    cost). Gates at ≤5 ms p95.
//   prep.payloadBytes — the compiled body size: THE byte truth of the
//                    provider payload (dialect-normalized segments — thinking
//                    cut, images reduced to cas:// placeholders), gated at
//                    ≤32 MB always and ≤12 MB on the images corpus. The
//                    compile's maxBytes guard runs on this measured path, so
//                    a breach fails the bench with WireBudgetExceeded.
//   prep.manifestBytes — Σ segment byteLen of the projection manifest (the
//                    compaction byte-trigger axis) for contrast: raw payload
//                    bytes ≥ wire bytes, never equal.
//
// Usage: node --expose-gc scripts/bench/bench-prep.mjs
//        (env FIXTURE=... [WINDOW=200] [ITERS=50] [MAX_PAYLOAD_BYTES=33554432])
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const fail = (message) => {
  console.error(`bench-prep: ${message}`);
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
const projectionUrl = pathToFileURL(join(packagesRoot, 'context-projection/src/index.ts')).href;
const wireUrl = pathToFileURL(join(packagesRoot, 'wire-compiler/src/index.ts')).href;

const fixture = process.env.FIXTURE;
if (!fixture) fail('FIXTURE env var is required (path to a .jsonl session file)');
const windowSize = Number(process.env.WINDOW ?? 200);
if (!Number.isInteger(windowSize) || windowSize < 1) fail(`WINDOW must be a positive integer, got "${process.env.WINDOW}"`);
const iters = Number(process.env.ITERS ?? 50);
if (!Number.isInteger(iters) || iters < 1) fail(`ITERS must be a positive integer, got "${process.env.ITERS}"`);
const maxPayloadBytes = Number(process.env.MAX_PAYLOAD_BYTES ?? 32 * 1048576);
if (!Number.isFinite(maxPayloadBytes) || maxPayloadBytes < 0) fail(`MAX_PAYLOAD_BYTES must be non-negative, got "${process.env.MAX_PAYLOAD_BYTES}"`);

const { ProjectionService } = await import(projectionUrl);
const { compile, createLruSegmentCache } = await import(wireUrl);
const { scanFixture, gc, percentileMs, metric } = await import('./lib/scan-fixture.mjs');

// Open: capsule + retained window slice (the lazy open; measured separately
// from the prep stage and gated by the resume bench).
const { totalLines, lastLines } = await scanFixture(fixture, windowSize);
const head = totalLines;
const sliceStart = totalLines - lastLines.length;
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
const openStarted = performance.now();
const service = ProjectionService.fromCapsule(capsule, entries);
const manifest = service.manifest();
const openMs = performance.now() - openStarted;

// The wire entries of the window: the per-entry stage a real dialect
// normalizes. Content is the fixture line's REAL message (text and image
// blocks — the minimax-m3 dialect cuts inline base64 down to cas:// links),
// so prep.payloadBytes measures what would actually go to the provider.
function messageOf(line) {
  try {
    const parsed = JSON.parse(line);
    const message = parsed?.message;
    if (message && typeof message.role === 'string') {
      return { role: message.role, content: message.content };
    }
  } catch {
    // fall through to the raw-line shape
  }
  return { role: 'user', content: line };
}
const wireEntries = manifest.segments.map((segment, index) => {
  const message = messageOf(lastLines[index] ?? '');
  const kind = message.role === 'system' ? 'system' : 'text';
  return {
    entryId: segment.entryId,
    kind,
    role: message.role,
    content: message.content,
  };
});
const wireManifest = manifest.segments.map((segment) => ({ entryId: segment.entryId }));

// Cold-cache compiles: a fresh LRU each iteration (every segment serialized
// and hashed).
const coldSamples = [];
for (let i = 0; i < iters; i += 1) {
  const cache = createLruSegmentCache(windowSize * 2);
  const started = performance.now();
  compile(wireManifest, wireEntries, { maxBytes: maxPayloadBytes, cache });
  coldSamples.push(performance.now() - started);
}

// Warm steady state: one shared cache, pre-warmed; every compile is 100%
// cache hits with no re-hashing.
const warmCache = createLruSegmentCache(windowSize * 2);
compile(wireManifest, wireEntries, { maxBytes: maxPayloadBytes, cache: warmCache });
let warmPayloadBytes = 0;
const warmSamples = [];
for (let i = 0; i < iters; i += 1) {
  const started = performance.now();
  const compiled = compile(wireManifest, wireEntries, { maxBytes: maxPayloadBytes, cache: warmCache });
  warmSamples.push(performance.now() - started);
  warmPayloadBytes = compiled.totalBytes;
}

metric('prep.p95Ms', percentileMs(coldSamples, 0.95));
metric('prep.p50Ms', percentileMs(coldSamples, 0.5));
metric('prep.warmP95Ms', percentileMs(warmSamples, 0.95));
metric('prep.warmP50Ms', percentileMs(warmSamples, 0.5));
metric('prep.payloadBytes', warmPayloadBytes);
metric('prep.manifestBytes', manifest.windowBytes);
metric('prep.windowEntries', manifest.segments.length);
metric('prep.openMs', openMs);
metric('prep.iters', iters);
