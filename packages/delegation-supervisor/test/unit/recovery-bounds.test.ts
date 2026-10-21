/**
 * Regression tests for the recovery/replay bounds:
 * - recovery is proportional to active state, not to foreign history length
 *   (document-checkpoint fast path via point reads);
 * - a spawn replay joins the prior child submission even after the record
 *   aged out of the bounded terminal tail;
 * - a stop cascade reaches descendants recovered from durable spawned
 *   payloads, never silently skipping a subtree;
 * - decided waits (forks, detached, completed) do not accumulate pending
 *   waiters during recovery.
 */

import { describe, expect, it } from 'vitest';

import { SqliteZstdBackend } from '../../../durable-backend-sqlite-zstd/src/index.js';
import { childSpec, doneOutcome, makeBackend, makeSupervisor, spawnKey } from '../helpers.js';

describe('recovery and replay bounds', () => {
  it('opens a foreign-heavy log with a tiny budget via the document checkpoint', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });

    // 2 MiB of foreign entries committed AFTER the supervisor activity: the
    // recovery fast path must never scan them.
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 32; i += 1) {
      await backend.appendBatch([{ id: `foreign:${i}`, kind: 'pi.foreign', payload: { blob: chunk } }]);
    }

    const directory = backend.directory;
    await backend.close();
    const reopenedBackend = SqliteZstdBackend.open(directory);
    const reopened = await makeSupervisor(reopenedBackend, { recoveryScanBytes: 1024 * 1024 });

    expect(reopened.recovery.mode).toBe('document-checkpoint');
    expect(reopened.recovery.replayedEntries).toBe(0);
    const record = await reopened.getDelegation(spawn.delegationId);
    expect(record).toMatchObject({ waitState: 'backgrounded', childState: 'running' });

    // The supervisor keeps working after the checkpoint restore: a new
    // transition chains onto the restored revision.
    const completion = await reopened.complete({
      delegationId: spawn.delegationId,
      childRunId: 'post-recovery',
      outcome: doneOutcome,
    });
    expect(completion.delivery).toBe('reporter');
    expect(reopened.documentRevision).toBe(3);
    await reopenedBackend.close();
  });

  it('joins the prior child submission on replay even after terminal-tail eviction', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend, { maxTerminalRecords: 0 });
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.complete({ delegationId: spawn.delegationId, childRunId: 'r1', outcome: doneOutcome });
    expect(supervisor.listIndexed()).toHaveLength(0);
    const headAfterFirst = backend.head;

    const replay = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });

    expect(replay.replayed).toBe(true);
    expect(replay.delegationId).toBe(spawn.delegationId);
    expect(replay.childSubmissionId).toBe(spawn.childSubmissionId);
    expect(backend.head).toBe(headAfterFirst);

    // The durable replay still discriminates the spec.
    await expect(
      supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec({ prompt: 'changed' }) }),
    ).rejects.toMatchObject({ name: 'DelegationKeyConflictError', code: 'DELEGATION_KEY_CONFLICT' });
    expect(backend.head).toBe(headAfterFirst);
  });

  it('stop cascade reaches descendants rebuilt from durable spawned payloads after eviction', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend, { maxTerminalRecords: 0 });
    const root = await supervisor.spawnDelegation({ ...spawnKey({ toolCallId: 'tool-root' }), childSpec: childSpec() });
    const left = await supervisor.spawnDelegation({
      ...spawnKey({ parentConversationId: root.childConversationId, toolCallId: 'tool-left' }),
      childSpec: childSpec({ parentDelegationId: root.delegationId }),
    });
    const grandchild = await supervisor.spawnDelegation({
      ...spawnKey({ parentConversationId: left.childConversationId, toolCallId: 'tool-grandchild' }),
      childSpec: childSpec({ parentDelegationId: left.delegationId }),
    });
    // Both ancestors become terminal and age out of the zero-size tail; the
    // running grandchild stays indexed but loses its ancestor links.
    await supervisor.complete({ delegationId: root.delegationId, childRunId: 'r1', outcome: doneOutcome });
    await supervisor.complete({ delegationId: left.delegationId, childRunId: 'r2', outcome: doneOutcome });

    const result = await supervisor.stop({ rootDelegationId: root.delegationId });

    // The walk must NOT silently skip the subtree: both terminal ancestors are
    // reported skipped, and the running grandchild IS stopped.
    expect(result.outcomes).toEqual([
      { delegationId: root.delegationId, action: 'skipped', skippedBecause: 'terminal', depth: 0 },
      { delegationId: left.delegationId, action: 'skipped', skippedBecause: 'terminal', depth: 1 },
      { delegationId: grandchild.delegationId, action: 'stop-requested', depth: 2 },
    ]);
    const stopped = await supervisor.getDelegation(grandchild.delegationId);
    expect(stopped).toMatchObject({ childState: 'stopping' });
  });

  it('does not create pending waiters for decided waits (forks, detached) during recovery', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    const detached = await supervisor.spawnDelegation({
      ...spawnKey({ toolCallId: 'tool-bg' }),
      childSpec: childSpec(),
    });
    await supervisor.detachToBackground({ delegationId: detached.delegationId, reason: 'owner-input' });
    const fork = await supervisor.forkChild({ delegationId: spawn.delegationId });

    const directory = backend.directory;
    await backend.close();
    const reopenedBackend = SqliteZstdBackend.open(directory);
    const reopened = await makeSupervisor(reopenedBackend);

    // Only the one foreground wait is re-materialized; the detached record and
    // the fork branch (waitState 'none') create no never-resolving waiters.
    expect(reopened.recovery.reMaterializedWaits).toEqual([spawn.waitId]);
    expect(reopened.getWait(`wait-${fork.forkDelegationId}`)).toBeUndefined();
    expect(reopened.getWait(detached.waitId)).toBeUndefined();
    // A handle for a decided wait is still available on demand, resolved:
    // replaying the detached record's key materializes it with its outcome.
    const onDemand = await reopened.spawnDelegation({
      ...spawnKey({ toolCallId: 'tool-bg' }),
      childSpec: childSpec(),
    });
    expect(onDemand.replayed).toBe(true);
    await expect(onDemand.wait.promise).resolves.toMatchObject({ kind: 'backgrounded' });
    await reopenedBackend.close();
  });
});
