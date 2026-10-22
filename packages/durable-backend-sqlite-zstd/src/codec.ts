/**
 * Compression codec seam of the `sqlite-zstd` durable backend.
 *
 * A batch is stored as ONE compressed frame inside a small envelope. The
 * current envelope (magic `MZS2`) carries the declared frame and uncompressed
 * lengths so a torn write is caught by comparison, not only by the codec
 * checksum (`node:zlib`'s Zstandard decoder happily decodes a frame whose
 * trailing checksum bytes were cut off — only a stored length makes that
 * truncation detectable):
 *
 * ```text
 * 'MZS2' (4, ASCII)      — envelope version
 * | codec id (1 byte)    — which codec compressed the frame
 * | frame length (8, u64 BE)      — compressed byte count that MUST follow
 * | uncompressed length (8, u64 BE) — byte count the frame MUST decode to
 * | one compressed frame
 * ```
 *
 * The zstd codec uses `node:zlib`'s built-in Zstandard support (Node >= 22.15
 * / 23.8) and enables the frame checksum (XXH64 over the frame content, its
 * flag carried in the frame header), so `zstdDecompressSync` rejects any batch
 * whose bytes were flipped mid-frame. When the runtime has no Zstandard, the
 * seam falls back to gzip (CRC32-verified) behind the same `Codec` interface
 * and emits a one-time warning — the fallback is never silent; decoding
 * follows the envelope's codec id, so databases written by either codec stay
 * readable in every runtime.
 *
 * Legacy envelopes (magic `MZS1`, header = magic + codec id, no declared
 * lengths) stay decodable: they are guarded by the frame checksum alone.
 */

import { gzipSync, gunzipSync } from 'node:zlib';
import * as zlib from 'node:zlib';

import { CodecUnavailableError, CorruptFrameError } from './errors.js';

/** Compression codecs this package can store batches with. */
export type CodecName = 'zstd' | 'gzip';

/**
 * Hard decompression output bound applied when a caller does not pass
 * {@link DecodeFrameOptions.maxOutputLength}: a decompression bomb (a few
 * kilobytes expanding to tens of megabytes) is refused instead of
 * materialized. Sized far above any legitimate batch.
 */
export const DEFAULT_MAX_OUTPUT_LENGTH = 256 * 1024 * 1024;

/** Symmetric compress/decompress implementation behind the stored envelope. */
export interface Codec {
	readonly name: CodecName;
	compress(data: Uint8Array): Buffer;
	decompress(data: Uint8Array, options?: { readonly maxOutputLength?: number }): Buffer;
}

/** Byte the envelope uses to identify the codec of the frame that follows. */
const CODEC_IDS: Readonly<Record<CodecName, number>> = { zstd: 0x01, gzip: 0x02 };

/** Envelope magic of the current format (declared lengths follow the codec id). */
const FRAME_MAGIC = Buffer.from('MZS2', 'ascii');

/** Envelope magic of the legacy format (no declared lengths). */
const LEGACY_FRAME_MAGIC = Buffer.from('MZS1', 'ascii');

/** Current envelope header: magic (4) + codec id (1) + two u64 lengths. */
const FRAME_HEADER_LENGTH = FRAME_MAGIC.length + 1 + 8 + 8;

/** Legacy envelope header: magic (4) + codec id (1). */
const LEGACY_FRAME_HEADER_LENGTH = LEGACY_FRAME_MAGIC.length + 1;

/**
 * Shape of the optional Zstandard bindings in `node:zlib`. Declared
 * structurally so the package compiles against @types/node versions that do
 * not know the zstd additions yet.
 */
interface ZstdBindings {
	readonly zstdCompressSync?: (data: Uint8Array, options?: { readonly params?: Readonly<Record<number, number>> }) => Buffer;
	readonly zstdDecompressSync?: (data: Uint8Array, options?: { readonly maxOutputLength?: number }) => Buffer;
	readonly ZSTD_c_checksumFlag?: number;
	/**
	 * The checksum flag constant lives here on the module-namespace (ESM)
	 * surface: on the target runtime (Node 22.22.2, verified) the top-level
	 * `ZSTD_c_checksumFlag` is undefined while `constants.ZSTD_c_checksumFlag`
	 * is 201 — in the main thread AND in worker threads. The detector reads
	 * both locations.
	 */
	readonly constants?: { readonly ZSTD_c_checksumFlag?: number } | undefined;
}

const zlibBindings = zlib as typeof zlib & ZstdBindings;

/**
 * The zstd frame-checksum flag parameter, resolved from whichever surface the
 * running runtime exposes it on: `constants.ZSTD_c_checksumFlag` first, the
 * top-level `ZSTD_c_checksumFlag` second (the CJS surface of some runtimes).
 * `undefined` when the runtime exposes neither — then there is no checksummed
 * zstd and the codec falls back to gzip.
 */
