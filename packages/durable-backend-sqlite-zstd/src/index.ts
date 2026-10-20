/**
 * `@mavis/durable-backend-sqlite-zstd`
 * -----------------------------------
 *
 * Durable delta-log storage backend: immutable compressed entry batches in
 * SQLite. Each `appendBatch()` writes the whole batch as ONE zstd (or gzip)
 * frame — content checksummed, torn frames are never served — plus its index
 * rows and the log head, all in ONE transaction under WAL and
 * `synchronous = FULL`. Format generations (`sessions.gN.db`) open forward
 * only: a newer generation seals the older ones byte-for-byte.
 *
 * This is the fifth storage backend beside Memory/JSONL/SQLite/DO, written
 * against the durable storage seam; the compression codec lives in the
 * `./codec` subpath.
 */

export {
	SqliteZstdBackend,
	FORMAT_ID,
	currentGeneration,
	databaseFileName,
	loadSqlite3Constructor,
	type Sqlite3Constructor,
} from './backend.js';
export { isZstdSupported, type Codec, type CodecName } from './codec.js';
export { CorruptFrameError, SealedGenerationError, SqliteZstdError } from './errors.js';
export {
	type BatchId,
	type Commit,
	type Entry,
	type EntryDraft,
	type JsonValue,
	MAX_BATCH_UNCOMPRESSED_BYTES,
	type OpenDurableBackendOptions,
	SEQ_AT_START,
	type Seq,
	type SqliteZstdBackendOptions,
} from './types.js';
