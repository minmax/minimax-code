/**
 * Error hierarchy of the durable seam. Every error carries a stable `code`
 * (the steering design names `REQUEST_ID_CONFLICT` explicitly) so callers
 * react on the code, never on message text.
 *
 * @module
 */

/** Machine-readable outcomes of the seam primitives. */
export type SeamErrorCode =
	/** A different payload arrived under an existing `(conversationId, requestId)`. */
	| 'REQUEST_ID_CONFLICT'
	/** A different wait identity arrived under an existing `waitId`. */
	| 'WAIT_ID_CONFLICT'
	/** The `expectedVersion` CAS of a wait transition did not hold. */
	| 'VERSION_CONFLICT'
	/** The storage owner epoch moved: this writer lost the generation. */
	| 'OWNER_LOST'
	/** A terminal wait cannot take the requested transition. */
	| 'WAIT_TERMINAL'
	/** The wait id is unknown to the recovered registry. */
	| 'UNKNOWN_WAIT'
	/** A tool result already exists with a different outcome. */
	| 'TOOL_RESULT_CONFLICT'
	/** The delivery index has no active (or stored) entry for the key. */
	| 'UNKNOWN_INPUT'
	/** Structural validation of a call argument failed. */
	| 'INVALID_INPUT'
	/** The owner input exceeds the admission byte budget (explicit backpressure). */
	| 'INPUT_TOO_LARGE'
	/** The underlying generation is sealed; write to a newer one. */
	| 'GENERATION_SEALED'
	/** A deterministic entry id collided: the log already holds that id. */
	| 'ENTRY_ID_COLLISION'
	/** Anything else the storage contract raised. */
	| 'STORAGE_FAILURE';

/** Base class of every seam error. */
export class SeamError extends Error {
	readonly code: SeamErrorCode;

	constructor(code: SeamErrorCode, message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'SeamError';
		this.code = code;
	}
}

/** Different payload under an already-accepted `(conversationId, requestId)`. */
export class RequestIdConflictError extends SeamError {
	constructor(key: { readonly conversationId: string; readonly requestId: string }, options?: { readonly cause?: unknown }) {
		super(
			'REQUEST_ID_CONFLICT',
			`request ${JSON.stringify(key.requestId)} is already accepted for conversation ${JSON.stringify(
				key.conversationId,
			)} with a different payload; a retry must reuse the original payload`,
			options,
		);
		this.name = 'RequestIdConflictError';
	}
}

/** Different wait identity under an already-opened `waitId`. */
export class WaitIdConflictError extends SeamError {
	readonly waitId: string;

	constructor(waitId: string, detail: string, options?: { readonly cause?: unknown }) {
		super(
			'WAIT_ID_CONFLICT',
			`wait ${JSON.stringify(waitId)} is already opened with a different identity: ${detail}; ` +
				'a waitId anchors exactly one delegation tool-round',
			options,
		);
		this.name = 'WaitIdConflictError';
		this.waitId = waitId;
	}
}

/** Explicit backpressure: the owner input exceeds the admission byte budget. */
export class InputTooLargeError extends SeamError {
	readonly bytes: number;
	readonly limitBytes: number;

	constructor(bytes: number, limitBytes: number, options?: { readonly cause?: unknown }) {
		super(
			'INPUT_TOO_LARGE',
			`owner input is ${bytes} canonical JSON bytes, over the ${limitBytes}-byte admission budget; ` +
				'the client keeps the text and may retry smaller or via a CAS reference',
			options,
		);
		this.name = 'InputTooLargeError';
		this.bytes = bytes;
		this.limitBytes = limitBytes;
	}
}

/** The wait moved underneath the caller: CAS expectation is stale. */
export class VersionConflictError extends SeamError {
	readonly waitId: string;
	readonly expectedVersion: number;
	readonly currentVersion: number;

	constructor(
		waitId: string,
		expectedVersion: number,
		currentVersion: number,
		options?: { readonly cause?: unknown },
	) {
		super(
			'VERSION_CONFLICT',
			`wait ${JSON.stringify(waitId)} is at stateVersion ${currentVersion}, not the expected ${expectedVersion}; ` +
				'refresh the wait view and retry with the current version',
			options,
		);
		this.name = 'VersionConflictError';
		this.waitId = waitId;
		this.expectedVersion = expectedVersion;
		this.currentVersion = currentVersion;
	}
}

/** The writer lost the single-writer epoch of the generation. */
export class SeamOwnerLostError extends SeamError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super('OWNER_LOST', message, options);
		this.name = 'SeamOwnerLostError';
	}
}

/** The requested transition hits a terminal wait. */
export class WaitTerminalError extends SeamError {
	readonly waitId: string;
	readonly state: string;

	constructor(waitId: string, state: string, requested: string, options?: { readonly cause?: unknown }) {
		super(
			'WAIT_TERMINAL',
			`wait ${JSON.stringify(waitId)} is ${state} and cannot take ${requested}; ` +
				'terminal wait states are irreversible',
			options,
		);
		this.name = 'WaitTerminalError';
		this.waitId = waitId;
		this.state = state;
	}
}

/** The wait id is not in the registry (never opened, or belongs elsewhere). */
export class UnknownWaitError extends SeamError {
	readonly waitId: string;

	constructor(waitId: string, options?: { readonly cause?: unknown }) {
		super('UNKNOWN_WAIT', `wait ${JSON.stringify(waitId)} is not registered in this seam`, options);
		this.name = 'UnknownWaitError';
		this.waitId = waitId;
	}
}

/** A second, DIFFERENT outcome for an already-finalized tool call. */
export class ToolResultConflictError extends SeamError {
	readonly toolCallId: string;

	constructor(toolCallId: string, detail: string, options?: { readonly cause?: unknown }) {
		super(
			'TOOL_RESULT_CONFLICT',
			`tool call ${JSON.stringify(toolCallId)} already has a final result: ${detail}; ` +
				'a toolCallId is finalized exactly once and a prepared outcome is reproduced verbatim',
			options,
		);
		this.name = 'ToolResultConflictError';
		this.toolCallId = toolCallId;
	}
}

/** Storage-contract failure wrapper (including generation-sealed refusals). */
export class SeamStorageError extends SeamError {
	constructor(code: SeamErrorCode, message: string, options?: { readonly cause?: unknown }) {
		super(code, message, options);
		this.name = 'SeamStorageError';
	}
}

/** Argument validation failure (bad ids, cyclic payloads, unknown enum values). */
export class InvalidInputError extends SeamError {
	constructor(detail: string, options?: { readonly cause?: unknown }) {
		super('INVALID_INPUT', detail, options);
		this.name = 'InvalidInputError';
	}
}
