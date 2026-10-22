import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';

import { createStorageWorker } from '../../src/client.js';
import { sqliteZstdStorageBackend, toEntryDraft, entryDraftSizeBytes } from '../../src/sqlite-zstd-adapter.js';
import type { Entry } from '../../src/contracts.js';

// Cross-package integration: the storage worker driving the REAL sqlite-zstd
// durable backend through the shipped adapter. This is the seam the review
// flagged — createStorageWorker must connect to SqliteZstdBackend without any
// hand-written glue, and the fresh-worker checkpoint + oversize-entry cases
// must terminate instead of wedging.

const directories: string[] = [];

function freshDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-zstd-e2e-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function entry(entryId: string, text: string, parentId: string | null = null): Entry {
  return {
    entryId,
    parentId,
    kind: 'pi.session',
    payload: { text, role: 'user' },
    bytes: Buffer.byteLength(JSON.stringify(toEntryDraft({ entryId, parentId, kind: 'pi.session', payload: { text, role: 'user' }, bytes: 0 }))),
  };
}

describe('createStorageWorker -> sqlite-zstd (end to end)', () => {
  it('checks out the fresh-worker checkpoint on a real backend without any commit', async () => {
    const directory = freshDirectory();
    const backend = openSqliteZstdBackend(directory);
    const worker = createStorageWorker(sqliteZstdStorageBackend(backend));

    // Empty window, nothing ever committed: the checkpoint must ride the
    // backend probe (write surface verified) and NOT fabricate a commit.
    await worker.checkpoint();
    expect(backend.head).toBe(0);
    expect(backend.readResume()).toBeNull();

    await worker.dispose();
    await backend.close();
  });

  it('fails the checkpoint closed on a sealed backend instead of flushing nothing', async () => {
    const directory = freshDirectory();
    const backend = openSqliteZstdBackend(directory);
    backend.seal();
    const worker = createStorageWorker(sqliteZstdStorageBackend(backend));

    await expect(worker.checkpoint()).rejects.toThrow(/is sealed; write to a newer generation/);
    await worker.dispose();
    await backend.close();
  });

  it('commits the queue, preserves the parent chain, and reads it back', async () => {
    const directory = freshDirectory();
    const backend = openSqliteZstdBackend(directory);
    const worker = createStorageWorker(sqliteZstdStorageBackend(backend), {
      windowMs: 60_000, // deterministic: the 1-byte window cuts one batch per entry
      windowBytes: 1,
    });

    const first = entry('e1', 'first', null);
    const second = entry('e2', 'second', 'e1');
    const third = entry('e3', 'third', 'e2');
    await worker.enqueue(first);
    await worker.enqueue(second);
    await worker.enqueue(third);

    const commit = await worker.flush();
    // The 1-byte window cuts per add: batch 1 carries e1, batch 2 e2+e3
    // (they were queued while batch 1 was in flight).
    expect(commit).toEqual({ batchId: '2', seq: 2, head: '2' });
    expect(backend.head).toBe(2);

    await worker.checkpoint(); // durability barrier on the real backend

    const delta = backend.readDelta(0, 1024 * 1024);
    expect(delta.map((item) => item.id)).toEqual(['e1', 'e2', 'e3']);
    expect(delta.map((item) => item.parentId)).toEqual([null, 'e1', 'e2']);
    expect((delta[0]?.payload as { text: string }).text).toBe('first');

    // Point read by entry id — one batch decoded, not the whole log.
    expect(backend.getEntry('e2')?.payload).toEqual({ text: 'second', role: 'user' });
    expect(backend.getEntry('e2')?.seq).toBe(2);
    expect(backend.getEntry('missing')).toBeUndefined();
    // Window read anchored at an entry id (batch-granular: e2 anchors batch 2).
    expect(backend.readDeltaFrom('e2', 1024 * 1024)).toEqual([]);
    expect(backend.readDeltaFrom('e2', 1024 * 1024, { inclusive: true }).map((item) => item.id)).toEqual([
      'e2',
      'e3',
    ]);
    expect(backend.readDeltaFrom('e1', 1024 * 1024).map((item) => item.id)).toEqual(['e2', 'e3']);
    // The resume capsule of the last commit.
    expect(backend.readResume()).toEqual({
      batchId: 2,
      seq: 2,
      head: 2,
      entryCount: 2,
      updatedMs: expect.any(Number),
    });

    await worker.dispose();
    await backend.close();

    // Reopen: ownership released, history durable.
    const reopened = openSqliteZstdBackend(directory);
    expect(reopened.head).toBe(2);
    expect(reopened.readDelta(0, 1024 * 1024)).toHaveLength(3);
    reopened.close();
  });

  it('splits a batch that overflows the backend cap post-stringify instead of failing it', async () => {
    const directory = freshDirectory();
    const backend = openSqliteZstdBackend(directory);
    expect(backend.maxBatchUncompressedBytes).toBe(256 * 1024);
    const worker = createStorageWorker(sqliteZstdStorageBackend(backend), {
      windowMs: 60_000,
      windowBytes: 512 * 1024, // the worker window trusts entry.bytes; the cap is below
      maxBatchUncompressedBytes: backend.maxBatchUncompressedBytes,
    });

    // 16 x 16 KiB entries: the window reaches exactly the cap area, and the
    // real serialized batch (draft wrappers included) overflows 256 KiB —
    // the exact overflow reproduced in review (263 063 > 262 144).
    const text = 'x'.repeat(16 * 1024);
    const entries: Entry[] = [];
    for (let i = 0; i < 16; i++) {
      const item = entry(`chunk-${i}`, text, i === 0 ? null : `chunk-${i - 1}`);
      entries.push(item);
      await worker.enqueue(item);
    }
    const wholeBatch = JSON.stringify(entries.map(toEntryDraft));
    expect(Buffer.byteLength(wholeBatch, 'utf8')).toBeGreaterThan(256 * 1024);

    const commit = await worker.flush();

    // The adapter split it: more than one commit, every entry durable, none lost.
    expect(backend.head).toBeGreaterThanOrEqual(2);
    const delta = backend.readDelta(0, 8 * 1024 * 1024);
    expect(delta.map((item) => item.id)).toEqual(entries.map((item) => item.entryId));

    // IC-F1-006: the returned commit covers the WHOLE split range. Resuming
    // from its seq serves the entire tail (no middle sub-batch skipped), and
    // its head is the backend's durable head.
    expect(commit).not.toBeNull();
    expect(Number(commit?.head)).toBe(backend.head);
    const tail = backend.readDelta(commit!.seq, 8 * 1024 * 1024).map((item) => item.id);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail).toEqual(delta.slice(delta.length - tail.length).map((item) => item.id));
    expect(backend.readDelta(Number(commit!.head), 8 * 1024 * 1024)).toEqual([]);

    await worker.dispose();
    await backend.close();
  });

  it('quarantines a single entry that cannot fit into any batch and keeps committing behind it', async () => {
    const directory = freshDirectory();
    const backend = openSqliteZstdBackend(directory);
    const worker = createStorageWorker(sqliteZstdStorageBackend(backend), {
      windowMs: 60_000,
      windowBytes: 1024 * 1024,
    });

    // Declares 100 bytes, really serializes to ~300 KiB: past admission on a
    // lie, caught by the post-stringify measurement as poison.
    const liar = { entryId: 'liar', parentId: null, kind: 'pi.session', payload: { text: 'y'.repeat(300 * 1024) }, bytes: 100 };
    await worker.enqueue(liar);
    await expect(worker.flush()).rejects.toThrow(/serializes to \d+ bytes, above the backend batch cap/);
    expect(worker.quarantined.map((item) => item.entryId)).toEqual(['liar']);

    await worker.enqueue(entry('after-liar', 'still works'));
    const commit = await worker.flush();
    expect(commit).not.toBeNull();
    expect(backend.getEntry('after-liar')).toBeDefined();
    expect(backend.getEntry('liar')).toBeUndefined(); // never persisted

    await worker.dispose();
    await backend.close();
  });

  it('sizes drafts exactly as the backend stores them', () => {
    const draft = toEntryDraft(entry('s1', 'z'.repeat(1000)));
    expect(entryDraftSizeBytes(draft)).toBe(Buffer.byteLength(JSON.stringify(draft), 'utf8'));
  });
});
