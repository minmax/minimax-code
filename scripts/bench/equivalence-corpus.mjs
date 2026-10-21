#!/usr/bin/env node
// Corpus equivalence gate (Ф2 acceptance): the compiler's body bytes must
// match the reference "full replay + stringify" on EVERY sampled head of the
// corpus — 100%, no tolerance (final-architecture.md:407).
//
// Tested path: the INCREMENTAL pipeline — each commit applied through ONE
// ProjectionService, manifest window compiled through the wire compiler with
// a WARM cache carried across heads (cache-key drift, eviction staleness,
// fold divergence and ordering bugs all break this).
//
// Reference path: independent of the incremental machinery — a FULL rebuild
// (`buildProjection`) of each sampled head's log, every manifest entry
// converted and serialized fresh (`serializeCompiledEntry`), concatenated in
// manifest order. No LRU, no incremental fold, no budget guard.
//
// The manifest equivalence itself is checked head-by-head too: incremental
// apply×N must equal a full rebuild at every sampled head.
//
// Exit code: 0 when every head matched, 1 on any mismatch (the merge-barrier
// form; performance.yml runs this against the messages corpus).
//
// Usage: node scripts/bench/equivalence-corpus.mjs
//        (env FIXTURE=... [STEP=10] [MAX_HEADS=0=all])
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const fail = (message) => {
  console.error(`equivalence-corpus: ${message}`);
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
const convertUrl = pathToFileURL(join(packagesRoot, 'convert-to-llm/src/index.ts')).href;
const wireUrl = pathToFileURL(join(packagesRoot, 'wire-compiler/src/index.ts')).href;

const fixture = process.env.FIXTURE;
if (!fixture) fail('FIXTURE env var is required (path to a .jsonl session file)');
const step = Number(process.env.STEP ?? 10);
if (!Number.isInteger(step) || step < 1) fail(`STEP must be a positive integer, got "${process.env.STEP}"`);
const maxHeads = Number(process.env.MAX_HEADS ?? 0);

const { ProjectionService, buildProjection } = await import(projectionUrl);
const { convertEntry, serializeCompiledEntry } = await import(convertUrl);
const { compile, compiledEntryToWireEntry, compiledRecordDialect, createLruSegmentCache } = await import(wireUrl);
const { scanFixture } = await import('./lib/scan-fixture.mjs');

// The corpus: every fixture line is one committed entry (one entry per
// commit, seq 1..N) carrying the line's REAL message ({model:[message]} —
// the pi-durable convention convert-to-llm decodes). The whole corpus is
// replayed from the first entry — the equivalence target is the FULL log
// per head, not a windowed resume.
const { totalLines, lastLines } = await scanFixture(fixture, Number.MAX_SAFE_INTEGER);
function messageOf(line, index) {
  try {
    const message = JSON.parse(line)?.message;
    if (message && typeof message.role === 'string') return message;
  } catch {
    // fall through
  }
  return { role: index % 2 === 0 ? 'user' : 'assistant', content: line };
}
const entries = lastLines.map((line, index) => ({
  id: `e${index + 1}`,
  parentId: index === 0 ? null : `e${index}`,
  kind: index % 2 === 0 ? 'pi.user' : 'pi.assistant',
  payload: { model: [messageOf(line, index)] },
  seq: index + 1,
  ordinal: 0,
}));
const entryById = new Map(entries.map((entry) => [entry.id, entry]));

const service = new ProjectionService();
const cache = createLruSegmentCache(4096);
const dialect = compiledRecordDialect();
let headsChecked = 0;
let manifestMismatches = 0;
let bodyMismatches = 0;

for (let applied = 1; applied <= entries.length; applied += 1) {
  const entry = entries[applied - 1];
  service.apply({ seq: entry.seq, batchId: entry.seq, entryCount: 1, head: entry.seq, codec: 'zstd', compressedBytes: 0, uncompressedBytes: 0, entries: [entry] });

  const isSampled = applied % step === 0 || applied === entries.length;
  if (!isSampled) continue;
  if (maxHeads > 0 && headsChecked >= maxHeads) break;

  // Tested path: incremental manifest + warm-cache compile.
  const manifest = service.manifest();
  const wireEntries = manifest.segments
    .map((segment) => entryById.get(segment.entryId))
    .filter((candidate) => candidate !== undefined)
    .map((candidate) => compiledEntryToWireEntry(convertEntry(candidate)));
  const wireManifest = manifest.segments.map((segment) => ({ entryId: segment.entryId }));
  const compiled = compile(wireManifest, wireEntries, { maxBytes: 32 * 1048576, dialect, cache });

  // Reference path: full rebuild + fresh convert + stringify per head.
  const logPrefix = entries.slice(0, applied);
  const referenceManifest = buildProjection(logPrefix);
  const referenceBody = Buffer.concat(
    referenceManifest.segments
      .map((segment) => entryById.get(segment.entryId))
      .filter((candidate) => candidate !== undefined)
      .map((candidate) => Buffer.from(`${serializeCompiledEntry(convertEntry(candidate))}\n`, 'utf8')),
  );

  const manifestEqual =
    JSON.stringify(manifest.segments) === JSON.stringify(referenceManifest.segments) &&
    manifest.usageAnchor === referenceManifest.usageAnchor &&
    manifest.head === referenceManifest.head;
  if (!manifestEqual) manifestMismatches += 1;
  if (!compiled.body.equals(referenceBody)) bodyMismatches += 1;
  headsChecked += 1;
}

console.log(`equivalence.headsChecked=${headsChecked}`);
console.log(`equivalence.manifestMismatches=${manifestMismatches}`);
console.log(`equivalence.bodyMismatches=${bodyMismatches}`);
console.log(`equivalence.totalEntries=${totalLines}`);
console.log(`equivalence.step=${step}`);
if (manifestMismatches > 0 || bodyMismatches > 0) {
  console.error('equivalence-corpus: FAILED — compiler bytes diverged from the full-replay reference');
  process.exit(1);
}
console.log('equivalence.passed=true');
