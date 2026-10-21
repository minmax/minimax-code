/**
 * Error taxonomy of the storage worker.
 *
 * These errors cross the worker-thread bridge through `serializeWorkerError`
 * and are reconstructed by `deserializeWorkerError` on the receiving side, so
 * `error.name` is part of the protocol: it classifies terminal (non-retryable)
 * failures from ordinary retriable ones. Never rename these classes.
 *
 * @module
 */

/**
 * Admission-time rejection: the entry can never fit into one backend batch,
 * so enqueueing it would only wedge the queue behind an eternal retry loop.
 * The caller's `enqueue` promise rejects immediately and the entry is never
 * queued.
 */
export class EntryExceedsBatchCapError extends RangeError {
	/** The `entry.bytes` value the caller declared. */
	readonly entryBytes: number;
	/** The batch cap the entry was measured against, in bytes. */
	readonly capBytes: number;

	constructor(entryId: string, entryBytes: number, capBytes: number) {
		super(
			`entry ${entryId} (${entryBytes} bytes) exceeds the backend batch cap ` +
				`(${capBytes} bytes); it can never be part of a committable batch`,
		);
		this.name = 'EntryExceedsBatchCapError';
		this.entryBytes = entryBytes;
		this.capBytes = capBytes;
	}
}

/**
 * A single entry is larger than the backend batch cap even after the worker
 * split the batch down to one entry (the entry's declared `bytes` under-reported
 * its true serialized size). The entry is quarantined — it is never retried —
 * and every flush learns about it immediately.
 */
export class EntryTooLargeError extends Error {
	/** Id of the entry that cannot be persisted. */
	readonly entryId: string;
	/** Serialized size of the entry as actually measured, in bytes. */
	readonly serializedBytes: number;
	/** The batch cap the entry was measured against, in bytes. */
	readonly capBytes: number;

	constructor(entryId: string, serializedBytes: number, capBytes: number) {
		super(
			`entry ${entryId} serializes to ${serializedBytes} bytes, above the backend ` +
				`batch cap of ${capBytes} bytes; quarantined instead of retrying forever`,
		);
		this.name = 'EntryTooLargeError';
		this.entryId = entryId;
		this.serializedBytes = serializedBytes;
		this.capBytes = capBytes;
	}
}

/**
 * The same batch composition failed `maxConsecutiveFlushFailures` times in a
 * row. The batch is quarantined and its entries are reported as dead letters
 * instead of being retried forever: the failure must reach the caller, not
 * spin in a 200 ms loop.
 */
export class BatchStuckError extends Error {
	/** Entry ids of the quarantined batch, in enqueue order. */
	readonly entryIds: readonly string[];
	/** How many consecutive times this exact composition failed. */
	readonly attempts: number;
	/** The last underlying backend error. */
	readonly cause: unknown;

