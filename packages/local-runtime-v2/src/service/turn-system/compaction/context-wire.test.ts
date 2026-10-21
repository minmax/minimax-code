// ContextWirePipeline tests (wave-2 review, readiness finding): the runtime
// really imports the Ф2 context path — projection → convert-to-llm →
// wire-compiler — and the composed pipeline satisfies the invariants the
// gates rely on: incremental prepare ≡ one-shot prepare, window-bounded
// content retention, byte-guard on the measured path, capsule resume.
//
// Wave-2 round-1 additions (steering D+C seam contract): the two
// model-visible control kinds reach the provider payload exactly as
// `assembleManifestPayload` (convert-to-llm) emits them —
// `mcode.owner-input.placed` exactly once (inputEntryId dedup, first log
// occurrence wins, recovery-artifact duplicates dropped) and
// `mcode.system-reminder` strictly after the stable prefix — and the seam's
// compiled body is BYTE-IDENTICAL to `assembleManifestPayload` on the same
// window (pinned, not assumed: the two manifest assembly paths must never
// fork).

import { describe, expect, it } from 'vitest';

import type { Entry, JsonValue, Seq } from '../../../../../durable-backend-sqlite-zstd/src/types.js';

import {
  ContextWirePipeline,
  DEFAULT_MAX_PAYLOAD_BYTES,
  commitOfEntries,
  prepareContextWire,
  type ContextWireResidency,
} from './context-wire.js';
import type { ContextMmu, PageHandle } from '../../../../../context-mmu/src/index.js';
import {
  assembleManifestPayload,
  serializeCompiledEntry,
} from '../../../../../convert-to-llm/src/index.js';
import { WireBudgetExceeded } from '../../../../../wire-compiler/src/index.js';

let counter = 0;

function entry(kind: string, payload: JsonValue, seq: number, ordinal: number): Entry {
  counter += 1;
  return { id: `e-${counter}`, parentId: null, kind, payload, seq: seq as Seq, ordinal };
}

