import { describe, expect, it } from 'vitest';
import type { TSchema } from '@sinclair/typebox';

import type {
	RuntimeTool,
	ToolExecutionContext,
	ToolResult,
} from '@mavis/agent-core/tools';
import type { Commit, StorageWorker } from '@mavis/storage-worker';
import {
	TOOL_OUTCOME_UNKNOWN,
	checkpointBeforeLlmCallHook,
	turnCheckpointBarrier,
	withCheckpointPolicy,
} from './turn-checkpoint-policy.js';

interface FakeWorkerTrace {
	readonly checkpointCalls: string[];
	/** When set, every `checkpoint` rejects with this error. */
	readonly checkpointError?: Error;
}

function fakeStorageWorker(trace: FakeWorkerTrace): StorageWorker {
	return {
		enqueue: async () => undefined,
		flush: async (): Promise<Commit | null> => null,
		checkpoint: async () => {
			trace.checkpointCalls.push('checkpoint');
			if (trace.checkpointError) throw trace.checkpointError;
		},
		quarantined: [],
		dispose: async () => undefined,
	};
}

interface ToolTrace {
	readonly executions: string[];
	impl?: (ctx: ToolExecutionContext) => Promise<ToolResult> | ToolResult;
}

function fakeTool(trace: ToolTrace, name = 'echo'): RuntimeTool<TSchema, ToolExecutionContext> {
	return {
		def: {
			name,
			description: `${name} fake tool`,
			schema: { type: 'object' } as never,
		},
		impl: {
			execute: async (ctx) => {
				trace.executions.push(`${name}:${ctx.toolCallId ?? 'no-call-id'}`);
				if (trace.impl) return await trace.impl(ctx);
				return { tool_name: name, text: 'ok', content: [{ type: 'text', text: 'ok' }] };
			},
		},
	};
}

function toolContext(toolCallId?: string): ToolExecutionContext {
	return { sessionId: 's1', turnId: 't1', ...(toolCallId ? { toolCallId } : {}) };
}

describe('turnCheckpointBarrier', () => {
	it('flushes through the storage worker barrier (fail-closed checkpoint)', async () => {
		const trace: FakeWorkerTrace = { checkpointCalls: [] };
		const barrier = turnCheckpointBarrier(fakeStorageWorker(trace));
		await barrier.beforeLlmRequest();
		await barrier.beforeToolEffect('echo');
		expect(trace.checkpointCalls).toEqual(['checkpoint', 'checkpoint']);
	});

	it('propagates a barrier failure (never fabricates durability)', async () => {
		const barrier = turnCheckpointBarrier(
			fakeStorageWorker({
				checkpointCalls: [],
				checkpointError: new Error('backend sealed'),
			}),
		);
		await expect(barrier.beforeLlmRequest()).rejects.toThrow('backend sealed');
	});
});

describe('checkpointBeforeLlmCallHook', () => {
	it('returns no decision when the barrier confirms durability', async () => {
		const hook = checkpointBeforeLlmCallHook(
			turnCheckpointBarrier(fakeStorageWorker({ checkpointCalls: [] })),
		);
		expect(await hook({ sessionId: 's1', turnId: 't1', phase: 'initial' } as never)).toBe(
			undefined,
		);
	});

	it('aborts the provider request when the barrier fails (fail-closed)', async () => {
		const hook = checkpointBeforeLlmCallHook(
			turnCheckpointBarrier(
				fakeStorageWorker({
					checkpointCalls: [],
					checkpointError: new Error('worker gone'),
				}),
			),
		);
		const decision = await hook({ sessionId: 's1', turnId: 't1', phase: 'iteration' } as never);
		expect(decision).toMatchObject({ type: 'abort' });
		if (decision?.type === 'abort') {
			expect(decision.reason).toContain('checkpoint policy');
			expect(decision.reason).toContain('worker gone');
		}
	});
});

