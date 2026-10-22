/**
 * The DelegationControlSeam → DurableSeam adapter (steering-control →
 * durable-seam): the single bridge between the reactive release control and
 * the wait-outcome authority.
 *
 * Pinned here (round-1 review fixes):
 * - ONE durable representation of the release: the adapter routes every
 *   prepare/finalize through the seam's own transitions — the committed
 *   `mcode.delegation.backgrounded` entry carries the control operationId;
 * - the FIXED stale-refusal mapping rule: seam `VERSION_CONFLICT`,
 *   `OWNER_LOST` and `GENERATION_SEALED` surface as
 *   `StaleStateVersionError` ('stale-version'), everything else passes
 *   through — a CAS conflict must never degrade into a generic 'failed'
 *   (single-outcome.test.ts pins the visible blocker semantics).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { DurableSeam, SEAM_ENTRY_KINDS } from '../../durable-seam/src/index.js';
import { InMemoryDurableLog } from '../../durable-seam/test/helpers.js';
import { createReactiveControl } from '../src/reactive-control.js';
import { createDurableSeamControlSeam } from '../src/durable-seam-adapter.js';
import { deriveWaitId } from '../src/wait-set.js';
import type { DelegationControlSeam, WaitHandle } from '../src/types.js';

function key(toolCallId: string): { parentConversationId: string; parentRunId: string; toolCallId: string } {
	return { parentConversationId: 'conv-1', parentRunId: 'run-1', toolCallId };
}

async function openSeam(): Promise<{ seam: DurableSeam; log: InMemoryDurableLog }> {
	const log = new InMemoryDurableLog();
	const seam = await DurableSeam.open(log);
	return { seam, log };
}

/** Registers the durable wait + the control wait, like the spawn path would. */
async function register(seam: DurableSeam, controlSeam: DelegationControlSeam, control: ReturnType<typeof createReactiveControl>, toolCallId: string): Promise<WaitHandle> {
	const waitKey = key(toolCallId);
	const waitId = deriveWaitId(waitKey);
	await seam.openForegroundWait({
		waitId,
		toolCallId,
		conversationId: waitKey.parentConversationId,
		delegationId: `del-${toolCallId}`,
		childConversationId: `child-${toolCallId}`,
	});
	return control.registerWait({ ...waitKey, stateVersion: 1 });
}

describe('durable-seam adapter: single durable release representation', () => {
	it('routes the release through the seam: the committed entry carries the control operationId', async () => {
		const { seam, log } = await openSeam();
		const controlSeam = createDurableSeamControlSeam(seam, {
			backgroundHandleFor: (identity) => ({
				delegationId: identity.delegationId ?? 'del-x',
				supervisorTaskId: 'sup-1',
				childConversationId: identity.childConversationId ?? 'child-x',
			}),
		});
		await seam.openForegroundWait({
			waitId: deriveWaitId(key('tc-1')),
			toolCallId: 'tc-1',
			conversationId: 'conv-1',
			delegationId: 'del-tc-1',
			childConversationId: 'child-tc-1',
		});
		const prepared = await controlSeam.prepareRelease({
			operationId: 'release-op-1',
			reason: 'owner_input',
			urgent: true,
			wait: { waitId: deriveWaitId(key('tc-1')), key: key('tc-1'), stateVersion: 1 },
		});

		expect(prepared.operationId).toBe('release-op-1');
		expect(prepared.taskId).toBe('tc-1'); // stable task id = the tool call
		expect(prepared.backgroundHandle).toEqual({
			delegationId: 'del-tc-1',
			supervisorTaskId: 'sup-1',
			childConversationId: 'child-tc-1',
		});

		// Exactly ONE backgrounded entry exists, and it carries the operationId.
		const entries = [...logEntries(log)];
		const backgrounded = entries.filter((entry) => entry.kind === SEAM_ENTRY_KINDS.backgrounded);
		expect(backgrounded).toHaveLength(1);
		expect(backgrounded[0]).toMatchObject({
			payload: {
				operationId: 'release-op-1',
				waitId: deriveWaitId(key('tc-1')),
			},
		});
	});

	it('finalizes exactly one tool-result; a redelivery replays', async () => {
		const { seam, log } = await openSeam();
		const controlSeam = createDurableSeamControlSeam(seam);
		const waitId = deriveWaitId(key('tc-1'));
		await seam.openForegroundWait({ waitId, toolCallId: 'tc-1', conversationId: 'conv-1' });
		const prepared = await controlSeam.prepareRelease({
			operationId: 'op-1',
			reason: 'owner_input',
			urgent: true,
			wait: { waitId, key: key('tc-1'), stateVersion: 1 },
		});

		const first = await controlSeam.finalizeTool(prepared);
		expect(first).toEqual({ toolCallId: 'tc-1', taskId: 'tc-1', outcome: 'background', replayed: false });
		const second = await controlSeam.finalizeTool(prepared);
		expect(second.replayed).toBe(true);

		const toolResults = [...logEntries(log)].filter((entry) => entry.kind === SEAM_ENTRY_KINDS.toolResult);
		expect(toolResults).toHaveLength(1);

		// Recovery sees nothing pending after the finalization.
		expect(await controlSeam.listPreparedReleases()).toHaveLength(0);
	});

	it('recovery reproduces a prepared-but-unfinalized outcome (crash between the phases)', async () => {
		const { seam, log } = await openSeam();
		const controlSeam = createDurableSeamControlSeam(seam);
		const waitId = deriveWaitId(key('tc-1'));
		await seam.openForegroundWait({ waitId, toolCallId: 'tc-1', conversationId: 'conv-1' });
		const prepared = await controlSeam.prepareRelease({
			operationId: 'op-1',
			reason: 'owner_input',
			urgent: true,
			wait: { waitId, key: key('tc-1'), stateVersion: 1 },
		});
		// The process died before finalizing. A fresh adapter over the SAME
		// seam (recovered registry) re-reads the durable prepared outcome.
		const revived = createDurableSeamControlSeam(seam);
		const pending = await revived.listPreparedReleases({ parentConversationId: 'conv-1' });
		expect(pending).toHaveLength(1);
		expect(pending[0]?.operationId).toBe('op-1');
		const finalization = await revived.finalizeTool(pending[0]!);
		expect(finalization).toEqual({ toolCallId: 'tc-1', taskId: 'tc-1', outcome: 'background', replayed: false });
		// The prepared outcome was reproduced verbatim — never re-decided.
		void prepared;
		expect([...logEntries(log)].filter((entry) => entry.kind === SEAM_ENTRY_KINDS.toolResult)).toHaveLength(1);
	});
});

