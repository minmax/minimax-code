import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { openSqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';

import { createStorageWorker } from '../../src/client.js';
import type { Entry, StorageWorker, StorageWorkerBackend } from '../../src/contracts.js';
import { TOOL_OUTCOME_UNKNOWN } from '../../src/contracts.js';
import { createCheckpointBarrier } from '../../src/checkpoint-policy.js';
import {
  sqliteZstdStorageBackend,
  toEntryDraft,
  type SqliteZstdBackendLike,
  type SqliteZstdCommitLike,
  type SqliteZstdEntryDraft,
} from '../../src/sqlite-zstd-adapter.js';

// Checkpoint-policy integration (SE-SW-002): the fail-closed barrier composed
// into the agent turn path — flush before EVERY LLM request and before EVERY
// tool effect, and TOOL_OUTCOME_UNKNOWN (no auto-retry) for an interrupted
// call. One scenario drives the REAL sqlite-zstd backend through the shipped
// adapter; the policy scenarios use a controllable in-memory backend so the
// failure injection is deterministic.

const directories: string[] = [];

afterEach(async () => {
  while (workers.length > 0) {
    const worker = workers.pop();
    if (worker !== undefined) await worker.dispose().catch(() => {});
  }
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function freshDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoint-barrier-e2e-'));
  directories.push(dir);
  return dir;
}

function entry(entryId: string, text: string, parentId: string | null = null): Entry {
  const payload = { text, role: 'user' };
  return {
    entryId,
    parentId,
    kind: 'pi.session',
    payload,
    bytes: Buffer.byteLength(
      JSON.stringify(toEntryDraft({ entryId, parentId, kind: 'pi.session', payload, bytes: 0 })),
    ),
  };
}

/** Workers to tear down even when an assertion throws mid-scenario. */
const workers: StorageWorker[] = [];

function trackedWorker(backend: StorageWorkerBackend, options = {}): StorageWorker {
  const worker = createStorageWorker(backend, { windowMs: 60_000, ...options });
  workers.push(worker);
  return worker;
}

interface MemoryBackend {
  backend: StorageWorkerBackend;
  state: {
    events: string[];
    appendedIds: string[];
    checkpointCount: number;
    failCheckpoint: boolean;
  };
}

function memoryBackend(): MemoryBackend {
  let seq = 0;
  const state = { events: [], appendedIds: [], checkpointCount: 0, failCheckpoint: false };
  const backend: StorageWorkerBackend = {
    async appendBatch(entries) {
      const ids = entries.map((item) => item.entryId);
      state.events.push(`commit:${ids.join(',')}`);
      state.appendedIds.push(...ids);
      seq += 1;
      return { batchId: String(seq), seq, head: String(seq) };
    },
    async checkpoint() {
      state.checkpointCount += 1;
      state.events.push('backend-checkpoint');
      if (state.failCheckpoint) throw new Error('checkpoint unavailable');
      return null;
    },
  };
  return { backend, state };
}

/** Traces the REAL backend so event ordering includes batch commits. */
function tracedSqliteBackend(
  directory: string,
  events: string[],
): { backend: SqliteZstdBackendLike; closeReal: () => Promise<void> } {
  const real = openSqliteZstdBackend(directory);
  return {
    backend: {
      appendBatch: async (drafts: readonly SqliteZstdEntryDraft[]): Promise<SqliteZstdCommitLike> => {
        const commit = await real.appendBatch(drafts);
        events.push(`commit:${drafts.map((draft) => draft.id).join(',')}`);
        return commit;
      },
      checkpoint: async () => {
        await real.checkpoint();
        events.push('backend-checkpoint');
      },
    },
    closeReal: () => real.close(),
  };
}

describe('checkpoint barrier (composition root policy)', () => {
  it('flushes before the LLM request and before every tool effect, durably, on the real backend', async () => {
    const directory = freshDirectory();
    const events: string[] = [];
    const { backend, closeReal } = tracedSqliteBackend(directory, events);
    const worker = trackedWorker(sqliteZstdStorageBackend(backend));
    const barrier = createCheckpointBarrier(worker);

    // Turn step 1: intent entries enqueued, then the pre-LLM barrier.
    await worker.enqueue(entry('t1', 'first', null));
    await worker.enqueue(entry('t2', 'second', 't1'));
    await barrier.beforeLlmRequest();
    events.push('llm-request');

    // Turn step 2: a tool intent, then the effect under the barrier.
    await worker.enqueue(entry('t3', 'tool intent', 't2'));
    const outcome = await barrier.runToolEffect({
      callId: 'call-1',
      toolName: 'fs.write',
      run: async () => {
        events.push('effect:fs.write');
        return 'wrote';
      },
    });
    expect(outcome).toEqual({ outcome: 'completed', value: 'wrote' });

    // Every guarded step ran strictly after its batch commit AND the backend
    // checkpoint probe: intent -> commit -> checkpoint -> step.
    expect(events).toEqual([
      'commit:t1,t2',
      'backend-checkpoint',
      'llm-request',
      'commit:t3',
      'backend-checkpoint',
      'effect:fs.write',
    ]);

    // The barrier means DURABLE, not merely drained: close the writer, reopen
    // the database, and read the whole chain back.
    await worker.dispose();
    await closeReal();
    const reopened = openSqliteZstdBackend(directory);
    try {
      const delta = reopened.readDelta(0, 1024 * 1024);
      expect(delta.map((item) => item.id)).toEqual(['t1', 't2', 't3']);
      expect(delta.map((item) => item.parentId)).toEqual([null, 't1', 't2']);
      expect(reopened.readResume()).not.toBeNull();
    } finally {
      await reopened.close();
    }
  });

  it('stays fail-closed: a backend that cannot confirm durability blocks the guarded steps', async () => {
    const { backend, state } = memoryBackend();
    const worker = trackedWorker(backend);
    const barrier = createCheckpointBarrier(worker);

    state.failCheckpoint = true;
    await worker.enqueue(entry('e1', 'intent'));

    // The commit itself succeeded, but unverified durability is never
    // reported as success: the LLM request is not issued.
    await expect(barrier.beforeLlmRequest()).rejects.toThrow('checkpoint unavailable');
    expect(state.appendedIds).toEqual(['e1']);

    // And the tool effect is never started under a failed barrier: the tool
    // intent is enqueued, so the barrier flush drives the failing probe.
    await worker.enqueue(entry('e2', 'tool intent', 'e1'));
    let effectRan = false;
    await expect(
      barrier.runToolEffect({
        callId: 'call-2',
        toolName: 'fs.write',
        run: async () => {
          effectRan = true;
          return 'never';
        },
      }),
    ).rejects.toThrow('checkpoint unavailable');
    expect(effectRan).toBe(false);
  });

  it('maps an interrupted tool call to TOOL_OUTCOME_UNKNOWN and forbids auto-retry', async () => {
    const { backend } = memoryBackend();
    const worker = trackedWorker(backend);
    const barrier = createCheckpointBarrier(worker);

    const controller = new AbortController();
    let runs = 0;
    let started = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });

    const interrupted = barrier.runToolEffect(
      {
        callId: 'call-9',
        toolName: 'web.fetch',
        run: async (signal) => {
          runs += 1;
          started();
          await new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('interrupted')));
          });
        },
      },
      { signal: controller.signal },
    );
    await startedPromise;
    controller.abort();

    // The effect ran exactly once; its outcome is unconfirmed, not "failed".
    expect(await interrupted).toEqual({ outcome: TOOL_OUTCOME_UNKNOWN });
    expect(runs).toBe(1);
    expect(barrier.unknownOutcomeCallIds).toEqual(['call-9']);

    // No-auto-retry: the same callId is refused until the caller explicitly
    // accepts the double-effect risk.
    await expect(
      barrier.runToolEffect({
        callId: 'call-9',
        toolName: 'web.fetch',
        run: async () => 'again',
      }),
    ).rejects.toThrow(/unknown outcome/);
    expect(runs).toBe(1);

    // Explicit recovery decision: the retry goes through and clears the record.
    const recovered = await barrier.runToolEffect(
      {
        callId: 'call-9',
        toolName: 'web.fetch',
        run: async () => {
          runs += 1;
          return 'recovered';
        },
      },
      { allowAfterUnknownOutcome: true },
    );
    expect(recovered).toEqual({ outcome: 'completed', value: 'recovered' });
    expect(runs).toBe(2);
    expect(barrier.unknownOutcomeCallIds).toEqual([]);
  });

  it('reports a definitive effect failure as failed — not unknown — without retrying', async () => {
    const { backend, state } = memoryBackend();
    const worker = trackedWorker(backend);
    const barrier = createCheckpointBarrier(worker);

    await worker.enqueue(entry('e1', 'intent'));
    const failure = new Error('tool refused');
    const outcome = await barrier.runToolEffect({
      callId: 'call-3',
      toolName: 'fs.write',
      run: async () => {
        throw failure;
      },
    });
    expect(outcome).toEqual({ outcome: 'failed', error: failure });
    expect(barrier.unknownOutcomeCallIds).toEqual([]);
    // The barrier flushed the intent before the effect ran.
    expect(state.events).toEqual(['commit:e1', 'backend-checkpoint']);
  });
});