const ZSTD_CHECKSUM_FLAG: number | undefined = (() => {
	const fromConstants = zlibBindings.constants?.ZSTD_c_checksumFlag;
	if (typeof fromConstants === 'number') return fromConstants;
	const topLevel = zlibBindings.ZSTD_c_checksumFlag;
	return typeof topLevel === 'number' ? topLevel : undefined;
})();

/** Whether this runtime's `node:zlib` provides checksummed Zstandard frames. */
export function isZstdSupported(): boolean {
	return (
		typeof zlibBindings.zstdCompressSync === 'function' &&
		typeof zlibBindings.zstdDecompressSync === 'function' &&
		typeof ZSTD_CHECKSUM_FLAG === 'number'
	);
}

function createZstdCodec(): Codec | undefined {
	const compress = zlibBindings.zstdCompressSync;
	const decompress = zlibBindings.zstdDecompressSync;
	if (typeof compress !== 'function' || typeof decompress !== 'function' || ZSTD_CHECKSUM_FLAG === undefined) {
		return undefined;
	}
	return {
		name: 'zstd',
		// The checksum flag marks the frame header so the XXH64 content
		// checksum that follows the frame body is written and verified.
		compress: (data) => compress(data, { params: { [ZSTD_CHECKSUM_FLAG]: 1 } }),
		decompress: (data, options) => decompress(data, options),
	};
}

const zstdCodec: Codec | undefined = createZstdCodec();

const gzipCodec: Codec = {
	name: 'gzip',
	compress: (data) => gzipSync(data),
	decompress: (data, options) => gunzipSync(data, options),
};

/** Resolve a codec by name; `zstd` throws when the runtime cannot provide it. */
export function getCodec(name: CodecName): Codec {
	if (name === 'zstd') {
		if (zstdCodec === undefined) {
			// A distinct class: an environment gap, never a corrupt-frame verdict.
			throw new CodecUnavailableError('zstd is not available in this runtime; node:zlib lacks Zstandard support');
		}
		return zstdCodec;
	}
	return gzipCodec;
}

let warnedGzipFallback = false;

/**
 * Best available codec: the preferred one when given, otherwise `zstd` when
 * the runtime supports it and `gzip` as the fallback. The automatic fallback
 * is explicit: a one-time warning is emitted, so a log silently compressed
 * with the weaker codec can be noticed.
 */
export function resolveCodec(preferred?: CodecName): Codec {
	if (preferred === undefined) {
		if (zstdCodec !== undefined) return zstdCodec;
		if (!warnedGzipFallback) {
			warnedGzipFallback = true;
			process.emitWarning(
				'node:zlib lacks Zstandard support; falling back to gzip for new batches (upgrade to Node >= 22.15 for zstd)',
				{ code: 'SQLITE_ZSTD_GZIP_FALLBACK' },
			);
		}
		return gzipCodec;
	}
	return getCodec(preferred);
}

/** Wrap one compressed frame in the stored envelope (single allocation, no intermediate copies). */
export function encodeFrame(name: CodecName, data: Uint8Array): Buffer {
	const frame = getCodec(name).compress(data);
	const envelope = Buffer.alloc(FRAME_HEADER_LENGTH + frame.length);
	FRAME_MAGIC.copy(envelope, 0);
	envelope[FRAME_MAGIC.length] = CODEC_IDS[name];
	envelope.writeBigUInt64BE(BigInt(frame.length), FRAME_MAGIC.length + 1);
	envelope.writeBigUInt64BE(BigInt(data.length), FRAME_MAGIC.length + 1 + 8);
	envelope.set(frame, FRAME_HEADER_LENGTH);
	return envelope;
}

/** Decoded envelope: the codec that wrote the frame and its uncompressed bytes. */
export type DecodedFrame = {
	readonly name: CodecName;
	readonly data: Buffer;
};

/** Options of {@link decodeFrame}. */
export type DecodeFrameOptions = {
	/**
	 * Refuse frames that claim to decode to more than this many bytes (and
	 * frames whose envelope-declared uncompressed length exceeds it) instead of
	 * materializing a decompression bomb. Default: {@link DEFAULT_MAX_OUTPUT_LENGTH}.
	 */
	readonly maxOutputLength?: number;
};

/**
 * Unwrap a stored envelope and verify its frame. Raises `CorruptFrameError`
 * for a bad header, an unknown codec, a declared-length disagreement (truncated
 * or over-long payload), a frame that fails its checksum, or an output past
 * `maxOutputLength` — callers treat that batch as torn and never serve its
 * bytes. A missing codec raises `CodecUnavailableError`: an environment gap
 * must surface loudly, never masquerade as corruption.
 */
