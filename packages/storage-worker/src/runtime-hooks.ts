/**
 * Runtime hooks of the checkpoint policy (SE-SW-002): the turn-path wiring
 * over the storage-worker API.
 *
 * `createCheckpointBarrier` (checkpoint-policy.ts) is the durability
 * primitive; this module composes it into the runtime's turn loop at the two
 * places where work with unrepeatable outcomes happens, keyed by the
 * runtime's call markers:
 *
 * - {@link CheckpointPolicyRuntime.emitLlmStepResult} — fail-closed
 *   `worker.checkpoint()` BEFORE the result of an LLM step is emitted; a
 *   barrier failure prevents the emit entirely (an LLM step has no world
 *   effect, so not emitting is the honest outcome);
 * - {@link CheckpointPolicyRuntime.runToolEffect} — fail-closed
 *   `worker.checkpoint()` BEFORE each tool effect (identified by its call
 *   marker), exactly one execution, and {@link TOOL_OUTCOME_UNKNOWN} for
 *   every call whose outcome cannot be confirmed.
 *
 * Fail-closed mapping (the difference from the raw barrier): when the
 * barrier cannot confirm the batch BEFORE an effect (uncommitted entries,
 * backend unavailable), the wrapper never throws into the turn loop and
 * never starts the effect — the call is recorded and reported as
 * {@link TOOL_OUTCOME_UNKNOWN} (`interrupted-call policy: "Прерванный вызов
 * получает TOOL_OUTCOME_UNKNOWN без автоповтора"`). Such a call is never
 * re-run implicitly: a later attempt with the same call marker is rejected
 * unless the composition passes `allowAfterUnknownOutcome` — the explicit
 * recovery decision.
 *
 * @module
 */

import {
	TOOL_OUTCOME_UNKNOWN,
	type StorageWorker,
	type ToolEffectOutcome,
} from './contracts.js';
import {
	createCheckpointBarrier,
	type CheckpointBarrier,
	type RunToolEffectOptions,
	type ToolEffect,
} from './checkpoint-policy.js';

/**
 * The runtime's marker of one tool effect call: the stable call identity the
 * barrier keys its no-auto-retry record on.
 */
export interface EffectCallMarker {
	/** Stable identity of the call (the tool-call id of the turn). */
	readonly callId: string;
	/** Tool name, for diagnostics. */
	readonly toolName: string;
}

/** The runtime's marker of one LLM step whose result is about to be emitted. */
export interface LlmStepMarker {
	/** Stable identity of the step, for diagnostics in barrier errors. */
	readonly stepId: string;
}

/** Why a call's outcome could not be confirmed. */
export type UnknownOutcomeReason =
	/** The effect was aborted mid-flight; it may or may not have taken place. */
	| 'interrupted'
	/** The fail-closed barrier could not confirm the batch before the effect. */
	| 'barrier-failed';

/** Observability payload of {@link CheckpointRuntimePolicy.onUnknownOutcome}. */
export interface UnknownOutcomeInfo {
	readonly reason: UnknownOutcomeReason;
	/** The barrier failure; present only for `reason: 'barrier-failed'`. */
	readonly error?: Error;
}

/** Composition knobs of {@link withCheckpointPolicy}. */
export interface CheckpointRuntimePolicy {
	/**
	 * Called whenever a call's outcome is reported as
	 * {@link TOOL_OUTCOME_UNKNOWN} — interrupted mid-flight, or the fail-closed
	 * barrier found an uncommitted batch. Observability only: it can never
	 * change the reported outcome.
	 */
	readonly onUnknownOutcome?: (marker: EffectCallMarker, info: UnknownOutcomeInfo) => void;
}

