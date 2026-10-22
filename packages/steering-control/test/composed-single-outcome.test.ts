/**
 * COMPOSED single-outcome proof (steering-design-sol.md §3, round-1 review
 * fix): the reactive control (steering-control), the wait-outcome authority
 * (durable-seam) and the delegation supervisor share ONE real sqlite-zstd
 * delta log, and ONE release produces EXACTLY
 *
 * - one `mcode.delegation.backgrounded` entry per waitId — written by the
 *   seam, projected by the supervisor (never duplicated), and
 * - one `mcode.delegation.tool-result` entry per toolCallId,
 *
 * across BOTH stores (the seam's entries and the supervisor's index
 * document). The supervisor's `detachToBackground` routes through the same
 * seam commit the control uses, so both entry points converge on one record.
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteZstdBackend } from '../../durable-backend-sqlite-zstd/src/index.js';
import { DurableSeam, SEAM_ENTRY_KINDS, sqliteZstdDurableLogPort } from '../../durable-seam/src/index.js';
import { sqliteZstdDelegationLog } from '../../delegation-supervisor/src/log.js';
import { DelegationSupervisor } from '../../delegation-supervisor/src/supervisor.js';
import { KIND_BACKGROUNDED, KIND_COMPLETED } from '../../delegation-supervisor/src/types.js';
import { isSupervisorKind } from '../../delegation-supervisor/src/document.js';
import { createDurableSeamControlSeam } from '../src/durable-seam-adapter.js';
import { createReactiveControl } from '../src/reactive-control.js';
import { deriveWaitId } from '../src/wait-set.js';

const directories: string[] = [];

afterEach(() => {
	while (directories.length > 0) {
		const dir = directories.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

interface Composed {
	backend: SqliteZstdBackend;
	seam: DurableSeam;
	supervisor: DelegationSupervisor;
	control: ReturnType<typeof createReactiveControl>;
}

async function compose(): Promise<Composed> {
	const directory = mkdtempSync(join(tmpdir(), 'steering-composed-'));
	directories.push(directory);
	const backend = SqliteZstdBackend.open(directory);
	const seam = await DurableSeam.open(sqliteZstdDurableLogPort(backend));
	const supervisor = await DelegationSupervisor.open({
		log: sqliteZstdDelegationLog(backend),
		waitSeam: seam,
	});
	// The integration order of the composed stack: the control's release
	// commits through the seam, and the supervisor's projection of the
	// committed decision is synced BEFORE the release ack (the supervisor is
	// a projector of the seam-owned record, never a second writer).
	const base = createDurableSeamControlSeam(seam);
	const control = createReactiveControl({
		prepareRelease: async (request) => {
			const prepared = await base.prepareRelease(request);
			await supervisor.syncWaitDecision(request.wait.waitId);
			return prepared;
		},
		finalizeTool: (prepared) => base.finalizeTool(prepared),
		listPreparedReleases: (query) => base.listPreparedReleases(query),
		flushUrgent: base.flushUrgent?.bind(base),
	});
	return { backend, seam, supervisor, control };
}

function supervisorEntries(backend: SqliteZstdBackend): Array<{ id: string; kind: string; payload: Record<string, unknown>; seq: number }> {
	return backend
		.readDeltaChecked(0, 64 * 1024 * 1024)
		.entries.filter((entry) => isSupervisorKind(entry.kind))
		.map((entry) => ({ id: entry.id, kind: entry.kind, payload: entry.payload as Record<string, unknown>, seq: entry.seq }));
}

function kindsOf(backend: SqliteZstdBackend, kind: string): Array<Record<string, unknown>> {
	return supervisorEntries(backend)
		.filter((entry) => entry.kind === kind)
		.map((entry) => entry.payload);
}

describe('composed: one release, one backgrounded record, one tool-result (both stores)', () => {
	it('releases through the control and converges both writers on one record set', async () => {
		const composed = await compose();
		const { backend, seam, supervisor, control } = composed;

		const spawn = await supervisor.spawnDelegation({
			parentConversationId: 'conv-parent',
			parentRunId: 'run-1',
			toolCallId: 'tc-task-1',
			childSpec: { prompt: 'explore' },
		});
		// The durable wait identity is the spawn's; the seam holds the wait
		// under it (the supervisor anchored it at T_spawn).
		const waitId = spawn.waitId;
		expect(seam.getWait(waitId)?.state).toBe('foreground');

		const handle = control.registerWait({
			parentConversationId: 'conv-parent',
			parentRunId: 'run-1',
			toolCallId: 'tc-task-1',
			stateVersion: 1,
			delegationId: spawn.delegationId,
			waitId: spawn.waitId, // the id the spawn anchored with the authority
		});

		const result = await control.onCommittedSteer({ parentConversationId: 'conv-parent', requestId: 'req-1' });
		expect(result?.released).toHaveLength(1);
		const outcome = await handle.outcome;
		expect(outcome.kind).toBe('backgrounded');

		// EXACTLY one backgrounded entry per waitId across the whole shared
		// log — the seam wrote it; the supervisor projected it (its document
		// is a different kind) instead of writing a second copy.
		const backgrounded = kindsOf(backend, KIND_BACKGROUNDED);
		expect(backgrounded).toHaveLength(1);
		expect(backgrounded[0]).toMatchObject({
			waitId,
			toolCallId: 'tc-task-1',
			operationId: result?.released[0]?.operationId,
		});
		expect(backgrounded[0]?.outcome).toMatchObject({ delegationId: spawn.delegationId, reason: 'owner_input' });

		// EXACTLY one tool-result per toolCallId (T_complete, seam-owned).
		const toolResults = kindsOf(backend, SEAM_ENTRY_KINDS.toolResult);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({ toolCallId: 'tc-task-1' });

		// Both stores agree: the supervisor's projection is backgrounded and
		// the control's prepared outcome is the seam's committed one.
		const record = await supervisor.getDelegation(spawn.delegationId);
		expect(record).toMatchObject({ waitState: 'backgrounded', childState: 'running' });
		// The seam side: the finalized wait LEFT the bounded active projection
		// (its durable state now lives in the tool-result entry below).
		expect(seam.getWait(waitId)).toBeUndefined();
		const releasedRecord = result?.released[0];
		expect(releasedRecord?.prepared?.waitId).toBe(waitId);
		expect(releasedRecord?.finalization).toMatchObject({
			toolCallId: 'tc-task-1',
			outcome: 'background',
			replayed: false,
		});

		// A supervisor detach AFTER the control release converges on the SAME
		// commit: with the control's operationId it is a replay of the
		// recorded outcome; with a foreign one it is refused (irreversible).
		// Either way no second backgrounded entry appears.
		const lateDetach = await supervisor.detachToBackground({
			delegationId: spawn.delegationId,
			reason: 'manual_background',
			operationId: result?.released[0]?.operationId,
		});
		expect(lateDetach.released).toBe(true);
		expect(lateDetach.replayed).toBe(true);
		await expect(
			supervisor.detachToBackground({
				delegationId: spawn.delegationId,
				reason: 'manual_background',
			}),
		).rejects.toMatchObject({ name: 'DelegationNotForegroundError', code: 'DELEGATION_NOT_FOREGROUND' });
		expect(kindsOf(backend, KIND_BACKGROUNDED)).toHaveLength(1);

		// A duplicate steer finds nothing left to release.
		const again = await control.onCommittedSteer({ parentConversationId: 'conv-parent' });
		expect(again).toBeNull();

		// The late child outcome is reporter-delivered (never a second
		// foreground tool result) and keeps ONE completion record.
		const completion = await supervisor.complete({
			delegationId: spawn.delegationId,
			childRunId: 'child-run-1',
			outcome: { status: 'completed', summary: 'done' },
		});
		expect(completion.delivery).toBe('reporter');
		expect(completion.requestId).toBe(`delegation:${spawn.delegationId}:completion:child-run-1`);
		expect(kindsOf(backend, KIND_COMPLETED)).toHaveLength(1);
		// Still exactly one tool-result and one backgrounded record.
		expect(kindsOf(backend, SEAM_ENTRY_KINDS.toolResult)).toHaveLength(1);
		expect(kindsOf(backend, KIND_BACKGROUNDED)).toHaveLength(1);

		await backend.close();
	});

	it('a supervisor detach racing nothing commits the SAME single record the control would', async () => {
		const composed = await compose();
		const { backend, supervisor } = composed;

		const spawn = await supervisor.spawnDelegation({
			parentConversationId: 'conv-parent',
			parentRunId: 'run-1',
			toolCallId: 'tc-task-1',
			childSpec: { prompt: 'explore' },
		});
		const release = await supervisor.detachToBackground({
			delegationId: spawn.delegationId,
			reason: 'timer',
		});
		expect(release.released).toBe(true);

		// Routed through the seam: one backgrounded entry, carrying the
		// supervisor's deterministic operationId — the same record a control
		// release converges on.
		const backgrounded = kindsOf(backend, KIND_BACKGROUNDED);
		expect(backgrounded).toHaveLength(1);
		expect(backgrounded[0]).toMatchObject({
			waitId: spawn.waitId,
			operationId: release.operationId,
		});
		await backend.close();
	});
});
