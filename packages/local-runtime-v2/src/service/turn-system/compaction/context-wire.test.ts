// ContextWirePipeline tests (wave-2 review, readiness finding): the runtime
// really imports the Ф2 context path — projection → convert-to-llm →
// wire-compiler — and the composed pipeline satisfies the invariants the
// gates rely on: incremental prepare ≡ one-shot prepare, window-bounded
// content retention, byte-guard on the measured path, capsule resume.

import { describe, expect, it } from 'vitest';

import type { Entry, JsonValue, Seq } from '../../../../../durable-backend-sqlite-zstd/src/types.js';

import {
  ContextWirePipeline,
  DEFAULT_MAX_PAYLOAD_BYTES,
  commitOfEntries,
  prepareContextWire,
} from './context-wire.js';
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
