/**
 * Effect-fence disengagement ownership (steering-design-sol.md §4/§5,
 * round-1 review fix): the supervisor OWNS lifting the fence after a PROVEN
 * child terminal fact — `complete` and `recordChildTerminal` disengage; a
 * stop signal (`stop` / `parentAborted`) never does, because the fence
 * "снимается после доказанного завершения, не после отправки сигнала".
 */

import { describe, expect, it } from 'vitest';

import type { DelegationSupervisor } from '../../src/supervisor.js';
import type { EffectFenceDisengage, FenceDisengageRequest } from '../../src/types.js';
import { childSpec, doneOutcome, makeBackend, makeSupervisor, spawnKey } from '../helpers.js';

interface RecordingFence extends EffectFenceDisengage {
  readonly requests: FenceDisengageRequest[];
  failNext(): void;
}

function recordingFence(): RecordingFence {
  const requests: FenceDisengageRequest[] = [];
  let failing = false;
  return {
    requests,
    failNext() {
      failing = true;
    },
    async disengage(request) {
      requests.push(request);
      if (failing) {
        failing = false;
        return { status: 'failed', error: 'gateway unavailable' };
      }
      return { status: 'disengaged' };
    },
  };
}

async function spawnOne(supervisor: DelegationSupervisor): Promise<{ delegationId: string; waitId: string }> {
  const spawn = await supervisor.spawnDelegation({ ...spawnKey(), childSpec: childSpec() });
  return { delegationId: spawn.delegationId, waitId: spawn.waitId };
}

describe('fence disengage on proven terminal facts', () => {
  it('disengages after `complete` with the terminal ref, reports it on the result', async () => {
    const backend = makeBackend();
    const fence = recordingFence();
    const supervisor = await makeSupervisor(backend, {}, fence);
    const { delegationId, waitId } = await spawnOne(supervisor);

    // The detach itself is NOT a terminal fact: no disengage.
    await supervisor.detachToBackground({ delegationId, reason: 'owner-input' });
    expect(fence.requests).toHaveLength(0);

    const completion = await supervisor.complete({ delegationId, childRunId: 'r1', outcome: doneOutcome });
    expect(completion.fence).toEqual({ status: 'disengaged' });
    expect(fence.requests).toHaveLength(1);
    expect(fence.requests[0]).toEqual({
      parentConversationId: 'conv-parent',
      reason: 'child_completed',
      refs: [{ delegationId, waitId, toolCallId: 'tool-1' }],
    });

    // The idempotent completion replay does not disengage twice.
    await supervisor.complete({ delegationId, childRunId: 'r1', outcome: doneOutcome });
    expect(fence.requests).toHaveLength(1);
  });

  it('disengages after `recordChildTerminal` (confirmed stop), NOT after the stop signal', async () => {
    const backend = makeBackend();
    const fence = recordingFence();
    const supervisor = await makeSupervisor(backend, {}, fence);
    const { delegationId, waitId } = await spawnOne(supervisor);

    // Signals: stop cascade + parent abort — the fence stays.
    await supervisor.stop({ rootDelegationId: delegationId, cause: 'user' });
    await supervisor.parentAborted({ parentConversationId: 'conv-parent', explicitStop: true });
    expect(fence.requests).toHaveLength(0);

    const terminal = await supervisor.recordChildTerminal({
      delegationId,
      terminal: 'stopped',
      reason: 'stop acknowledged by child runtime',
    });
    expect(terminal.fence).toEqual({ status: 'disengaged' });
    expect(fence.requests).toHaveLength(1);
    expect(fence.requests[0]).toMatchObject({
      parentConversationId: 'conv-parent',
      reason: 'child_stopped',
      refs: [{ delegationId, waitId, toolCallId: 'tool-1' }],
    });
  });

  it('reports a failing gateway without rolling back the terminal fact', async () => {
    const backend = makeBackend();
    const fence = recordingFence();
    const supervisor = await makeSupervisor(backend, {}, fence);
    const { delegationId } = await spawnOne(supervisor);

    fence.failNext();
    const completion = await supervisor.complete({
      delegationId,
      childRunId: 'r1',
      outcome: { status: 'failed', summary: 'child crashed' },
    });
    expect(completion.fence).toEqual({ status: 'failed', error: 'gateway unavailable' });
    const record = await supervisor.getDelegation(delegationId);
    expect(record).toMatchObject({ childState: 'terminal', waitState: 'completed' });
  });

  it('a throwing gateway is reported, never thrown into the transition', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend, {}, {
      async disengage() {
        throw new Error('boom');
      },
    });
    const { delegationId } = await spawnOne(supervisor);
    const completion = await supervisor.complete({ delegationId, childRunId: 'r1', outcome: doneOutcome });
    expect(completion.fence).toEqual({ status: 'failed', error: 'boom' });
    expect((await supervisor.getDelegation(delegationId))?.completion).toMatchObject({ delivery: 'foreground' });
  });

  it('without a wired fence the results carry no disengagement', async () => {
    const backend = makeBackend();
    const supervisor = await makeSupervisor(backend);
    const { delegationId } = await spawnOne(supervisor);
    const completion = await supervisor.complete({ delegationId, childRunId: 'r1', outcome: doneOutcome });
    expect(completion.fence).toBeUndefined();
  });
});