export function decodeFrame(blob: Uint8Array, options: DecodeFrameOptions = {}): DecodedFrame {
	// Zero-copy view of the payload: the Buffer methods below (equals,
	// readBigUInt64BE) never duplicate the bytes.
	const bytes = bufferViewOf(blob);
	const maxOutputLength = options.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH;
	const isCurrent = bytes.subarray(0, FRAME_MAGIC.length).equals(FRAME_MAGIC);
	const isLegacy = !isCurrent && bytes.subarray(0, LEGACY_FRAME_MAGIC.length).equals(LEGACY_FRAME_MAGIC);
	if (!isCurrent && !isLegacy) {
		const got = bytes.subarray(0, 8).toString('latin1');
		throw new CorruptFrameError(
			`frame magic mismatch: expected ${FRAME_MAGIC.toString('ascii')} (or legacy ${LEGACY_FRAME_MAGIC.toString('ascii')}), ` +
				`got ${got}`,
		);
	}
	const headerLength = isCurrent ? FRAME_HEADER_LENGTH : LEGACY_FRAME_HEADER_LENGTH;
	if (bytes.length < headerLength) {
		throw new CorruptFrameError(
			`frame is ${bytes.length} bytes, shorter than the ${headerLength}-byte envelope header`,
		);
	}
	const codecId = bytes[FRAME_MAGIC.length];
	const name = codecId === CODEC_IDS.zstd ? 'zstd' : codecId === CODEC_IDS.gzip ? 'gzip' : undefined;
	if (name === undefined) {
		throw new CorruptFrameError(`unknown frame codec id 0x${(codecId ?? 0).toString(16)}`);
	}
	let declaredUncompressedLength: number | null = null;
	if (isCurrent) {
		// Declared frame length: any truncation or over-long tail is caught by
		// comparison before a single decompressed byte is materialized.
		const declaredFrameLength = readDeclaredLength(bytes, FRAME_MAGIC.length + 1);
		if (declaredFrameLength !== bytes.length - headerLength) {
			throw new CorruptFrameError(
				`frame length mismatch: envelope declares ${declaredFrameLength} frame bytes, payload holds ${bytes.length - headerLength}`,
			);
		}
		declaredUncompressedLength = readDeclaredLength(bytes, FRAME_MAGIC.length + 1 + 8);
		if (declaredUncompressedLength > maxOutputLength) {
			throw new CorruptFrameError(
				`frame declares ${declaredUncompressedLength} uncompressed bytes, above the ${maxOutputLength}-byte output limit`,
			);
		}
	}
	let codec: Codec;
	try {
		codec = getCodec(name);
	} catch (cause) {
		if (cause instanceof CodecUnavailableError) throw cause;
		throw new CodecUnavailableError(`frame codec ${name} is unavailable in this runtime`, { cause });
	}
	let data: Buffer;
	try {
		data = codec.decompress(bytes.subarray(headerLength), { maxOutputLength });
	} catch (cause) {
		throw new CorruptFrameError(`frame failed ${name} decompression (checksum mismatch, torn bytes, or output over the limit)`, {
			cause,
		});
	}
	if (declaredUncompressedLength !== null && data.length !== declaredUncompressedLength) {
		throw new CorruptFrameError(
			`uncompressed length mismatch: envelope declares ${declaredUncompressedLength} bytes, frame decoded to ${data.length}`,
		);
	}
	return { name, data };
}

/**
 * The uncompressed byte count a stored envelope declares for its frame, or
 * `null` for a legacy envelope (no declared lengths). Lets a reader budget a
 * window WITHOUT decompressing the batch first.
 */
export function peekFrameUncompressedLength(blob: Uint8Array): number | null {
	const bytes = bufferViewOf(blob);
	if (bytes.length < FRAME_HEADER_LENGTH || !bytes.subarray(0, FRAME_MAGIC.length).equals(FRAME_MAGIC)) return null;
	return readDeclaredLength(bytes, FRAME_MAGIC.length + 1 + 8);
}

/** Zero-copy Buffer view over a byte array (no duplication of the payload). */
function bufferViewOf(bytes: Uint8Array): Buffer {
	if (Buffer.isBuffer(bytes)) return bytes;
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Read one u64 BE length field, refusing values beyond the safe integer range. */
function readDeclaredLength(bytes: Buffer, offset: number): number {
	const value = bytes.readBigUInt64BE(offset);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new CorruptFrameError(`envelope declares an unreasonable length (${value})`);
	}
	return Number(value);
}
