import { describe, expect, it, vi } from 'vitest';

import { createStorageWorker } from '../../src/client.js';
import { EntryExceedsBatchCapError } from '../../src/errors.js';
import type { Entry } from '../../src/contracts.js';
import { makeCommit, makeEntry, until } from '../helpers.js';

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
});
