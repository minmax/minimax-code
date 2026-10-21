#!/usr/bin/env node
// Full-circuit bench: the Ф2 request path measured END TO END through the real
// packages, not through a composed pipeline shortcut:
//
//   (1) corpus   — N_ENTRIES synthetic history entries (pi-durable
//                  `payload.model = [message]` convention). HEAVY_IMAGES=1
//                  replaces 62 of them with image entries carrying a ~1.5 MiB
//                  base64 imitation INLINE in the durable payload; the same
//                  bytes are published into a real CAS and wrapped in the
//                  Context MMU (resident budget 12 MiB, LRU eviction). The
//                  payload assembly runs under the residency overlay: a
//                  RESIDENT page rides the provider payload as a data URL
//                  (content-keyed wire id), a digest page stays the dialect
//                  placeholder — the Ф2 R2 architecture, judge round 1.
//   (2) commits  — entries flow through `createStorageWorker` (bridge mode:
//                  batch windows on the worker thread, `appendBatch` on this
//                  thread via `sqliteZstdStorageBackend`) into a fresh temp
//                  store. Every flush is read back (`readDelta`) and applied
//                  to the `ProjectionService` as `CommitWithEntries` — the
//                  O(new entries) incremental fold. When history exceeds
//                  WINDOW, one `mcode.compaction` control entry is committed
//                  through the same path, cutting the derived window to the
//                  last WINDOW entries.
//   (3) open     — the measured lazy open: `openSqliteZstdBackend` +
//                  `readResume()` (one meta row) + `readDeltaFrom`
//                  (firstKeptEntryId, batch-granular, trimmed to the capsule
//                  start) + `ProjectionService.fromCapsule` with the
//                  MMU-backed residency policy. Median of OPEN_ITERS.
//   (4) prepare  — the per-request path: `llmContext()` through the residency
//                  policy, `convertEntry` per window entry (the pinned
//                  per-entry stage), `compiledEntryToWireEntry`, then
//                  `compile()` with the 32 MiB guard, the compiled-record
//                  dialect and a persistent segment cache (hashes on cache
//                  misses only — the runtime steady state).
//   (5) llm-mock — the provider is replaced by a body verification, no
//                  network: NDJSON line boundaries, per-segment sha256,
//                  record shape of every line, byte stability across prepares,
//                  and zero EVICTED image-base64 leak into the body — a
//                  resident page's bytes ride the payload by design (the Ф2
//                  R2 overlay); an evicted page's base64 must never reach it.
//
// Gate (printed to stdout, drives the exit code): PASS iff prep.p95Ms
// ≤ PREP_BUDGET_MS (50) and payload.bytes ≤ MAX_PAYLOAD_BYTES (32 MiB) and
// the mock/MMU invariants hold; FAIL otherwise, with the reason.
//
// Requires --experimental-transform-types: the context-mmu sources use
// TypeScript parameter properties, which strip-only mode rejects.
//
// Requires --conditions=development on a clean checkout: the packages'
// `exports` map the `import` condition to built `dist/` (gitignored, not
// built by scripts/build.mjs); `development` resolves the TypeScript
// sources. Without it the run dies with ERR_MODULE_NOT_FOUND
// (@mavis/cas/dist/cas-ref.js via wire-compiler/src/dialect.ts).
//
// Usage:
//   node --conditions=development --experimental-transform-types --expose-gc scripts/bench/bench-prepare.mjs
//
// Profiles (each must print gate=PASS and exit 0):
//   text   — node --conditions=development --experimental-transform-types --expose-gc scripts/bench/bench-prepare.mjs
//   images — HEAVY_IMAGES=1 node --conditions=development --experimental-transform-types --expose-gc scripts/bench/bench-prepare.mjs
//   10x    — N_ENTRIES=20610 node --conditions=development --experimental-transform-types --expose-gc scripts/bench/bench-prepare.mjs
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (message) => {
  console.error(`bench-prepare: ${message}`);
  process.exit(2);
};

// Type stripping / transformation loads `.ts` sources but does not map the
// packages' `.js` specifiers onto them; register the mapping for this process
// only (same twist as the other benches).
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
const load = (relative) => pathToFileURL(join(packagesRoot, relative)).href;

