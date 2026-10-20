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
 * A stored batch frame did not survive decoding: header mismatch, codec
 * checksum failure, malformed JSON, or an entry index that disagrees with the
 * payload. Readers treat the batch as a torn tail and never serve it.
 */
export class CorruptFrameError extends SqliteZstdError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'CorruptFrameError';
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
 * was opened, but the meta owner epoch has since moved — another writer took
 * over. Terminal for this handle: it must not retry, its view of the log is
 * stale.
 */
export class OwnerLostError extends SqliteZstdError {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'OwnerLostError';
	}
}
