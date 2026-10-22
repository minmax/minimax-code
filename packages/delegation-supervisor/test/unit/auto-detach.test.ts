/**
 * Auto-detach and cancelOnParentAbort: the release is one irreversible wait
 * transition; the stored supervision link keeps acting after the detach
 * (foreground abort stops the child, backgrounded abort does not, explicit
 * Stop always does — policy permitting), and a late child outcome after the
 * detach arrives through the deduplicated reporter, never as a second
 * foreground tool result.
 */

import { describe, expect, it } from 'vitest';

import {
  KIND_BACKGROUNDED,
  KIND_STOP_REQUESTED,
  completionRequestId,
  type StopRequestedPayload,
} from '../../src/index.js';
import {
  childSpec,
  delay,
  doneOutcome,
  expectPending,
  makeBackend,
  makeSupervisor,
  payloadsOfKind,
  spawnKey,
  trackResolutions,
} from '../helpers.js';

describe('auto-detach and late outcome (T_release + supervision)', () => {
  it('releases the foreground wait exactly once with the background handle', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    const resolutions = trackResolutions(spawn.wait.promise);

    const release = await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });

    expect(release.released).toBe(true);
    expect(release.replayed).toBe(false);
    expect(release.backgroundHandle).toMatchObject({
      kind: 'task-background',
      supervisorTaskId: spawn.supervisorTaskId,
      childConversationId: spawn.childConversationId,
      childSubmissionId: spawn.childSubmissionId,
    });

    // The waiter resolves AFTER the commit with the standard background outcome.
    await expect(spawn.wait.promise).resolves.toMatchObject({
      kind: 'backgrounded',
      delegationId: spawn.delegationId,
      reason: 'owner-input',
    });
    const record = await supervisor.getDelegation(spawn.delegationId);
    expect(record).toMatchObject({ waitState: 'backgrounded', childState: 'running' });
    expect(payloadsOfKind(backend, KIND_BACKGROUNDED)).toHaveLength(1);

    // The wait transition is irreversible: a DIFFERENT operation id cannot
    // release the same wait again.
    await expect(
      supervisor.detachToBackground({
        delegationId: spawn.delegationId,
        reason: 'manual',
        operationId: 'background-manual-attempt',
      }),
    ).rejects.toMatchObject({ name: 'DelegationNotForegroundError', code: 'DELEGATION_NOT_FOREGROUND' });

    // ...while a replay of the SAME operation id returns the recorded outcome.
    const replay = await supervisor.detachToBackground({
      delegationId: spawn.delegationId,
      reason: 'owner-input',
      operationId: release.operationId,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.backgroundHandle).toEqual(release.backgroundHandle);
    await delay(5);
    expect(resolutions.count()).toBe(1);
  });

  it('a parent abort after the auto-detach does NOT stop the child', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });
    const headBefore = backend.head;

    const result = await supervisor.parentAborted({
      parentConversationId: 'conv-parent',
      parentRunId: 'run-1',
      explicitStop: false,
    });

    expect(result.outcomes).toEqual([
      { delegationId: spawn.delegationId, action: 'skipped', skippedBecause: 'backgrounded' },
    ]);
    // No stop-request was committed: the backgrounded child keeps running.
    expect(backend.head).toBe(headBefore);
    expect(payloadsOfKind(backend, KIND_STOP_REQUESTED)).toHaveLength(0);
    const record = await supervisor.getDelegation(spawn.delegationId);
    expect(record).toMatchObject({ childState: 'running', waitState: 'backgrounded' });
  });

  it('an explicit parent Stop after the auto-detach DOES stop the child', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });

    const result = await supervisor.parentAborted({
      parentConversationId: 'conv-parent',
      explicitStop: true,
    });

    expect(result.outcomes).toEqual([{ delegationId: spawn.delegationId, action: 'stop-requested' }]);
    const requests = payloadsOfKind<StopRequestedPayload>(backend, KIND_STOP_REQUESTED);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ cause: 'parent-stop', initiator: 'supervision' });
    const record = await supervisor.getDelegation(spawn.delegationId);
    expect(record).toMatchObject({ childState: 'stopping' });
  });

  it('a parent abort while the wait is still foreground stops the child', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await expectPending(spawn.wait.promise);

    const result = await supervisor.parentAborted({
      parentConversationId: 'conv-parent',
      parentRunId: 'run-1',
      explicitStop: false,
    });

    expect(result.outcomes).toEqual([{ delegationId: spawn.delegationId, action: 'stop-requested' }]);
    const requests = payloadsOfKind<StopRequestedPayload>(backend, KIND_STOP_REQUESTED);
    expect(requests[0]).toMatchObject({ cause: 'parent-abort', initiator: 'supervision' });
    // The foreground wait stays pending: only the child outcome or a release
    // ends it; the stop is a child-lifecycle transition.
    await expectPending(spawn.wait.promise);
  });

  it('cancelOnParentAbort=false keeps the child alive even through an explicit parent Stop', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({
      ...spawnKey(),
      childSpec: childSpec({ supervision: { cancelOnParentAbort: false } }),
    });

    const autoAbort = await supervisor.parentAborted({
      parentConversationId: 'conv-parent',
      explicitStop: false,
    });
    expect(autoAbort.outcomes).toEqual([
      { delegationId: spawn.delegationId, action: 'skipped', skippedBecause: 'policy-off' },
    ]);

    const explicitStop = await supervisor.parentAborted({
      parentConversationId: 'conv-parent',
      explicitStop: true,
    });
    expect(explicitStop.outcomes).toEqual([
      { delegationId: spawn.delegationId, action: 'skipped', skippedBecause: 'policy-off' },
    ]);
    expect(payloadsOfKind(backend, KIND_STOP_REQUESTED)).toHaveLength(0);
    const record = await supervisor.getDelegation(spawn.delegationId);
    expect(record).toMatchObject({ childState: 'running' });
  });

  it('a late child outcome after the detach is reporter-delivered, never a second foreground result', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    const resolutions = trackResolutions(spawn.wait.promise);
    await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });
    await spawn.wait.promise;
    expect(resolutions.count()).toBe(1);

    const completion = await supervisor.complete({
      delegationId: spawn.delegationId,
      childRunId: 'child-run-late',
      outcome: doneOutcome,
    });

    // Backgrounded wait → the reporter path with the stable requestId.
    expect(completion.delivery).toBe('reporter');
    expect(completion.requestId).toBe(completionRequestId(spawn.delegationId, 'child-run-late'));
    // The resolved foreground consumer was NOT woken a second time.
    await delay(5);
    expect(resolutions.count()).toBe(1);
    const record = await supervisor.getDelegation(spawn.delegationId);
    expect(record).toMatchObject({ waitState: 'backgrounded', childState: 'terminal' });
    expect(record?.completion).toMatchObject({ delivery: 'reporter', reportSettled: true });
  });

  it('a completion that wins the race against the release keeps the normal task result', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.complete({ delegationId: spawn.delegationId, childRunId: 'r1', outcome: doneOutcome });

    const release = await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });
    expect(release.released).toBe(false);
    expect(release.reason).toBe('already-completed');
    expect(release.backgroundHandle).toBeNull();
    expect(payloadsOfKind(backend, KIND_BACKGROUNDED)).toHaveLength(0);
  });

  it('a completion during `stopping` is still saved and resolves the foreground wait', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.parentAborted({ parentConversationId: 'conv-parent', explicitStop: false });
    expect((await supervisor.getDelegation(spawn.delegationId))?.childState).toBe('stopping');

    const completion = await supervisor.complete({
      delegationId: spawn.delegationId,
      childRunId: 'r1',
      outcome: { status: 'failed', summary: 'aborted by stop' },
    });
    // The wait is still foreground, so the outcome is the foreground delivery.
    expect(completion.delivery).toBe('foreground');
    await expect(spawn.wait.promise).resolves.toMatchObject({
      kind: 'completed',
      outcome: { status: 'failed', summary: 'aborted by stop' },
    });
    const record = await supervisor.getDelegation(spawn.delegationId);
    expect(record).toMatchObject({ childState: 'terminal', waitState: 'completed' });
  });

  it('recordChildTerminal closes stopping → terminal and settles a foreground wait', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.parentAborted({ parentConversationId: 'conv-parent', explicitStop: false });

    const terminal = await supervisor.recordChildTerminal({
      delegationId: spawn.delegationId,
      terminal: 'stopped',
      reason: 'stop acknowledged by child runtime',
    });
    expect(terminal.replayed).toBe(false);
    await expect(spawn.wait.promise).resolves.toMatchObject({
      kind: 'completed',
      delivery: 'foreground',
      outcome: { status: 'failed', summary: 'stop acknowledged by child runtime' },
    });

    const replay = await supervisor.recordChildTerminal({
      delegationId: spawn.delegationId,
      terminal: 'stopped',
      reason: 'stop acknowledged by child runtime',
    });
    expect(replay.replayed).toBe(true);
    await expect(
      supervisor.recordChildTerminal({
        delegationId: spawn.delegationId,
        terminal: 'completed',
        reason: 'contradiction',
      }),
    ).rejects.toMatchObject({ name: 'DelegationTerminalConflictError', code: 'DELEGATION_TERMINAL_CONFLICT' });
  });

  it('rejects a stale expectedStateVersion on release', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await expect(
      supervisor.detachToBackground({
        delegationId: spawn.delegationId,
        reason: 'timer',
        expectedStateVersion: 41,
      }),
    ).rejects.toMatchObject({ name: 'DelegationVersionConflictError', code: 'DELEGATION_VERSION_CONFLICT' });
  });
});