const projectionUrl = load('context-projection/src/index.ts');
const storageWorkerUrl = load('storage-worker/src/index.ts');
const backendUrl = load('durable-backend-sqlite-zstd/src/index.ts');
const wireCompilerUrl = load('wire-compiler/src/index.ts');
const contextMmuUrl = load('context-mmu/src/index.ts');
const casUrl = load('cas/src/index.ts');
const convertToLlmUrl = load('convert-to-llm/src/index.ts');

// ── Environment ──────────────────────────────────────────────────────────────
const numberEnv = (name, fallback) => (process.env[name] === undefined ? fallback : Number(process.env[name]));
const nEntries = numberEnv('N_ENTRIES', 2061);
const windowSize = numberEnv('WINDOW', 200);
const iters = numberEnv('ITERS', 30);
const openIters = numberEnv('OPEN_ITERS', 5);
const entryTextKib = numberEnv('ENTRY_TEXT_KIB', 2);
const imageCount = numberEnv('IMAGE_COUNT', 62);
const imageKib = numberEnv('IMAGE_KIB', 1536); // ~1.5 MiB of base64 per image
const maxPayloadBytes = numberEnv('MAX_PAYLOAD_BYTES', 32 * 1048576);
const prepBudgetMs = numberEnv('PREP_BUDGET_MS', 50);
const mmuResidentBytes = numberEnv('MMU_RESIDENT_BYTES', 12 * 1048576);
const heavyImages = process.env.HEAVY_IMAGES === '1';
const keep = process.env.KEEP === '1';
const chunkEntries = numberEnv('CHUNK', 200);
const readBudgetBytes = 512 * 1048576; // uncompressed batch-scan budget for range reads

for (const [name, value] of [
  ['N_ENTRIES', nEntries],
  ['WINDOW', windowSize],
  ['ITERS', iters],
  ['OPEN_ITERS', openIters],
  ['ENTRY_TEXT_KIB', entryTextKib],
  ['IMAGE_COUNT', imageCount],
  ['IMAGE_KIB', imageKib],
  ['CHUNK', chunkEntries],
]) {
  if (!Number.isInteger(value) || value < 1) fail(`${name} must be a positive integer, got "${process.env[name]}"`);
}
for (const [name, value] of [['MAX_PAYLOAD_BYTES', maxPayloadBytes], ['PREP_BUDGET_MS', prepBudgetMs], ['MMU_RESIDENT_BYTES', mmuResidentBytes]]) {
  if (!Number.isFinite(value) || value < 0) fail(`${name} must be non-negative, got "${process.env[name]}"`);
}
if (windowSize > nEntries) fail(`WINDOW (${windowSize}) must not exceed N_ENTRIES (${nEntries})`);

const profileLabel = heavyImages ? `images-n${nEntries}` : `text-n${nEntries}`;

// ── Package imports (TypeScript sources, see the resolve hook above) ────────
const { ProjectionService, COMPACTION_KIND } = await import(projectionUrl);
const { createStorageWorker, sqliteZstdStorageBackend } = await import(storageWorkerUrl);
const { isZstdSupported, openSqliteZstdBackend } = await import(backendUrl);
const { compile, compiledEntryToWireEntry, compiledRecordDialect, createLruSegmentCache } = await import(wireCompilerUrl);
const { createMMU } = await import(contextMmuUrl);
const { openCas } = await import(casUrl);
const { convertEntry } = await import(convertToLlmUrl);
const { gc, metric, percentileMs, rssMiB } = await import('./lib/scan-fixture.mjs');

// ── Corpus generation helpers ────────────────────────────────────────────────
// One image entry every `imageStep` indices spreads IMAGE_COUNT images evenly
// across the history (and guarantees several land inside the final window).
const imageStep = heavyImages ? Math.max(1, Math.floor(nEntries / imageCount)) : 0;

function textFor(index) {
  const head = `Synthetic history entry ${index} of ${nEntries} (${profileLabel} corpus).`;
  const filler = 'The quick brown fox jumps over the lazy dog. ';
  const target = entryTextKib * 1024;
  const body = filler.repeat(Math.ceil(target / filler.length));
  return `${head}\n${body.slice(0, Math.max(0, target - head.length - 1))}`;
}

/** Deterministic ~imageKib KiB base64 string (the "base64 imitation"). */
function imageBase64(index) {
  const raw = Buffer.alloc(Math.floor((imageKib * 1024 * 3) / 4));
  let state = (index * 2654435761) >>> 0;
  // All four state bytes per step, not just the low byte: a low-byte-only
  // stream is periodic in 256 and every image repeats every other image's
  // substrings — the residency leak check below would false-positive on a
  // resident page carrying an evicted page's 48-char sample.
  for (let i = 0; i < raw.length; ) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    raw[i++] = (state >>> 24) & 0xff;
    if (i < raw.length) raw[i++] = (state >>> 16) & 0xff;
    if (i < raw.length) raw[i++] = (state >>> 8) & 0xff;
    if (i < raw.length) raw[i++] = state & 0xff;
  }
  return raw.toString('base64');
}

