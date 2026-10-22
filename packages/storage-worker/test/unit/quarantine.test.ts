import { describe, expect, it, vi } from 'vitest';

import { createStorageWorker } from '../../src/client.js';
import { EntryExceedsBatchCapError } from '../../src/errors.js';
import {
  appendBoundedQuarantine,
  QUARANTINED_METADATA_LIMIT,
  QUARANTINED_PAYLOAD_LIMIT,
} from '../../src/engine.js';
import type { Commit, Entry } from '../../src/contracts.js';
import { deferred, makeCommit, makeEntry, until } from '../helpers.js';

// These tests pin the terminal (non-retryable) failure surface end to end
// through the real worker thread: admission caps and quarantine must reach
// the CALLER instead of spinning an eternal 200 ms retry loop.

describe('storage worker terminal failures', () => {
  it('rejects at admission an entry larger than the batch cap', async () => {
    const backend = { appendBatch: vi.fn(async (_entries: Entry[]) => makeCommit(1)) };
    const worker = createStorageWorker(backend, {
      queueBytes: 1024 * 1024,
      windowMs: 60_000,
      maxBatchUncompressedBytes: 256 * 1024,
    });

    await expect(
      worker.enqueue(makeEntry(300 * 1024, { entryId: 'oversize-admission' })),
    ).rejects.toThrow(EntryExceedsBatchCapError);
    await expect(
      worker.enqueue(makeEntry(300 * 1024, { entryId: 'oversize-admission' })),
    ).rejects.toThrow('can never be part of a committable batch');

    // Nothing was queued, nothing was appended.
    await worker.dispose();
    expect(backend.appendBatch).not.toHaveBeenCalled();
    expect(worker.quarantined).toHaveLength(0);
  });

  it('quarantines an entry whose real serialized size exceeds the cap and keeps the worker flowing', async () => {
    // entry.bytes lies (declares 16), the append executor measures the truth.
    // The poison classification must survive the thread bridge by NAME.
    const append = vi.fn(async (entries: Entry[]) => {
      if (entries.some((entry) => entry.entryId === 'liar')) {
        const error = new Error(
          'entry liar serializes to 300000 bytes, above the backend batch cap of 262144 bytes',
        );
        error.name = 'EntryTooLargeError';
        throw error;
      }
      return makeCommit(entries.length);
    });
    const quarantinedEntries: Entry[][] = [];
    const quarantinedErrors: Error[] = [];
    const worker = createStorageWorker({ appendBatch: append }, {
      windowMs: 60_000,
      onQuarantined: (entries, error) => {
        quarantinedEntries.push([...entries]);
        quarantinedErrors.push(error);
      },
    });

    await worker.enqueue(makeEntry(16, { entryId: 'liar' }));
    // The poison error itself crosses the thread bridge to the flush caller.
    await expect(worker.flush()).rejects.toThrow('entry liar serializes to 300000 bytes');

    // Dead letters are visible on the handle; the queue bytes were released.
    await until(() => worker.quarantined.length === 1);
    expect(worker.quarantined.map((entry) => entry.entryId)).toEqual(['liar']);
    expect(quarantinedEntries).toHaveLength(1);
    expect(quarantinedErrors[0]?.name).toBe('EntryTooLargeError');

    // The worker still makes progress behind the quarantine.
    await worker.enqueue(makeEntry(16, { entryId: 'after-liar' }));
    const commit = await worker.flush();
    expect(commit).toEqual(makeCommit(1));
    await worker.dispose();
  });

  it('reports a stuck batch terminally after maxConsecutiveFlushFailures identical failures', async () => {
    let attempt = 0;
    const append = vi.fn(async (_entries: Entry[]) => {
      attempt += 1;
      throw new Error(`backend broken (attempt ${attempt})`);
    });
    const quarantineErrors: Error[] = [];
    const worker = createStorageWorker({ appendBatch: append }, {
      windowMs: 5,
      maxConsecutiveFlushFailures: 2,
      onQuarantined: (entries, error) => quarantineErrors.push(error),
    });

    await worker.enqueue(makeEntry(16, { entryId: 'stuck' }));
    await expect(worker.flush()).rejects.toThrow('backend broken (attempt 1)');

    // One retry later the same composition fails again -> threshold reached,
    // the batch is quarantined and never retried again. The terminal report
    // is a BatchStuckError (error.name survives the thread bridge), so a
    // caller can branch on it programmatically.
    await until(() => worker.quarantined.length === 1, 5_000);
    expect(quarantineErrors[0]?.name).toBe('BatchStuckError');
    expect(quarantineErrors[0]?.message).toContain('failed 2 consecutive times with the same composition');
    expect(attempt).toBe(2); // terminal: no further retry
    expect(worker.quarantined.map((entry) => entry.entryId)).toEqual(['stuck']);
    await worker.dispose();
  });

  it('quarantines only the poison entry and commits its committable batch mates', async () => {
    // The whole window is cut as ONE batch; the append path rejects it with a
    // poison error naming the offender. The offender is quarantined alone and
    // the honest entries are re-cut and committed.
    const append = vi.fn(async (entries: Entry[]) => {
      const poison = entries.find((entry) => entry.entryId === 'poison');
      if (poison !== undefined) {
        const error = new Error(
          'entry poison serializes to 409664 bytes, above the backend batch cap of 262144 bytes',
        );
        error.name = 'EntryTooLargeError';
        (error as { entryId?: string }).entryId = 'poison';
        throw error;
      }
      return makeCommit(entries.length);
    });
    const worker = createStorageWorker({ appendBatch: append }, { windowMs: 60_000 });

    await worker.enqueue(makeEntry(16, { entryId: 'poison' }));
    await worker.enqueue(makeEntry(16, { entryId: 'honest-1' }));
    await worker.enqueue(makeEntry(16, { entryId: 'honest-2' }));

    await expect(worker.flush()).rejects.toMatchObject({ name: 'EntryTooLargeError' });
    expect(worker.quarantined.map((entry) => entry.entryId)).toEqual(['poison']);

    // The survivors were returned to the window and committed by the re-cut.
    const commit = await worker.flush();
    expect(commit).toEqual(makeCommit(2));
    expect(append.mock.calls[1]?.[0].map((entry) => entry.entryId)).toEqual(['honest-1', 'honest-2']);
    await worker.dispose();
  });

  it('keeps retrying a transient failure and commits on recovery (not quarantined)', async () => {
    let attempt = 0;
    const append = vi.fn(async (entries: Entry[]) => {
      attempt += 1;
      if (attempt < 2) throw new Error('transient');
      return makeCommit(entries.length);
    });
    const worker = createStorageWorker({ appendBatch: append }, {
      windowMs: 5,
      maxConsecutiveFlushFailures: 2,
    });

    await worker.enqueue(makeEntry(16, { entryId: 'recovers' }));
    await expect(worker.flush()).rejects.toThrow('transient');
    const commit = await worker.flush();
    await worker.dispose();

    expect(attempt).toBe(2);
    expect(commit).toEqual(makeCommit(1));
    expect(worker.quarantined).toHaveLength(0);
  });

  it('fails closed on a terminal backend refusal instead of quarantining (IC-F1-004)', async () => {
    // OwnerLostError means another writer took the generation: retrying can
    // never win and burying the entries as dead letters would be lossy. The
    // refusal must cross the bridge BY NAME and break the handle fail-closed.
    const append = vi.fn(async (_entries: Entry[]) => {
      const error = new Error('owner epoch moved; another writer took over this generation');
      error.name = 'OwnerLostError';
      throw error;
    });
    const worker = createStorageWorker({ appendBatch: append }, { windowMs: 60_000 });

    await worker.enqueue(makeEntry(16, { entryId: 'doomed' }));
    await expect(worker.flush()).rejects.toMatchObject({ name: 'OwnerLostError' });

    // Not quarantined — the data is still in the window, and the handle is
    // broken: new writes reject with the same terminal error.
    expect(worker.quarantined).toHaveLength(0);
    await expect(worker.enqueue(makeEntry(16, { entryId: 'late' }))).rejects.toMatchObject({
      name: 'OwnerLostError',
    });
    await expect(worker.flush()).rejects.toMatchObject({ name: 'OwnerLostError' });
    await worker.dispose();
  });

  it('rehydrates BatchStuckError with entry ids, attempts, and cause across the bridge', async () => {
    const append = vi.fn(async (_entries: Entry[]) => {
      throw new Error('disk on fire');
    });
    const quarantineErrors: Error[] = [];
    const worker = createStorageWorker({ appendBatch: append }, {
      windowMs: 5,
      maxConsecutiveFlushFailures: 2,
      onQuarantined: (entries, error) => quarantineErrors.push(error),
    });

    await worker.enqueue(makeEntry(16, { entryId: 'stuck-cause' }));
    await until(() => worker.quarantined.length === 1, 5_000);

    const stuck = quarantineErrors[0];
    expect(stuck?.name).toBe('BatchStuckError');
    expect((stuck as { entryIds?: string[] }).entryIds).toEqual(['stuck-cause']);
    expect((stuck as { attempts?: number }).attempts).toBe(2);
    const cause = (stuck as { cause?: Error }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause?.message).toBe('disk on fire');
    await worker.dispose();
  });

  it('rejects enqueue during the final drain and still flushes the released tail (SW-02)', async () => {
    // The first append blocks on the gate; dispose's drain waits on it. While
    // the drain runs, admission must reject (never slip past the last flush),
    // and an entry released from backpressure DURING the drain must be
    // flushed by the re-check instead of being terminated away.
    const gate = deferred<Commit>();
    let appendCalls = 0;
    const append = vi.fn(async (entries: Entry[]) => {
      appendCalls += 1;
      if (appendCalls === 1) return gate.promise;
      return makeCommit(entries.length);
    });
    const worker = createStorageWorker({ appendBatch: append }, {
      queueBytes: 100,
      windowMs: 60_000,
      windowBytes: 10_000,
    });

    const first = makeEntry(40, { entryId: 'tail-1' });
    const second = makeEntry(40, { entryId: 'tail-2' });
    const third = makeEntry(40, { entryId: 'tail-3' }); // parks: 80 + 40 > 100
    await worker.enqueue(first);
    await worker.enqueue(second);
    const thirdPromise = worker.enqueue(third);

    const disposePromise = worker.dispose();
    await until(() => appendCalls === 1);

    // During the drain: admission rejects explicitly...
    await expect(worker.enqueue(makeEntry(10, { entryId: 'too-late' }))).rejects.toThrow(
      /disposing/,
    );

    // ...and the committed batch releases the parked entry, which the
    // dispose re-check flushes as a second append instead of losing it.
    gate.resolve(makeCommit(2));
    await thirdPromise;
    await disposePromise;

    expect(appendCalls).toBe(2);
    expect(append.mock.calls[0]?.[0].map((entry) => entry.entryId)).toEqual(['tail-1', 'tail-2']);
    expect(append.mock.calls[1]?.[0].map((entry) => entry.entryId)).toEqual(['tail-3']);
    await expect(worker.enqueue(makeEntry(10))).rejects.toThrow('disposed');
  });
});

