/**
 * `sqlite-zstd` durable backend: immutable zstd-compressed entry batches in SQLite.
 *
 * Layout of one database file (`sessions.gN.db`):
 *
 * - `batches(batch_id PK, created_ms, compressed, payload BLOB)` — one row per
 *   commit; `payload` is the envelope + ONE compressed frame holding the whole
 *   batch, `compressed` the payload byte length;
 * - `entries(entry_id PK, seq, ordinal, batch_id)` — the log index
 *   `entry_id -> (batch_id, ordinal)`, ordered for windowed reads by `(seq, ordinal)`;
 * - `meta(key, value)` — format id and the log `head` (last committed sequence).
 *
 * Every `appendBatch()` commits batch row, index rows, and head in ONE SQLite
 * transaction on a WAL journal with `synchronous = FULL`, so a resolved commit
 * is durable and later reads observe it.
 *
 * Format generations: a database opens as `sessions.gN.db`. Opening generation
 * `N + 1` next to it seals every older generation — live handles refuse writes
 * (`SealedGenerationError`) and their files lose their write bits, preserving
 * them byte-for-byte. Sealed generations stay readable.
 */

import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { type Codec, decodeFrame, encodeFrame, resolveCodec } from './codec.js';
import { CorruptFrameError, SealedGenerationError, SqliteZstdError } from './errors.js';
import {
	type BatchId,
	type Commit,
	type Entry,
	type EntryDraft,
	type JsonValue,
	type OpenDurableBackendOptions,
	SEQ_AT_START,
	type Seq,
	type SqliteZstdBackendOptions,
	MAX_BATCH_UNCOMPRESSED_BYTES,
} from './types.js';

/** Id stored in `meta.format`; open rejects files written by another format. */
export const FORMAT_ID = 'sqlite-zstd.v1';

/** File name of the database of one format generation. */
export function databaseFileName(generation: number): string {
	return `sessions.g${generation}.db`;
}

const GENERATION_FILE_PATTERN = /^sessions\.g(\d+)\.db$/;

/** Read-only mode applied to the files of a sealed generation. */
const SEALED_FILE_MODE = 0o444;

/** Highest generation number present in `directory`; `0` when none exists yet. */
export function currentGeneration(directory: string): number {
	let highest = 0;
	for (const name of readdirSync(directory)) {
		const match = GENERATION_FILE_PATTERN.exec(name);
		const parsed = match?.[1] === undefined ? Number.NaN : Number(match[1]);
		if (Number.isSafeInteger(parsed) && parsed > highest) highest = parsed;
	}
	return highest;
}

/**
 * Minimal structural surface of better-sqlite3 this backend uses. Declared
 * locally (like `local-runtime`'s database client) so no node-module types are
 * required and the native module is loaded through `createRequire`.
 */
interface SqliteStatement {
	run(...params: unknown[]): { readonly changes: number | bigint };
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	transaction<T>(fn: () => T): () => T;
	close(): void;
}

export type Sqlite3Constructor = new (
	filename: string,
	options?: { readonly readonly?: boolean; readonly fileMustExist?: boolean; readonly timeout?: number },
) => SqliteDatabase;