/** One user turn as two durable entries. */
function turn(seq: number, text: string): Entry[] {
  return [
    entry('pi.user', { model: [{ role: 'user', content: text }] }, seq, 0),
    entry('pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'text', text: `ok: ${text}` }] }] }, seq, 1),
  ];
}

/** The steering placed entry (`mcode.owner-input.placed`) — the executed user input. */
function placed(text: string, inputEntryId: string, seq: number, ordinal: number): Entry {
  return entry('mcode.owner-input.placed', { inputEntryId, model: [{ role: 'user', content: text, timestamp: 5 }] }, seq, ordinal);
}

/** A dedicated system-reminder entry (converts to a tail record). */
function reminder(text: string, seq: number, ordinal: number): Entry {
  return entry('mcode.system-reminder', { text }, seq, ordinal);
}

/** The assembled payload bytes of the reference manifest path, record for record. */
function referenceBody(entries: readonly Entry[], manifest: ReturnType<ContextWirePipeline['manifest']>): Buffer {
  return Buffer.concat(
    assembleManifestPayload(entries, manifest).records.map((record) =>
      Buffer.from(`${serializeCompiledEntry(record)}\n`, 'utf8'),
    ),
  );
}

describe('ContextWirePipeline (runtime composition of the Ф2 context path)', () => {
  it('prepare() over incremental commits equals the one-shot full-log prepare', () => {
    const pipeline = new ContextWirePipeline();
    const log: Entry[] = [];
    for (let seq = 1; seq <= 6; seq += 1) {
      const batch = turn(seq, `question ${seq}`);
      log.push(...batch);
      pipeline.applyCommit(commitOfEntries(seq, batch));
    }

    const incremental = pipeline.prepare();
    const oneShot = prepareContextWire(log);
    expect(incremental.body.equals(oneShot.body)).toBe(true);
    expect(incremental.totalBytes).toBe(oneShot.totalBytes);
    expect(incremental.manifestBytes).toBe(oneShot.manifestBytes);
    expect(incremental.manifest.segments).toEqual(oneShot.manifest.segments);
    // The provider payload is NDJSON: one provider record per line.
    const lines = incremental.body.toString('utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(12);
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
  });

  it('prunes content pages to the window: compaction drops the cut entries', () => {
    const pipeline = new ContextWirePipeline();
    const firstTurn = turn(1, 'early history that will be compacted away');
    pipeline.applyCommit(commitOfEntries(1, firstTurn));
    const secondTurn = turn(2, 'kept');
    pipeline.applyCommit(commitOfEntries(2, secondTurn));

    const beforePages = pipeline.pageCount;
    expect(beforePages).toBe(4);
    const segmentsBefore = pipeline.manifest().segments.map((segment) => segment.entryId);

    // Compaction checkpoint: keeps the second turn only.
    const keptId = segmentsBefore[2]!;
    const checkpoint = entry(
      'mcode.compaction',
      {
        summary: 'summary of turn 1',
        firstKeptEntryId: keptId,
        systemMessage: null,
        isSplitTurn: false,
        tokensBefore: 100,
        estimatedTokensAfter: 20,
        createdAtMs: 1,
      },
      3,
      0,
    );
    pipeline.applyCommit(commitOfEntries(3, [checkpoint]));

    expect(pipeline.pageCount).toBe(2); // the kept turn's two pages only
    const prepared = pipeline.prepare();
    expect(prepared.manifest.segments).toHaveLength(2);
    expect(prepared.body.toString('utf8')).toContain('summary of turn 1');
  });

  it('capsule round-trip: fromCapsule resumes the same provider payload after a compaction', () => {
    const pipeline = new ContextWirePipeline();
    const log: Entry[] = [];
    for (let seq = 1; seq <= 3; seq += 1) {
      const batch = turn(seq, `q${seq}`);
      log.push(...batch);
      pipeline.applyCommit(commitOfEntries(seq, batch));
    }
    // Compact away the first two turns: the capsule now describes the
    // retained window (summary mark + kept third turn).
    const keptId = pipeline.manifest().segments[4]!.entryId;
    const checkpoint = entry(
      'mcode.compaction',
      {
        summary: 'summary of turns 1-2',
        firstKeptEntryId: keptId,
        systemMessage: null,
        isSplitTurn: false,
        tokensBefore: 300,
        estimatedTokensAfter: 40,
        createdAtMs: 1,
      },
      4,
      0,
    );
    log.push(checkpoint);
    pipeline.applyCommit(commitOfEntries(4, [checkpoint]));

    const capsule = pipeline.capsule();
    expect(capsule.firstKeptEntryId).toBe(keptId);
    // The retained slice the storage layer serves: kept entries plus the
    // checkpoint entry that closes the window (its summary also rides in the
    // capsule, so the fold and the mark agree).
    const slice = log.filter((candidate) => candidate.seq >= 3);
    const resumed = ContextWirePipeline.fromCapsule(capsule, slice);
    expect(resumed.prepare().body.equals(pipeline.prepare().body)).toBe(true);
    expect(resumed.capsule().appliedSeq).toBe(capsule.appliedSeq);
  });

  it('enforces the payload byte guard on the measured path', () => {
    const pipeline = new ContextWirePipeline({ maxBytes: 64 });
    const big = entry('pi.user', { model: [{ role: 'user', content: 'x'.repeat(256) }] }, 1, 0);
    pipeline.applyCommit(commitOfEntries(1, [big]));
    expect(() => pipeline.prepare()).toThrow(WireBudgetExceeded);
    // The default is the Ф2 gate value.
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(32 * 1024 * 1024);
  });

  it('warm prepares reuse cached segments (no re-serialization) byte-identically', () => {
    const pipeline = new ContextWirePipeline();
    const batch = turn(1, 'only turn');
    pipeline.applyCommit(commitOfEntries(1, batch));
    const first = pipeline.prepare();
    const second = pipeline.prepare();
    expect(second.body.equals(first.body)).toBe(true);
    expect(second.segments.every((stat) => stat.cacheHit)).toBe(true);
    // Cache hits carry no sha256 — the hot path pays no per-segment hashing.
    expect(second.segments.every((stat) => stat.sha256 === undefined)).toBe(true);
  });
});

describe('ContextWirePipeline steering D+C seam (model-visible control kinds)', () => {
  it('admits the placed entry exactly once — a recovery-artifact duplicate is dropped', () => {
    // A crash between the admission commit and the delivery-index update can
    // replay the placement: two durable placed entries share one
    // inputEntryId. The payload must carry the input EXACTLY once (first log
    // occurrence wins), and the seam must agree with convert-to-llm.
    const pipeline = new ContextWirePipeline();
    const log: Entry[] = [
      ...turn(1, 'question'),
      placed('steer text', 'in_1', 2, 0),
      // Recovery artifact: same inputEntryId, fresh entry id, corrupt copy.
      placed('corrupt copy', 'in_1', 3, 0),
      ...turn(4, 'after steer'),
    ];
    for (let seq = 1; seq <= 4; seq += 1) {
      const batch = log.filter((candidate) => candidate.seq === seq);
      if (batch.length > 0) pipeline.applyCommit(commitOfEntries(seq, batch));
    }

    const prepared = pipeline.prepare();
    const lines = prepared.body.toString('utf8').trimEnd().split('\n');
    const steerLines = lines.filter((line) => line.includes('steer text'));
    expect(steerLines).toHaveLength(1);
    expect(prepared.body.toString('utf8')).not.toContain('corrupt copy');
    // The audit receipt never reaches the payload even if it logs.
    expect(prepared.body.toString('utf8')).not.toContain('mcode.owner-input.received');

    // Incremental ≡ one-shot ≡ the reference manifest path, byte for byte.
    expect(prepared.body.equals(prepareContextWire(log).body)).toBe(true);
    expect(prepared.body.equals(referenceBody(log, prepared.manifest))).toBe(true);
  });

  it('positions reminder records strictly after the stable cache prefix', () => {
    const pipeline = new ContextWirePipeline();
    const log: Entry[] = [
      ...turn(1, 'before'),
      // A reminder logged BETWEEN turns still becomes a tail record.
      reminder('context usage is high', 2, 0),
      // An embedded block inside user text splits: residual prefix + tail.
      entry('pi.user', { model: [{ role: 'user', content: 'real ask <system-reminder>embedded note</system-reminder>' }] }, 3, 0),
      ...turn(4, 'after'),
    ];
    for (let seq = 1; seq <= 4; seq += 1) {
      pipeline.applyCommit(commitOfEntries(seq, log.filter((candidate) => candidate.seq === seq)));
    }

    const prepared = pipeline.prepare();
    const text = prepared.body.toString('utf8');
    const lines = text.trimEnd().split('\n');
    // The reference path owns the ordering contract: every tail record sits
    // after every prefix record. Recompute the split from the reference.
    const reference = assembleManifestPayload(log, prepared.manifest);
    expect(reference.tails.length).toBeGreaterThanOrEqual(2);
    const tailLines = reference.tails.map((record) => `${serializeCompiledEntry(record)}\n`);
    // The body ends with exactly the tail section, in reference order.
    expect(text.endsWith(tailLines.join(''))).toBe(true);
    // No reminder bytes leak into the prefix section.
    const prefixText = lines.slice(0, lines.length - reference.tails.length).join('\n');
    expect(prefixText).not.toContain('context usage is high');
    expect(prefixText).not.toContain('embedded note');
    expect(prefixText).toContain('real ask');
    // Both manifests agree byte for byte.
    expect(prepared.body.equals(referenceBody(log, prepared.manifest))).toBe(true);
    expect(prepared.body.equals(prepareContextWire(log).body)).toBe(true);
  });

  it('cuts control pages at a compaction exactly like the retained slice does', () => {
    const pipeline = new ContextWirePipeline();
    const firstTurn = turn(1, 'old question');
    const preSteer = placed('old steer', 'in_old', 1, 2); // before the future cut
    pipeline.applyCommit(commitOfEntries(1, [...firstTurn, preSteer]));
    const keptTurn = turn(2, 'kept question');
    pipeline.applyCommit(commitOfEntries(2, keptTurn));
    const keptId = keptTurn[0]!.id;
    const checkpoint = entry(
      'mcode.compaction',
      { summary: 'summary of turn 1', firstKeptEntryId: keptId, systemMessage: null, isSplitTurn: false, tokensBefore: 100, estimatedTokensAfter: 20, createdAtMs: 1 },
      3,
      0,
    );
    pipeline.applyCommit(commitOfEntries(3, [checkpoint]));
    const postSteer = placed('new steer', 'in_new', 4, 0);
    const postReminder = reminder('fresh reminder', 4, 1);
    const controlBatch = [postSteer, postReminder];
    pipeline.applyCommit(commitOfEntries(4, controlBatch));

    const log: Entry[] = [...firstTurn, preSteer, ...keptTurn, checkpoint, ...controlBatch];
    const prepared = pipeline.prepare();
    const text = prepared.body.toString('utf8');
    // The cut prefix's steering went with it; the window's own control stayed.
    expect(text).toContain('new steer');
    expect(text).toContain('fresh reminder');
    expect(text).not.toContain('old steer');
    expect(prepared.manifest.compaction).toEqual({ summary: 'summary of turn 1', firstKeptEntryId: keptId });

    // Byte equality holds on the retained slice the capsule serves (from
    // firstKeptEntryId to head — the resumed pipeline's exact input).
    const sliceStart = log.findIndex((candidate) => candidate.id === keptId);
    const slice = log.slice(sliceStart);
    expect(prepared.body.equals(referenceBody(slice, prepared.manifest))).toBe(true);

    // A pipeline resumed from the capsule compiles the same body.
    const resumed = ContextWirePipeline.fromCapsule(pipeline.capsule(), slice);
    expect(resumed.prepare().body.equals(prepared.body)).toBe(true);
  });
});

describe('ContextWirePipeline image residency (Ф2 R2 overlay, judge round 1)', () => {
  /** One user entry carrying a text part and an inline base64 image block. */
  function imageEntry(seq: number, ordinal: number, base64: string): Entry {
    return entry(
      'pi.user',
      { model: [{ role: 'user', content: [{ type: 'text', text: `shot ${ordinal}` }, { type: 'image', mimeType: 'image/png', data: base64 }] }] },
      seq,
      ordinal,
    );
  }

  /** Minimal Context-MMU double: residency statuses keyed by page id. */
  function residencyOf(
    pageByEntry: ReadonlyMap<string, { id: string; sha256: string }>,
    statusByPage: Map<string, 'resident' | 'digest'>,
  ): ContextWireResidency {
    return {
      mmu: {
        statusOf: (handle: PageHandle) => statusByPage.get(handle.id) ?? 'digest',
      } as unknown as ContextMmu,
      pageOf: (candidate: Entry) => pageByEntry.get(candidate.id),
    };
  }

  it('a resident image rides the payload; a digest one stays a placeholder', () => {
    const imgA = imageEntry(1, 0, 'QUFBQUFB');
    const imgB = imageEntry(1, 1, 'QkJCQkJC');
    const pageA = { id: 'page-a', sha256: 'a'.repeat(64) };
    const pageB = { id: 'page-b', sha256: 'b'.repeat(64) };
    const statusByPage = new Map<string, 'resident' | 'digest'>([
      ['page-a', 'resident'],
      ['page-b', 'digest'],
    ]);
    const pipeline = new ContextWirePipeline({
      residency: residencyOf(
        new Map([
          [imgA.id, pageA],
          [imgB.id, pageB],
        ]),
        statusByPage,
      ),
    });
    pipeline.applyCommit(commitOfEntries(1, [imgA, imgB]));

    const prepared = pipeline.prepare();
    const text = prepared.body.toString('utf8');
    // The RESIDENT page's real bytes ride the record as a data URL...
    expect(text).toContain('data:image/png;base64,QUFBQUFB');
    // ...while the DIGEST page keeps the dialect placeholder and never leaks.
    expect(text).toContain('[image: image/png]');
    expect(text).not.toContain('QkJCQkJC');
    // The resident record compiles under its content-keyed wire identity; the
    // digest one under the plain entry id.
    const ids = prepared.segments.map((segment) => segment.entryId);
    expect(ids).toContain(`${imgA.id}#resident@${'a'.repeat(16)}`);
    expect(ids).toContain(imgB.id);
  });

  it('a residency flip recompiles: the segment cache never serves the other state', () => {
    const img = imageEntry(1, 0, 'QUFBQUFB');
    const page = { id: 'page-a', sha256: 'a'.repeat(64) };
    const statusByPage = new Map<string, 'resident' | 'digest'>([['page-a', 'resident']]);
    const pipeline = new ContextWirePipeline({ residency: residencyOf(new Map([[img.id, page]]), statusByPage) });
    pipeline.applyCommit(commitOfEntries(1, [img]));
    const resident = pipeline.prepare();
    expect(resident.body.toString('utf8')).toContain('data:image/png;base64,QUFBQUFB');

    // The page is EVICTED: the next prepare must re-convert to the
    // placeholder — the cached resident bytes are keyed under the resident
    // wire identity, so a stale hit is impossible.
    statusByPage.set('page-a', 'digest');
    const evicted = pipeline.prepare();
    const evictedText = evicted.body.toString('utf8');
    expect(evictedText).not.toContain('QUFBQUFB');
    expect(evictedText).toContain('[image: image/png]');
    expect(evictedText.length).toBeLessThan(resident.totalBytes);

    // Faulted back in: the resident bytes return (a fresh segment under the
    // content key), byte-identical to the first resident prepare.
    statusByPage.set('page-a', 'resident');
    const back = pipeline.prepare();
    expect(back.body.equals(resident.body)).toBe(true);
  });

  it('without a residency option the path stays the all-evicted baseline', () => {
    const img = imageEntry(1, 0, 'QUFBQUFB');
    const baseline = new ContextWirePipeline();
    baseline.applyCommit(commitOfEntries(1, [img]));
    const prepared = baseline.prepare();
    const text = prepared.body.toString('utf8');
    expect(text).toContain('[image: image/png]');
    expect(text).not.toContain('QUFBQUFB');
    expect(prepared.segments.map((segment) => segment.entryId)).toEqual([img.id]);
    // Byte-identical to a residency whose page is never resident.
    const digestOnly = new ContextWirePipeline({
      residency: residencyOf(new Map([[img.id, { id: 'p', sha256: 'a'.repeat(64) }]]), new Map()),
    });
    digestOnly.applyCommit(commitOfEntries(1, [img]));
    expect(digestOnly.prepare().body.equals(prepared.body)).toBe(true);
  });
});
