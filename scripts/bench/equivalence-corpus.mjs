#!/usr/bin/env node
// Corpus equivalence gate (Ф2 acceptance): the compiler's body bytes must
// match the reference "full replay + stringify" on EVERY sampled head of the
// corpus — 100%, no tolerance (final-architecture.md:407).
//
// Corpus completeness (wave-2 round 1): the gate must cover not only plain
// user/assistant messages but the Ф2 log shapes — `mcode.context_edit`
// (omission and strict-prune variants), split turns (one turn stored as
// user → assistant toolCall → tool-result entries) and interrupted tools
// (toolResult with isError:true). The plain corpora stay supported; the
// `hybrid` corpus (build-fixtures.mjs) carries the full-shape cases via the
// per-line `case` marker.
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
// apply×N must equal a full rebuild at every sampled head — the check that
// actually exercises the context_edit rewrite (both sides must agree on the
// pruned segment list, head after head).
//
// Exit code: 0 when every head matched, 1 on any mismatch (the merge-barrier
// form; performance.yml runs this against the messages and hybrid corpora).
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

function fallbackMessage(line, index) {
  try {
    const message = JSON.parse(line)?.message;
    if (message && typeof message.role === 'string') return message;
  } catch {
    // fall through
  }
  return { role: index % 2 === 0 ? 'user' : 'assistant', content: line };
}

// Entry construction. Plain lines map 1:1; the hybrid cases expand to their
// durable shapes (split turn → three entries, interrupted tool → two) and
// context_edit lines become control entries whose targets are resolved
// against the log built so far — strict-prune targets must be current
// segments, so the generator cycle guarantees one fresh split-turn group
// between consecutive edits.
const entries = [];
const splitTurnGroups = []; // most recent last; strict prune pops, omission peeks
const hybridCounters = { splitTurn: 0, interruptedTool: 0, contextEdit: 0 };

function pushEntry(kind, payload) {
  const id = `e${entries.length + 1}`;
  entries.push({
    id,
    parentId: entries.length === 0 ? null : entries[entries.length - 1].id,
    kind,
    payload: { model: [payload] },
    seq: entries.length + 1,
    ordinal: 0,
  });
  return id;
}

/** Control entries carry their payload raw — no `{model:[...]}` wrapper. */
function pushControlEntry(kind, payload) {
  const id = `e${entries.length + 1}`;
  entries.push({
    id,
    parentId: entries.length === 0 ? null : entries[entries.length - 1].id,
    kind,
    payload,
    seq: entries.length + 1,
    ordinal: 0,
  });
  return id;
}

function buildSplitTurn(line) {
  const group = [];
  group.push(pushEntry('pi.user', line.message));
  group.push(pushEntry('pi.assistant', line.assistant));
  group.push(pushEntry('pi.tool-result', line.toolResult));
  splitTurnGroups.push(group);
  hybridCounters.splitTurn += 1;
}

function buildInterruptedTool(line) {
  pushEntry('pi.assistant', line.message);
  pushEntry('pi.tool-result', line.toolResult);
  hybridCounters.interruptedTool += 1;
}

function buildContextEdit(line, index) {
  if (line.variant !== 'prune' && line.variant !== 'omission') {
    fail(`fixture line ${index + 1}: unknown context_edit variant "${line.variant}"`);
  }
  const group = splitTurnGroups[splitTurnGroups.length - 1];
  if (group === undefined) fail(`fixture line ${index + 1}: context_edit before any split-turn group`);
  const payload =
    line.variant === 'prune'
      ? { removedEntryIds: [...group] } // strict prune: exact window knowledge
      : { action: 'omission', targetIds: [...group], reason: 'overflow-retraction (synthetic corpus)' };
  if (line.variant === 'prune') splitTurnGroups.pop(); // its targets are gone
  pushControlEntry('mcode.context_edit', payload);
  hybridCounters.contextEdit += 1;
}

lastLines.forEach((line, index) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = undefined;
  }
  const testCase = typeof parsed?.case === 'string' ? parsed.case : 'message';
  switch (testCase) {
    case 'split_turn':
      buildSplitTurn(parsed);
      break;
    case 'interrupted_tool':
      buildInterruptedTool(parsed);
      break;
    case 'context_edit':
      buildContextEdit(parsed, index);
      break;
    default: {
      const message = fallbackMessage(line, index);
      pushEntry(message.role === 'assistant' ? 'pi.assistant' : 'pi.user', message);
    }
  }
});
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
console.log(`equivalence.logEntries=${entries.length}`);
console.log(`equivalence.step=${step}`);
// Shape coverage of the corpus (the Ф2 cases the gate must exercise; zero
// counts on the hybrid corpus would mean the gate silently shrank back to
// plain messages).
console.log(`equivalence.splitTurnGroups=${hybridCounters.splitTurn}`);
console.log(`equivalence.interruptedTools=${hybridCounters.interruptedTool}`);
console.log(`equivalence.contextEdits=${hybridCounters.contextEdit}`);
if (manifestMismatches > 0 || bodyMismatches > 0) {
  console.error('equivalence-corpus: FAILED — compiler bytes diverged from the full-replay reference');
  process.exit(1);
}
console.log('equivalence.passed=true');
