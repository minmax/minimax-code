/**
 * Stop cascade: one stop-request per node of the subtree under one shared
 * operation id, deduplicated by operation id and by child state, with
 * deterministic derived operation ids across cascades.
 */

import { describe, expect, it } from 'vitest';

import { SqliteZstdBackend } from '../../../durable-backend-sqlite-zstd/src/index.js';
import { KIND_STOP_REQUESTED, type SpawnDelegationResult, type StopRequestedPayload } from '../../src/index.js';
import { childSpec, makeBackend, makeSupervisor, payloadsOfKind, spawnKey } from '../helpers.js';

/** The four delegation ids of the test tree, by role. */
interface DelegationHarness {
  readonly root: SpawnDelegationResult;
  readonly left: SpawnDelegationResult;
  readonly grandchild: SpawnDelegationResult;
  readonly right: SpawnDelegationResult;
}

/** Builds a tree: root → {left → grandchild, right}; returns ids by role. */
async function buildTree(supervisor: Awaited<ReturnType<typeof makeSupervisor>>): Promise<DelegationHarness> {
  const root = await supervisor.spawnDelegation({ ...spawnKey({ toolCallId: 'tool-root' }), childSpec: childSpec() });
  const left = await supervisor.spawnDelegation({
    ...spawnKey({ parentConversationId: root.childConversationId, toolCallId: 'tool-left' }),
    childSpec: childSpec({ parentDelegationId: root.delegationId }),
  });
  const grandchild = await supervisor.spawnDelegation({
    ...spawnKey({ parentConversationId: left.childConversationId, toolCallId: 'tool-grandchild' }),
    childSpec: childSpec({ parentDelegationId: left.delegationId }),
  });
  const right = await supervisor.spawnDelegation({
    ...spawnKey({ parentConversationId: root.childConversationId, toolCallId: 'tool-right' }),
    childSpec: childSpec({ parentDelegationId: root.delegationId }),
  });
  return { root, left, grandchild, right };
}

describe('stop cascade', () => {
  it('requests every node of the subtree exactly once under one shared operationId', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const tree = await buildTree(supervisor);
    const headBefore = backend.head;

    const result = await supervisor.stop({ rootDelegationId: tree.root.delegationId, cause: 'user', initiator: 'owner' });

    expect(result.operationId).toBe(`stop-${tree.root.delegationId}-0`);
    // Breadth-first, deterministic: root, then its children, then grandchildren.
    expect(result.outcomes).toEqual([
      { delegationId: tree.root.delegationId, action: 'stop-requested', depth: 0 },
      { delegationId: tree.left.delegationId, action: 'stop-requested', depth: 1 },
      { delegationId: tree.right.delegationId, action: 'stop-requested', depth: 1 },
      { delegationId: tree.grandchild.delegationId, action: 'stop-requested', depth: 2 },
    ]);

    // One stop-request entry per node, all carrying the SAME operation id.
    const requests = payloadsOfKind<StopRequestedPayload>(backend, KIND_STOP_REQUESTED);
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.operationId).toBe(`stop-${tree.root.delegationId}-0`);
      expect(request.rootDelegationId).toBe(tree.root.delegationId);
      expect(request.cause).toBe('user');
      expect(request.initiator).toBe('owner');
    }
    // All four records went to `stopping` with bumped versions.
    for (const node of [tree.root, tree.left, tree.grandchild, tree.right]) {
      const record = await supervisor.getDelegation(node.delegationId);
      expect(record).toMatchObject({ childState: 'stopping' });
      expect(record?.stateVersion).toBe(node.stateVersion + 1);
    }
    // The whole cascade was ONE atomic batch (4 requests + document).
    expect(backend.head).toBe(headBefore + 1);
  });

  it('replaying the same operation commits nothing and reports the replay', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const tree = await buildTree(supervisor);
    const first = await supervisor.stop({ rootDelegationId: tree.root.delegationId });
    const headAfterFirst = backend.head;

    const replay = await supervisor.stop({
      rootDelegationId: tree.root.delegationId,
      operationId: first.operationId,
    });

    expect(replay.operationId).toBe(first.operationId);
    expect(replay.replayed).toBe(true);
    expect(replay.outcomes.every((outcome) => outcome.action === 'skipped')).toBe(true);
    expect(backend.head).toBe(headAfterFirst);
    expect(payloadsOfKind(backend, KIND_STOP_REQUESTED)).toHaveLength(4);
  });

  it('a new cascade over an already-stopping subtree produces no duplicate requests', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const tree = await buildTree(supervisor);
    await supervisor.stop({ rootDelegationId: tree.root.delegationId });
    const headBefore = backend.head;

    // A genuinely NEW operation (fresh derived id) over the left subtree.
    const result = await supervisor.stop({ rootDelegationId: tree.left.delegationId });

    expect(result.replayed).toBe(false);
    expect(result.outcomes).toEqual([
      { delegationId: tree.left.delegationId, action: 'skipped', skippedBecause: 'already-stopping', depth: 0 },
      { delegationId: tree.grandchild.delegationId, action: 'skipped', skippedBecause: 'already-stopping', depth: 1 },
    ]);
    // Nothing was committed: both nodes were already stopping.
    expect(backend.head).toBe(headBefore);
  });

  it('stopping a leaf subtree leaves sibling branches running', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const tree = await buildTree(supervisor);

    const result = await supervisor.stop({ rootDelegationId: tree.right.delegationId });

    expect(result.outcomes).toEqual([
      { delegationId: tree.right.delegationId, action: 'stop-requested', depth: 0 },
    ]);
    const left = await supervisor.getDelegation(tree.left.delegationId);
    const root = await supervisor.getDelegation(tree.root.delegationId);
    expect(left).toMatchObject({ childState: 'running' });
    expect(root).toMatchObject({ childState: 'running' });
  });

  it('skips terminal nodes and stops only the running part of the subtree', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const tree = await buildTree(supervisor);
    await supervisor.complete({ delegationId: tree.grandchild.delegationId, childRunId: 'gc-1', outcome: { status: 'completed' } });

    const result = await supervisor.stop({ rootDelegationId: tree.root.delegationId });

    expect(result.outcomes).toEqual([
      { delegationId: tree.root.delegationId, action: 'stop-requested', depth: 0 },
      { delegationId: tree.left.delegationId, action: 'stop-requested', depth: 1 },
      { delegationId: tree.right.delegationId, action: 'stop-requested', depth: 1 },
      { delegationId: tree.grandchild.delegationId, action: 'skipped', skippedBecause: 'terminal', depth: 2 },
    ]);
  });

  it('derives the next operation id after a committed cascade, even across a restart', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const tree = await buildTree(supervisor);
    await supervisor.stop({ rootDelegationId: tree.root.delegationId });

    const directory = backend.directory;
    await backend.close();
    const reopenedBackend = SqliteZstdBackend.open(directory);
    const reopened = await makeSupervisor(reopenedBackend);

    // The derived id must move FORWARD (the committed cascade was counted),
    // otherwise a fresh stop would be swallowed as a replay of the old one.
    const second = await reopened.stop({ rootDelegationId: tree.root.delegationId });
    expect(second.operationId).toBe(`stop-${tree.root.delegationId}-1`);
    expect(second.replayed).toBe(false);
    expect(second.outcomes.every((outcome) => outcome.action === 'skipped')).toBe(true);
    await reopenedBackend.close();
  });

  it('refuses unknown roots', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    await expect(supervisor.stop({ rootDelegationId: 'del-unknown' })).rejects.toMatchObject({
      name: 'DelegationNotFoundError',
    });
  });
});
