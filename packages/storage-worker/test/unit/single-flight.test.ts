import { describe, expect, it, vi } from 'vitest';

import { createBatchEngine } from '../../src/worker.js';
import type { Entry } from '../../src/contracts.js';
import { deferred, delay, makeCommit, makeEntry, until } from '../helpers.js';

describe('batch engine single-flight', () => {
  it('never issues a second append while one is in flight', async () => {
    const gate = deferred<void>();
    let inflight = 0;
    let maxInflight = 0;
    let seq = 0;
    const append = vi.fn(async (_entries: Entry[]) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await gate.promise;
      inflight -= 1;
      seq += 1;
      return makeCommit(seq);
    });
    // Size limit tiny: every add would eagerly cut if the engine allowed
    // concurrent appends.
    const engine = createBatchEngine({ windowMs: 5, windowBytes: 1 }, append);

    const addedIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const entry = makeEntry(10);
      addedIds.push(entry.entryId);
      engine.add(entry);
      await delay(2);
    }
    expect(append).toHaveBeenCalledOnce(); // first batch gates everything else

    gate.resolve();
    // The engine drains the whole accumulated window with as few cuts as it
    // needs; what matters is that every entry is appended exactly once, in
    // order, with no two appends overlapping.
    await until(() => append.mock.calls.flatMap((call) => call[0]).length >= 20, 5_000);
    engine.dispose();

    expect(maxInflight).toBe(1); // the single-flight invariant held throughout
    // Entries leave in enqueue order across sequential batches.
    const appendedIds = append.mock.calls.flatMap((call) => call[0].map((entry) => entry.entryId));
    expect(appendedIds).toEqual(addedIds);
  });

  it('chains the accumulated window right after the in-flight append', async () => {
    const gate = deferred<void>();
    let seq = 0;
    const append = vi.fn(async (_entries: Entry[]) => {
      await gate.promise;
      seq += 1;
      return makeCommit(seq);
    });
    const engine = createBatchEngine({ windowMs: 60_000, windowBytes: 50 }, append);

    engine.add(makeEntry(50)); // size cut -> append #1
    await until(() => engine.appending);
    engine.add(makeEntry(30)); // window refills while append #1 is in flight
    engine.add(makeEntry(30)); // 60 >= 50 -> wants to cut, must wait
    expect(append).toHaveBeenCalledOnce();

    gate.resolve();
    await until(() => append.mock.calls.length === 2);
    engine.dispose();
    expect(append.mock.calls[1]?.[0]).toHaveLength(2);
    expect(engine.lastCommit).toEqual(makeCommit(2));
  });

  it('flush waits for the in-flight append plus the remaining window', async () => {
    const gate = deferred<void>();
    let seq = 0;
    const append = vi.fn(async (_entries: Entry[]) => {
      await gate.promise;
      seq += 1;
      return makeCommit(seq);
    });
    const engine = createBatchEngine({ windowMs: 60_000, windowBytes: 50 }, append);

    engine.add(makeEntry(50)); // append #1 starts, gated
    await until(() => engine.appending);
    engine.add(makeEntry(10)); // lands in the next window

    let settled = false;
    const flushPromise = engine.flush().then((commit) => {
      settled = true;
      return commit;
    });
    await delay(20);
    expect(settled).toBe(false); // still blocked behind the in-flight append
    expect(append).toHaveBeenCalledOnce();

    gate.resolve();
    const commit = await flushPromise;
    engine.dispose();
    expect(append).toHaveBeenCalledTimes(2);
    expect(commit).toEqual(makeCommit(2)); // commit of the batch that drained the queue
  });
});
