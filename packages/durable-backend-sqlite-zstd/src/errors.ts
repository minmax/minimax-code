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
