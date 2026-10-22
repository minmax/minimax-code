/**
 * Manifest-driven assembly ({@link assembleManifestPayload}) over REAL
 * projection manifests: every happy-path manifest here is built by
 * `buildProjection` from `@mavis/context-projection`, which never emits
 * `mcode.*` segments (its `isControlKind` covers every `mcode.` kind). The
 * tests pin the contract that follows from that:
 *
 * - the two model-visible control kinds (placed entry, system reminder)
 *   reach the payload from the entry LOG, not from the manifest, and the
 *   payload reports how many (`stats.modelVisibleSelected`);
 * - the compaction summary replaces the cut prefix as the leading user
 *   record (content-keyed id, the runtime seam's convention);
 * - corrupted manifests are loud (duplicate or unresolved segment ids),
 *   mirroring the wire compiler's manifest handling.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  buildProjection,
  type ContextManifest,
  type Segment,
} from '../../../context-projection/src/index.js';
import type { Entry as BackendEntry } from '../../../durable-backend-sqlite-zstd/src/types.js';
import { assembleManifestPayload, assemblePayload, type DurableEntry } from '../../src/index.js';
import { makeEntry, resetEntrySeq, userEntry } from './helpers.js';

/** The projection folds backend `Entry` values (branded `Seq`); cast the fixtures. */
function project(entries: readonly DurableEntry[]): ContextManifest {
  return buildProjection(entries as unknown as readonly BackendEntry[]);
}

/**
 * Hand-built manifest for MALFORMED-INPUT tests only (duplicate or
 * unresolved segment ids). The real `buildProjection` cannot produce these
 * shapes — which is exactly why the error paths need a literal. The `as Seq`
 * style numeric fields are the only unchecked part; every other field is
 * checked against the imported type.
 */
function rawManifest(segments: ReadonlyArray<{ entryId: string; kind: string }>): ContextManifest {
  const rows: Segment[] = segments.map((segment, index) => ({
    entryId: segment.entryId,
    byteLen: 16 + index,
    kind: segment.kind,
  }));
  return {
    head: 9 as never,
    segments: rows,
    windowBytes: rows.reduce((total, row) => total + row.byteLen, 0),
    usageAnchor: rows.length > 0 ? rows[rows.length - 1]!.entryId : null,
    watermark: { seq: 9 as never, ordinal: 0 },
  };
}

const placedPayload = (inputEntryId: string, text: string) => ({
  inputEntryId,
  model: [{ role: 'user', content: text, timestamp: 5 }],
});

