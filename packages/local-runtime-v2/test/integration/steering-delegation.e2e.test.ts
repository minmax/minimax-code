/**
 * In-process steering e2e over the REAL sqlite-zstd backend
 * (steering-design-sol.md §6.2 + §6.9, round-1 review fixes 4–5):
 *
 * - §6.2 "реальная проактивность": a child tool held busy (no cooperation
 *   needed), a single `task` blocker, and a committed steer — the span
 *   `Enter (durable saved-ack) → committed release → start of the next
 *   parent provider request` is measured on REAL clocks. The provider
 *   request is a stub started by the caller right after the release
 *   resolves (the composition owns no provider I/O), which is the
 *   in-process structural lower bound of the gate; the asserted budget is
 *   the §6.2 p95 ≤ 500 ms (p99 ≤ 1 s), provider hop excluded — no network
 *   in-process. The saved-ack leg additionally probes §6.1 (p99 ≤ 250 ms).
 * - §6.9 in-process state-machine matrix: exactly one backgrounded record
 *   and one tool-result per waitId across both stores; the child is NOT
 *   restarted; the late child completion arrives reporter-delivered; the
 *   input line walks the committed delivery states; the parent's fence
 *   engages after the release and lifts after the proven child terminal
 *   fact.
 *
 * The wave-3 packages reach this test through the turn-system composition
 * (`delegation-release-composition.ts`) — their first importer outside the
 * four of them.
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';
import { SEAM_ENTRY_KINDS } from '@mavis/durable-seam';
import { KIND_BACKGROUNDED, KIND_COMPLETED } from '@mavis/delegation-supervisor';

import { createDelegationSteeringComposition, type DelegationSteeringComposition } from '../../src/service/turn-system/execution/steering/delegation-release-composition.js';

const directories: string[] = [];
const backends: SqliteZstdBackend[] = [];

afterEach(() => {
	while (backends.length > 0) {
		const backend = backends.pop();
		void backend?.close();
	}
	while (directories.length > 0) {
		const dir = directories.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

/** A gateway fence: engages per conversation, disengages per terminal fact. */
function gatewayFence(): EffectFence & {
	readonly engagedConversations: string[];
	readonly disengagedRefs: Array<{ conversationId: string; reason: string; delegationId: string }>;
	isEngaged(conversationId: string): boolean;
} {
	const engaged = new Set<string>();
	const engagedConversations: string[] = [];
	const disengagedRefs: Array<{ conversationId: string; reason: string; delegationId: string }> = [];
	return {
		engagedConversations,
		disengagedRefs,
		isEngaged(conversationId) {
			return engaged.has(conversationId);
		},
		async engage(request) {
			if (!engaged.has(request.parentConversationId)) {
				engaged.add(request.parentConversationId);
				engagedConversations.push(request.parentConversationId);
			}
			return { status: 'engaged' };
		},
		async disengage(request) {
			for (const ref of request.refs) {
				disengagedRefs.push({
					conversationId: request.parentConversationId,
					reason: request.reason,
					delegationId: ref.delegationId,
				});
			}
			if (!engaged.has(request.parentConversationId)) {
				return { status: 'failed', error: 'not engaged' };
			}
			engaged.delete(request.parentConversationId);
			return { status: 'disengaged' };
		},
	};
}

// Local structural twin (the fence types come from @mavis/steering-control
// through the composition's option surface).
interface EffectFence {
	engage(request: { readonly parentConversationId: string; readonly refs: readonly { delegationId: string }[] }): Promise<{ status: string }>;
	disengage?(request: { readonly parentConversationId: string; readonly reason: string; readonly refs: readonly { delegationId: string }[] }): Promise<{ status: string; error?: string }>;
}

async function compose(fence?: EffectFence): Promise<{ composition: DelegationSteeringComposition; backend: SqliteZstdBackend }> {
	const directory = mkdtempSync(join(tmpdir(), 'steering-e2e-'));
	directories.push(directory);
	const backend = SqliteZstdBackend.open(directory);
	backends.push(backend);
	const composition = await createDelegationSteeringComposition({ backend, effectFence: fence as never });
	return { composition, backend };
}

