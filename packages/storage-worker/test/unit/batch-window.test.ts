import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBatchEngine, DEFAULT_WINDOW_BYTES, DEFAULT_WINDOW_MS } from '../../src/worker.js';
import type { Entry } from '../../src/contracts.js';
import { deferred, delay, makeCommit, makeEntry, until } from '../helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('batch engine window', () => {
  it('uses the spec defaults: 200 ms window, 256 KiB size cut', () => {
    expect(DEFAULT_WINDOW_MS).toBe(200);
    expect(DEFAULT_WINDOW_BYTES).toBe(256 * 1024);
  });

  it('cuts one batch with all entries after the window elapses', async () => {
    const append = vi.fn(async (_entries: Entry[]) => makeCommit(0));
    const engine = createBatchEngine({ windowMs: 40, windowBytes: 256 * 1024 }, append);

    engine.add(makeEntry(10));
    engine.add(makeEntry(20));
    engine.add(makeEntry(30));
    expect(append).not.toHaveBeenCalled();

    await delay(15);
    expect(append).not.toHaveBeenCalled(); // window is still open

    await until(() => append.mock.calls.length > 0);
    engine.dispose();
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toHaveLength(3);
    expect(engine.lastCommit).toEqual(makeCommit(0));
  });

  it('cuts immediately when the window reaches its byte limit', async () => {
    const append = vi.fn(async (_entries: Entry[]) => makeCommit(0));
    // Far-future timer: only the size cut can fire within the test.
    const engine = createBatchEngine({ windowMs: 60_000, windowBytes: 100 }, append);

    engine.add(makeEntry(60));
    await delay(10);
    expect(append).not.toHaveBeenCalled(); // 60 < 100

    engine.add(makeEntry(40)); // 100 >= 100 -> size cut
    await until(() => append.mock.calls.length > 0);
    engine.dispose();
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toHaveLength(2);
    expect(engine.windowBytes).toBe(0);
  });

  it('holds the size cut below the nominal window by the serialization reserve', async () => {
    // OPT-H3: a window cut at EXACTLY the backend cap splits guaranteed in
    // half when entry.bytes under-reports the serialized size. The default
    // reserve (windowBytes / 16) cuts early enough that moderate inflation
    // still fits one backend batch.
    const append = vi.fn(async (_entries: Entry[]) => makeCommit(0));
    const engine = createBatchEngine({ windowMs: 60_000, windowBytes: 160 }, append);

    engine.add(makeEntry(100));
    await delay(10);
    expect(append).not.toHaveBeenCalled(); // 100 < 150 (160 - 160/16)

    engine.add(makeEntry(60)); // 160 >= 150 -> size cut below the nominal window
    await until(() => append.mock.calls.length > 0);
    engine.dispose();
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('cuts exactly at the nominal window when the reserve is set to zero', async () => {
    const append = vi.fn(async (_entries: Entry[]) => makeCommit(0));
    const engine = createBatchEngine(
      { windowMs: 60_000, windowBytes: 100, windowBytesReserve: 0 },
      append,
    );

    engine.add(makeEntry(99));
    await delay(10);
    expect(append).not.toHaveBeenCalled(); // 99 < 100

    engine.add(makeEntry(1)); // 100 >= 100 -> exact cut
    await until(() => append.mock.calls.length > 0);
    engine.dispose();
    expect(append).toHaveBeenCalledOnce();
  });

  it('keeps accumulating a new window while a batch is in flight', async () => {
    const gate = deferred<void>();
    let seq = 0;
    const append = vi.fn(async (_entries: Entry[]) => {
      await gate.promise;
      seq += 1;
      return makeCommit(seq);
    });
    const engine = createBatchEngine({ windowMs: 20, windowBytes: 1_000_000 }, append);

    engine.add(makeEntry(10));
    await until(() => engine.appending);
    expect(append).toHaveBeenCalledOnce();

    // Second window fills (and its timer fires) while the first append is
    // still in flight: it must NOT start a second append call.
    engine.add(makeEntry(10));
    await delay(40);
    expect(append).toHaveBeenCalledOnce();
    expect(engine.windowBytes).toBe(10);

    gate.resolve();
    await until(() => append.mock.calls.length === 2);
    engine.dispose();
    expect(engine.lastCommit).toEqual(makeCommit(2));
  });

  it('flush cuts the open window immediately and returns its commit', async () => {
    const append = vi.fn(async (_entries: Entry[]) => makeCommit(1));
    const engine = createBatchEngine({ windowMs: 60_000, windowBytes: 256 * 1024 }, append);

    engine.add(makeEntry(10));
    engine.add(makeEntry(10));
    const commit = await engine.flush();

    engine.dispose();
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toHaveLength(2);
    expect(commit).toEqual(makeCommit(1));
  });

  it('flush with an empty never-appended queue probes checkpoint instead of appending an empty batch', async () => {
    // The backend contract: an EMPTY batch is invalid. The old fake here
    // accepted `appendBatch([])`, pinning the opposite (wrong) contract.
    const append = vi.fn(async (entries: Entry[]) => {
      if (entries.length === 0) throw new TypeError('batch must contain at least one entry');
      return makeCommit(1);
    });
    const checkpoint = vi.fn(async () => null); // nothing open in the backend
    const engine = createBatchEngine({ windowMs: 60_000, windowBytes: 256 * 1024, checkpoint }, append);

    const commit = await engine.flush();
    engine.dispose();
    expect(append).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledOnce(); // the probe preserved the write surface
    expect(commit).toBeNull(); // nothing was committed — no fabricated commit
  });

  it('flush settles on the commit produced by the checkpoint probe', async () => {
    const append = vi.fn(async (entries: Entry[]) => {
      if (entries.length === 0) throw new TypeError('batch must contain at least one entry');
      return makeCommit(1);
    });
    const checkpoint = vi.fn(async () => makeCommit(7)); // backend flushed its open batch
    const engine = createBatchEngine({ windowMs: 60_000, windowBytes: 256 * 1024, checkpoint }, append);

    const commit = await engine.flush();
    engine.dispose();
    expect(append).not.toHaveBeenCalled();
    expect(commit).toEqual(makeCommit(7));
    expect(engine.lastCommit).toEqual(makeCommit(7));
  });

  it('flush with an empty window settles on the last commit without any backend call', async () => {
    const append = vi.fn(async (entries: Entry[]) => {
      if (entries.length === 0) throw new TypeError('batch must contain at least one entry');
      return makeCommit(entries.length);
    });
    const checkpoint = vi.fn(async () => null);
    const engine = createBatchEngine({ windowMs: 60_000, windowBytes: 256 * 1024, checkpoint }, append);

    engine.add(makeEntry(10));
    await engine.flush();
    const second = await engine.flush(); // window already drained

    engine.dispose();
    expect(append).toHaveBeenCalledOnce();
    expect(checkpoint).not.toHaveBeenCalled(); // lastCommit settles the barrier
    expect(second).toEqual(makeCommit(1));
  });

  it('quarantines a poison entry instead of retrying it forever', async () => {
    const append = vi.fn(async (entries: Entry[]) => {
      if (entries.length === 0) throw new TypeError('batch must contain at least one entry');
      const poison = entries.find((entry) => entry.entryId === 'poison');
      if (poison !== undefined && entries.length === 1) {
        const error = new Error(
          `entry poison serializes to 999999 bytes, above the backend batch cap`,
        );
        error.name = 'EntryTooLargeError';
        throw error;
      }
      return makeCommit(entries.length);
    });
    const quarantined: Entry[][] = [];
    const engine = createBatchEngine(
      { windowMs: 60_000, windowBytes: 256 * 1024, onQuarantine: (entries) => quarantined.push([...entries]) },
      append,
    );

    engine.add(makeEntry(10, { entryId: 'poison' }));
    // The poison error itself reaches the flush caller, by name and message.
    await expect(engine.flush()).rejects.toThrow('entry poison serializes to 999999 bytes');
    expect(engine.quarantined.map((entry) => entry.entryId)).toEqual(['poison']);
    expect(engine.windowBytes).toBe(0); // not retained for retry

    // The worker keeps making progress behind the quarantined entry.
    engine.add(makeEntry(10, { entryId: 'after' }));
    const commit = await engine.flush();
    engine.dispose();
    expect(commit).toEqual(makeCommit(1));
    expect(quarantined).toHaveLength(1);
  });

  it('quarantines a batch after maxConsecutiveFlushFailures failures of the same composition', async () => {
    let attempt = 0;
    const append = vi.fn(async (entries: Entry[]) => {
      if (entries.length === 0) throw new TypeError('batch must contain at least one entry');
      attempt += 1;
      throw new Error(`backend broken (attempt ${attempt})`);
    });
    const engine = createBatchEngine(
      { windowMs: 5, windowBytes: 256 * 1024, maxConsecutiveFlushFailures: 3 },
      append,
    );

    engine.add(makeEntry(10, { entryId: 'stuck-1' }));
    engine.add(makeEntry(10, { entryId: 'stuck-2' }));
    const firstFlush = engine.flush();
    await expect(firstFlush).rejects.toThrow('backend broken (attempt 1)');

    // Two more attempts happen on the retry timer (5 ms ticks); the third
    // consecutive failure of the same composition crosses the threshold.
    await until(() => attempt >= 3, 5_000);
    await until(() => engine.quarantined.length === 2, 5_000);
    expect(attempt).toBe(3); // terminal: no fourth attempt
    engine.dispose();

    const followup = engine.flush();
    await expect(followup).rejects.toThrow('disposed');
  });

  it('rejects flush when the append fails but keeps entries for retry', async () => {
    let fail = true;
    const append = vi.fn(async (_entries: Entry[]) => {
      if (fail) throw new Error('backend down');
      return makeCommit(1);
    });
    const engine = createBatchEngine({ windowMs: 30, windowBytes: 256 * 1024 }, append);

    engine.add(makeEntry(10));
    await expect(engine.flush()).rejects.toThrow('backend down');
    expect(engine.windowBytes).toBe(10); // retained, not lost

    fail = false;
    await until(() => append.mock.calls.length >= 2); // retried on the next tick
    const commit = await engine.flush();
    engine.dispose();
    expect(commit).toEqual(makeCommit(1));
  });
});
