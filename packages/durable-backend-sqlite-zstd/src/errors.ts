/** Error hierarchy of the `sqlite-zstd` durable backend. */

/** Base class of every error this backend raises. */
export class SqliteZstdError extends Error {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'SqliteZstdError';
	}
}

/**
 * A write was attempted on a sealed (older) format generation. Reads stay
 * allowed: sealed generations are preserved byte-for-byte.
 */
export class SealedGenerationError extends SqliteZstdError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'SealedGenerationError';
	}
}

/**
 * A stored batch frame did not survive decoding: header mismatch, declared
 * length disagreement, codec checksum failure, malformed JSON, or a payload
 * past the JSON depth limit. Readers treat the batch as a torn tail and never
 * serve it.
 */
export class CorruptFrameError extends SqliteZstdError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'CorruptFrameError';
	}
}

/**
 * The codec a stored frame was written with cannot run in this runtime (for
 * example `node:zlib` lacks Zstandard support). This is an environment
 * problem, not payload corruption: readers must surface it loudly instead of
 * misclassifying every frame of that codec as a torn tail.
 */
export class CodecUnavailableError extends SqliteZstdError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'CodecUnavailableError';
	}
}

/**
 * An entry id violates the `entries.entry_id` primary key: the id was already
 * committed. The backend classifies the raw `SQLITE_CONSTRAINT` failure into
 * this domain error so callers can react deliberately (skip, split, or report)
 * instead of pattern-matching SQLite messages.
 */
export class DuplicateEntryError extends SqliteZstdError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'DuplicateEntryError';
	}
}

/**
 * Single-writer refusal at open time: a live writer (same process, or a
 * process that is still alive) already owns this generation. The second
 * writer must open a newer generation or wait — it never retries blindly.
 */
export class OwnerWriteLockError extends SqliteZstdError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'OwnerWriteLockError';
	}
}

/**
 * Single-writer loss at write time: this handle owned the generation when it
 * was opened, but the meta owner epoch (or owner instance) has since moved —
 * another writer took over. Terminal for this handle: it must not retry, its
 * view of the log is stale.
 */
export class OwnerLostError extends SqliteZstdError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'OwnerLostError';
	}
}