// ── Circuit state ────────────────────────────────────────────────────────────
const casDir = mkdtempSync(join(tmpdir(), 'bench-prepare-cas-'));
const storeDir = mkdtempSync(join(tmpdir(), 'bench-prepare-store-'));
const cas = await openCas(casDir);
const mmu = createMMU(cas, { maxResidentBytes: mmuResidentBytes });

/** entryId of every image entry → its MMU page handle. */
const imageHandleByEntry = new Map();
/** First bytes of every image's base64 payload; the leak check samples them. */
const imageLeakSamples = [];
let imagesInWindow = 0;

let rssMaxMb = 0;
const sampleRss = () => {
  rssMaxMb = Math.max(rssMaxMb, rssMiB());
};

function draftOf(index, base64) {
  const isImage = base64 !== undefined;
  const role = isImage || index % 2 === 1 ? 'user' : 'assistant';
  const content = isImage
    ? [{ type: 'image', mimeType: 'image/png', data: base64 }]
    : [{ type: 'text', text: textFor(index) }];
  const payload = { model: [{ role, content }] };
  return {
    entryId: `e${index}`,
    parentId: index === 1 ? null : `e${index - 1}`,
    kind: role === 'user' ? 'pi.user' : 'pi.assistant',
    payload,
    // The worker's window accounting uses the declared bytes; declare the real
    // serialized size instead of a guess.
    bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
  };
}

// ── Phase 1: corpus → storage-worker → backend → incremental projection ─────
const backendOptions = heavyImages ? { maxBatchUncompressedBytes: 4 * 1048576 } : {};
const backend = openSqliteZstdBackend(storeDir, backendOptions);
const worker = createStorageWorker(sqliteZstdStorageBackend(backend), {
  windowBytes: backend.maxBatchUncompressedBytes,
  maxBatchUncompressedBytes: backend.maxBatchUncompressedBytes,
});

const service = new ProjectionService();
let appliedSeq = 0; // SEQ_AT_START
let commitsApplied = 0;
let foldMs = 0;
let lastApplyResult = null;
const gateFailures = [];

/** Applies one backend batch (a readback group) to the projection. */
function applyGroup(entries) {
  const seq = entries[0].seq;
  const started = performance.now();
  // The projection reads only head === seq, entryCount, the successor order
  // and the per-entry seq; batchId === seq is a backend invariant
  // (durable-backend types.ts), uncompressedBytes is exact, compressedBytes
  // and codec are commit metadata the fold never reads.
  lastApplyResult = service.apply({
    seq,
    batchId: seq,
    head: seq,
    entryCount: entries.length,
    codec: isZstdSupported() ? 'zstd' : 'gzip',
    compressedBytes: 0,
    uncompressedBytes: entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'), 0),
    entries,
  });
  foldMs += performance.now() - started;
  appliedSeq = seq;
  commitsApplied += 1;
}

/** Enqueues the batch, flushes it through the worker, reads it back, folds it. */
async function commitBatch(batch) {
  if (batch.length === 0) return;
  for (const entry of batch) await worker.enqueue(entry);
  await worker.flush();
  await worker.checkpoint(); // fail-closed durability barrier per batch
  const readback = backend.readDelta(appliedSeq, readBudgetBytes);
  let group = [];
  for (const entry of readback) {
    if (group.length > 0 && group[0].seq !== entry.seq) {
      applyGroup(group);
      group = [];
    }
    group.push(entry);
  }
  if (group.length > 0) applyGroup(group);
}