function kinds(backend: SqliteZstdBackend, kind: string): Array<Record<string, unknown>> {
	return backend
		.readDeltaChecked(0, 512 * 1024 * 1024)
		.entries.filter((entry: { kind: string }) => entry.kind === kind)
		.map((entry: { payload: unknown }) => entry.payload as Record<string, unknown>);
}

const percentile = (values: number[], quantile: number): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))]!;
};

/** The "next parent provider request" stub: its START is what §6.2 measures. */
function startStubProviderRequest(startedAt: number): { readonly startedAt: number } {
	return { startedAt };
}

describe('steering e2e (in-process, real backend) — §6.2 + §6.9', () => {
	it('Enter → committed release → next parent provider request starts before the child finishes', async () => {
		const { composition, backend } = await compose();
		const { supervisor } = composition;

		const iterations = 40;
		const spans: number[] = [];
		const savedAckSpans: number[] = [];

		for (let index = 0; index < iterations; index += 1) {
			const requestId = `steer-req-${index}`;
			const toolCallId = `tc-task-${index}`;

			// T_spawn: the child is held busy — unbounded, no cooperation.
			const spawn = await composition.spawnDelegation({
				parentConversationId: 'conv-parent',
				parentRunId: `run-${index}`,
				toolCallId,
				childSpec: { prompt: 'endless analysis' },
			});
			const handle = composition.registerWait(spawn, {
				parentConversationId: 'conv-parent',
				parentRunId: `run-${index}`,
				toolCallId,
			});

			// Enter: optimistic row → durable saved-ack (§6.1 probe).
			const enterStarted = performance.now();
			const inputId = `input-${index}`;
			composition.delivery.register(inputId, {
				requestId,
				conversationId: 'conv-parent',
				target: { conversationId: 'conv-parent', kind: 'parent' },
				whenBusy: 'steer',
			});
			const saved = await composition.acceptOwnerInput({
				conversationId: 'conv-parent',
				requestId,
				content: { text: 'switch to background' },
				whenBusy: 'steer',
			});
			expect(saved.status).toBe('committed');
			const savedDone = performance.now();
			savedAckSpans.push(savedDone - enterStarted);

			// Committed steer → release → the parent starts its next provider
			// request (started, not awaited — §6.2 measures the START).
			const release = await composition.onCommittedSteer({ parentConversationId: 'conv-parent', requestId });
			expect(release?.released).toHaveLength(1);
			const provider = startStubProviderRequest(performance.now());
			spans.push(provider.startedAt - enterStarted);

			// The wait settled exactly once, as backgrounded, child untouched.
			const outcome = await handle.outcome;
			expect(outcome.kind).toBe('backgrounded');
			expect(handle.isSettled()).toBe(true);
		}

		// §6.2: Enter → start of the next parent provider request.
		expect(percentile(spans, 0.95)).toBeLessThanOrEqual(500);
		expect(percentile(spans, 0.99)).toBeLessThanOrEqual(1000);
		// §6.1 probe: the saved-ack leg on the real backend.
		expect(percentile(savedAckSpans, 0.95)).toBeLessThanOrEqual(100);
		expect(percentile(savedAckSpans, 0.99)).toBeLessThanOrEqual(250);

		// §6.9 invariants over the whole matrix: per iteration exactly one
		// spawn, one wait anchor, one backgrounded record, one tool-result —
		// and the child was never restarted.
		expect(kinds(backend, 'mcode.delegation.spawned')).toHaveLength(iterations);
		expect(kinds(backend, 'mcode.delegation.wait-opened')).toHaveLength(iterations);
		expect(kinds(backend, KIND_BACKGROUNDED)).toHaveLength(iterations);
		expect(kinds(backend, SEAM_ENTRY_KINDS.toolResult)).toHaveLength(iterations);
		const record = await supervisor.getDelegation(
			(kinds(backend, 'mcode.delegation.spawned')[0] as { delegationId: string }).delegationId,
		);
		expect(record).toMatchObject({ waitState: 'backgrounded' });

		await composition.close();
	});

	it('the single outcome, delivery projection and fence lifecycle follow §2/§4 end-to-end', async () => {
		const fence = gatewayFence();
		const { composition, backend } = await compose(fence);
		const { supervisor } = composition;

		const spawn = await composition.spawnDelegation({
			parentConversationId: 'conv-parent',
			parentRunId: 'run-1',
			toolCallId: 'tc-task-1',
			childSpec: { prompt: 'explore' },
		});
		const handle = composition.registerWait(spawn, {
			parentConversationId: 'conv-parent',
			parentRunId: 'run-1',
			toolCallId: 'tc-task-1',
		});

		// Enter + release through the composed control.
		const saved = await composition.acceptOwnerInput({
			conversationId: 'conv-parent',
			requestId: 'steer-1',
			content: { text: 'to background' },
			whenBusy: 'steer',
		});
		composition.delivery.register(saved.inputEntryId, {
			requestId: 'steer-1',
			conversationId: 'conv-parent',
			target: { conversationId: 'conv-parent', kind: 'parent' },
			whenBusy: 'steer',
		});
		composition.delivery.transition(saved.inputEntryId, 'saved', {
			submissionId: saved.submissionId,
			receiptEntryId: saved.inputEntryId,
			commitSeq: saved.commitSeq,
		});
		const release = await composition.onCommittedSteer({ parentConversationId: 'conv-parent', requestId: 'steer-1' });
		expect(release?.released).toHaveLength(1);
		expect(await handle.outcome).toMatchObject({ kind: 'backgrounded' });

		// §4: the fence engaged for the parent conversation after the release.
		expect(fence.isEngaged('conv-parent')).toBe(true);
		expect(fence.engagedConversations).toEqual(['conv-parent']);

		// One input line, saved, one row (projection of committed states).
		const projection = composition.delivery.get(saved.inputEntryId);
		expect(projection.state).toBe('saved');
		expect(projection.active).toBe(true);
		expect(composition.delivery.active()).toHaveLength(1);

		// The child finishes LATE: reporter delivery (never a second tool
		// result), and the fence lifts on the PROVEN terminal fact (§4/§5).
		const completion = await supervisor.complete({
			delegationId: spawn.delegationId,
			childRunId: 'child-run-1',
			outcome: { status: 'completed', summary: 'done' },
		});
		expect(completion.delivery).toBe('reporter');
		expect(completion.fence).toEqual({ status: 'disengaged' });
		expect(fence.disengagedRefs).toEqual([
			{ conversationId: 'conv-parent', reason: 'child_completed', delegationId: spawn.delegationId },
		]);
		expect(fence.isEngaged('conv-parent')).toBe(false);

		expect(kinds(backend, KIND_COMPLETED)).toHaveLength(1);
		expect(kinds(backend, KIND_BACKGROUNDED)).toHaveLength(1);
		expect(kinds(backend, SEAM_ENTRY_KINDS.toolResult)).toHaveLength(1);

		// §6.4 zero-loss probe: the committed input replays verbatim from the
		// durable log — a freshly recovered stack over the SAME store answers
		// a repeat of Enter with the ORIGINAL commit.
		const fresh = await createDelegationSteeringComposition({ backend, effectFence: fence as never });
		const replay = await fresh.acceptOwnerInput({
			conversationId: 'conv-parent',
			requestId: 'steer-1',
			content: { text: 'to background' },
			whenBusy: 'steer',
		});
		expect(replay.status).toBe('replayed');
		expect(replay.inputEntryId).toBe(saved.inputEntryId);
		await fresh.close();

		await composition.close();
	});
});