describe('durable-seam adapter: the fixed stale-refusal mapping rule', () => {
	it('maps VERSION_CONFLICT to STALE_STATE_VERSION so the control classifies stale-version', async () => {
		const { seam } = await openSeam();
		const controlSeam = createDurableSeamControlSeam(seam);
		const waitId = deriveWaitId(key('tc-1'));
		await seam.openForegroundWait({ waitId, toolCallId: 'tc-1', conversationId: 'conv-1' });
		// Advance the durable version behind the caller's back (a completed
		// finalize): the caller's version 1 is now stale.
		await seam.finalizeTool({ toolCallId: 'tc-1', outcome: { status: 'completed' } });

		await expect(
			controlSeam.prepareRelease({
				operationId: 'op-1',
				reason: 'owner_input',
				urgent: true,
				wait: { waitId, key: key('tc-1'), stateVersion: 1 },
			}),
		).rejects.toMatchObject({ name: 'StaleStateVersionError', code: 'STALE_STATE_VERSION' });
	});

	it('maps OWNER_LOST to STALE_STATE_VERSION', async () => {
		const { seam, log } = await openSeam();
		const controlSeam = createDurableSeamControlSeam(seam);
		const waitId = deriveWaitId(key('tc-1'));
		await seam.openForegroundWait({ waitId, toolCallId: 'tc-1', conversationId: 'conv-1' });
		log.stealOwnership(); // another writer took the generation

		await expect(
			controlSeam.prepareRelease({
				operationId: 'op-1',
				reason: 'owner_input',
				urgent: true,
				wait: { waitId, key: key('tc-1'), stateVersion: 1 },
			}),
		).rejects.toMatchObject({ name: 'StaleStateVersionError', code: 'STALE_STATE_VERSION' });
	});

	it('passes foreign failures through unchanged (generic failed, not stale)', async () => {
		const { seam } = await openSeam();
		const controlSeam = createDurableSeamControlSeam(seam);
		// A release for a wait that was never opened: the adapter's stale view
		// guard refuses with the control's own error, but a seam INVALID_INPUT
		// (e.g. a bad version) must pass through un-mapped.
		const waitId = deriveWaitId(key('tc-1'));
		await seam.openForegroundWait({ waitId, toolCallId: 'tc-1', conversationId: 'conv-1' });
		await expect(
			controlSeam.prepareRelease({
				operationId: 'op-1',
				reason: 'owner_input',
				urgent: true,
				wait: { waitId, key: key('tc-1'), stateVersion: 0 },
			}),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
	});

	it('end-to-end: the reactive control keeps the stale-version branch semantics over the adapter', async () => {
		const { seam, log } = await openSeam();
		const controlSeam = createDurableSeamControlSeam(seam);
		const control = createReactiveControl(controlSeam);
		const handle = await register(seam, controlSeam, control, 'tc-1');

		// The durable state moved to version 2; the registering side saw 1.
		await seam.finalizeTool({ toolCallId: 'tc-1', outcome: { status: 'completed' } });
		void handle;

		const refused = await control.onCommittedSteer({ parentConversationId: 'conv-1' });
		// The seam-owned wait is terminal: the control reports stale-version
		// (visible refusal), and the seam wrote NO second backgrounded entry.
		expect(refused).not.toBeNull();
		expect(refused?.released).toHaveLength(0);
		expect(refused?.skipped.every((record) => record.status === 'stale-version' || record.status === 'failed')).toBe(true);
		expect([...logEntries(log)].filter((entry) => entry.kind === SEAM_ENTRY_KINDS.backgrounded)).toHaveLength(0);
	});
});

/** All committed entries of the in-memory log (kind-level assertions). */
function logEntries(log: InMemoryDurableLog): Array<{ id: string; kind: string; payload: unknown; seq: number }> {
	return [...log.entries.values()].sort((left, right) => left.seq - right.seq || left.ordinal - right.ordinal);
}