/** Resolve the native better-sqlite3 constructor (mirrors the local-runtime database client). */
export function loadSqlite3Constructor(): Sqlite3Constructor {
	const loaded: unknown = createRequire(import.meta.url)('better-sqlite3');
	const constructor = typeof loaded === 'function' ? loaded : (loaded as { default?: unknown } | null)?.default;
	if (typeof constructor !== 'function') {
		throw new SqliteZstdError('better-sqlite3 module does not export a database constructor');
	}
	return constructor as Sqlite3Constructor;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS batches (
  batch_id INTEGER PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  compressed INTEGER NOT NULL,
  payload BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  entry_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  batch_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_by_seq ON entries (seq, ordinal);
CREATE INDEX IF NOT EXISTS entries_by_batch ON entries (batch_id, ordinal);
INSERT OR IGNORE INTO meta (key, value) VALUES ('format', '${FORMAT_ID}');
INSERT OR IGNORE INTO meta (key, value) VALUES ('head', '${SEQ_AT_START}');
`;

/** Live backends per directory, so opening a newer generation seals them. */
const openBackendsByDirectory = new Map<string, Set<SqliteZstdBackend>>();

function registerBackend(backend: SqliteZstdBackend): void {
	const key = realpathSync(backend.directory);
	let set = openBackendsByDirectory.get(key);
	if (set === undefined) {
		set = new Set();
		openBackendsByDirectory.set(key, set);
	}
	set.add(backend);
}

function unregisterBackend(backend: SqliteZstdBackend): void {
	const key = realpathSync(backend.directory);
	const set = openBackendsByDirectory.get(key);
	set?.delete(backend);
	if (set !== undefined && set.size === 0) openBackendsByDirectory.delete(key);
}

/**
 * Strip write bits from every file of one generation, best effort. Other
 * processes then downgrade to read-only connections at open time; live
 * in-process handles are sealed separately through the registry.
 */
function sealGenerationFiles(directory: string, generation: number): void {
	const base = databaseFileName(generation);
	// databaseFileName already carries the `.db` extension; the WAL and SHM
	// sidecar files add their suffixes to the full name.
	for (const suffix of ['', '-wal', '-shm'] as const) {
		const path = join(directory, base + suffix);
		if (!existsSync(path)) continue;
		try {
			chmodSync(path, SEALED_FILE_MODE);
		} catch {
			// Best effort: on platforms without POSIX modes the in-process
			// seal still guards this backend's own handle.
		}
	}
}

/** Append-only delta log backed by one `sessions.gN.db` file. */
export class SqliteZstdBackend {
	/** Directory holding the `sessions.gN.db` file. */
	readonly directory: string;
	/** Format generation of the opened file. */
	readonly generation: number;
	/** Absolute path of the underlying SQLite file. */
	readonly path: string;

	private db: SqliteDatabase | null;
	private codec: Codec;
	private maxBatchUncompressedBytes: number;
	private sealedFlag: boolean;
	private closedFlag: boolean;
	private headValue: Seq;
	private openBatch: EntryDraft[];

	private readonly setHeadStmt: SqliteStatement;
	private readonly insertBatchStmt: SqliteStatement;
	private readonly insertEntryStmt: SqliteStatement;
	private readonly scanBatchesStmt: SqliteStatement;
	private readonly batchIndexStmt: SqliteStatement;

	/**
	 * Open (or create) the current generation of `directory`: the highest
	 * existing `sessions.gN.db`, creating `g1` when none exists. A file that
	 * lost its write bits (a sealed generation) opens read-only.
	 */
	static open(directory: string, options: OpenDurableBackendOptions = {}): SqliteZstdBackend {
		mkdirSync(directory, { recursive: true });
		let generation: number;
		if (options.generation !== undefined) {
			if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
				throw new SqliteZstdError(`generation must be a positive integer, got ${options.generation}`);
			}
			if (!existsSync(join(directory, databaseFileName(options.generation)))) {
				throw new SqliteZstdError(`generation g${options.generation} does not exist in ${directory}`);
			}
			generation = options.generation;
		} else {
			generation = Math.max(currentGeneration(directory), 1);
		}
		const path = join(directory, databaseFileName(generation));
		const writable = isWritablePath(path);
		const db = new DatabaseConstructor(path, writable ? { timeout: 5000 } : { readonly: true, fileMustExist: true });
		let backend: SqliteZstdBackend;
		try {
			backend = new SqliteZstdBackend(directory, generation, path, db, !writable, options);
		} catch (error) {
			db.close(); // a rejected open must not leak the connection
			throw error;
		}
		registerBackend(backend);
		return backend;
	}

	/**
	 * Create the next format generation `sessions.gN+1.db` next to the highest
	 * existing one and seal every older generation: their live handles refuse
	 * further writes and their files lose their write bits. The new database
	 * starts empty (head 0); moving content between generations is the
	 * migration's job, not this call's.
	 */
	static openNextGeneration(directory: string, options: SqliteZstdBackendOptions = {}): SqliteZstdBackend {
		mkdirSync(directory, { recursive: true });
		const generation = currentGeneration(directory) + 1;
		const path = join(directory, databaseFileName(generation));
		const db = new DatabaseConstructor(path, { timeout: 5000 });
		let backend: SqliteZstdBackend;
		try {
			backend = new SqliteZstdBackend(directory, generation, path, db, false, options);
		} catch (error) {
			db.close();
			throw error;
		}
		// Flush live handles first: sealing must not drop their open batches,
		// and the flush needs files that are still writable.
		const registryKey = realpathSync(directory);
		for (const existing of openBackendsByDirectory.get(registryKey) ?? []) {
			if (existing.generation < generation) existing.seal();
		}
		for (let older = generation - 1; older >= 1; older -= 1) {
			if (existsSync(join(directory, databaseFileName(older)))) sealGenerationFiles(directory, older);
		}
		registerBackend(backend);
		return backend;
	}

	private constructor(
		directory: string,
		generation: number,
		path: string,
		db: SqliteDatabase,
		sealed: boolean,
		options: SqliteZstdBackendOptions,
	) {
		this.directory = directory;
		this.generation = generation;
		this.path = path;
		this.db = db;
		this.codec = resolveCodec(options.codec);
		this.maxBatchUncompressedBytes = options.maxBatchUncompressedBytes ?? MAX_BATCH_UNCOMPRESSED_BYTES;
		this.sealedFlag = sealed;
		this.closedFlag = false;
		this.headValue = SEQ_AT_START as Seq;
		this.openBatch = [];

		if (sealed) {
			db.exec('PRAGMA busy_timeout = 5000;');
			this.assertFormat(db);
		} else {
			db.exec('PRAGMA journal_mode = WAL;');
			db.exec('PRAGMA synchronous = FULL;');
			db.exec('PRAGMA busy_timeout = 5000;');
			// A file that already holds tables must already be ours; only a
			// genuinely fresh file receives the schema, never a foreign one.
			if (hasUserTables(db)) this.assertFormat(db);
			else db.exec(SCHEMA_SQL);
		}

		const headRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('head') as { readonly value?: unknown } | undefined;
		const head = Number(headRow?.value);
		if (!Number.isSafeInteger(head) || head < 0) {
			throw new SqliteZstdError(`${path}: meta.head is not a valid sequence (${String(headRow?.value)})`);
		}
		this.headValue = head as Seq;

		this.setHeadStmt = db.prepare(
			'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
		);
		this.insertBatchStmt = db.prepare(
			'INSERT INTO batches (batch_id, created_ms, compressed, payload) VALUES (?, ?, ?, ?)',
		);
		this.insertEntryStmt = db.prepare('INSERT INTO entries (entry_id, seq, ordinal, batch_id) VALUES (?, ?, ?, ?)');
		this.scanBatchesStmt = db.prepare('SELECT batch_id, payload FROM batches WHERE batch_id > ? ORDER BY batch_id ASC');
		this.batchIndexStmt = db.prepare('SELECT entry_id, ordinal FROM entries WHERE batch_id = ? ORDER BY ordinal ASC');
	}

	/** Last committed sequence; `0` for an empty or fresh database. */
	get head(): Seq {
		this.assertOpen();
		return this.headValue;
	}

	/** Whether this generation is sealed (reads allowed, writes rejected). */
	get sealed(): boolean {
		return this.sealedFlag;
	}

	/** Atomically append one batch: one frame, batch row, index rows, head — one transaction. */
	async appendBatch(entries: readonly EntryDraft[]): Promise<Commit> {
		this.assertWritable();
		return this.commitBatch(entries);
	}

	/**
	 * Accumulate entries into the in-memory open batch without writing. The
	 * open batch becomes durable only when `checkpoint()` (or `close()`, or a
	 * seal) flushes it through the same atomic path as `appendBatch()`.
	 */
	stage(entries: readonly EntryDraft[]): void {
		this.assertWritable();
		for (const draft of entries) validateDraft(draft);
		for (const draft of entries) this.openBatch.push(draft); // no spread: batches may be large
	}

	/**
	 * Flush the open batch as one committed frame; `undefined` when nothing is
	 * staged. A sealed or closed backend rejects even an empty checkpoint, so
	 * a fail-closed flush policy notices a lost write surface instead of
	 * silently flushing nothing.
	 */
	async checkpoint(): Promise<Commit | undefined> {
		this.assertWritable();
		if (this.openBatch.length === 0) return undefined;
		const batch = this.openBatch;
		this.openBatch = [];
		try {
			return this.commitBatch(batch);
		} catch (error) {
			// Fail closed: put the entries back instead of dropping them.
			this.openBatch = batch;
			throw error;
		}
	}

	/**
	 * Entries of committed batches with `seq > afterSeq`, oldest first, within
	 * a budget of `limitBytes` uncompressed batch bytes. Batches are atomic
	 * units: the scan stops before the batch that would overflow the budget,
	 * except the first batch past `afterSeq`, which is always returned so a
	 * reader can never stall. A torn batch (checksum failure, malformed
	 * content, index disagreement) ends the scan — the intact prefix is
	 * returned and the torn tail is never served.
	 */
	readDelta(afterSeq: number, limitBytes: number): Entry[] {
		this.assertOpen();
		if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
			throw new RangeError(`afterSeq must be a non-negative safe integer, got ${afterSeq}`);
		}
		if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
			throw new RangeError(`limitBytes must be a positive safe integer, got ${limitBytes}`);
		}
		const result: Entry[] = [];
		let budgetUsed = 0;
		for (const row of this.scanBatchesStmt.all(afterSeq)) {
			const batch = parseBatchRow(row);
			let entries: Entry[];
			let decodedBytes: number;
			try {
				const decoded = decodeBatchPayload(batch.payload, batch.batchId);
				this.assertIndexMatches(batch.batchId, decoded.entries);
				entries = decoded.entries;
				decodedBytes = decoded.byteLength;
			} catch (error) {
				if (error instanceof CorruptFrameError) break; // torn tail: serve the intact prefix only
				throw error;
			}
			if (result.length > 0 && budgetUsed + decodedBytes > limitBytes) break;
			for (const entry of entries) result.push(entry);
			budgetUsed += decodedBytes;
		}
		return result;
	}

	/**
	 * Seal this generation: flush the open batch while the file is still
	 * writable, refuse further writes, then strip the write bits from the
	 * generation's files. Idempotent; reads stay allowed.
	 */
	seal(): void {
		if (this.sealedFlag || this.closedFlag) return;
		if (this.openBatch.length > 0) {
			const batch = this.openBatch;
			this.openBatch = [];
			try {
				this.commitBatch(batch);
			} catch (error) {
				this.openBatch = batch;
				throw error;
			}
		}
		this.sealedFlag = true;
		sealGenerationFiles(this.directory, this.generation);
	}

	/**
	 * Flush the open batch (unless sealed), release the database, and make all
	 * later operations reject. Idempotent.
	 */
	async close(): Promise<void> {
		if (this.closedFlag) return;
		if (!this.sealedFlag && this.openBatch.length > 0) await this.checkpoint();
		this.db?.close();
		this.db = null;
		this.closedFlag = true;
		unregisterBackend(this);
	}

	/** Commit path shared by `appendBatch`, `checkpoint`, and sealing. */
	private commitBatch(drafts: readonly EntryDraft[]): Commit {
		if (drafts.length === 0) {
			// A commit without entries would advance the head for nothing;
			// `checkpoint()` reports an empty open batch as `undefined` instead.
			throw new TypeError('batch must contain at least one entry');
		}
		for (const draft of drafts) validateDraft(draft);
		const json = JSON.stringify(drafts);
		const jsonBytes = Buffer.from(json, 'utf8');
		if (this.maxBatchUncompressedBytes > 0 && jsonBytes.length > this.maxBatchUncompressedBytes) {
			throw new SqliteZstdError(
				`batch exceeds the uncompressed cap: ${jsonBytes.length} > ${this.maxBatchUncompressedBytes} bytes`,
			);
		}
		const frame = encodeFrame(this.codec.name, jsonBytes);
		const db = this.db;
		if (db === null) throw new SqliteZstdError(`backend at ${this.path} is closed`);
		const codecName = this.codec.name;
		const commit = db.transaction(() => {
			// Re-read the head inside the transaction: the new sequence is
			// derived from the durable head, keeping it strictly monotonic.
			const headRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('head') as
				| { readonly value?: unknown }
				| undefined;
			const currentHead = Number(headRow?.value);
			if (!Number.isSafeInteger(currentHead) || currentHead < 0 || currentHead !== this.headValue) {
				throw new SqliteZstdError(`${this.path}: durable head ${String(headRow?.value)} diverged from ${this.headValue}`);
			}
			const seq = (currentHead + 1) as Seq;
			this.insertBatchStmt.run(seq, Date.now(), frame.length, frame);
			drafts.forEach((draft, ordinal) => {
				this.insertEntryStmt.run(draft.id, seq, ordinal, seq);
			});
			this.setHeadStmt.run('head', String(seq));
			return {
				seq,
				batchId: seq as unknown as BatchId,
				entryCount: drafts.length,
				head: seq,
				codec: codecName,
				compressedBytes: frame.length,
				uncompressedBytes: jsonBytes.length,
			} satisfies Commit;
		})();
		this.headValue = commit.head;
		return commit;
	}

	/** The stored format must be ours; a foreign file is never rewritten. */
	private assertFormat(db: SqliteDatabase): void {
		const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined;
		if (!hasMeta) throw new SqliteZstdError(`${this.path}: not a ${FORMAT_ID} database (no meta table)`);
		const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('format') as
			| { readonly value?: unknown }
			| undefined;
		if (row?.value !== FORMAT_ID) {
			throw new SqliteZstdError(`${this.path}: not a ${FORMAT_ID} database (format: ${String(row?.value)})`);
		}
	}

	private assertOpen(): void {
		if (this.closedFlag) throw new SqliteZstdError(`backend at ${this.path} is closed`);
	}

	private assertWritable(): void {
		this.assertOpen();
		if (this.sealedFlag) {
			throw new SealedGenerationError(
				`generation g${this.generation} at ${this.path} is sealed; write to a newer generation instead`,
			);
		}
	}

	/** The entry index must agree with the decoded payload; divergence is corruption. */
	private assertIndexMatches(batchId: number, entries: readonly Entry[]): void {
		const rows = this.batchIndexStmt.all(batchId);
		if (rows.length !== entries.length) {
			throw new CorruptFrameError(`batch ${batchId}: entry index has ${rows.length} rows, payload has ${entries.length} entries`);
		}
		rows.forEach((row, ordinal) => {
			const entry = entries[ordinal];
			const parsed = parseIndexRow(row);
			if (entry === undefined || parsed === undefined || parsed.ordinal !== ordinal || parsed.entryId !== entry.id) {
				throw new CorruptFrameError(`batch ${batchId}: entry index does not match the payload at ordinal ${ordinal}`);
			}
		});
	}
}

const DatabaseConstructor = loadSqlite3Constructor();

/** Whether the path can be written; missing files count as writable (they will be created). */
function isWritablePath(path: string): boolean {
	if (!existsSync(path)) return true;
	try {
		accessSync(path, fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Whether the database defines any user table at all. */
function hasUserTables(db: SqliteDatabase): boolean {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ readonly name?: unknown }>;
	return rows.some((row) => typeof row.name === 'string' && !row.name.startsWith('sqlite_'));
}

type BatchRow = {
	readonly batchId: number;
	readonly payload: Uint8Array;
};

function parseBatchRow(row: unknown): BatchRow {
	if (!isObject(row)) throw new SqliteZstdError(`unexpected batch row shape: ${typeof row}`);
	if (!isSafeIntegerValue(row.batch_id)) throw new SqliteZstdError(`batch row has an invalid batch_id: ${String(row.batch_id)}`);
	if (!(row.payload instanceof Uint8Array)) throw new SqliteZstdError(`batch ${String(row.batch_id)} payload is not a blob`);
	return { batchId: row.batch_id, payload: row.payload };
}

function parseIndexRow(row: unknown): { readonly entryId: string; readonly ordinal: number } | undefined {
	if (!isObject(row) || typeof row.entry_id !== 'string' || !isSafeIntegerValue(row.ordinal)) return undefined;
	return { entryId: row.entry_id, ordinal: row.ordinal };
}

/** Decode one stored batch payload into its entries. */
function decodeBatchPayload(payload: Uint8Array, batchId: number): { readonly entries: Entry[]; readonly byteLength: number } {
	const frame = decodeFrame(payload);
	let parsed: unknown;
	try {
		parsed = JSON.parse(frame.data.toString('utf8'));
	} catch (cause) {
		throw new CorruptFrameError(`batch ${batchId}: payload is not valid JSON`, { cause });
	}
	if (!Array.isArray(parsed)) {
		throw new CorruptFrameError(`batch ${batchId}: payload is not a JSON array`);
	}
	const entries: Entry[] = [];
	parsed.forEach((item, ordinal) => {
		entries.push(parseStoredEntry(item, batchId, ordinal));
	});
	return { entries, byteLength: frame.data.length };
}

function parseStoredEntry(item: unknown, batchId: number, ordinal: number): Entry {
	if (!isObject(item) || typeof item.id !== 'string' || item.id.length === 0 || typeof item.kind !== 'string') {
		throw new CorruptFrameError(`batch ${batchId} entry ${ordinal}: malformed entry record`);
	}
	if (!('payload' in item) || !isJsonValue(item.payload)) {
		throw new CorruptFrameError(`batch ${batchId} entry ${ordinal}: payload is not JSON`);
	}
	return {
		id: item.id,
		kind: item.kind,
		payload: item.payload as JsonValue,
		seq: batchId as Seq,
		ordinal,
	};
}

/** Validate one entry draft before any write touches the database. */
function validateDraft(draft: EntryDraft): void {
	if (!isObject(draft) || typeof draft.id !== 'string' || draft.id.length === 0) {
		throw new TypeError('entry draft requires a non-empty string id');
	}
	if (typeof draft.kind !== 'string' || draft.kind.length === 0) {
		throw new TypeError(`entry ${draft.id}: kind must be a non-empty string`);
	}
	if (!('payload' in draft) || !isJsonValue(draft.payload)) {
		throw new TypeError(`entry ${draft.id}: payload must be a JSON value`);
	}
}

/** Structural JSON check; cyclic input fails later in JSON.stringify, before any write. */
function isJsonValue(value: unknown): boolean {
	if (value === null) return true;
	switch (typeof value) {
		case 'boolean':
		case 'string':
			return true;
		case 'number':
			return Number.isFinite(value);
		case 'object':
			break;
		default:
			return false;
	}
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (isObject(value)) return Object.values(value).every(isJsonValue);
	return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isSafeIntegerValue(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value);
}
