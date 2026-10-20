/**
 * Error taxonomy of the storage worker.
 *
 * These errors cross the worker-thread bridge as `{ name, message }` pairs and
 * are reconstructed by name on the receiving side, so `error.name` is part of
 * the protocol: it classifies terminal (non-retryable) failures from ordinary
 * retriable ones. Never rename these classes.
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