describe('withCheckpointPolicy', () => {
	it('returns the catalog unchanged without a barrier', () => {
		const trace: ToolTrace = { executions: [] };
		const tools = [fakeTool(trace)];
		expect(withCheckpointPolicy(tools, {})).toBe(tools);
	});

	it('flushes before the effect and passes the completed value through', async () => {
		const workerTrace: FakeWorkerTrace = { checkpointCalls: [] };
		const toolTrace: ToolTrace = { executions: [] };
		const [tool] = withCheckpointPolicy([fakeTool(toolTrace)], {
			barrier: turnCheckpointBarrier(fakeStorageWorker(workerTrace)),
		});
		const result = await tool.impl.execute(toolContext('call-1'), {});
		expect(result.text).toBe('ok');
		// Barrier strictly before the effect: the intent must be durable first.
		expect(workerTrace.checkpointCalls).toEqual(['checkpoint']);
		expect(toolTrace.executions).toEqual(['echo:call-1']);
	});

	it('rethrows a definitive tool failure without recording an unknown outcome', async () => {
		const failure = new Error('definitive failure');
		const toolTrace: ToolTrace = { executions: [], impl: () => Promise.reject(failure) };
		const barrier = turnCheckpointBarrier(fakeStorageWorker({ checkpointCalls: [] }));
		const [tool] = withCheckpointPolicy([fakeTool(toolTrace)], { barrier });
		await expect(tool.impl.execute(toolContext('call-1'), {})).rejects.toBe(failure);
		expect(barrier.unknownOutcomeCallIds).toEqual([]);
	});

	it('maps an interrupted call to TOOL_OUTCOME_UNKNOWN without a retry', async () => {
		const controller = new AbortController();
		controller.abort();
		const toolTrace: ToolTrace = {
			executions: [],
			impl: () => Promise.reject(new Error('aborted mid-flight')),
		};
		const barrier = turnCheckpointBarrier(fakeStorageWorker({ checkpointCalls: [] }));
		const [tool] = withCheckpointPolicy([fakeTool(toolTrace)], { barrier, signal: controller.signal });
		const result = await tool.impl.execute(toolContext('call-1'), {});
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			checkpointPolicy: { outcome: TOOL_OUTCOME_UNKNOWN, callId: 'call-1', toolName: 'echo' },
		});
		expect(result.text).toContain(TOOL_OUTCOME_UNKNOWN);
		expect(barrier.unknownOutcomeCallIds).toEqual(['call-1']);
		expect(toolTrace.executions).toEqual(['echo:call-1']);
	});

	it('forbids an implicit re-run of a call with an unknown outcome', async () => {
		const controller = new AbortController();
		controller.abort();
		const toolTrace: ToolTrace = {
			executions: [],
			impl: () => Promise.reject(new Error('aborted mid-flight')),
		};
		const barrier = turnCheckpointBarrier(fakeStorageWorker({ checkpointCalls: [] }));
		const [tool] = withCheckpointPolicy([fakeTool(toolTrace)], { barrier, signal: controller.signal });
		await tool.impl.execute(toolContext('call-1'), {});
		// A second attempt of the same call (turn-level retry re-issues the same
		// tool-call id) must never run implicitly.
		await expect(tool.impl.execute(toolContext('call-1'), {})).rejects.toThrow(
			/auto-retry is forbidden|unknown outcome/,
		);
		expect(toolTrace.executions).toEqual(['echo:call-1']);
	});

	it('allows an explicit recovery re-run with allowAfterUnknownOutcome', async () => {
		const controller = new AbortController();
		controller.abort();
		let attempts = 0;
		const toolTrace: ToolTrace = {
			executions: [],
			impl: () => {
				attempts += 1;
				return attempts === 1
					? Promise.reject(new Error('aborted mid-flight'))
					: Promise.resolve({ tool_name: 'echo', text: 'recovered', content: [] });
			},
		};
		const barrier = turnCheckpointBarrier(fakeStorageWorker({ checkpointCalls: [] }));
		const [tool] = withCheckpointPolicy([fakeTool(toolTrace)], {
			barrier,
			signal: controller.signal,
			allowAfterUnknownOutcome: true,
		});
		await tool.impl.execute(toolContext('call-1'), {});
		const result = await tool.impl.execute(toolContext('call-1'), {});
		expect(result.text).toBe('recovered');
		expect(barrier.unknownOutcomeCallIds).toEqual([]);
	});

	it('keeps effects runnable without a provider call id (synthetic identity)', async () => {
		const toolTrace: ToolTrace = { executions: [] };
		const barrier = turnCheckpointBarrier(fakeStorageWorker({ checkpointCalls: [] }));
		const [tool] = withCheckpointPolicy([fakeTool(toolTrace)], { barrier });
		const result = await tool.impl.execute(toolContext(), {});
		expect(result.text).toBe('ok');
		expect(toolTrace.executions).toEqual(['echo:no-call-id']);
		expect(barrier.unknownOutcomeCallIds).toEqual([]);
	});

	it('fails closed: a barrier failure prevents the effect from starting', async () => {
		const toolTrace: ToolTrace = { executions: [] };
		const barrier = turnCheckpointBarrier(
			fakeStorageWorker({
				checkpointCalls: [],
				checkpointError: new Error('flush failed'),
			}),
		);
		const [tool] = withCheckpointPolicy([fakeTool(toolTrace)], { barrier });
		await expect(tool.impl.execute(toolContext('call-1'), {})).rejects.toThrow('flush failed');
		expect(toolTrace.executions).toEqual([]);
	});
});
