/**
 * T_complete: exactly one delivery per completion — the foreground consumer
 * or the deduplicated background reporter with the stable requestId
 * `delegation:<id>:completion:<childRunId>` — replay-safe across crashes, and
 * identity-guarded against a second child run reusing the delegation result.
 */

import { describe, expect, it } from 'vitest';

import { SqliteZstdBackend } from '../../../durable-backend-sqlite-zstd/src/index.js';
import {
  KIND_BACKGROUNDED,
  KIND_CHILD_CONVERSATION,
  KIND_COMPLETED,
  KIND_COMPLETION_REPORT,
  KIND_SPAWNED,
  KIND_SUPERVISOR_TASK,
  backgroundedEntryId,
  childConversationEntryId,
  childSpecDigest,
  completionRequestId,
  completionSubmissionId,
  completedEntryId,
  deriveSpawnIdentity,
  spawnedEntryId,
  supervisorTaskEntryId,
  type CompletionReportPayload,
} from '../../src/index.js';
import {
  asJson,
  childSpec,
  delay,
  doneOutcome,
  makeBackend,
  makeSupervisor,
  payloadsOfKind,
  spawnKey,
  supervisorEntries,
} from '../helpers.js';

describe('complete (T_complete)', () => {
  it('delivers to the foreground consumer exactly once; a repeat is an idempotent replay', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });

    const waitResolution = spawn.wait.promise.then((result) => result);
    const completion = await supervisor.complete({
      delegationId: spawn.delegationId,
      childRunId: 'child-run-1',
      outcome: doneOutcome,
    });

    expect(completion).toMatchObject({ delivery: 'foreground', requestId: null, submissionId: null, replayed: false });
    await expect(waitResolution).resolves.toMatchObject({
      kind: 'completed',
      delivery: 'foreground',
      childRunId: 'child-run-1',
      outcome: doneOutcome,
    });

    const headAfterFirst = backend.head;
    const repeat = await supervisor.complete({
      delegationId: spawn.delegationId,
      childRunId: 'child-run-1',
      outcome: doneOutcome,
    });
    expect(repeat.replayed).toBe(true);
    expect(repeat.delivery).toBe('foreground');
    // No second completion batch, and only one completed entry in the log.
    expect(backend.head).toBe(headAfterFirst);
    expect(payloadsOfKind(backend, KIND_COMPLETED)).toHaveLength(1);
  });

  it('refuses a completion under a different child run: that is new work, not a duplicate', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.complete({ delegationId: spawn.delegationId, childRunId: 'child-run-1', outcome: doneOutcome });

    await expect(
      supervisor.complete({ delegationId: spawn.delegationId, childRunId: 'child-run-2', outcome: doneOutcome }),
    ).rejects.toMatchObject({ name: 'DelegationAlreadyCompletedError', code: 'DELEGATION_ALREADY_COMPLETED' });
  });

  it('after a detach the completion goes through the deduplicated reporter with the stable requestId', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });

    const completion = await supervisor.complete({
      delegationId: spawn.delegationId,
      childRunId: 'child-run-9',
      outcome: doneOutcome,
    });
    const expectedRequestId = completionRequestId(spawn.delegationId, 'child-run-9');
    expect(completion.delivery).toBe('reporter');
    expect(completion.requestId).toBe(expectedRequestId);
    expect(completion.requestId).toBe(`delegation:${spawn.delegationId}:completion:child-run-9`);
    expect(completion.submissionId).toBe(completionSubmissionId(expectedRequestId));

    // The durable reporter submission record exists with exactly those ids.
    const reports = payloadsOfKind<CompletionReportPayload>(backend, KIND_COMPLETION_REPORT);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      requestId: expectedRequestId,
      submissionId: completion.submissionId,
      delegationId: spawn.delegationId,
      childRunId: 'child-run-9',
    });

    // Repeating the completion returns the SAME submission without writing.
    const headAfterFirst = backend.head;
    const repeat = await supervisor.complete({
      delegationId: spawn.delegationId,
      childRunId: 'child-run-9',
      outcome: doneOutcome,
    });
    expect(repeat.replayed).toBe(true);
    expect(repeat.submissionId).toBe(completion.submissionId);
    expect(backend.head).toBe(headAfterFirst);
  });

  it('after a crash the repeated completion still returns the same submission (durable dedup)', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });
    const first = await supervisor.complete({
      delegationId: spawn.delegationId,
      childRunId: 'child-run-9',
      outcome: doneOutcome,
    });

    const directory = backend.directory;
    await backend.close();
    const reopenedBackend = SqliteZstdBackend.open(directory);
    const reopened = await makeSupervisor(reopenedBackend);
    const replay = await reopened.complete({
      delegationId: spawn.delegationId,
      childRunId: 'child-run-9',
      outcome: doneOutcome,
    });

    expect(replay.replayed).toBe(true);
    expect(replay.submissionId).toBe(first.submissionId);
    expect(replay.requestId).toBe(first.requestId);
    // Still exactly one reporter record in the whole log.
    expect(payloadsOfKind(reopenedBackend, KIND_COMPLETION_REPORT)).toHaveLength(1);
    await reopenedBackend.close();
  });

  it('returns the same submission even when the completion aged out of the index tail', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend, { maxTerminalRecords: 0 });
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    await supervisor.detachToBackground({ delegationId: spawn.delegationId, reason: 'owner-input' });
    const first = await supervisor.complete({
      delegationId: spawn.delegationId,
      childRunId: 'child-run-9',
      outcome: doneOutcome,
    });
    // With a zero-size terminal tail the record left the live index entirely.
    expect(supervisor.listIndexed()).toHaveLength(0);

    const replay = await supervisor.complete({
      delegationId: spawn.delegationId,
      childRunId: 'child-run-9',
      outcome: doneOutcome,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.submissionId).toBe(first.submissionId);
    expect(replay.delivery).toBe('reporter');
  });

  it('rejects a stale expectedStateVersion instead of overwriting', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });

    await expect(
      supervisor.complete({
        delegationId: spawn.delegationId,
        childRunId: 'child-run-1',
        outcome: doneOutcome,
        expectedStateVersion: 99,
      }),
    ).rejects.toMatchObject({ name: 'DelegationVersionConflictError', code: 'DELEGATION_VERSION_CONFLICT' });
  });

  it('recovery repairs a committed completion whose reporter record is missing, under the same requestId', async () => {
    const backend = makeBackend();
    // A log written by a SPLIT delivery design: raw transition entries and NO
    // index document, with a reporter delivery whose submission record never
    // landed. Recovery must rebuild from the transitions (the entry-replay
    // fallback) and re-emit the reporter record under the SAME requestId.
    const key = spawnKey();
    const identity = deriveSpawnIdentity(key);
    const requestId = completionRequestId(identity.delegationId, 'child-run-7');
    await backend.appendBatch([
      {
        id: supervisorTaskEntryId(identity.supervisorTaskId),
        kind: KIND_SUPERVISOR_TASK,
        payload: asJson({
          supervisorTaskId: identity.supervisorTaskId,
          delegationId: identity.delegationId,
          ownershipBoundary: 'native-background',
        }),
      },
      {
        id: childConversationEntryId(identity.childConversationId),
        kind: KIND_CHILD_CONVERSATION,
        payload: asJson({
          childConversationId: identity.childConversationId,
          delegationId: identity.delegationId,
          supervisorTaskId: identity.supervisorTaskId,
          queueForkPolicy: 'initial',
          queues: identity.queues,
          epochSeed: identity.epochSeed,
          inheritedReceipts: 'none',
        }),
      },
      {
        id: spawnedEntryId(identity.delegationId),
        kind: KIND_SPAWNED,
        payload: asJson({
          delegationId: identity.delegationId,
          key,
          supervisorTaskId: identity.supervisorTaskId,
          childConversationId: identity.childConversationId,
          childSubmissionId: identity.childSubmissionId,
          waitId: identity.waitId,
          queues: identity.queues,
          epochSeed: identity.epochSeed,
          supervision: { cancelOnParentAbort: true },
          parentDelegationId: null,
          stateVersion: 1,
          childSpecDigest: childSpecDigest(childSpec()),
        }),
      },
      {
        id: backgroundedEntryId(identity.delegationId),
        kind: KIND_BACKGROUNDED,
        payload: asJson({
          delegationId: identity.delegationId,
          waitId: identity.waitId,
          operationId: `background-${identity.delegationId}`,
          reason: 'owner-input',
          backgroundHandle: {
            kind: 'task-background',
            supervisorTaskId: identity.supervisorTaskId,
            childConversationId: identity.childConversationId,
            childSubmissionId: identity.childSubmissionId,
          },
          stateVersion: 2,
        }),
      },
      {
        id: completedEntryId(identity.delegationId, 'child-run-7'),
        kind: KIND_COMPLETED,
        payload: asJson({
          delegationId: identity.delegationId,
          childRunId: 'child-run-7',
          outcome: doneOutcome,
          delivery: 'reporter',
          requestId,
          stateVersion: 3,
        }),
      },
    ]);

    const reopened = await makeSupervisor(backend);
    expect(reopened.recovery.mode).toBe('entry-replay');
    expect(reopened.recovery.repairedReporterSubmissions).toEqual([requestId]);

    // The repeat of the completion returns the same (repaired) submission.
    const repeat = await reopened.complete({
      delegationId: identity.delegationId,
      childRunId: 'child-run-7',
      outcome: doneOutcome,
    });
    expect(repeat.replayed).toBe(true);
    expect(repeat.requestId).toBe(requestId);
    expect(repeat.submissionId).toBe(completionSubmissionId(requestId));
    expect(payloadsOfKind(backend, KIND_COMPLETION_REPORT)).toHaveLength(1);
    await backend.close();
  });

  it('unknown delegations are refused, not invented', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    await expect(
      supervisor.complete({ delegationId: 'del-does-not-exist', childRunId: 'r', outcome: doneOutcome }),
    ).rejects.toMatchObject({ name: 'DelegationNotFoundError', code: 'DELEGATION_NOT_FOUND' });
  });

  it('resolves the foreground wait only once even under racing repeats', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
    let resolutions = 0;
    spawn.wait.promise.then(() => {
      resolutions += 1;
    });

    await Promise.all([
      supervisor.complete({ delegationId: spawn.delegationId, childRunId: 'r1', outcome: doneOutcome }),
      supervisor.complete({ delegationId: spawn.delegationId, childRunId: 'r1', outcome: doneOutcome }),
      supervisor.complete({ delegationId: spawn.delegationId, childRunId: 'r1', outcome: doneOutcome }),
    ]);
    await delay(10);
    expect(resolutions).toBe(1);
  });
});
