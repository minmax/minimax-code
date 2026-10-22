/**
 * Runtime wiring of the durability checkpoint policy (SE-SW-002).
 *
 * The barrier primitive itself lives on the worker
 * (`StorageWorker.checkpoint()` — fail-closed drain + backend flush); this
 * module composes it into the agent turn path, per the checkpoint policy of
 * `final-architecture.md`:
 *
 * - `beforeLlmRequest()` — fail-closed flush BEFORE every LLM request;
 * - `beforeToolEffect()` — fail-closed flush BEFORE every tool effect
 *   (nested codemode/MCP calls go through the same gateway);
 * - `runToolEffect()` — runs one effect under the barrier and maps an
 *   interrupted call to {@link TOOL_OUTCOME_UNKNOWN} WITHOUT auto-retry:
 *   the effect may or may not have taken place, so re-running it is only
 *   allowed as an explicit recovery decision
 *   (`allowAfterUnknownOutcome`).
 *
 * The barrier never fabricates durability: every flush failure propagates to
 * the caller BEFORE the guarded step runs (the LLM request is not issued, the
 * tool effect is not started).
 *
 * @module
 */

import { TOOL_OUTCOME_UNKNOWN, type StorageWorker, type ToolEffectOutcome } from './contracts.js';

/** One tool call driven through the checkpoint barrier. */
export interface ToolEffect<A = unknown> {
	/**
	 * Stable identity of the call (the tool-call id of the turn). The barrier
	 * uses it to enforce the no-auto-retry contract across attempts.
	 */
	readonly callId: string;
	/** Tool name, for diagnostics in barrier errors. */
	readonly toolName: string;
	/**
	 * Runs the effect. Implementations must honor the abort signal: an aborted
	 * effect rejects, and the barrier records
	 * {@link TOOL_OUTCOME_UNKNOWN} for the call.
	 */
	run(signal: AbortSignal): Promise<A>;
}

export interface RunToolEffectOptions {
	/** Abort signal of the enclosing turn/request. */
	readonly signal?: AbortSignal;
	/**
	 * Required `true` to run a call whose earlier recorded outcome was
	 * {@link TOOL_OUTCOME_UNKNOWN}. This is the explicit recovery decision the
	 * no-auto-retry contract asks for: the caller accepts that the previous
	 * attempt may have taken effect.
	 */
	readonly allowAfterUnknownOutcome?: boolean;
}

/** Barrier between the durable write path and the agent turn path. */
export interface CheckpointBarrier {
	/**
	 * Fail-closed flush before an LLM request: drains every enqueued entry and
	 * calls `backend.checkpoint()`. Rejects when durability cannot be
	 * confirmed — the request must not be issued.
	 */
	beforeLlmRequest(): Promise<void>;
	/**
	 * Fail-closed flush before a tool effect: the committed intent (and every
	 * earlier entry) must be durable before the tool may touch the world.
	 * Nested codemode/MCP calls go through the same barrier.
	 */
	beforeToolEffect(toolName: string): Promise<void>;
	/**
	 * Runs one tool effect under the barrier: flushes
	 * (`beforeToolEffect`), then runs the effect exactly once, then maps the
	 * outcome. Never retries: an interrupted call resolves with
	 * {@link TOOL_OUTCOME_UNKNOWN}, and a later attempt with the same
	 * `callId` rejects unless `allowAfterUnknownOutcome` is set.
	 */
	runToolEffect<A>(effect: ToolEffect<A>, options?: RunToolEffectOptions): Promise<ToolEffectOutcome<A>>;
	/** Call ids whose last recorded outcome was {@link TOOL_OUTCOME_UNKNOWN}. */
	readonly unknownOutcomeCallIds: readonly string[];
}

/**
 * Composes the checkpoint policy around a storage worker. The worker handle
 * stays on the caller's thread; the barrier only drives its fail-closed
 * `checkpoint()`.
 */
export function createCheckpointBarrier(worker: StorageWorker): CheckpointBarrier {
	const unknownOutcome = new Set<string>();

	return {
		beforeLlmRequest: () => worker.checkpoint(),
		beforeToolEffect: () => worker.checkpoint(),

		async runToolEffect<A>(effect: ToolEffect<A>, options: RunToolEffectOptions = {}): Promise<ToolEffectOutcome<A>> {
			if (unknownOutcome.has(effect.callId) && options.allowAfterUnknownOutcome !== true) {
				// No-auto-retry contract: a call with an unconfirmed outcome is
				// never re-run implicitly — the previous attempt may have taken
				// effect already.
				throw new Error(
					`tool call ${effect.callId} (${effect.toolName}) has an unknown outcome; ` +
						'auto-retry is forbidden by the checkpoint policy — pass ' +
						'allowAfterUnknownOutcome to accept the risk explicitly',
				);
			}
			// Fail-closed barrier BEFORE the effect: everything enqueued so far
			// (including the call's intent entry) must be durable first. A barrier
			// failure propagates and the effect is never started.
			await worker.checkpoint();

			const controller = new AbortController();
			const signal = options.signal ?? controller.signal;
			try {
				const value = await effect.run(signal);
				unknownOutcome.delete(effect.callId);
				return { outcome: 'completed', value };
			} catch (error) {
				if (signal.aborted) {
					// Interrupted: the effect may or may not have taken place.
					// Record the unknown outcome — never retry implicitly.
					unknownOutcome.add(effect.callId);
					return { outcome: TOOL_OUTCOME_UNKNOWN };
				}
				unknownOutcome.delete(effect.callId);
				return {
					outcome: 'failed',
					error: error instanceof Error ? error : new Error(String(error)),
				};
			}
		},

		get unknownOutcomeCallIds(): readonly string[] {
			return [...unknownOutcome];
		},
	};
}
