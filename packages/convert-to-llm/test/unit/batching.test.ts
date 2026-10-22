/**
 * Immediate-send batching (acceptance coverage for the outbound-message-
 * normalizer port): messages sharing `hostMetadata.immediateSendBatchId`
 * merge into ONE user record at the first member's position, including
 * non-adjacent members, exactly like `mergeImmediateSendBatches` in the
 * mcode outbound-message-normalizer.
 */

import { describe, expect, it } from 'vitest';

import { assemblePayload } from '../../src/index.js';
import { makeEntry, resetEntrySeq, toolResultEntry, userEntry } from './helpers.js';

function batchedUserEntry(id: string, text: string, batchId: string) {
  return makeEntry(id, 'pi.user', {
    model: [
      {
        role: 'user',
        content: text,
        timestamp: 1,
        hostMetadata: { immediateSendBatchId: batchId },
      },
    ],
  });
}

describe('immediate-send batching', () => {
  it('merges batch members into the first member position', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      userEntry('u0', 'regular turn'),
      batchedUserEntry('b1', 'queued one', 'batch-1'),
      batchedUserEntry('b2', 'queued two', 'batch-1'),
    ]);

    const users = payload.records.filter((record) => record.role === 'user');
    expect(users.map((record) => record.entryId)).toEqual(['u0', 'b1']);
    expect(users[1]!.content).toBe('queued one\n\nqueued two');
    expect(users[1]!.sourceEntryIds).toEqual(['b1', 'b2']);
    expect(payload.stats.batchJoins).toBe(1);
  });

  it('merges non-adjacent members into the first member position', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      batchedUserEntry('b1', 'steer', 'batch-1'),
      toolResultEntry('t1', 'call_1', 'tool output'),
      batchedUserEntry('b2', 'steer more', 'batch-1'),
    ]);

    expect(payload.records.map((record) => record.entryId)).toEqual(['b1', 't1']);
    const merged = payload.records[0]!;
    expect(merged.content).toBe('steer\n\nsteer more');
    expect(merged.sourceEntryIds).toEqual(['b1', 'b2']);
  });

  it('keeps different batches and unbatched entries independent', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      batchedUserEntry('a1', 'a-one', 'batch-a'),
      batchedUserEntry('b1', 'b-one', 'batch-b'),
      batchedUserEntry('a2', 'a-two', 'batch-a'),
      userEntry('solo', 'plain'),
    ]);

    const users = payload.records.filter((record) => record.role === 'user');
    expect(users.map((record) => record.entryId)).toEqual(['a1', 'b1', 'solo']);
    expect(users[0]!.content).toBe('a-one\n\na-two');
    expect(users[1]!.content).toBe('b-one');
    expect(payload.stats.batchJoins).toBe(1);
  });

  it('merging is deterministic and keys by all member ids', () => {
    resetEntrySeq();
    const entries = [batchedUserEntry('b1', 'one', 'x'), batchedUserEntry('b2', 'two', 'x')];
    const first = assemblePayload(entries);
    const second = assemblePayload(entries);
    expect(JSON.stringify(first.records)).toBe(JSON.stringify(second.records));
    expect(first.records[0]!.cacheKey).toContain('b1+b2');
  });
});
