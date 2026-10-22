import { describe, expect, it, vi } from 'vitest';

import { EntryTooLargeError, SqliteZstdAdapterStateError } from '../../src/errors.js';
import {
  commitFromSqliteZstd,
  sqliteZstdStorageBackend,
  toEntryDraft,
  type SqliteZstdBackendLike,
  type SqliteZstdCommitLike,
} from '../../src/sqlite-zstd-adapter.js';
import type { Commit, Entry } from '../../src/contracts.js';

// Replay safety of the post-stringify split: when a bisect commits a prefix
// and the suffix fails, a worker retry must skip EXACTLY the committed prefix
// and re-append EXACTLY the suffix — never the committed part again (the
// backend's entry-id primary key would fail and mask the original error).

function entry(entryId: string, textKb: number): Entry {
  return {
    entryId,
    parentId: null,
    kind: 'pi.session',
    payload: { text: 'z'.repeat(textKb * 1024) },
    bytes: textKb * 1024,
  };
}

describe('sqlite-zstd adapter replay safety', () => {
  it('resumes a partially split batch from the failed suffix, not from the prefix', async () => {
    const cap = 256 * 1024;
    let call = 0;
    const calls: string[][] = [];
    const commits: SqliteZstdCommitLike[] = [];
    const backend: SqliteZstdBackendLike = {
      maxBatchUncompressedBytes: cap,
      appendBatch: vi.fn(async (drafts) => {
        call += 1;
        calls.push(drafts.map((draft) => draft.id));
        // Attempt 1: prefix [e1,e2] commits, suffix [e3,e4] "backend dies".
        // Attempt 2 (the worker retry): the suffix must go through alone.
        if (call === 2) throw new Error('backend died mid-split');
        commits.push({ batchId: commits.length + 1, seq: commits.length + 1, head: commits.length + 1 });
        return commits[commits.length - 1]!;
      }),
    };
    const adapter = sqliteZstdStorageBackend(backend);
    const batch = [entry('e1', 80), entry('e2', 80), entry('e3', 80), entry('e4', 80)];
    const whole = JSON.stringify(batch.map(toEntryDraft));
    expect(Buffer.byteLength(whole, 'utf8')).toBeGreaterThan(cap); // splits

    // Attempt 1: the prefix commits, the suffix fails.
    await expect(adapter.appendBatch(batch)).rejects.toThrow('backend died mid-split');
    expect(calls).toEqual([['e1', 'e2'], ['e3', 'e4']]);

    // Attempt 2 (worker retry of the SAME batch): only the suffix is written.
    const commit: Commit = await adapter.appendBatch(batch);
    expect(calls).toEqual([['e1', 'e2'], ['e3', 'e4'], ['e3', 'e4']]);
    expect(commit).toEqual(commitFromSqliteZstd({ batchId: 2, seq: 2, head: 2 }));

    // The poison path still names its single offender after bisecting.
    await expect(adapter.appendBatch([entry('huge', 300)])).rejects.toThrow(EntryTooLargeError);
  });

  it('never re-appends committed ids even across many retries', async () => {
    const cap = 256 * 1024;
    const seen: string[][] = [];
    let failSuffix = true;
    const backend: SqliteZstdBackendLike = {
      maxBatchUncompressedBytes: cap,
      appendBatch: async (drafts) => {
        const ids = drafts.map((draft) => draft.id);
        seen.push(ids);
        if (ids.includes('e4') && failSuffix) throw new Error('suffix keeps failing');
        return { batchId: seen.length, seq: seen.length, head: seen.length };
      },
    };
    const adapter = sqliteZstdStorageBackend(backend);
    const batch = [entry('e1', 80), entry('e2', 80), entry('e3', 80), entry('e4', 80)];

    await expect(adapter.appendBatch(batch)).rejects.toThrow('suffix keeps failing');
    failSuffix = false;
    const commit = await adapter.appendBatch(batch);

    // The committed prefix [e1,e2] was sent exactly ONCE across both attempts.
    expect(seen[0]).toEqual(['e1', 'e2']);
    expect(seen[1]).toEqual(['e3', 'e4']);
    expect(seen[2]).toEqual(['e3', 'e4']);
    expect(commit.batchId).toBe('3');
  });

  it('returns a commit covering the whole split range: first seq, last head', async () => {
    // IC-F1-006: a resume cursor anchored at the returned commit must not
    // skip middle sub-batches. The aggregate carries the FIRST sub-batch's
    // seq and the LAST sub-batch's head; single-commit calls are untouched.
    const cap = 256 * 1024;
    let seq = 0;
    const backend: SqliteZstdBackendLike = {
      maxBatchUncompressedBytes: cap,
      appendBatch: async () => {
        seq += 1;
        return { batchId: seq, seq, head: seq };
      },
    };
    const adapter = sqliteZstdStorageBackend(backend);
    const batch = [entry('e1', 80), entry('e2', 80), entry('e3', 80), entry('e4', 80)];

    const commit: Commit = await adapter.appendBatch(batch);
    // Split into [e1,e2] (seq 1) + [e3,e4] (seq 2): first seq, last head.
    expect(commit).toEqual({ batchId: '2', seq: 1, head: '2' });
  });

  it('consumes a duplicate-insert refusal as idempotent success (SW-04)', async () => {
    // The in-memory committedIds Set is the fast path; the backend's domain
    // duplicate error is the backstop when bookkeeping missed (another
    // adapter instance over the same backend, a replayed batch).
    let call = 0;
    const seen: string[][] = [];
    const backend: SqliteZstdBackendLike = {
      maxBatchUncompressedBytes: 256 * 1024,
      appendBatch: async (drafts) => {
        call += 1;
        const ids = drafts.map((draft) => draft.id);
        seen.push(ids);
        // "dupe" was committed by someone else; the raw sqlite wording is
        // what today's backend raises before a domain class lands.
        if (ids.includes('dupe')) {
          const error = new Error('UNIQUE constraint failed: entries.entry_id');
          throw error;
        }
        return { batchId: call, seq: call, head: call };
      },
    };
    const adapter = sqliteZstdStorageBackend(backend);
    // Fits one cap: the first append attempt throws on the duplicate, the
    // adapter bisects entry by entry, skips the durable one as success.
    const commit: Commit = await adapter.appendBatch([
      entry('fresh-1', 10),
      entry('dupe', 10),
      entry('fresh-2', 10),
    ]);

    expect(seen).toEqual([
      ['fresh-1', 'dupe', 'fresh-2'], // whole batch -> duplicate refusal
      ['fresh-1'], // left half appends
      ['dupe', 'fresh-2'], // right half -> duplicate refusal again
      ['dupe'], // isolated -> idempotent success, nothing sent... recorded refusal
      ['fresh-2'], // right tail appends
    ]);
    // The aggregate covers the appended range around the skipped duplicate:
    // first appended commit's seq (call 2), last appended commit's head (call 5).
    expect(commit.seq).toBe(2);
    expect(commit.head).toBe('5');
  });

  it('fails loudly when every entry of the batch is already durable', async () => {
    const backend: SqliteZstdBackendLike = {
      maxBatchUncompressedBytes: 256 * 1024,
      appendBatch: async () => {
        throw new Error('UNIQUE constraint failed: entries.entry_id');
      },
    };
    const adapter = sqliteZstdStorageBackend(backend);
    // Nothing appended -> no commit exists to return; never fabricate one.
    await expect(adapter.appendBatch([entry('dupe', 10)])).rejects.toThrow(
      SqliteZstdAdapterStateError,
    );
  });
});
