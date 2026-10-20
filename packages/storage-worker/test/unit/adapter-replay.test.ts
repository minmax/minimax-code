import { describe, expect, it, vi } from 'vitest';

import { EntryTooLargeError } from '../../src/errors.js';
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
});
