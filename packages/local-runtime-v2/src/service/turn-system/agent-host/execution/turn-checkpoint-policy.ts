/**
 * Runtime wiring of the SE-SW-002 checkpoint policy into the Agent turn path.
 *
 * The durability primitive is the storage worker's fail-closed
 * `StorageWorker.checkpoint()`; the policy composition lives in
 * `@mavis/storage-worker` (`createCheckpointBarrier`). This module composes
 * that barrier into the two places of a local Turn where work with
 * unrepeatable outcomes starts:
 *
 * - {@link checkpointBeforeLlmCallHook} — a first-position
 *   `beforeLlmCallHook` that flushes (`CheckpointBarrier.beforeLlmRequest`)
 *   BEFORE every provider request. Fail-closed: a barrier failure resolves
 *   with an `abort` decision, which the runner turns into
 *   `before_llm_checkpoint_aborted` — the request is never issued.
 * - {@link withCheckpointPolicy} — wraps the turn's tool catalog so every
 *   tool effect (built-in, configured, delegated/MCP gateway alike) runs
 *   through `CheckpointBarrier.runToolEffect`: flush first, then exactly one
 *   execution. An interrupted call resolves with `TOOL_OUTCOME_UNKNOWN`
 *   (surfaced as a tool error, never fabricated as a result) and the barrier
 *   records the call id, so re-running that call is rejected unless the
 *   composition passes `allowAfterUnknownOutcome` — the explicit recovery
 *   decision the no-auto-retry contract requires.
 *
 * The barrier is optional by composition: without a durable storage worker
 * the turn path behaves exactly as before. When one is provided, a barrier
 * failure surfaces BEFORE the guarded step runs — the request is not issued,
 * the tool effect is not started.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import type { PiBeforeLlmCallHook } from '@mavis/agent-core/pi-turn-runner';
import type {
	RuntimeTool,
	ToolExecutionContext,
	ToolImpl,
	ToolResult,
} from '@mavis/agent-core/tools';
import type { TSchema } from '@sinclair/typebox';
import {
	TOOL_OUTCOME_UNKNOWN,
	createCheckpointBarrier,
	type CheckpointBarrier,
	type StorageWorker,
	type ToolEffect,
} from '@mavis/storage-worker';

export { TOOL_OUTCOME_UNKNOWN };
export type { CheckpointBarrier, StorageWorker };

/**
 * Composes the checkpoint barrier around a storage worker for the turn path.
 * Every durability flush of the policy flows through the storage-worker
 * barrier (fail-closed `worker.checkpoint()`), never around it.
 */
export function turnCheckpointBarrier(worker: StorageWorker): CheckpointBarrier {
	return createCheckpointBarrier(worker);
}

/**
 * First-position before-LLM hook: confirms durability before every provider
 * request of the turn. Fail-closed — a barrier failure aborts the request
 * with the failure as the reason; it is never swallowed.
 */
export function checkpointBeforeLlmCallHook(barrier: CheckpointBarrier): PiBeforeLlmCallHook {
	return async () => {
		try {
			await barrier.beforeLlmRequest();
		} catch (error) {
			return {
				type: 'abort',
				reason: `checkpoint policy: durability barrier failed before the LLM request: ${describeError(error)}`,
			};
		}
		return undefined;
	};
}

/** Options of {@link withCheckpointPolicy}. */
export interface CheckpointToolPolicyOptions {
	/**
	 * The checkpoint barrier driving every effect. Omitted only by
	 * compositions without a durable storage worker: the catalog is then
	 * returned unchanged.
	 */
	readonly barrier?: CheckpointBarrier;
	/**
	 * Abort signal of the enclosing turn. An effect rejected while this signal
	 * is aborted has an unconfirmable outcome and is recorded as
	 * `TOOL_OUTCOME_UNKNOWN` by the barrier.
	 */
	readonly signal?: AbortSignal;
	/**
	 * Explicit recovery decision: allows re-running a call whose earlier
	 * recorded outcome was `TOOL_OUTCOME_UNKNOWN`. Default: forbidden —
	 * the previous attempt may have taken effect already.
	 */
	readonly allowAfterUnknownOutcome?: boolean;
}

/**
 * Wraps the turn's tool catalog so every tool effect runs under the
 * checkpoint barrier (`runToolEffect`): flush BEFORE the effect, exactly one
 * execution, interrupted calls recorded as `TOOL_OUTCOME_UNKNOWN` without
 * auto-retry. Without a barrier the catalog is returned unchanged.
 */
export function withCheckpointPolicy<TCtx extends ToolExecutionContext>(
	tools: readonly RuntimeTool<TSchema, TCtx>[],
	options: CheckpointToolPolicyOptions,
): readonly RuntimeTool<TSchema, TCtx>[] {
	if (!options.barrier) return tools;
	return tools.map((tool) => ({
		...tool,
		impl: checkpointedToolImpl(tool.def.name, tool.impl, options),
	}));
}

function checkpointedToolImpl<TCtx extends ToolExecutionContext>(
	toolName: string,
	impl: ToolImpl<TSchema, TCtx>,
	options: CheckpointToolPolicyOptions,
): ToolImpl<TSchema, TCtx> {
	return {
		async execute(ctx, input, signal, onUpdate) {
			const effect: ToolEffect<ToolResult> = {
				callId: ctx.toolCallId ?? `checkpoint-policy:${ctx.turnId}:${toolName}:${randomUUID()}`,
				toolName,
				// The effect keeps the runner's own abort channel when the
				// composition passed none; the barrier classifies the outcome from
				// `options.signal`.
				run: (effectSignal) => impl.execute(ctx, input, signal ?? effectSignal, onUpdate),
			};
			const outcome = await options.barrier!.runToolEffect(effect, {
				...(options.signal ? { signal: options.signal } : {}),
				...(options.allowAfterUnknownOutcome ? { allowAfterUnknownOutcome: true } : {}),
			});
			if (outcome.outcome === 'completed') return outcome.value;
			if (outcome.outcome === 'failed') throw outcome.error;
			return unknownOutcomeToolResult(effect.callId, toolName);
		},
	};
}

/**
 * The visible form of an interrupted call: an honest tool error carrying the
 * `TOOL_OUTCOME_UNKNOWN` label. The barrier has recorded the call id, so any
 * further attempt of the same call is rejected until recovery is explicit.
 */
function unknownOutcomeToolResult(callId: string, toolName: string): ToolResult {
	const text =
		`Tool call ${callId} (${toolName}) was interrupted before its outcome could be confirmed ` +
		`(${TOOL_OUTCOME_UNKNOWN}). Auto-retry is forbidden by the checkpoint policy: ` +
		'the previous attempt may have taken effect, so re-running this call requires an ' +
		'explicit recovery decision (allowAfterUnknownOutcome).';
	return {
		tool_name: toolName,
		text,
		content: [{ type: 'text', text }],
		isError: true,
		details: {
			checkpointPolicy: { outcome: TOOL_OUTCOME_UNKNOWN, callId, toolName },
		},
	};
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
