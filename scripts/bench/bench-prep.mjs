#!/usr/bin/env node
// Measures the PREP stage of the new context path (Ф2 "prep ≤50 ms p95 at
// any history length; goal ≤5 ms warm") through the RUNTIME COMPOSITION —
// `ContextWirePipeline.prepare()`, the exact request path:
// convertEntry → compiledEntryToWireEntry → compiledRecordDialect, with the
// per-entry conversion NOT memoized across prepares (it re-runs for every
// window segment on every prepare, exactly as in
// packages/local-runtime-v2/.../context-wire.ts).
//
//   prep.p95Ms     — cold compiles: a fresh pipeline (fresh segment cache)
//                    per iteration; every segment converted + serialized +
//                    hashed fresh. Gates at ≤50 ms p95.
//   prep.warmP95Ms — the steady state: one warm pipeline; 100% segment-cache
//                    hits, no re-hashing — but the per-entry conversion still
//                    runs, because that is what the runtime does. Gates at
//                    ≤5 ms p95.
//   prep.payloadBytes — the compiled body size: THE byte truth of the
//                    provider payload (dialect-normalized wire segments),
//                    gated at ≤32 MB always and ≤12 MB on the images corpus.
//                    The pipeline's maxBytes guard runs on this measured
//                    path; a breach fails the bench with WireBudgetExceeded.
//   prep.manifestBytes — Σ segment byteLen of the projection manifest (the
//                    compaction byte-trigger axis) for contrast.
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
const contextWireUrl = pathToFileURL(join(packagesRoot, 'local-runtime-v2/src/service/turn-system/compaction/context-wire.ts')).href;

const fixture = process.env.FIXTURE;
if (!fixture) fail('FIXTURE env var is required (path to a .jsonl session file)');
const windowSize = Number(process.env.WINDOW ?? 200);
if (!Number.isInteger(windowSize) || windowSize < 1) fail(`WINDOW must be a positive integer, got "${process.env.WINDOW}"`);
const iters = Number(process.env.ITERS ?? 50);
if (!Number.isInteger(iters) || iters < 1) fail(`ITERS must be a positive integer, got "${process.env.ITERS}"`);
const maxPayloadBytes = Number(process.env.MAX_PAYLOAD_BYTES ?? 32 * 1048576);
if (!Number.isFinite(maxPayloadBytes) || maxPayloadBytes < 0) fail(`MAX_PAYLOAD_BYTES must be non-negative, got "${process.env.MAX_PAYLOAD_BYTES}"`);

const { ContextWirePipeline } = await import(contextWireUrl);
const { scanFixture, gc, percentileMs, metric } = await import('./lib/scan-fixture.mjs');

// The durable entries of the window: the fixture line's REAL message under
// the pi-durable payload convention (`{model:[message]}`) — what
// convert-to-llm decodes; the images corpus's inline base64 is cut to
// placeholders by the conversion, exactly as in production.
const { totalLines, lastLines } = await scanFixture(fixture, windowSize);
const sliceStart = totalLines - lastLines.length;
function messageOf(line, index0) {
  try {
    const message = JSON.parse(line)?.message;
    if (message && typeof message.role === 'string') return message;
  } catch {
    // fall through
  }
  return { role: index0 % 2 === 0 ? 'user' : 'assistant', content: line };
}
const entries = lastLines.map((line, index) => {
  const index0 = sliceStart + index;
  return {
    id: `e${index0 + 1}`,
    parentId: index === 0 ? null : `e${index0}`,
    kind: index0 % 2 === 0 ? 'pi.user' : 'pi.assistant',
    payload: { model: [messageOf(line, index0)] },
    seq: totalLines,
    ordinal: index,
  };
});
const capsule = {
  head: totalLines,
  firstKeptEntryId: null,
  compaction: null,
  usageAnchor: entries.at(-1)?.id ?? null,
  appliedSeq: totalLines,
};

/** A pipeline over the fixed window; the (lazy-open) fold is NOT timed. */
function makePipeline(cacheCapacity) {
  const started = performance.now();
  const pipeline = ContextWirePipeline.fromCapsule(capsule, entries, {
    maxBytes: maxPayloadBytes,
    cacheCapacity,
  });
  return { pipeline, constructMs: performance.now() - started };
}

// ── Cold: a fresh pipeline per iteration (fresh cache, conversion +
// serialization + hashing from scratch), one prepare each.
const coldSamples = [];
const coldPayloadBytes = [];
const openSamples = [];
for (let i = 0; i < iters; i += 1) {
  gc();
  const { pipeline, constructMs } = makePipeline(windowSize * 2);
  openSamples.push(constructMs);
  const started = performance.now();
  const prepared = pipeline.prepare();
  coldSamples.push(performance.now() - started);
  coldPayloadBytes.push(prepared.totalBytes);
}

// ── Warm: one pipeline, pre-warmed; the steady-state prepare — cache hits,
// no re-hashing, conversion still runs per segment (the runtime behavior).
const warm = makePipeline(windowSize * 2);
warm.pipeline.prepare(); // warm the segment cache
let warmPayloadBytes = 0;
const warmSamples = [];
for (let i = 0; i < iters; i += 1) {
  const started = performance.now();
  const prepared = warm.pipeline.prepare();
  warmSamples.push(performance.now() - started);
  warmPayloadBytes = prepared.totalBytes;
}

metric('prep.p95Ms', percentileMs(coldSamples, 0.95));
metric('prep.p50Ms', percentileMs(coldSamples, 0.5));
metric('prep.warmP95Ms', percentileMs(warmSamples, 0.95));
metric('prep.warmP50Ms', percentileMs(warmSamples, 0.5));
metric('prep.payloadBytes', warmPayloadBytes);
metric('prep.manifestBytes', warm.pipeline.manifest().windowBytes);
metric('prep.windowEntries', warm.pipeline.manifest().segments.length);
metric('prep.openMs', percentileMs(openSamples, 0.5));
metric('prep.iters', iters);