describe('manifest path over a real buildProjection fold', () => {
  it('keeps model-visible control entries the manifest never carries', () => {
    resetEntrySeq();
    const entries = [
      userEntry('u1', 'kept'),
      makeEntry('r1', 'mcode.owner-input.received', { inputId: 'in_1' }),
      makeEntry('p1', 'mcode.owner-input.placed', placedPayload('in_7', 'steer text')),
      makeEntry('rem1', 'mcode.system-reminder', { text: 'todo changed' }),
      userEntry('u2', 'also kept'),
    ];
    // The real fold: audit/control NEVER become segments — including the
    // placed entry and the reminder.
    const manifest = project(entries);
    expect(manifest.segments.map((segment) => segment.entryId)).toEqual(['u1', 'u2']);

    const payload = assembleManifestPayload(entries, manifest);
    // Placed entry and reminder come from the log at their log positions;
    // the audit receipt is gone.
    expect(payload.records.map((record) => record.entryId)).toEqual([
      'u1',
      'p1',
      'u2',
      'rem1',
    ]);
    expect(payload.records.some((record) => record.entryId === 'r1')).toBe(false);
    // Steer text survives: "placed exactly once" holds on the manifest path.
    const placed = payload.records.filter((record) => record.entryId === 'p1');
    expect(placed).toHaveLength(1);
    expect(placed[0]!.role).toBe('user');
    expect(placed[0]!.content).toBe('steer text');
    // Reminder sits strictly after the prefix.
    expect(payload.tails.map((record) => record.entryId)).toEqual(['rem1']);
    expect(payload.prefix.every((record) => !record.tail)).toBe(true);
    // The outside-the-window share is measurable, never silent.
    expect(payload.stats.modelVisibleSelected).toBe(2);
    expect(payload.stats.manifestSegments).toBe(2);
    expect(payload.stats.compactionSummaryIncluded).toBe(false);
  });

  it('dedups a recovery-artifact double placement on the manifest path', () => {
    resetEntrySeq();
    const entries = [
      userEntry('u1', 'before'),
      makeEntry('p1', 'mcode.owner-input.placed', placedPayload('in_7', 'steer text')),
      makeEntry('p2', 'mcode.owner-input.placed', placedPayload('in_7', 'corrupt copy')),
    ];
    const manifest = project(entries);
    expect(manifest.segments.map((segment) => segment.entryId)).toEqual(['u1']);

    const payload = assembleManifestPayload(entries, manifest);
    const placed = payload.records.filter((record) => record.entryId.startsWith('p'));
    expect(placed.map((record) => record.entryId)).toEqual(['p1']);
    expect(placed[0]!.content).toBe('steer text');
    expect(payload.stats.placedDropped).toBe(1);
    expect(payload.stats.modelVisibleSelected).toBe(2);
  });

  it('puts the compaction summary first and keeps the kept tail after it', () => {
    resetEntrySeq();
    const summary = 'Earlier turns: project setup and a bash tutorial.';
    // Create in log order: the real fold rejects non-advancing positions.
    const u0 = userEntry('u0', 'cut by compaction');
    const u1 = userEntry('u1', 'kept turn');
    const compaction = makeEntry('c1', 'mcode.compaction', {
      summary,
      firstKeptEntryId: 'u1',
    });
    const entries = [u0, u1, compaction];
    const manifest = project(entries);
    expect(manifest.segments.map((segment) => segment.entryId)).toEqual(['u1']);
    expect(manifest.compaction).toEqual({ summary, firstKeptEntryId: 'u1' });

    const payload = assembleManifestPayload(entries, manifest);
    // Leading user record keyed by the summary content (runtime-seam
    // convention: mcode-compaction-summary#<sha256[:16]>).
    const expectedId = `mcode-compaction-summary#${
      createHash('sha256').update(summary, 'utf8').digest('hex').slice(0, 16)
    }`;
    expect(payload.records.map((record) => record.entryId)).toEqual([expectedId, 'u1']);
    expect(payload.records[0]!.role).toBe('user');
    expect(payload.records[0]!.content).toBe(summary);
    expect(payload.records[0]!.tail).toBe(false);
    // The cut entry stays out; the summary is part of the stable prefix.
    expect(payload.records.some((record) => record.entryId === 'u0')).toBe(false);
    expect(payload.prefix.map((record) => record.entryId)).toEqual([expectedId, 'u1']);
    expect(payload.tails).toHaveLength(0);
    expect(payload.stats.compactionSummaryIncluded).toBe(true);
    expect(payload.stats.prefixBytes).toBe(
      payload.prefix.reduce((total, record) => total + record.byteLen, 0),
    );
    expect(payload.stats.totalBytes).toBe(payload.stats.prefixBytes + payload.stats.tailBytes);
  });

  it('keys the summary record by summary content, not by cut position', () => {
    resetEntrySeq();
    const foldWith = (summary: string) => {
      // Create in log order: the real fold rejects non-advancing positions.
      const u1 = userEntry('u1', 'kept');
      const compaction = makeEntry('c1', 'mcode.compaction', {
        summary,
        firstKeptEntryId: 'u1',
      });
      const entries = [u1, compaction];
      return { entries, manifest: project(entries) };
    };
    const variantA = foldWith('summary A');
    const variantB = foldWith('summary B');
    const first = assembleManifestPayload(variantA.entries, variantA.manifest);
    const recompiled = assembleManifestPayload(variantA.entries, variantA.manifest);
    const changed = assembleManifestPayload(variantB.entries, variantB.manifest);
    // Same summary → same id (cache-stable); new summary over the same cut → new id.
    expect(first.records[0]!.entryId).toBe(recompiled.records[0]!.entryId);
    expect(first.records[0]!.entryId).not.toBe(changed.records[0]!.entryId);
    expect(changed.records[0]!.content).toBe('summary B');
  });

  it('is deterministic over repeated real-manifest assemblies', () => {
    resetEntrySeq();
    const entries = [
      userEntry('u1', 'hello'),
      makeEntry('rem1', 'mcode.system-reminder', { text: 'todo changed' }),
      userEntry('u2', 'world'),
    ];
    const manifest = project(entries);
    const first = JSON.stringify(assembleManifestPayload(entries, manifest).records);
    for (let i = 0; i < 20; i += 1) {
      expect(JSON.stringify(assembleManifestPayload(entries, manifest).records)).toBe(first);
    }
  });

  it('differs from the direct path exactly by the window and the summary', () => {
    resetEntrySeq();
    // Create in log order: the real fold rejects non-advancing positions.
    const u0 = userEntry('u0', 'old');
    const u1 = userEntry('u1', 'kept');
    const compaction = makeEntry('c1', 'mcode.compaction', {
      summary: 'setup summary',
      firstKeptEntryId: 'u1',
    });
    const entries = [u0, u1, compaction];
    const manifest = project(entries);

    const viaManifest = assembleManifestPayload(entries, manifest);
    expect(viaManifest.records.some((record) => record.entryId === 'u0')).toBe(false);
    // The direct path over the same log keeps everything convertible (the
    // compaction entry itself is audit/control and drops out there).
    expect(assemblePayload(entries).records.map((record) => record.entryId)).toEqual(['u0', 'u1']);
    expect(viaManifest.records.map((record) => record.entryId)).toEqual([
      expect.stringMatching(/^mcode-compaction-summary#/),
      'u1',
    ]);
  });
});

describe('manifest integrity (loud, mirroring the wire compiler)', () => {
  it('rejects duplicate segment ids instead of silently collapsing them', () => {
    resetEntrySeq();
    const entries = [userEntry('u1', 'hello')];
    // Unproducible by the real fold — a botched fold / hand-edit artifact.
    const manifest = rawManifest([
      { entryId: 'u1', kind: 'pi.user' },
      { entryId: 'u1', kind: 'pi.user' },
    ]);
    expect(() => assembleManifestPayload(entries, manifest)).toThrow(
      /duplicate entryId in manifest segments: "u1"/,
    );
  });

  it('rejects segments whose entry is absent from entries instead of skipping', () => {
    resetEntrySeq();
    const entries = [userEntry('u1', 'hello')];
    const manifest = rawManifest([
      { entryId: 'u1', kind: 'pi.user' },
      { entryId: 'ghost', kind: 'pi.user' },
    ]);
    expect(() => assembleManifestPayload(entries, manifest)).toThrow(
      /manifest segment references entry absent from entries: "ghost"/,
    );
  });
});
