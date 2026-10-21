/**
 * Domain errors of the reactive delegation control.
 *
 * @module
 */

/**
 * Thrown by `seam.prepareRelease` when the owner-epoch, active run/wait IDs
 * or `stateVersion` no longer match the durable record (§3 T_release, §4
 * Гонки): the release is refused explicitly and must be retried only after
 * the caller re-reads the state — never applied to a newer run.
 */
export class StaleStateVersionError extends Error {
	readonly code = 'STALE_STATE_VERSION';

	constructor(message = 'release refused: stale stateVersion / owner epoch', options?: ErrorOptions) {
		super(message, options);
		this.name = 'StaleStateVersionError';
	}
}

/**
 * Thrown by `registerWait` when a tool-round already holds the bounded
 * ForegroundWaitSet capacity. Fails closed on purpose: overflow must be an
 * explicit, visible refusal, never a silent drop of a delegation wait.
 */
export class WaitSetOverflowError extends Error {
	readonly code = 'WAITSET_OVERFLOW';
	readonly parentConversationId: string;
	readonly parentRunId: string;
	readonly capacity: number;

	constructor(
		parentConversationId: string,
		parentRunId: string,
		capacity: number,
		message = `ForegroundWaitSet for ${parentConversationId}/${parentRunId} is full (${capacity} waits)`,
	) {
		super(message);
		this.name = 'WaitSetOverflowError';
		this.parentConversationId = parentConversationId;
		this.parentRunId = parentRunId;
		this.capacity = capacity;
	}
}

/** Structural check that survives seam boundaries (instanceof is not enough). */
export function isStaleStateVersionError(error: unknown): boolean {
	return (
		error instanceof StaleStateVersionError ||
		(typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'STALE_STATE_VERSION')
	);
}

/** Human-readable message of an unknown seam failure. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
