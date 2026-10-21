/**
 * T_spawn: atomic four-record spawn, key-based replay joining the prior child
 * submission, fresh child queue identity, and supervision-tree linking.
 */

import { describe, expect, it } from 'vitest';

import { SqliteZstdBackend } from '../../../durable-backend-sqlite-zstd/src/index.js';
import {
  DELEGATION_DOCUMENT_KIND,
  KIND_CHILD_CONVERSATION,
  KIND_SPAWNED,
  KIND_SUPERVISOR_TASK,
} from '../../src/index.js';
import {
  childSpec,
  expectPending,
  makeBackend,
  makeSupervisor,
  payloadsOfKind,
  spawnKey,
  supervisorEntries,
} from '../helpers.js';

describe('spawnDelegation (T_spawn)', () => {
  it('commits supervisor task, child conversation, delegation record, and document in ONE batch', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const result = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });

    expect(result.replayed).toBe(false);
    expect(result.stateVersion).toBe(1);
    expect(result.supervisorTaskId).toBe(`dst-${result.delegationId.slice('del-'.length)}`);
    expect(result.childConversationId).toBe(`conv-child-${result.delegationId.slice('del-'.length)}`);
    expect(result.childSubmissionId).toBe(`childsub-${result.delegationId.slice('del-'.length)}`);

    const entries = supervisorEntries(backend);
    expect(entries.map((entry) => entry.kind)).toEqual([
      KIND_SUPERVISOR_TASK,
      KIND_CHILD_CONVERSATION,
      KIND_SPAWNED,
      DELEGATION_DOCUMENT_KIND,
    ]);
    // Atomicity: every record of the transition carries the same sequence.
    const sequences = new Set(entries.map((entry) => entry.seq));
    expect(sequences.size).toBe(1);

    const childConversation = payloadsOfKind(backend, KIND_CHILD_CONVERSATION)[0]!;
    expect(childConversation).toMatchObject({
      queueForkPolicy: 'initial',
      inheritedReceipts: 'none',
      childConversationId: result.childConversationId,
    });

    const record = await supervisor.getDelegation(result.delegationId);
    expect(record).toMatchObject({
      waitState: 'foreground',
      childState: 'running',
      stateVersion: 1,
      key: { parentConversationId: 'conv-parent', parentRunId: 'run-1', toolCallId: 'tool-1' },
    });
  });

  it('replays with the same key: same ids, same child submission, no second batch', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const first = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    const headAfterFirst = backend.head;

    const replay = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });

    expect(replay.replayed).toBe(true);
    expect(replay.delegationId).toBe(first.delegationId);
    expect(replay.childConversationId).toBe(first.childConversationId);
    expect(replay.childSubmissionId).toBe(first.childSubmissionId);
    expect(replay.waitId).toBe(first.waitId);
    // The foreground wait of a replay is the SAME wait handle.
    expect(replay.wait.promise).toBe(first.wait.promise);
    // Nothing new was written: the log head did not move.
    expect(backend.head).toBe(headAfterFirst);
    expect(supervisor.recovery.documentRevision).toBeLessThanOrEqual(1);
    expect(payloadsOfKind(backend, KIND_SPAWNED)).toHaveLength(1);
  });

  it('rejects a replay under the same key with a different child spec', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec({ prompt: 'original' }) });

    await expect(
      supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec({ prompt: 'changed' }) }),
    ).rejects.toMatchObject({ name: 'DelegationKeyConflictError', code: 'DELEGATION_KEY_CONFLICT' });
  });

  it('spawns a distinct delegation per distinct key', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const first = await supervisor.spawnDelegation({ ...spawnKey({ toolCallId: 'tool-1' }), childSpec: childSpec() });
    const second = await supervisor.spawnDelegation({ ...spawnKey({ toolCallId: 'tool-2' }), childSpec: childSpec() });

    expect(second.delegationId).not.toBe(first.delegationId);
    expect(second.childConversationId).not.toBe(first.childConversationId);
    expect(second.waitId).not.toBe(first.waitId);
  });

  it('serializes concurrent spawns of the same key into ONE delegation', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() })),
    );

    const ids = new Set(results.map((result) => result.delegationId));
    expect(ids.size).toBe(1);
    // Exactly one spawn batch was committed (4 entries → head 1).
    expect(backend.head).toBe(1);
  });

  it('replays are durable: after reopening, the same key rejoins and the wait is re-materialized', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const first = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await expectPending(first.wait.promise, 'the foreground wait before the restart');

    const directory = backend.directory;
    await backend.close();
    const reopenedBackend = SqliteZstdBackend.open(directory);
    const reopened = await makeSupervisor(reopenedBackend);

    expect(reopened.recovery.reMaterializedWaits).toContain(first.waitId);
    const replay = await reopened.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    expect(replay.replayed).toBe(true);
    expect(replay.delegationId).toBe(first.delegationId);
    expect(replay.childSubmissionId).toBe(first.childSubmissionId);
    await expectPending(replay.wait.promise, 'the re-materialized foreground wait');
    await reopenedBackend.close();
  });

  it('gives every child conversation its OWN queue identity (R3 basis)', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const first = await supervisor.spawnDelegation({ ...spawnKey({ toolCallId: 'tool-1' }), childSpec: childSpec() });
    const second = await supervisor.spawnDelegation({ ...spawnKey({ toolCallId: 'tool-2' }), childSpec: childSpec() });

    const firstRecord = await supervisor.getDelegation(first.delegationId);
    const secondRecord = await supervisor.getDelegation(second.delegationId);
    expect(firstRecord?.queues.inboxId).not.toBe(secondRecord?.queues.inboxId);
    expect(firstRecord?.queues.deliveryIndexId).not.toBe(secondRecord?.queues.deliveryIndexId);
    expect(firstRecord?.queues.delegationIndexId).not.toBe(secondRecord?.queues.delegationIndexId);
    expect(firstRecord?.epochSeed).not.toBe(secondRecord?.epochSeed);
  });

  it('validates the supervision-tree link for nested spawns', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const parent = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });

    // Valid: the grandchild's parent conversation IS the child conversation of
    // the referenced delegation.
    const grandchild = await supervisor.spawnDelegation({
      ...spawnKey({ parentConversationId: parent.childConversationId, toolCallId: 'tool-grandchild' }),
      childSpec: childSpec({ parentDelegationId: parent.delegationId }),
    });
    const parentRecord = await supervisor.getDelegation(parent.delegationId);
    expect(parentRecord?.childDelegationIds).toContain(grandchild.delegationId);
    expect(grandchild.delegationId).not.toBe(parent.delegationId);

    // Invalid: a parentDelegationId whose child conversation does not match.
    await expect(
      supervisor.spawnDelegation({
        ...spawnKey({ parentConversationId: 'conv-somewhere-else', toolCallId: 'tool-orphan' }),
        childSpec: childSpec({ parentDelegationId: parent.delegationId }),
      }),
    ).rejects.toMatchObject({ name: 'DelegationParentMismatchError', code: 'DELEGATION_PARENT_MISMATCH' });
  });
});
