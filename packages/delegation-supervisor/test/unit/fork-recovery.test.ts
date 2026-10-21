/**
 * R3 fork compatibility and recovery: a fork branch owns a fresh conversation,
 * inbox, delivery index, delegation index, and epoch seed; inherited receipts
 * are recorded as history. Recovery rebuilds the projection, re-materializes
 * waits, and reports pending stop-requests.
 */

import { describe, expect, it } from 'vitest';

import { SqliteZstdBackend } from '../../../durable-backend-sqlite-zstd/src/index.js';
import { KIND_CHILD_CONVERSATION, type ChildConversationPayload } from '../../src/index.js';
import {
  childSpec,
  doneOutcome,
  expectPending,
  makeBackend,
  makeSupervisor,
  payloadsOfKind,
  spawnKey,
} from '../helpers.js';

describe('R3 fork compatibility', () => {
  it('gives the fork branch its own conversation, queues, and epoch; inherited receipts are history', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const source = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });

    const fork = await supervisor.forkChild({ delegationId: source.delegationId, reason: 'rewind' });

    expect(fork.fromDelegationId).toBe(source.delegationId);
    expect(fork.forkIndex).toBe(0);
    // Fully fresh identity: nothing is shared with the source child.
    expect(fork.childConversationId).not.toBe(source.childConversationId);
    expect(fork.queues.inboxId).not.toContain(source.delegationId.slice('del-'.length));
    const sourceRecord = await supervisor.getDelegation(source.delegationId);
    const forkRecord = await supervisor.getDelegation(fork.forkDelegationId);
    expect(forkRecord?.queues.inboxId).not.toBe(sourceRecord?.queues.inboxId);
    expect(forkRecord?.queues.deliveryIndexId).not.toBe(sourceRecord?.queues.deliveryIndexId);
    expect(forkRecord?.queues.delegationIndexId).not.toBe(sourceRecord?.queues.delegationIndexId);
    expect(forkRecord?.epochSeed).not.toBe(sourceRecord?.epochSeed);
    // R3 semantics on the record: inherited receipts are history, not pending.
    expect(forkRecord).toMatchObject({
      inheritedReceipts: 'history',
      forkedFromDelegationId: source.delegationId,
      waitState: 'none',
      childState: 'running',
    });
    // The fork's own conversation record carries the same history marker.
    const forkConversations = payloadsOfKind<ChildConversationPayload>(backend, KIND_CHILD_CONVERSATION);
    expect(forkConversations).toHaveLength(2);
    expect(forkConversations[1]).toMatchObject({
      childConversationId: fork.childConversationId,
      inheritedReceipts: 'history',
      queueForkPolicy: 'initial',
    });
    // The source record links the branch and is otherwise unchanged.
    expect(sourceRecord?.forkDelegationIds).toContain(fork.forkDelegationId);
    expect(sourceRecord?.childState).toBe('running');
  });

  it('derives a fresh identity per fork index', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const source = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    const first = await supervisor.forkChild({ delegationId: source.delegationId });
    const second = await supervisor.forkChild({ delegationId: source.delegationId });

    expect(second.forkIndex).toBe(1);
    expect(second.forkDelegationId).not.toBe(first.forkDelegationId);
    expect(second.childConversationId).not.toBe(first.childConversationId);
    expect(second.queues.inboxId).not.toBe(first.queues.inboxId);
  });

  it('a fork branch has no foreground wait, so its completion is reporter-delivered', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const source = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    const fork = await supervisor.forkChild({ delegationId: source.delegationId });

    const completion = await supervisor.complete({
      delegationId: fork.forkDelegationId,
      childRunId: 'fork-run-1',
      outcome: doneOutcome,
    });

    expect(completion.delivery).toBe('reporter');
    expect(completion.requestId).toBe(`delegation:${fork.forkDelegationId}:completion:fork-run-1`);
    // The source delegation is untouched by the fork's completion.
    const sourceRecord = await supervisor.getDelegation(source.delegationId);
    expect(sourceRecord).toMatchObject({ childState: 'running', completion: null });
  });

  it('fork identity survives a restart (derived, not counted in memory only)', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const source = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.forkChild({ delegationId: source.delegationId });
    const directory = backend.directory;
    await backend.close();

    const reopenedBackend = SqliteZstdBackend.open(directory);
    const reopened = await makeSupervisor(reopenedBackend);
    const second = await reopened.forkChild({ delegationId: source.delegationId });
    expect(second.forkIndex).toBe(1);
    await reopenedBackend.close();
  });
});

