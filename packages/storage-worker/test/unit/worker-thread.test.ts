import { describe, expect, it, vi } from 'vitest';

import { createStorageWorker } from '../../src/client.js';
import type { Entry } from '../../src/contracts.js';
import { delay, makeCommit, makeEntry, until } from '../helpers.js';

// These tests spawn the REAL worker thread (worker.ts), loaded from TypeScript
// source through Node's built-in type stripping — the same path production
// takes when the package runs unbundled.

describe('storage worker thread (end-to-end)', () => {
  it('persists a whole queue drain as ONE appendBatch call', async () => {
    const backend = {
      appendBatch: vi.fn(async (entries: Entry[]) => makeCommit(entries.length)),
      checkpoint: vi.fn(),
    };
    const worker = createStorageWorker(backend, { windowMs: 60_000, windowBytes: 256 * 1024 });

    const entries = [makeEntry(10), makeEntry(20), makeEntry(30), makeEntry(40), makeEntry(50)];
    for (const entry of entries) await worker.enqueue(entry);

    const commit = await worker.flush();
    expect(commit).toEqual(makeCommit(5));
    expect(backend.appendBatch).toHaveBeenCalledTimes(1);
    expect(backend.appendBatch.mock.calls[0]?.[0].map((entry) => entry.entryId)).toEqual(
      entries.map((entry) => entry.entryId),
    );

    await worker.checkpoint();
    expect(backend.checkpoint).toHaveBeenCalledTimes(1);
    await worker.dispose();
  });

  it('cuts the batch by the time window inside the thread without flush', async () => {
    const backend = { appendBatch: vi.fn(async (_entries: Entry[]) => makeCommit(1)) };
    const worker = createStorageWorker(backend, { windowMs: 40, windowBytes: 256 * 1024 });

    await worker.enqueue(makeEntry(10));
    await worker.enqueue(makeEntry(10));
    await worker.enqueue(makeEntry(10));

    await until(() => backend.appendBatch.mock.calls.length > 0);
    await worker.dispose();
    expect(backend.appendBatch).toHaveBeenCalledTimes(1);
    expect(backend.appendBatch.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it('returns from enqueue immediately and defers the batch to the window', async () => {
    const backend = { appendBatch: vi.fn(async (_entries: Entry[]) => makeCommit(1)) };
    const worker = createStorageWorker(backend, { windowMs: 200, windowBytes: 256 * 1024 });

    await worker.enqueue(makeEntry(16));
    // enqueue returned right away; the main-thread event loop keeps running
    // timers while the entry waits in the worker's batch window.
    await delay(25);
    expect(backend.appendBatch).not.toHaveBeenCalled();
    await worker.dispose();
    expect(backend.appendBatch).toHaveBeenCalledTimes(1); // dispose drained it
  });

  it('transfers buffer payloads across the bridge and restores them on retry (OPT-B1)', async () => {
    // Array payloads with plain ArrayBuffers are TRANSFERRED, not cloned, in
    // both directions. The engine retains a failed batch for retry, so on an
    // appendError the buffers must ride the rejection back — otherwise the
    // retried batch would carry detached (empty) payloads.
    let attempt = 0;
    const firstBytes: number[] = [];
    const backend = {
      appendBatch: vi.fn(async (entries: Entry[]) => {
        attempt += 1;
        const blob = (entries[0]?.payload as { blob?: ArrayBuffer } | undefined)?.blob;
        firstBytes.push(blob instanceof ArrayBuffer ? (new Uint8Array(blob)[0] ?? -1) : -2);
        if (attempt === 1) throw new Error('transient');
        return makeCommit(entries.length);
      }),
    };
    const worker = createStorageWorker(backend, { windowMs: 5, maxConsecutiveFlushFailures: 3 });

    const blob = new Uint8Array([42]).buffer;
    await worker.enqueue({ entryId: 'binary', parentId: null, kind: 'test', payload: { blob }, bytes: 16 });
    await expect(worker.flush()).rejects.toThrow('transient');
    const commit = await worker.flush();
    expect(commit).toEqual(makeCommit(1));

    // Byte 42 survived the transfer out, the failed append, the restore, and
    // the retried transfer — not a detached zero-length buffer.
    expect(firstBytes).toEqual([42, 42]);
    await worker.dispose();
  });
});