describe('quarantine memory bound (DS-B4)', () => {
  it('evicts the oldest payloads to metadata stubs past the limit', () => {
    const buffer: Entry[] = [];
    const incoming = Array.from({ length: QUARANTINED_PAYLOAD_LIMIT + 10 }, (_, index) =>
      makeEntry(16, { entryId: `dl-${index}`, payload: { big: 'x'.repeat(1024) } }),
    );
    appendBoundedQuarantine(buffer, incoming);

    expect(buffer).toHaveLength(QUARANTINED_PAYLOAD_LIMIT + 10);
    // The oldest 10 payloads were evicted to metadata-only stubs.
    for (let index = 0; index < 10; index += 1) {
      const stub = buffer[index]!;
      expect(stub.entryId).toBe(`dl-${index}`); // identity preserved
      expect((stub.payload as { deadLetterPayloadEvicted?: boolean }).deadLetterPayloadEvicted).toBe(
        true,
      );
      expect(stub.bytes).toBe(0);
    }
    // The newest entries keep their payloads.
    const newest = buffer[buffer.length - 1]!;
    expect((newest.payload as { big?: string }).big).toBe('x'.repeat(1024));
  });

  it('drops the oldest stubs entirely past the metadata limit', () => {
    const buffer: Entry[] = [];
    const first = Array.from({ length: QUARANTINED_METADATA_LIMIT }, (_, index) =>
      makeEntry(16, { entryId: `meta-${index}`, payload: { n: index } }),
    );
    appendBoundedQuarantine(buffer, first);
    // Every payload gets stubbed (all older than the live-payload limit).
    expect(buffer).toHaveLength(QUARANTINED_METADATA_LIMIT);
    expect(buffer[0]?.payload).toMatchObject({ deadLetterPayloadEvicted: true });

    appendBoundedQuarantine(buffer, [makeEntry(16, { entryId: 'latest' })]);
    expect(buffer).toHaveLength(QUARANTINED_METADATA_LIMIT);
    expect(buffer[buffer.length - 1]?.entryId).toBe('latest');
    expect(buffer[0]?.entryId).toBe('meta-1'); // oldest stub dropped
  });
});