describe('recovery', () => {
  it('rebuilds the projection, re-materializes only foreground waits, and reports pending stops', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const foreground = await supervisor.spawnDelegation({ ...spawnKey({ toolCallId: 'tool-fg' }), childSpec: childSpec() });
    const detached = await supervisor.spawnDelegation({ ...spawnKey({ toolCallId: 'tool-bg' }), childSpec: childSpec() });
    await supervisor.detachToBackground({ delegationId: detached.delegationId, reason: 'owner-input' });
    const stopped = await supervisor.spawnDelegation({ ...spawnKey({ toolCallId: 'tool-stopped' }), childSpec: childSpec() });
    await supervisor.complete({
      delegationId: stopped.delegationId,
      childRunId: 'run-stopped',
      outcome: doneOutcome,
    });

    const directory = backend.directory;
    await backend.close();
    const reopenedBackend = SqliteZstdBackend.open(directory);
    const reopened = await makeSupervisor(reopenedBackend);

    // Checkpoint recovery: restored from the latest document by point reads,
    // not by replaying entries.
    expect(reopened.recovery.mode).toBe('document-checkpoint');
    expect(reopened.recovery.replayedEntries).toBe(0);
    expect(reopened.recovery.reMaterializedWaits).toEqual([foreground.waitId]);
    expect(reopened.recovery.stoppingWithoutTerminal).toEqual([]);
    expect(reopened.recovery.repairedReporterSubmissions).toEqual([]);

    const foregroundRecord = await reopened.getDelegation(foreground.delegationId);
    expect(foregroundRecord).toMatchObject({ waitState: 'foreground', childState: 'running', stateVersion: 1 });
    const detachedRecord = await reopened.getDelegation(detached.delegationId);
    expect(detachedRecord).toMatchObject({ waitState: 'backgrounded' });
    await expectPending(reopened.getWait(foreground.waitId)!.promise, 'the re-materialized foreground wait');

    // The re-materialized wait is LIVE: a detach on the reopened supervisor
    // resolves the same waitId.
    await reopened.detachToBackground({ delegationId: foreground.delegationId, reason: 'post-recovery' });
    await expect(reopened.getWait(foreground.waitId)!.promise).resolves.toMatchObject({ kind: 'backgrounded' });
    await reopenedBackend.close();
  });

  it('reports stop-requests without a terminal outcome as pending work after a restart', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.parentAborted({ parentConversationId: 'conv-parent', explicitStop: false });

    const directory = backend.directory;
    await backend.close();
    const reopenedBackend = SqliteZstdBackend.open(directory);
    const reopened = await makeSupervisor(reopenedBackend);

    expect(reopened.recovery.stoppingWithoutTerminal).toEqual([spawn.delegationId]);
    const record = await reopened.getDelegation(spawn.delegationId);
    expect(record).toMatchObject({ childState: 'stopping' });
    // The supervision stop survives: an explicit parent stop now finds the
    // node already stopping and does not duplicate the request.
    const again = await reopened.parentAborted({ parentConversationId: 'conv-parent', explicitStop: true });
    expect(again.outcomes).toEqual([
      { delegationId: spawn.delegationId, action: 'skipped', skippedBecause: 'already-stopping' },
    ]);
    await reopenedBackend.close();
  });

  it('document revision advances by exactly one per committed transition', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    expect(supervisor.documentRevision).toBe(1);
    await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });
    expect(supervisor.documentRevision).toBe(2);
    await supervisor.complete({ delegationId: spawn.delegationId, childRunId: 'r', outcome: doneOutcome });
    expect(supervisor.documentRevision).toBe(3);
  });
});
