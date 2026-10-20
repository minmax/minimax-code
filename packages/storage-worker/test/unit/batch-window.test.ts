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

  it('flush with an empty never-appended queue persists one empty batch', async () => {
    const append = vi.fn(async (_entries: Entry[]) => makeCommit(1));
    const engine = createBatchEngine({ windowMs: 60_000, windowBytes: 256 * 1024 }, append);

    const commit = await engine.flush();
    engine.dispose();
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toHaveLength(0);
    expect(commit).toEqual(makeCommit(1));
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