	constructor(entryIds: readonly string[], attempts: number, cause: unknown) {
		super(
			`batch [${entryIds.join(', ')}] failed ${attempts} consecutive times with the same ` +
				`composition; quarantined. Last error: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = 'BatchStuckError';
		this.entryIds = entryIds;
		this.attempts = attempts;
		this.cause = cause;
	}
}

/**
 * Names of terminal backend refusals that must survive the worker-thread
 * bridge by name. `OwnerLostError` and `SealedGenerationError` are declared by
 * the backend package (`durable-backend-sqlite-zstd`), which this
 * dependency-free package never imports at runtime — the NAME is the
 * cross-package classification contract (mirrors the backend's error
 * taxonomy; renaming there breaks this protocol too).
 */
export type TerminalBridgeErrorName = 'OwnerLostError' | 'SealedGenerationError';

/** Whether `name` is a terminal backend refusal (never retried, never quarantined). */
export function isTerminalBridgeErrorName(name: string | undefined): boolean {
	return name === 'OwnerLostError' || name === 'SealedGenerationError';
}

/**
 * Whether `error` is a duplicate-insert refusal of the backend's entry-id
 * primary key. Detected by the backend's domain class name
 * (`DuplicateEntryError`) and, until that class is shipped there, by the raw
 * sqlite constraint message — both mean "already durable", which the worker
 * may treat as idempotent success instead of a wedge.
 */
export function isDuplicateEntryError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name === 'DuplicateEntryError') return true;
	return /UNIQUE constraint failed[^\n]*entry_id/.test(error.message);
}

/**
 * Wire shape of one error crossing the worker-thread bridge: everything the
 * receiving side needs to rebuild the error's class, fields, and cause.
 */
export interface SerializedWorkerError {
	/** `error.name` — the classification contract. Absent for non-Error throws. */
	readonly name?: string;
	readonly message: string;
	/** `EntryTooLargeError`: id of the offending entry. */
	readonly entryId?: unknown;
	/** `EntryTooLargeError`: measured vs cap bytes. */
	readonly serializedBytes?: number;
	readonly capBytes?: number;
	/** `BatchStuckError`: the quarantined batch's entry ids and attempt count. */
	readonly entryIds?: readonly string[];
	readonly attempts?: number;
	/** The error's `cause`, when it carried one (for example `BatchStuckError.cause`). */
	readonly causeName?: string;
	readonly causeMessage?: string;
}

/** Flattens an error (or any thrown value) onto the bridge wire shape. */
export function serializeWorkerError(error: unknown): SerializedWorkerError {
	if (!(error instanceof Error)) {
		return { message: String(error) };
	}
	const shape: {
		name?: string;
		message: string;
		entryId?: unknown;
		serializedBytes?: number;
		capBytes?: number;
		entryIds?: readonly string[];
		attempts?: number;
		causeName?: string;
		causeMessage?: string;
	} = { name: error.name, message: error.message };
	const fields = error as {
		readonly entryId?: unknown;
		readonly serializedBytes?: unknown;
		readonly capBytes?: unknown;
		readonly entryIds?: unknown;
		readonly attempts?: unknown;
	};
	if (fields.entryId !== undefined) shape.entryId = fields.entryId;
	if (typeof fields.serializedBytes === 'number') shape.serializedBytes = fields.serializedBytes;
	if (typeof fields.capBytes === 'number') shape.capBytes = fields.capBytes;
	if (Array.isArray(fields.entryIds)) shape.entryIds = fields.entryIds.map(String);
	if (typeof fields.attempts === 'number') shape.attempts = fields.attempts;
	const cause = error.cause;
	if (cause instanceof Error) {
		shape.causeName = cause.name;
		shape.causeMessage = cause.message;
	} else if (cause !== undefined && cause !== null) {
		shape.causeMessage = String(cause);
	}
	return shape;
}

/**
 * Rebuilds an error from its bridge wire shape. Classes owned by this package
 * (`EntryTooLargeError`, `BatchStuckError`) come back as real instances with
 * their fields; terminal backend refusals come back as `Error` instances with
 * the preserved name (their classes live in the backend package — `error.name`
 * is the programmatic contract, same as before this module existed).
 */
export function deserializeWorkerError(shape: SerializedWorkerError): Error {
	let error: Error;
	switch (shape.name) {
		case 'EntryTooLargeError': {
			error = new EntryTooLargeError(
				typeof shape.entryId === 'string' ? shape.entryId : 'unknown',
				shape.serializedBytes ?? 0,
				shape.capBytes ?? 0,
			);
			break;
		}
		case 'BatchStuckError': {
			const cause = new Error(shape.causeMessage ?? 'backend appendBatch failed');
			if (shape.causeName !== undefined) cause.name = shape.causeName;
			error = new BatchStuckError(shape.entryIds ?? [], shape.attempts ?? 0, cause);
			break;
		}
		case 'OwnerLostError':
		case 'SealedGenerationError': {
			error = causeFromShape(shape, shape.message);
			error.name = shape.name;
			break;
		}
		default: {
			error = causeFromShape(shape, shape.message);
			if (shape.name !== undefined) error.name = shape.name;
		}
	}
	// The wire message is authoritative: rebuilt classes template their own
	// message, but the sender's exact text (measured byte counts, backend
	// wording) is what callers match on.
	error.message = shape.message;
	return error;
}

function causeFromShape(shape: SerializedWorkerError, message: string): Error {
	const error = new Error(message);
	if (shape.causeMessage !== undefined) {
		const cause = new Error(shape.causeMessage);
		if (shape.causeName !== undefined) cause.name = shape.causeName;
		(error as { cause?: unknown }).cause = cause;
	}
	return error;
}
