import { describe, expect, it, vi } from 'vitest';

import { createStorageWorker } from '../../src/client.js';
import type { Commit, Entry } from '../../src/contracts.js';
import { deferred, delay, makeCommit, makeEntry, until } from '../helpers.js';

describe('storage worker client', () => {
  it('resolves enqueue in under 1 ms while the queue has capacity', async () => {
    const backend = { appendBatch: vi.fn(async (_entries: Entry[]) => makeCommit(1)) };
    // Retry a couple of times so a stray GC pause cannot fail the budget.
    for (let attempt = 0; attempt < 3; attempt++) {
      const worker = createStorageWorker(backend, { queueBytes: 1024 * 1024 });
      const entries = Array.from({ length: 50 }, () => makeEntry(16));
      let maxMs = 0;
      for (const entry of entries) {
        const start = performance.now();
        await worker.enqueue(entry);
        maxMs = Math.max(maxMs, performance.now() - start);
      }
      await worker.dispose();
      if (maxMs < 1) return;
    }
    throw new Error('enqueue never resolved within the 1 ms budget');
  });

  it('applies promise backpressure on overflow without dropping entries', async () => {
    const gate = deferred<Commit>();
    const backend = { appendBatch: vi.fn((_entries: Entry[]) => gate.promise) };
    const worker = createStorageWorker(backend, {
      queueBytes: 100,
      windowMs: 60_000, // only explicit flush() can cut batches in this test
      windowBytes: 10_000,
    });

    const first = makeEntry(40);
    const second = makeEntry(40);
    const third = makeEntry(40); // 80 reserved + 40 > 100 -> must park
    await worker.enqueue(first);
    await worker.enqueue(second);

    let thirdResolved = false;
    const thirdPromise = worker.enqueue(third).then(() => {
      thirdResolved = true;
    });
    await delay(30);
    expect(thirdResolved).toBe(false);
    expect(backend.appendBatch).not.toHaveBeenCalled(); // nothing forced a cut yet

    // Force the first batch; it blocks on the gate.
    const firstFlush = worker.flush();
    await until(() => backend.appendBatch.mock.calls.length === 1);

    gate.resolve(makeCommit(1)); // batch #1 commits -> 80 bytes released
    await thirdPromise; // third is admitted in enqueue order once room frees
    expect(thirdResolved).toBe(true);
    await firstFlush;

    const secondFlush = worker.flush(); // drains the now-admitted third entry
    await worker.dispose();
    expect(backend.appendBatch).toHaveBeenCalledTimes(2);
    // Every entry survived the overflow, in enqueue order.
    expect(backend.appendBatch.mock.calls[0]?.[0].map((entry) => entry.entryId)).toEqual([
      first.entryId,
      second.entryId,
    ]);
    expect(backend.appendBatch.mock.calls[1]?.[0].map((entry) => entry.entryId)).toEqual([
      third.entryId,
    ]);
    await secondFlush;
  });

  it('validates entries and never admits one larger than the ceiling', async () => {
    const backend = { appendBatch: vi.fn(async (_entries: Entry[]) => makeCommit(1)) };
    const worker = createStorageWorker(backend, { queueBytes: 100 });
    await expect(
      worker.enqueue({
        entryId: 'e-too-big',
        parentId: null,
        kind: 'test',
        payload: null,
        bytes: 101,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      worker.enqueue({ entryId: '', parentId: null, kind: 'test', payload: null, bytes: 1 }),
    ).rejects.toThrow(TypeError);
    await worker.dispose();
    expect(backend.appendBatch).not.toHaveBeenCalled();
  });

  it('checkpoint fails closed when the backend cannot persist', async () => {
    const backend = {
      appendBatch: vi.fn(async (_entries: Entry[]) => {
        throw new Error('backend down');
      }),
      checkpoint: vi.fn(),
    };
    const worker = createStorageWorker(backend, { windowMs: 5_000 });
    await worker.enqueue(makeEntry(16));
    await expect(worker.checkpoint()).rejects.toThrow('backend down');
    expect(backend.checkpoint).not.toHaveBeenCalled(); // barrier never faked
    await expect(worker.dispose()).rejects.toThrow('backend down');
    expect(backend.appendBatch.mock.calls[0]?.[0]).toHaveLength(1); // retained for retry
  });

  it('checkpoint drains the queue and then calls backend.checkpoint', async () => {
    const backend = {
      appendBatch: vi.fn(async (entries: Entry[]) => makeCommit(entries.length)),
      checkpoint: vi.fn(),
    };
    const worker = createStorageWorker(backend, { windowMs: 60_000 });
    await worker.enqueue(makeEntry(16));
    await worker.enqueue(makeEntry(16));
    await worker.checkpoint();
    expect(backend.appendBatch).toHaveBeenCalledOnce();
    expect(backend.appendBatch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(backend.checkpoint).toHaveBeenCalledOnce();
    await worker.dispose();
  });

  it('rejects calls after dispose and drains everything before stopping', async () => {
    const backend = { appendBatch: vi.fn(async (_entries: Entry[]) => makeCommit(1)) };
    const worker = createStorageWorker(backend, { windowMs: 60_000 });
    await worker.enqueue(makeEntry(16));
    await worker.dispose();
    expect(backend.appendBatch).toHaveBeenCalledOnce(); // final drain happened
    await expect(worker.enqueue(makeEntry(16))).rejects.toThrow('disposed');
    await expect(worker.flush()).rejects.toThrow('disposed');
    await expect(worker.checkpoint()).rejects.toThrow('disposed');
  });
});
