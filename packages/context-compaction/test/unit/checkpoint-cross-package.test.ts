// Cross-package bridge test for the CHECKPOINT contract (wave-2 review,
// round 2, correctness defect B): a real `compact()` draft produced over a
// log with interleaved `mcode.*` audit bookkeeping must (a) name a
// CONTEXT-VISIBLE entry as `firstKeptEntryId` — never an audit entry — and
// (b) FOLD through `@mavis/context-projection`'s ProjectionService without
// error, cutting the manifest to the kept tail.
//
// The defect: the cut-point pull-back parked `firstKeptEntryId` on an
// audit/control entry; the projection fold resolves the id against segments
// (audit entries never become segments) and threw
// `firstKeptEntryId "..." is not a segment of the current context` — and
// since the append persists the draft before any projection validation, the
// durable compaction commit could never be applied; the session wedged at
// that seq.
//
// Vocabulary adapter: the compaction core sees conversation entries as
// `mcode.message` (its own log dialect); the projection fold sees
// conversation entries as non-`mcode.*` kinds (pi.*) — the runtime
// composition maps between them. The adapter below preserves IDS and
// payloads 1:1, which is exactly what makes the `firstKeptEntryId` contract
// checkable across both packages.

import { describe, expect, it } from 'vitest';

import { compact, findCutPoint } from '../../src/index.js';
import type { CompactionMessage, LogEntry, ProjectedEntry } from '../../src/index.js';
import { RecordingSummarizer, messageEntry, userMessage } from './helpers.js';
import { ProjectionService, buildProjection } from '../../../context-projection/src/index.js';
import type { Entry, JsonValue, Seq } from '../../../durable-backend-sqlite-zstd/src/types.js';

/** Interleaved log: `messages` conversation entries, each followed by one audit bookkeeping entry. */
function interleavedLog(messages: number, fillerChars: number): LogEntry[] {
  const log: LogEntry[] = [];
  for (let i = 0; i < messages; i += 1) {
    log.push(messageEntry(userMessage(`${'m'.repeat(fillerChars)}-${i}`), `m${i + 1}`));
    log.push({
      id: `a${i + 1}`,
      parentId: `m${i + 1}`,
      kind: 'mcode.owner-input.received',
      payload: { received: `${'a'.repeat(64)}-${i}` },
      seq: 0,
      ordinal: 0,
    });
  }
  return log;
}

/** Projection-vocabulary view of the log: same ids and payloads, pi.* kinds for conversation entries. */
function toProjectionVocabulary(log: readonly LogEntry[]): Entry[] {
  return log.map((entry, index) => ({
    id: entry.id,
    parentId: entry.parentId ?? null,
    kind: entry.kind === 'mcode.message' ? 'pi.user' : entry.kind,
    payload: entry.payload as JsonValue,
    seq: (index + 1) as Seq,
    ordinal: 0,
  }));
}

function commit(seq: number, entries: readonly Entry[]) {
  return {
    seq: seq as Seq,
    batchId: seq as never,
    entryCount: entries.length,
    head: seq as Seq,
    codec: 'zstd' as const,
    compressedBytes: 0,
    uncompressedBytes: 0,
    entries,
  };
}

describe('compaction checkpoint folds through the projection with interleaved audit entries', () => {
  it('real compact() draft: firstKeptEntryId is context-visible and ProjectionService applies it', async () => {
    // 10 messages × 50 tokens, one audit entry after each. With
    // keepRecentTokens=100 the budget is crossed at the 8th-newest message,
    // and the OLD pull-back parked the cut on the audit right before it
    // (`a6`), which the projection fold can never resolve.
    const log = interleavedLog(10, 200);
    const summarizer = new RecordingSummarizer('S');
    const outcome = await compact({
      entries: log,
      summarizer: summarizer.call,
      keepRecentTokens: 100,
    });
    expect(outcome).not.toBeNull();

    const auditIds = log.filter((entry) => entry.kind !== 'mcode.message').map((entry) => entry.id);
    const messageIds = log.filter((entry) => entry.kind === 'mcode.message').map((entry) => entry.id);
    // (a) The cut is a CONTEXT-VISIBLE entry — never audit bookkeeping.
    expect(auditIds).not.toContain(outcome!.firstKeptEntryId);
    expect(messageIds).toContain(outcome!.firstKeptEntryId);
    expect(outcome!.draft.kind).toBe('mcode.compaction');

    // (b) The projection vocabulary view of the same log + the checkpoint
    // entry folds WITHOUT error and cuts exactly to the kept tail.
    const projectionLog = toProjectionVocabulary(log);
    projectionLog.push({
      id: outcome!.draft.id,
      parentId: projectionLog.at(-1)!.id,
      kind: outcome!.draft.kind,
      payload: outcome!.draft.payload as JsonValue,
      seq: (projectionLog.length + 1) as Seq,
      ordinal: 0,
    });

    const service = new ProjectionService();
    for (let index = 0; index < projectionLog.length; index += 1) {
      const entry = projectionLog[index]!;
      service.apply(commit(index + 1, [entry])); // must not throw ProjectionError
    }

    const keptFrom = projectionLog.findIndex((entry) => entry.id === outcome!.firstKeptEntryId);
    expect(keptFrom).toBeGreaterThan(0);
    const expectedSegments = projectionLog.slice(keptFrom).filter((entry) => !entry.kind.startsWith('mcode.')).map((entry) => entry.id);
    expect(service.manifest().segments.map((segment) => segment.entryId)).toEqual(expectedSegments);
    expect(service.manifest()).toEqual(buildProjection(projectionLog));
    // The summarized-away prefix is out of the window, byte axis included.
    expect(service.capsule().firstKeptEntryId).toBe(outcome!.firstKeptEntryId);
  });

  it('a cut in the middle of a metadata run still lands on a visible entry', () => {
    // Direct cut-point probe: a run of audit entries between two messages,
    // budget crossed right before the run.
    const visible = (id: string, text: string): ProjectedEntry => ({
      id,
      isCompaction: false,
      contextMessages: [{ role: 'user', content: text } as CompactionMessage],
    });
    const invisible = (id: string): ProjectedEntry => ({ id, isCompaction: false, contextMessages: [] });
    // [m1, a1, a2, m2, a4, m3]; the budget is crossed inside the a1..a2 run.
    const entries = [
      visible('m1', 'x'.repeat(400)),
      invisible('a1'),
      invisible('a2'),
      visible('m2', 'y'.repeat(400)),
      invisible('a4'),
      visible('m3', 'z'.repeat(400)),
    ];
    const cut = findCutPoint(entries, 0, entries.length, 150);
    const cutId = entries[cut.firstKeptEntryIndex]!.id;
    expect(['a1', 'a2', 'a4']).not.toContain(cutId);
    expect(entries[cut.firstKeptEntryIndex]!.contextMessages.length).toBeGreaterThan(0);
  });
});
