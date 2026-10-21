/**
 * Control-plane priorities P0–P4 (§2): cancel/permission → owner input /
 * release → stream → commit-drain → maintenance. Queued higher-priority work
 * runs first; a RUNNING atomic job is never interrupted; the lanes add no
 * timer delay of their own.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { CONTROL_PRIORITY, createControlPlane } from '../src/control-plane.js';
import { deriveWaitId } from '../src/wait-set.js';
import { driven, pumpMicrotasks, setup } from './helpers.js';

describe('control plane priorities', () => {
	it('runs queued higher-priority work before queued lower-priority work', async () => {
		const plane = createControlPlane();
		const order: string[] = [];
		const maintenance = plane.run(CONTROL_PRIORITY.MAINTENANCE, () => {
			order.push('p4-maintenance');
		});
		const release = plane.run(CONTROL_PRIORITY.OWNER_INPUT, () => {
			order.push('p1-owner-input');
		});
		await Promise.all([maintenance, release]);
		expect(order).toEqual(['p1-owner-input', 'p4-maintenance']);
	});

	it('P0 cancel/permission preempts every queued lane', async () => {
		const plane = createControlPlane();
		const order: string[] = [];
		const jobs = [
			plane.run(CONTROL_PRIORITY.STREAM, () => order.push('p2-stream')),
			plane.run(CONTROL_PRIORITY.MAINTENANCE, () => order.push('p4-maintenance')),
			plane.run(CONTROL_PRIORITY.CANCEL_PERMISSION, () => order.push('p0-cancel')),
			plane.run(CONTROL_PRIORITY.COMMIT_DRAIN, () => order.push('p3-drain')),
		];
		await Promise.all(jobs);
		expect(order).toEqual(['p0-cancel', 'p2-stream', 'p3-drain', 'p4-maintenance']);
	});

	it('never interrupts a running atomic job, even for P0', async () => {
		const plane = createControlPlane();
		const order: string[] = [];
		let finishDrain!: () => void;
		const gate = new Promise<void>(resolve => {
			finishDrain = resolve;
		});

		// A commit-drain transaction is in flight...
		const drain = plane.run(CONTROL_PRIORITY.COMMIT_DRAIN, async () => {
			order.push('drain:start');
			await gate;
			order.push('drain:end');
		});
		await pumpMicrotasks();
		expect(order).toEqual(['drain:start']);

		// ...so a P0 cancel waits for it instead of interrupting the commit.
		const cancel = plane.run(CONTROL_PRIORITY.CANCEL_PERMISSION, () => {
			order.push('cancel');
		});
		finishDrain();
		await Promise.all([drain, cancel]);
		expect(order).toEqual(['drain:start', 'drain:end', 'cancel']);
	});

	it('keeps FIFO order within one lane', async () => {
		const plane = createControlPlane();
		const order: string[] = [];
		await Promise.all([
			plane.run(CONTROL_PRIORITY.STREAM, () => order.push('a')),
			plane.run(CONTROL_PRIORITY.STREAM, () => order.push('b')),
			plane.run(CONTROL_PRIORITY.STREAM, () => order.push('c')),
		]);
		expect(order).toEqual(['a', 'b', 'c']);
	});

	it('a job failure rejects its caller but keeps the lanes working', async () => {
		const plane = createControlPlane();
		await expect(
			plane.run(CONTROL_PRIORITY.OWNER_INPUT, async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		await expect(plane.run(CONTROL_PRIORITY.OWNER_INPUT, () => 'ok')).resolves.toBe('ok');
		expect(plane.pendingCount()).toBe(0);
	});

	it('onIdle resolves only after the queue drains', async () => {
		const plane = createControlPlane();
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const job = plane.run(CONTROL_PRIORITY.STREAM, () => gate);
		let idle = false;
		const idlePromise = plane.onIdle().then(() => {
			idle = true;
		});
		await pumpMicrotasks();
		expect(idle).toBe(false);
		release();
		await Promise.all([job, idlePromise]);
		expect(idle).toBe(true);
		await expect(plane.onIdle()).resolves.toBeUndefined(); // already idle
	});

	it('the committed-steer release runs through the owner-input lane', async () => {
		const { control, clock, seam } = setup();
		const waitId = deriveWaitId({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1' });
		seam.registerDelegation({ waitId, taskId: 'task-1' });
		control.registerWait({ parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId: 'tc-1', stateVersion: 1 });

		// The job starts via microtasks; the seam work then runs on the clock.
		const result = await driven(clock, control.onCommittedSteer({ parentConversationId: 'conv-1' }));
		expect(result?.released).toHaveLength(1);
	});
});