try {
  let batch = [];
  for (let index = 1; index <= nEntries; index += 1) {
    let base64;
    if (imageStep > 0 && index % imageStep === 0) {
      base64 = imageBase64(index);
      // Publish the page into the CAS through the MMU now (admit decides
      // residency, fault publishes the bytes and drops the RAM copy).
      const bytes = Buffer.from(base64, 'utf8');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const handle = mmu.page({ sha256, mime: 'image/png', bytes });
      mmu.admit(handle);
      await mmu.fault(handle); // CAS round-trip; pendingBytes released
      imageHandleByEntry.set(`e${index}`, handle);
      imageLeakSamples.push({ entryId: `e${index}`, sample: base64.slice(0, 48) });
    }
    batch.push(draftOf(index, base64));
    if (batch.length >= chunkEntries) {
      await commitBatch(batch);
      batch = [];
    }
  }
  await commitBatch(batch);

  // Window bound: one real compaction control entry through the same
  // worker → backend → fold path when history exceeds the window.
  if (nEntries > windowSize) {
    const firstKeptEntryId = `e${nEntries - windowSize + 1}`;
    const payload = {
      summary: `Synthetic compaction of the ${profileLabel} corpus: entries 1..${nEntries - windowSize} replaced by this summary.`,
      firstKeptEntryId,
    };
    await commitBatch([
      {
        entryId: 'mcode.compaction#bench',
        parentId: `e${nEntries}`,
        kind: COMPACTION_KIND,
        payload,
        bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      },
    ]);
    if (lastApplyResult?.rebuilt !== true) fail('compaction commit did not rewrite the derived view');
  }

  const windowEntries = service.manifest().segments.length;
  const expectedWindow = Math.min(windowSize, nEntries);
  if (windowEntries !== expectedWindow) {
    fail(`window has ${windowEntries} segments after the fold, expected ${expectedWindow}`);
  }
  const windowEntryIds = new Set(service.manifest().segments.map((segment) => segment.entryId));
  let imagesInWindow = 0;
  for (const id of windowEntryIds) {
    if (imageHandleByEntry.has(id)) imagesInWindow += 1;
  }
  /** Whether the image page of this entry is resident RIGHT NOW (stable from here on). */
  const imageResident = (entryId) => {
    const imageHandle = imageHandleByEntry.get(entryId);
    return imageHandle !== undefined && mmu.statusOf(imageHandle) === 'resident';
  };

  await worker.dispose();
  backend.close(); // release the writer marker before the measured opens
  gc();
  sampleRss();

  // ── Phase 2: the measured lazy head open ───────────────────────────────────
  const capsule = service.capsule();
  const openSamples = [];
  let opened;
  for (let i = 0; i < openIters; i += 1) {
    const started = performance.now();
    // Same options as the writer: the decode cap is per-handle, and the
    // images corpus's >256 KiB frames refuse to decode under the default.
    const handle = openSqliteZstdBackend(storeDir, backendOptions);
    const storageCapsule = handle.readResume();
    if (storageCapsule === null) fail('store has no resume capsule (nothing committed?)');
    const anchor = capsule.firstKeptEntryId ?? 'e1';
    const raw = handle.readDeltaFrom(anchor, readBudgetBytes, { inclusive: true });
    // Range reads are batch-granular; trim the slice to the exact entry the
    // capsule names (fromCapsule asserts the slice start).
    const slice =
      capsule.firstKeptEntryId === null
        ? raw
        : raw.slice(Math.max(0, raw.findIndex((entry) => entry.id === capsule.firstKeptEntryId)));
    // Residency policy backed by the Context MMU: text pages are always
    // resident; image pages follow the MMU's LRU decision.
    const segmentsById = new Map(
      slice.map((entry) => [
        entry.id,
        { entryId: entry.id, byteLen: Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'), kind: entry.kind },
      ]),
    );
    let faults = 0;
    const residency = {
      resident(entryId) {
        const imageHandle = imageHandleByEntry.get(entryId);
        if (imageHandle === undefined) return true;
        return mmu.statusOf(imageHandle) === 'resident';
      },
      async onFault(entryId) {
        faults += 1;
        const segment = segmentsById.get(entryId);
        if (segment === undefined) fail(`residency onFault: no page materialization for ${entryId}`);
        return segment;
      },
    };
    const openedService = ProjectionService.fromCapsule(capsule, slice, { residency });
    const ms = performance.now() - started;
    openSamples.push(ms);
    opened = { service: openedService, slice, faultsOf: () => faults };
    handle.close();
  }
  const headOpenMs = percentileMs(openSamples, 0.5);
  gc();
  sampleRss();

  // ── Phase 3: payload assembly over the MMU-backed projection ──────────────
  const { service: prepService, slice } = opened;
  const sourceById = new Map(slice.map((entry) => [entry.id, entry]));
  const dialect = compiledRecordDialect();
  const cache = createLruSegmentCache(4096);
  // Same wire id convention as the runtime composition
  // (local-runtime-v2 context-wire.ts `summaryEntryId`).
  const mark = prepService.manifest().compaction;
  const summaryRecord =
    mark === undefined
      ? undefined
      : {
          entryId: `mcode-compaction-summary#${createHash('sha256').update(mark.summary, 'utf8').digest('hex').slice(0, 16)}`,
          kind: 'text',
          role: 'user',
          content: mark.summary,
        };

  async function assemble(requireHashes) {
    const pages = await prepService.llmContext(); // residency overlay on the request path
    const wireEntries = [];
    const wireManifest = [];
    if (summaryRecord !== undefined) {
      wireEntries.push(summaryRecord);
      wireManifest.push({ entryId: summaryRecord.entryId });
    }
    for (const page of pages) {
      const source = sourceById.get(page.entryId);
      if (source === undefined) fail(`window entry ${page.entryId} has no source content page`);
      // Resident image page: its bytes ride the payload as a data URL, under
      // a content-keyed wire identity (same convention as the runtime
      // composition in local-runtime-v2 context-wire.ts). Digest pages take
      // the plain placeholder conversion.
      const rendering = imageResident(page.entryId)
        ? {
            cacheState: `resident@${imageHandleByEntry.get(page.entryId).sha256.slice(0, 16)}`,
            renderImage: (part) => (part.data === undefined ? undefined : `data:${part.mimeType};base64,${part.data}`),
          }
        : undefined;
      let record = convertEntry(source, undefined, rendering);
      if (record === null) continue; // audit/control entries carry no provider bytes
      if (rendering !== undefined) record = { ...record, entryId: `${record.entryId}#${rendering.cacheState}` };
      wireEntries.push(compiledEntryToWireEntry(record));
      wireManifest.push({ entryId: record.entryId });
    }
    return compile(wireManifest, wireEntries, { maxBytes: maxPayloadBytes, dialect, cache, requireHashes });
  }

  // Cold + hashed pass: every segment serialized AND hashed (the degraded
  // equivalence mode). This body is the verification target of the LLM mock.
  let started = performance.now();
  const verified = await assemble(true);
  const prepColdMs = performance.now() - started;

  // ── Phase 4: the LLM mock — body verification, no network ─────────────────
  const mockErrors = [];
  function verifyBody(compiled) {
    const { body, totalBytes, segments } = compiled;
    if (body.length !== totalBytes) mockErrors.push(`body length ${body.length} != totalBytes ${totalBytes}`);
    let offset = 0;
    let hashesOk = 0;
    let placeholders = 0;
    const roles = new Set();
    for (const segment of segments) {
      const line = body.subarray(offset, offset + segment.bytes);
      if (line.length !== segment.bytes || line[line.length - 1] !== 0x0a) {
        mockErrors.push(`segment ${segment.entryId} is not a LF-terminated line`);
        break;
      }
      if (segment.sha256 !== undefined) {
        const actual = createHash('sha256').update(line).digest('hex');
        if (actual === segment.sha256) hashesOk += 1;
        else mockErrors.push(`segment ${segment.entryId} sha256 mismatch`);
      }
      try {
        const record = JSON.parse(line.toString('utf8'));
        if (typeof record?.role !== 'string') mockErrors.push(`segment ${segment.entryId} has no string role`);
        else roles.add(record.role);
        if (typeof record.content === 'string' && record.content.includes('[image:')) placeholders += 1;
      } catch {
        mockErrors.push(`segment ${segment.entryId} is not valid JSON`);
      }
      offset += segment.bytes;
    }
    if (offset !== body.length) mockErrors.push(`segment bytes (${offset}) do not cover the body (${body.length})`);
    for (const { entryId, sample } of imageLeakSamples) {
      // A RESIDENT page's base64 is SUPPOSED to be in the body (the Ф2 R2
      // overlay); only an evicted page's bytes leaking is a defect.
      if (imageResident(entryId) || !body.includes(sample)) continue;
      mockErrors.push('evicted image base64 leaked into the wire body');
      break;
    }
    return { lines: segments.length, hashesOk, placeholders, roles: [...roles].sort() };
  }

  const verifiedStats = verifyBody(verified);
  const bodySha256 = createHash('sha256').update(verified.body).digest('hex');

  // Steady state: the warm cache serves segments as-is, no re-hashing; the
  // per-entry conversion re-runs every request (the runtime behavior).
  const prepSamples = [];
  let lastBody = verified.body;
  for (let i = 0; i < iters; i += 1) {
    const iterStarted = performance.now();
    const prepared = await assemble(false);
    prepSamples.push(performance.now() - iterStarted);
    lastBody = prepared.body;
    sampleRss();
  }
  gc();

  const prepP50Ms = percentileMs(prepSamples, 0.5);
  const prepP95Ms = percentileMs(prepSamples, 0.95);
  const prepMaxMs = Math.max(...prepSamples);
  const payloadBytes = verified.totalBytes;
  const byteStable = lastBody.equals(verified.body);
  if (!byteStable) mockErrors.push('warm prepare produced different bytes than the hashed prepare');
  const mmuStats = mmu.stats();
  const residentPages = mmuStats.bytes;
  let residentWindowImages = 0;
  for (const id of windowEntryIds) {
    if (imageResident(id)) residentWindowImages += 1;
  }
  if (residentPages > mmuResidentBytes) {
    gateFailures.push(`mmu resident bytes ${residentPages} exceed the budget ${mmuResidentBytes}`);
  }

  // MMU fault round-trip: a non-resident page must still materialize its exact
  // bytes from the CAS (digest-mode load-through).
  let faultRoundTripOk = 0;
  const digestHandle = [...imageHandleByEntry.values()].find((imageHandle) => mmu.statusOf(imageHandle) !== 'resident');
  if (digestHandle !== undefined) {
    const restored = await mmu.fault(digestHandle);
    faultRoundTripOk = restored.length === digestHandle.bytes ? 1 : 0;
    if (faultRoundTripOk !== 1) gateFailures.push('MMU fault returned wrong byte count');
  }

  // ── Machine-readable output ───────────────────────────────────────────────
  metric('circuit.profile', profileLabel);
  metric('circuit.entries', nEntries);
  metric('circuit.window', windowEntries);
  metric('circuit.images', imageHandleByEntry.size);
  metric('circuit.imagesInWindow', imagesInWindow);
  metric('circuit.commits', commitsApplied);
  metric('circuit.foldMs', foldMs);
  metric('prep.coldMs', prepColdMs);
  metric('prep.p50Ms', prepP50Ms);
  metric('prep.p95Ms', prepP95Ms);
  metric('prep.maxMs', prepMaxMs);
  metric('prep.iters', iters);
  metric('payload.bytes', payloadBytes);
  metric('payload.sha256', bodySha256);
  metric('head.openMs', headOpenMs);
  metric('rss.maxMb', Number(rssMaxMb.toFixed(1)));
  metric('mmu.residentBytes', residentPages);
  metric('mmu.residentPages', mmuStats.resident);
  metric('mmu.budgetBytes', mmuResidentBytes);
  metric('mmu.windowFaults', opened.faultsOf());
  metric('mmu.windowResidentImages', residentWindowImages);
  metric('mmu.faultRoundTripOk', faultRoundTripOk);
  metric('mock.lines', verifiedStats.lines);
  metric('mock.hashesOk', verifiedStats.hashesOk);
  metric('mock.imagePlaceholders', verifiedStats.placeholders);
  metric('mock.roles', verifiedStats.roles.join(','));
  metric('mock.byteStable', byteStable ? 1 : 0);

  // ── Gate ──────────────────────────────────────────────────────────────────
  const reasons = [...gateFailures];
  if (prepP95Ms > prepBudgetMs) reasons.push(`prep.p95Ms=${prepP95Ms.toFixed(2)} > ${prepBudgetMs}`);
  if (payloadBytes > maxPayloadBytes) reasons.push(`payload.bytes=${payloadBytes} > ${maxPayloadBytes}`);
  if (mockErrors.length > 0) reasons.push(`llm-mock failed: ${mockErrors.join('; ')}`);
  if (reasons.length > 0) {
    console.log(`gate=FAIL reason="${reasons.join('; ')}"`);
    process.exitCode = 1;
  } else {
    console.log(`gate=PASS (prep.p95Ms=${prepP95Ms.toFixed(2)} <= ${prepBudgetMs}; payload.bytes=${payloadBytes} <= ${maxPayloadBytes})`);
  }
} finally {
  await worker.dispose().catch(() => {});
  try {
    backend.close();
  } catch {
    // already closed on the success path
  }
  mmu.close();
  if (!keep) {
    rmSync(casDir, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  } else {
    console.error(`bench-prepare: KEEP=1 — store left at ${storeDir}, CAS at ${casDir}`);
  }
}