/** Turn-path facade returned by {@link withCheckpointPolicy}. */
export interface CheckpointPolicyRuntime {
	/** The wrapped worker: the runtime enqueues its session entries here. */
	readonly worker: StorageWorker;
	/** The underlying barrier (for compositions that need its raw surface). */
	readonly barrier: CheckpointBarrier;
	/**
	 * Emits the result of one LLM step under the barrier: fail-closed
	 * `worker.checkpoint()` first, then `emit`. A barrier failure propagates
	 * (naming the step) and the result is never emitted on an unconfirmed
	 * batch.
	 */
	emitLlmStepResult<T>(step: LlmStepMarker, emit: () => T | Promise<T>): Promise<T>;
	/**
	 * Runs one tool effect under the barrier, keyed by its call marker:
	 * fail-closed `worker.checkpoint()` BEFORE the effect, exactly one
	 * execution, and {@link TOOL_OUTCOME_UNKNOWN} whenever the outcome cannot
	 * be confirmed (interrupted mid-flight, or the barrier found an
	 * uncommitted batch — the effect is then never started). Never retries:
	 * a later attempt with the same marker rejects unless
	 * `allowAfterUnknownOutcome` is set.
	 */
	runToolEffect<T>(
		marker: EffectCallMarker,
		run: (signal: AbortSignal) => Promise<T>,
		options?: RunToolEffectOptions,
	): Promise<ToolEffectOutcome<T>>;
	/**
	 * Call markers whose last recorded outcome is {@link TOOL_OUTCOME_UNKNOWN}
	 * — interrupted mid-flight or blocked by a failed barrier.
	 */
	readonly unknownOutcomeCallIds: readonly string[];
}

/**
 * Composes the checkpoint policy over a storage worker for the runtime turn
 * path. Every durability flush flows through the worker's fail-closed
 * `checkpoint()` (via {@link createCheckpointBarrier}), never around it.
 */
export function withCheckpointPolicy(
	worker: StorageWorker,
	policy: CheckpointRuntimePolicy = {},
): CheckpointPolicyRuntime {
	const barrier = createCheckpointBarrier(worker);
	// Call ids whose effect never started because the barrier could not
	// confirm the batch first. The barrier records only calls interrupted
	// MID-FLIGHT; this set completes the fail-closed picture for the runtime
	// path. Cleared when the caller explicitly recovers the call.
	const barrierFailed = new Set<string>();

	const unknownCallIds = (): Set<string> =>
		new Set([...barrier.unknownOutcomeCallIds, ...barrierFailed]);

	return {
		worker,
		barrier,

		async emitLlmStepResult<T>(step: LlmStepMarker, emit: () => T | Promise<T>): Promise<T> {
			try {
				// Fail-closed BEFORE the emit: everything enqueued so far (the
				// step's input entries included) must be durable first.
				await barrier.beforeLlmRequest();
			} catch (error) {
				// The result is never emitted on an unconfirmed batch; the step is
				// named so the runtime can report which turn step was blocked.
				throw new Error(
					`checkpoint policy: durability barrier failed before emitting the result of LLM step "${step.stepId}"`,
					{ cause: error },
				);
			}
			return await emit();
		},

		async runToolEffect<T>(
			marker: EffectCallMarker,
			run: (signal: AbortSignal) => Promise<T>,
			options: RunToolEffectOptions = {},
		): Promise<ToolEffectOutcome<T>> {
			if (unknownCallIds().has(marker.callId) && options.allowAfterUnknownOutcome !== true) {
				// No-auto-retry contract: an unconfirmed call is never re-run
				// implicitly — the previous attempt may have taken effect already.
				throw new Error(
					`tool call ${marker.callId} (${marker.toolName}) has an unknown outcome; ` +
						'auto-retry is forbidden by the checkpoint policy — pass ' +
						'allowAfterUnknownOutcome to accept the risk explicitly',
				);
			}
			const effect: ToolEffect<T> = { callId: marker.callId, toolName: marker.toolName, run };
			try {
				const outcome = await barrier.runToolEffect(effect, options);
				if (outcome.outcome === TOOL_OUTCOME_UNKNOWN) {
					// Interrupted mid-flight: the barrier has already recorded the
					// call id; surface it to the policy.
					policy.onUnknownOutcome?.(marker, { reason: 'interrupted' });
				} else {
					// A confirmed outcome (including an explicit recovery): an
					// earlier barrier-failure record for this call no longer holds.
					barrierFailed.delete(marker.callId);
				}
				return outcome;
			} catch (error) {
				// Fail-closed (SE-SW-002): the barrier rejected BEFORE the effect
				// started — the batch could not be confirmed committed (uncommitted
				// entries, backend unavailable). The call's completion is
				// unobservable, so it is reported as TOOL_OUTCOME_UNKNOWN: never
				// completed, never failed, never retried implicitly.
				barrierFailed.add(marker.callId);
				policy.onUnknownOutcome?.(marker, {
					reason: 'barrier-failed',
					error: error instanceof Error ? error : new Error(String(error)),
				});
				return { outcome: TOOL_OUTCOME_UNKNOWN };
			}
		},

		get unknownOutcomeCallIds(): readonly string[] {
			return [...unknownCallIds()];
		},
	};
}
