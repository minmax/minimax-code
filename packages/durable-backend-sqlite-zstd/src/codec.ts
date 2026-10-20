/**
 * Compression codec seam of the `sqlite-zstd` durable backend.
 *
 * A batch is stored as ONE compressed frame inside a small envelope:
 *
 * ```text
 * 'MZS1' (4 bytes, ASCII) | codec id (1 byte) | one compressed frame
 * ```
 *
 * The zstd codec uses `node:zlib`'s built-in Zstandard support (Node >= 22.15
 * / 23.8) and enables the frame checksum (XXH64 over the frame content, its
 * flag carried in the frame header), so `zstdDecompressSync` rejects any batch
 * whose bytes were torn or flipped. When the runtime has no Zstandard, the
 * seam falls back to gzip (CRC32-verified) behind the same `Codec` interface;
 * decoding follows the envelope's codec id, so databases written by either
 * codec stay readable in every runtime.
 */

import { gzipSync, gunzipSync } from 'node:zlib';
import * as zlib from 'node:zlib';

import { CorruptFrameError, SqliteZstdError } from './errors.js';

/** Compression codecs this package can store batches with. */
export type CodecName = 'zstd' | 'gzip';

/** Symmetric compress/decompress implementation behind the stored envelope. */
export interface Codec {
	readonly name: CodecName;
	compress(data: Uint8Array): Buffer;
	decompress(data: Uint8Array): Buffer;
}

/** Byte the envelope uses to identify the codec of the frame that follows. */
const CODEC_IDS: Readonly<Record<CodecName, number>> = { zstd: 0x01, gzip: 0x02 };

/** Envelope header: 4 magic bytes + 1 codec id byte. */
const FRAME_HEADER_LENGTH = 5;

const FRAME_MAGIC = Buffer.from('MZS1', 'ascii');

/**
 * Shape of the optional Zstandard bindings in `node:zlib`. Declared
 * structurally so the package compiles against @types/node versions that do
 * not know the zstd additions yet.
 */
interface ZstdBindings {
	readonly zstdCompressSync?: (data: Uint8Array, options?: { readonly params?: Readonly<Record<number, number>> }) => Buffer;
	readonly zstdDecompressSync?: (data: Uint8Array) => Buffer;
	readonly ZSTD_c_checksumFlag?: number;
}

const zlibBindings = zlib as typeof zlib & ZstdBindings;

/** Whether this runtime's `node:zlib` provides checksummed Zstandard frames. */
export function isZstdSupported(): boolean {
	return (
		typeof zlibBindings.zstdCompressSync === 'function' &&
		typeof zlibBindings.zstdDecompressSync === 'function' &&
		typeof zlibBindings.ZSTD_c_checksumFlag === 'number'
	);
}

function createZstdCodec(): Codec | undefined {
	const compress = zlibBindings.zstdCompressSync;
	const decompress = zlibBindings.zstdDecompressSync;
	const checksumFlag = zlibBindings.ZSTD_c_checksumFlag;
	if (typeof compress !== 'function' || typeof decompress !== 'function' || typeof checksumFlag !== 'number') {
		return undefined;
	}
	return {
		name: 'zstd',
		// The checksum flag marks the frame header so the XXH64 content
		// checksum that follows the frame body is written and verified.
		compress: (data) => compress(data, { params: { [checksumFlag]: 1 } }),
		decompress: (data) => decompress(data),
	};
}

const zstdCodec: Codec | undefined = createZstdCodec();

const gzipCodec: Codec = {
	name: 'gzip',
	compress: (data) => gzipSync(data),
	decompress: (data) => gunzipSync(data),
};

/** Resolve a codec by name; `zstd` throws when the runtime cannot provide it. */
export function getCodec(name: CodecName): Codec {
	if (name === 'zstd') {
		if (zstdCodec === undefined) {
			throw new SqliteZstdError('zstd is not available in this runtime; node:zlib lacks Zstandard support');
		}
		return zstdCodec;
	}
	return gzipCodec;
}

/**
 * Best available codec: the preferred one when given, otherwise `zstd` when
 * the runtime supports it and `gzip` as the fallback.
 */
export function resolveCodec(preferred?: CodecName): Codec {
	if (preferred === undefined) return zstdCodec ?? gzipCodec;
	return getCodec(preferred);
}

/** Wrap one compressed frame in the stored envelope. */
export function encodeFrame(name: CodecName, data: Uint8Array): Buffer {
	const frame = getCodec(name).compress(data);
	return Buffer.concat([FRAME_MAGIC, Buffer.from([CODEC_IDS[name]]), frame]);
}

/** Decoded envelope: the codec that wrote the frame and its uncompressed bytes. */
export type DecodedFrame = {
	readonly name: CodecName;
	readonly data: Buffer;
};

/**
 * Unwrap a stored envelope and verify its frame. Raises `CorruptFrameError`
 * for a bad header, an unknown codec, or a frame that fails its checksum —
 * callers treat that batch as torn and never serve its bytes.
 */
export function decodeFrame(blob: Uint8Array): DecodedFrame {
	if (blob.length < FRAME_HEADER_LENGTH) {
		throw new CorruptFrameError(`frame is ${blob.length} bytes, shorter than the ${FRAME_HEADER_LENGTH}-byte envelope header`);
	}
	const magic = blob.subarray(0, FRAME_MAGIC.length);
	const magicBytes = Buffer.from(magic);
	if (!magicBytes.equals(FRAME_MAGIC)) {
		throw new CorruptFrameError(`frame magic mismatch: expected ${FRAME_MAGIC.toString('ascii')}, got ${magicBytes.toString('latin1')}`);
	}
	const codecId = blob[FRAME_MAGIC.length];
	const name = codecId === CODEC_IDS.zstd ? 'zstd' : codecId === CODEC_IDS.gzip ? 'gzip' : undefined;
	if (name === undefined) {
		throw new CorruptFrameError(`unknown frame codec id 0x${(codecId ?? 0).toString(16)}`);
	}
	let codec: Codec;
	try {
		codec = getCodec(name);
	} catch (cause) {
		throw new CorruptFrameError(`frame codec ${name} is unavailable in this runtime`, { cause });
	}
	let data: Buffer;
	try {
		data = codec.decompress(blob.subarray(FRAME_HEADER_LENGTH));
	} catch (cause) {
		throw new CorruptFrameError(`frame failed ${name} decompression (checksum mismatch or torn bytes)`, { cause });
	}
	return { name, data };
}
