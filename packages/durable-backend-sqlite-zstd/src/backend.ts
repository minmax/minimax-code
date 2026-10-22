/**
 * `sqlite-zstd` durable backend: immutable zstd-compressed entry batches in SQLite.
 *
 * Layout of one database file (`sessions.gN.db`):
 *
 * - `batches(batch_id PK, created_ms, compressed, payload BLOB)` — one row per
 *   commit; `payload` is the envelope (magic, codec id, declared frame and
 *   uncompressed lengths — see `codec.ts`) + ONE compressed frame holding the
 *   whole batch, `compressed` the payload byte length;
 * - `entries(entry_id PK, seq, ordinal, batch_id)` — the log index
 *   `entry_id -> (batch_id, ordinal)`, ordered for windowed reads by
 *   `(batch_id, ordinal)` (`entries_by_batch`; the redundant `entries_by_seq`
 *   index of earlier wave-1 files is dropped at open, the `seq` column stays);
 * - `meta(key, value)` — format id, the log `head` (last committed sequence),
 *   the single-writer `owner_epoch`/`owner_pid`/`owner_instance` markers, and
 *   the `resume` capsule.
 *
 * Every `appendBatch()` commits batch row, index rows, head, and the resume
 * capsule in ONE SQLite transaction on a WAL journal with
 * `synchronous = FULL`, so a resolved commit is durable and later reads
 * observe it.
 *
 * Single writer (owner-epoch + owner-instance): a writable open takes
 * ownership — it bumps `meta.owner_epoch` and records its pid PLUS an instance
 * marker (uuid + wall clock) inside one transaction. A second writer whose
 * process is alive is refused at open (`OwnerWriteLockError`); a handle whose
 * epoch (or instance) moved underneath it refuses further writes
 * (`OwnerLostError`) instead of racing retries. The instance marker guards
 * against a recycled pid: a recorded pid that is alive but whose recorded
 * instance is not live in this process is treated as a dead writer whose pid
 * was reused. `close()` releases the markers; a crashed writer's pid is
 * detected as stale and stolen.
 *
 * Read integrity: batch payloads carry declared lengths in their envelopes,
 * so a torn batch (truncation, flipped byte, malformed JSON, over-deep
 * payload) fails decoding with `CorruptFrameError`. `readDeltaChecked()` walks
 * batches STREAMING (never materializing the whole log) under an uncompressed
 * window budget AND a compressed scan budget, stops at batch boundaries, and
 * reports a torn tail explicitly instead of silently confusing it with the
 * end of the log; plain `readDelta()` keeps returning the intact prefix and
 * additionally emits a warning when it stopped on a tear. Full
 * index-vs-payload agreement is a deliberate `verify()` walk, not a
 * per-read hot-path cost.
 *
 * Write-side identity: `appendBatch(entries, { idempotent: true })` skips
 * entries whose ids are already committed (classified as the domain
 * `DuplicateEntryError` otherwise), which makes split/retry loops replay-safe
 * without pre-filtering in the adapter.
 *
 * Format generations: a database opens as `sessions.gN.db`. Opening generation
 * `N + 1` next to it seals every older generation — live handles refuse writes
 * (`SealedGenerationError`) and their files lose their write bits, preserving
 * them byte-for-byte. Sealing first merges the WAL into the database file
 * (`PRAGMA wal_checkpoint(TRUNCATE)`), so a byte-copy of the `.db` alone never
 * loses the committed tail. Sealed generations stay readable.
 *
 * Synchronous core: every operation here (open, append, read, seal, close)
 * runs synchronously against better-sqlite3 on the calling thread. The async
 * signatures of `appendBatch`/`checkpoint`/`close` exist for seam
 * compatibility, not for concurrency — offloading to a worker thread is the
 * storage worker's job (`@mavis/storage-worker`'s off-thread loader), and this
 * backend deliberately stays single-threaded and blocking.
 */

import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
	DEFAULT_MAX_OUTPUT_LENGTH,
	type Codec,
	decodeFrame,
	encodeFrame,
	peekFrameUncompressedLength,
	resolveCodec,
} from './codec.js';
import { CorruptFrameError, DuplicateEntryError, OwnerLostError, OwnerWriteLockError, SealedGenerationError, SqliteZstdError } from './errors.js';
import {
	type BatchId,
	type Commit,
	type Entry,
	type EntryDraft,
	type JsonValue,
	type OpenDurableBackendOptions,
	type ResumeCapsule,
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

/**
 * Function-form alias of `SqliteZstdBackend.open`, shipped for factory-style
 * construction from worker threads (the off-thread storage worker loads a
 * module and calls an exported function; a static class method is an awkward
 * factory there).
 */
export function openSqliteZstdBackend(
	directory: string,
	options: OpenDurableBackendOptions = {},
): SqliteZstdBackend {
	return SqliteZstdBackend.open(directory, options);
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
	iterate(...params: unknown[]): IterableIterator<unknown>;
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
  batch_id INTEGER NOT NULL REFERENCES batches(batch_id)
);
CREATE INDEX IF NOT EXISTS entries_by_batch ON entries (batch_id, ordinal);
DROP INDEX IF EXISTS entries_by_seq;
INSERT OR IGNORE INTO meta (key, value) VALUES ('format', '${FORMAT_ID}');
INSERT OR IGNORE INTO meta (key, value) VALUES ('head', '${SEQ_AT_START}');
INSERT OR IGNORE INTO meta (key, value) VALUES ('owner_epoch', '0');
`;

/** Live backends per directory, so opening a newer generation seals them. */
const openBackendsByDirectory = new Map<string, Set<SqliteZstdBackend>>();

/** Instance markers of the live single-writer handles of this process. */
const liveOwnerInstances = new Set<string>();

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

/**
 * Best-effort WAL merge for a generation whose handle is NOT open in this
 * process (typically a crashed writer's leftover): a writable connection
 * runs `wal_checkpoint(TRUNCATE)` so the generation's `.db` file is complete
 * before its write bits are stripped. A live writer in another process, or an
 * already-sealed file, simply skips the hygiene step — SQLite still recovers
 * the WAL on the next normal open, and this is not a correctness gate.
 */
function checkpointGenerationWal(directory: string, generation: number): void {
	const path = join(directory, databaseFileName(generation));
	if (!existsSync(path) || !isWritablePath(path)) return;
	let db: SqliteDatabase | null = null;
	try {
		db = new DatabaseConstructor(path, { timeout: 2000 });
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	} catch {
		// Best effort (see doc): the WAL survives and remains recoverable.
	} finally {
		try {
			db?.close();
		} catch {
			// Nothing to salvage; the file is left as-is.
		}
	}
}

/**
 * A corrupt batch at the tail of a scan: the intact prefix before it was
 * served, everything from this batch on was not.
 */
export type TornTailInfo = {
	/** Batch id (= sequence) whose payload failed verification. */
	readonly batchId: number;
	/** Why the batch was rejected (checksum, truncation, malformed JSON, ...). */
	readonly reason: string;
};

/** Verdict-carrying result of a windowed delta read. */
export type ReadDeltaResult = {
	/** Intact entries of complete batches, oldest first. */
	readonly entries: Entry[];
	/**
	 * Cursor for the next window: the sequence of the last served batch, or
	 * `null` when nothing was served (log exhausted past `afterSeq`, or the
	 * very first batch is already torn).
	 */
	readonly nextAfterSeq: Seq | null;
	/**
	 * Set when the scan stopped on a corrupt batch: `entries` holds the intact
	 * prefix and the tail beyond `nextAfterSeq` was never served. `null` means
	 * the scan ended cleanly (budget reached or end of log) — "end of log" and
	 * "broken tail" are never confused.
	 */
	readonly tornTail: TornTailInfo | null;
};

/** Options of {@link SqliteZstdBackend.appendBatch}. */
export type AppendBatchOptions = {
	/**
	 * Pre-serialized UTF-8 JSON of `entries` — exactly what
	 * `JSON.stringify(entries)` produces. A caller that already serialized the
	 * batch for size accounting can hand the bytes over and spare the second
	 * serialization. The backend stores them as-is (guarded by the frame
	 * checksum and the declared envelope lengths).
	 */
	readonly serialized?: Uint8Array;
	/**
	 * Skip entries whose ids are already committed instead of failing the
	 * whole batch (idempotent retry semantics for split/retry loops). When
	 * EVERY id is already committed the call fails with
	 * `DuplicateEntryError` rather than fabricating an empty commit. Cannot
	 * combine with `serialized`.
	 */
	readonly idempotent?: boolean;
};

/** One corrupt batch found by {@link SqliteZstdBackend.verify}. */
export type VerifyIssue = {
	readonly batchId: number;
	readonly issue: string;
};

/** Report of a full log-integrity walk. */
export type VerifyResult = {
	/** Batch rows walked (including the corrupt ones listed in `issues`). */
	readonly batchesChecked: number;
	/** Entries whose payload/index agreement was confirmed. */
	readonly entriesChecked: number;
	/** One entry per corrupt batch, in batch order; empty = intact. */
	readonly issues: readonly VerifyIssue[];
};

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
	private batchCapBytes: number;
	private sealedFlag: boolean;
	private closedFlag: boolean;
	private headValue: Seq;
	private ownerEpoch: number | null;
	/** Instance marker (uuid@wallclock) this handle recorded at ownership time. */
	private ownerInstance: string | null;
	private openBatch: EntryDraft[];
	/** Uncompressed byte estimate of the open batch, for stage-time backpressure. */
	private openBatchBytes: number;

	/** Decoded tail batches for poll-style re-reads (batches are immutable). */
	private readonly decodedTailCache = new Map<number, { readonly entries: Entry[]; readonly byteLength: number }>();
	private decodedTailCacheBytes = 0;
	/** Batch ids whose torn tail was already warned about via `readDelta`. */
	private readonly tornTailsWarned = new Set<number>();

	// Prepared once per connection (readResume/getEntry/commitBatch/ownership
	// and the scan all reuse them — no per-call re-prepare).
	private metaGetStmt!: SqliteStatement;
	private setMetaStmt!: SqliteStatement;
	private insertBatchStmt!: SqliteStatement;
	private insertEntryStmt!: SqliteStatement;
	private scanBatchesStmt!: SqliteStatement;
	private batchIndexStmt!: SqliteStatement;
	private entryByIdStmt!: SqliteStatement;
	private batchByIdStmt!: SqliteStatement;
	private existingIdsStmt!: SqliteStatement;

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
	 *
	 * Exception-safe: sealing a live handle, merging a leftover WAL, or
	 * registering the new backend can fail — the just-created handle is then
	 * closed and its ownership released, so a failed call never leaves the new
	 * generation locked by a half-built backend.
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
		try {
			// Flush live handles first: sealing must not drop their open batches,
			// and the flush needs files that are still writable (and merges their
			// WAL as part of sealing).
			const sealedLive = new Set<number>();
			const registryKey = realpathSync(directory);
			for (const existing of openBackendsByDirectory.get(registryKey) ?? []) {
				if (existing.generation < generation) {
					existing.seal();
					sealedLive.add(existing.generation);
				}
			}
			for (let older = generation - 1; older >= 1; older -= 1) {
				if (existsSync(join(directory, databaseFileName(older)))) {
					if (!sealedLive.has(older)) checkpointGenerationWal(directory, older);
					sealGenerationFiles(directory, older);
				}
			}
			registerBackend(backend);
			return backend;
		} catch (error) {
			// The new generation exists and this instance took ownership of it:
			// on any failure close the handle and release the ownership so the
			// next open is not locked out by a half-built backend.
			backend.rollbackForFailedOpen();
			throw error;
		}
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
		this.batchCapBytes = options.maxBatchUncompressedBytes ?? MAX_BATCH_UNCOMPRESSED_BYTES;
		this.sealedFlag = sealed;
		this.closedFlag = false;
		this.headValue = SEQ_AT_START as Seq;
		this.ownerEpoch = null;
		this.ownerInstance = null;
		this.openBatch = [];
		this.openBatchBytes = 0;

		if (sealed) {
			db.exec('PRAGMA busy_timeout = 5000;');
			db.exec('PRAGMA mmap_size = 268435456;'); // 256 MiB window for sealed reads
			db.exec('PRAGMA cache_size = -16000;'); // 16 MiB page cache
			this.assertFormat(db);
		} else {
			// journal_mode must be VERIFIED, not fired and forgotten: a refusal
			// (e.g. a network filesystem without shared-memory support) must fail
			// the open instead of silently degrading durability.
			const modeRow = db.prepare('PRAGMA journal_mode = WAL').get() as { readonly journal_mode?: unknown } | undefined;
			if (String(modeRow?.journal_mode).toLowerCase() !== 'wal') {
				throw new SqliteZstdError(`${path}: could not enable WAL journal mode (got ${String(modeRow?.journal_mode)})`);
			}
			db.exec('PRAGMA synchronous = FULL;');
			db.exec('PRAGMA busy_timeout = 5000;');
			db.exec('PRAGMA mmap_size = 268435456;'); // 256 MiB memory-mapped reads
			db.exec('PRAGMA cache_size = -16000;'); // 16 MiB page cache
			// Enforce entries -> batches for databases created from now on (older
			// files keep their schema; the pragma is inert there).
			db.exec('PRAGMA foreign_keys = ON;');
			// A file that already holds tables must already be ours; only a
			// genuinely fresh file receives the schema, never a foreign one.
			if (hasUserTables(db)) {
				this.assertFormat(db);
				// Drop the dead `entries_by_seq` index of earlier wave-1 files
				// (the column stays; `entries_by_batch` serves every query).
				db.exec('DROP INDEX IF EXISTS entries_by_seq;');
			} else {
				db.exec(SCHEMA_SQL);
			}
		}

		this.prepareStatements(db);

		const headRow = this.metaGetStmt.get('head') as { readonly value?: unknown } | undefined;
		const head = Number(headRow?.value);
		if (!Number.isSafeInteger(head) || head < 0) {
			throw new SqliteZstdError(`${path}: meta.head is not a valid sequence (${String(headRow?.value)})`);
		}
		this.headValue = head as Seq;

		// Light structural consistency check at open: meta/batches/entries must
		// agree at the COUNT level; deep per-batch agreement is verify()'s job.
		this.assertConsistentSnapshot(db);

		if (!sealed) this.acquireOwnership(db);
	}

	/** Last committed sequence; `0` for an empty or fresh database. */
	get head(): Seq {
		this.assertOpen();
		return this.headValue;
	}

	/** The uncompressed batch cap this backend enforces, in bytes (`0` = disabled). */
	get maxBatchUncompressedBytes(): number {
		return this.batchCapBytes;
	}

	/** Whether this generation is sealed (reads allowed, writes rejected). */
	get sealed(): boolean {
		return this.sealedFlag;
	}

	/**
	 * Atomically append one batch: one frame, batch row, index rows, head — one
	 * transaction.
	 *
	 * `options.serialized` accepts a caller-provided UTF-8 JSON serialization
	 * of `entries` (spares the second stringify on the adapter path);
	 * `options.idempotent` skips already-committed entry ids so retry loops can
	 * replay a whole batch after a partial split failure.
	 */
	async appendBatch(entries: readonly EntryDraft[], options: AppendBatchOptions = {}): Promise<Commit> {
		this.assertWritable();
		for (const draft of entries) validateDraft(draft);
		if (options.serialized !== undefined && options.idempotent === true) {
			throw new TypeError('appendBatch: serialized and idempotent cannot combine — a pre-serialized batch cannot skip committed ids');
		}
		return this.commitBatch(entries, { validated: true, serialized: options.serialized, idempotent: options.idempotent });
	}

	/**
	 * Accumulate entries into the in-memory open batch without writing. The
	 * open batch becomes durable only when `checkpoint()` (or `close()`, or a
	 * seal) flushes it through the same atomic path as `appendBatch()`.
	 *
	 * Backpressure: staging is capped at the same uncompressed cap the commit
	 * enforces, so an over-full open batch is refused HERE (with a clear
	 * "checkpoint() first" message) instead of exploding at flush time. With
	 * `maxBatchUncompressedBytes: 0` the open batch is uncapped too.
	 */
	stage(entries: readonly EntryDraft[]): void {
		this.assertWritable();
		for (const draft of entries) validateDraft(draft);
		// Measure first, then push: an over-cap stage must not leave a partial
		// batch behind.
		let measured = 0;
		if (this.batchCapBytes > 0) {
			for (const draft of entries) {
				const size = Buffer.byteLength(JSON.stringify(draft), 'utf8');
				if (this.openBatchBytes + measured + size > this.batchCapBytes) {
					throw new SqliteZstdError(
						`staging entry ${draft.id} would push the open batch past the uncompressed cap ` +
							`(${this.openBatchBytes + measured + size} > ${this.batchCapBytes} bytes); checkpoint() the open batch first`,
					);
				}
				measured += size;
			}
		}
		for (const draft of entries) this.openBatch.push(draft); // no spread: batches may be large
		this.openBatchBytes += measured;
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
		const batchBytes = this.openBatchBytes;
		this.openBatch = [];
		this.openBatchBytes = 0;
		try {
			// Staged drafts were validated at stage() time: no revalidation.
			return this.commitBatch(batch, { validated: true });
		} catch (error) {
			// Fail closed: put the entries back instead of dropping them.
			this.openBatch = batch;
			this.openBatchBytes = batchBytes;
			throw error;
		}
	}

	/**
	 * Entries of committed batches with `seq > afterSeq`, oldest first, within
	 * a budget of `limitBytes` uncompressed batch bytes. Batches are atomic
	 * units: the scan stops before the batch that would overflow the budget,
	 * except the first batch past `afterSeq`, which is always returned so a
	 * reader can never stall.
	 *
	 * Compat wrapper over {@link readDeltaChecked}: the intact prefix is
	 * returned as before, but a torn tail is no longer fully silent — a
	 * one-time warning is emitted per torn batch. New callers should prefer
	 * `readDeltaChecked()` for an explicit verdict.
	 */
	readDelta(afterSeq: number, limitBytes: number): Entry[] {
		const result = this.readDeltaChecked(afterSeq, limitBytes);
		const torn = result.tornTail;
		if (torn !== null && !this.tornTailsWarned.has(torn.batchId)) {
			this.tornTailsWarned.add(torn.batchId);
			process.emitWarning(
				`readDelta stopped on a torn tail at batch ${torn.batchId} (${torn.reason}); ` +
					'the intact prefix was served — use readDeltaChecked() for an explicit verdict',
				{ code: 'SQLITE_ZSTD_TORN_TAIL' },
			);
		}
		return result.entries;
	}

	/**
	 * Like {@link readDelta}, but the result states WHY the scan stopped:
	 * `tornTail` distinguishes a corrupt tail from a clean end of log, and
	 * `nextAfterSeq` is the cursor for the next window.
	 *
	 * The scan is STREAMING (better-sqlite3 row iterator, not one `.all()`):
	 * compressed payload bytes are pulled from SQLite batch by batch under a
	 * compressed scan budget derived from `limitBytes`, and the uncompressed
	 * budget is checked per batch from the envelope's declared length BEFORE
	 * the batch is decompressed. A corrupt batch ends the scan with
	 * `tornTail` set — the intact prefix is served, the tail never is.
	 */
	readDeltaChecked(afterSeq: number, limitBytes: number): ReadDeltaResult {
		this.assertOpen();
		if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
			throw new RangeError(`afterSeq must be a non-negative safe integer, got ${afterSeq}`);
		}
		if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
			throw new RangeError(`limitBytes must be a positive safe integer, got ${limitBytes}`);
		}
		const entries: Entry[] = [];
		let budgetUsed = 0;
		let compressedScanned = 0;
		let lastServedSeq: Seq | null = null;
		let tornTail: TornTailInfo | null = null;
		// Compressed scan guard: never pull arbitrarily more compressed bytes
		// from SQLite than the window can serve (batches are pulled one row at
		// a time; the cap only bounds how FAR the iterator runs).
		const compressedCap =
			limitBytes > Number.MAX_SAFE_INTEGER / 2 ? Number.MAX_SAFE_INTEGER : limitBytes + Math.ceil(limitBytes / 2);
		for (const row of this.scanBatchesStmt.iterate(afterSeq)) {
			const batch = parseBatchRow(row);
			const isFirstBatch = lastServedSeq === null; // never stall on the first batch past afterSeq
			const declaredUncompressed = peekFrameUncompressedLength(batch.payload);
			if (!isFirstBatch) {
				// Batch-boundary stop BEFORE decoding, straight from the envelope.
				if (declaredUncompressed !== null && budgetUsed + declaredUncompressed > limitBytes) break;
				if (compressedScanned + batch.compressed > compressedCap) break;
			}
			let decoded: { readonly entries: Entry[]; readonly byteLength: number };
			try {
				decoded = this.decodeBatchCached(batch);
			} catch (error) {
				if (error instanceof CorruptFrameError) {
					tornTail = { batchId: batch.batchId, reason: error.message };
					break; // torn tail: serve the intact prefix only
				}
				// CodecUnavailableError & friends: environment problems surface
				// loudly instead of truncating the log silently.
				throw error;
			}
			// Legacy envelopes declare no length: fall back to the post-decode
			// budget check.
			if (!isFirstBatch && declaredUncompressed === null && budgetUsed + decoded.byteLength > limitBytes) break;
			for (const entry of decoded.entries) entries.push(entry);
			budgetUsed += decoded.byteLength;
			compressedScanned += batch.compressed;
			lastServedSeq = batch.batchId as Seq;
		}
		return { entries, nextAfterSeq: lastServedSeq, tornTail };
	}

	/**
	 * The durable resume capsule written by the last commit, or `null` when
	 * nothing was committed yet. One meta-row read — no batch decoding — so a
	 * reader can resume from `(seq, head)` in microseconds even on a
	 * gigabyte-scale log.
	 */
	readResume(): ResumeCapsule | null {
		this.assertOpen();
		const row = this.metaGetStmt.get('resume') as { readonly value?: unknown } | undefined;
		if (row?.value === undefined) return null;
		return parseResumeCapsule(row.value, this.path);
	}

	/**
	 * Point read by entry id: resolves the entry through the index and decodes
	 * ONLY the one batch containing it — not the whole log. `undefined` when
	 * the id was never committed.
	 *
	 * Hot path: the ordinal boundary is the cheap consistency check; the full
	 * index-vs-payload agreement walk is `verify()`'s job.
	 */
	getEntry(entryId: string): Entry | undefined {
		this.assertOpen();
		if (typeof entryId !== 'string' || entryId.length === 0) {
			throw new TypeError(`entryId must be a non-empty string, got ${JSON.stringify(entryId)}`);
		}
		const index = parseFullIndexRow(this.entryByIdStmt.get(entryId));
		if (index === undefined) return undefined;
		const batchRow = this.batchByIdStmt.get(index.batchId);
		if (batchRow === undefined) {
			throw new CorruptFrameError(`entry ${entryId}: index points at missing batch ${index.batchId}`);
		}
		const decoded = this.decodeBatchCached(parseBatchRow(batchRow));
		const entry = decoded.entries[index.ordinal];
		if (entry === undefined) {
			throw new CorruptFrameError(
				`entry ${entryId}: index ordinal ${index.ordinal} is out of range for batch ${index.batchId} (${decoded.entries.length} entries)`,
			);
		}
		return entry;
	}

	/**
	 * Windowed read anchored at an entry id: like `readDelta`, but starting
	 * at (inclusive) or right after (default) the anchor's BATCH instead of
	 * sequence `0` — resume without decoding everything before the anchor.
	 * Reads are batch-granular (batches are atomic units), so entries sharing
	 * the anchor's batch are only served with `inclusive`. The anchor resolves
	 * through the index alone, so the anchor batch is decoded exactly once —
	 * inside the scan. Throws when the anchor was never committed.
	 */
	readDeltaFrom(
		entryId: string,
		limitBytes: number,
		options: { readonly inclusive?: boolean } = {},
	): Entry[] {
		this.assertOpen();
		if (typeof entryId !== 'string' || entryId.length === 0) {
			throw new TypeError(`entryId must be a non-empty string, got ${JSON.stringify(entryId)}`);
		}
		const index = parseFullIndexRow(this.entryByIdStmt.get(entryId));
		if (index === undefined) {
			throw new SqliteZstdError(`entry ${entryId} does not exist in ${this.path}`);
		}
		const afterSeq = options.inclusive === true ? index.seq - 1 : index.seq;
		return this.readDelta(afterSeq, limitBytes);
	}

	/**
	 * Full log-integrity walk: decodes every batch from `afterSeq` on and
	 * asserts payload/index agreement — the deep check the hot read paths
	 * deliberately skip. Returns one issue per corrupt batch (in batch order);
	 * an empty `issues` array means the whole walked range is intact.
	 */
	verify(options: { readonly afterSeq?: number } = {}): VerifyResult {
		this.assertOpen();
		const afterSeq = options.afterSeq ?? SEQ_AT_START;
		if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
			throw new RangeError(`afterSeq must be a non-negative safe integer, got ${afterSeq}`);
		}
		let batchesChecked = 0;
		let entriesChecked = 0;
		const issues: VerifyIssue[] = [];
		for (const row of this.scanBatchesStmt.iterate(afterSeq)) {
			const batch = parseBatchRow(row);
			batchesChecked += 1;
			try {
				const decoded = decodeBatchPayload(batch.payload, batch.batchId, this.decodeCapBytes());
				this.assertIndexMatches(batch.batchId, decoded.entries);
				entriesChecked += decoded.entries.length;
			} catch (error) {
				if (error instanceof CorruptFrameError) {
					issues.push({ batchId: batch.batchId, issue: error.message });
					continue; // keep walking: the report covers the whole range
				}
				throw error;
			}
		}
		return { batchesChecked, entriesChecked, issues };
	}

	/**
	 * Seal this generation: flush the open batch while the file is still
	 * writable, refuse further writes, merge the WAL into the database file
	 * (`PRAGMA wal_checkpoint(TRUNCATE)` — a byte-copy of the `.db` alone then
	 * holds every commit), and strip the write bits from the generation's
	 * files. Idempotent; reads stay allowed.
	 */
	seal(): void {
		if (this.sealedFlag || this.closedFlag) return;
		if (this.openBatch.length > 0) {
			const batch = this.openBatch;
			const batchBytes = this.openBatchBytes;
			this.openBatch = [];
			this.openBatchBytes = 0;
			try {
				this.commitBatch(batch, { validated: true });
			} catch (error) {
				this.openBatch = batch;
				this.openBatchBytes = batchBytes;
				throw error;
			}
		}
		this.sealedFlag = true;
		if (this.db !== null) {
			try {
				this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
			} catch (cause) {
				// The commits are durable in the WAL either way; only the
				// single-file completeness of the sealed copy is at risk.
				process.emitWarning(`seal: wal_checkpoint(TRUNCATE) failed for ${this.path}: ${String(cause)}`, {
					code: 'SQLITE_ZSTD_SEAL_CHECKPOINT',
				});
			}
		}
		sealGenerationFiles(this.directory, this.generation);
	}

	/**
	 * Flush the open batch (unless sealed), release the single-writer lock,
	 * close the database, and make all later operations reject. Idempotent.
	 *
	 * Cleanup is exception-safe: a failed checkpoint, ownership release, or
	 * close never skips the remaining steps (ownership release, handle close,
	 * closed flag, registry removal) — the first failure is rethrown AFTER
	 * cleanup, so a rejected close never leaks the writer lock.
	 */
	async close(): Promise<void> {
		if (this.closedFlag) return;
		let failed = false;
		let firstError: unknown;
		const record = (error: unknown): void => {
			if (!failed) {
				failed = true;
				firstError = error;
			}
		};
		if (!this.sealedFlag && this.openBatch.length > 0) {
			try {
				await this.checkpoint();
			} catch (error) {
				record(error);
			}
		}
		try {
			if (!this.sealedFlag && this.ownerEpoch !== null) this.releaseOwnership();
		} catch (error) {
			record(error);
		}
		try {
			this.db?.close();
		} catch (error) {
			record(error);
		}
		this.db = null;
		this.closedFlag = true;
		try {
			unregisterBackend(this);
		} catch (error) {
			record(error);
		}
		if (failed) throw firstError;
	}

	/**
	 * Commit path shared by `appendBatch`, `checkpoint`, and sealing.
	 *
	 * Refuses to write when the single-writer epoch (or instance marker) moved
	 * underneath this handle (`OwnerLostError`): the durable view is stale,
	 * retrying would race the new owner. Also refreshes the `resume` capsule in
	 * the same transaction, so a committed batch and its resume point are
	 * atomic. A unique-constraint failure on `entries.entry_id` is classified
	 * as the domain `DuplicateEntryError`.
	 */
	private commitBatch(
		drafts: readonly EntryDraft[],
		options: { readonly validated?: boolean; readonly serialized?: Uint8Array; readonly idempotent?: boolean } = {},
	): Commit {
		if (drafts.length === 0) {
			// A commit without entries would advance the head for nothing;
			// `checkpoint()` reports an empty open batch as `undefined` instead.
			throw new TypeError('batch must contain at least one entry');
		}
		// Drafts that arrive from stage()/checkpoint() were validated at stage
		// time; appendBatch validates once at its own boundary.
		if (options.validated !== true) for (const draft of drafts) validateDraft(draft);
		let source = drafts;
		if (options.idempotent === true) {
			source = this.filterUncommittedIds(drafts);
			if (source.length === 0) {
				throw new DuplicateEntryError(
					`all ${drafts.length} entries are already committed; the idempotent append has nothing to write`,
				);
			}
		}
		// The JSON string itself is never bound: only its byte image survives
		// this line, so string + bytes + frame never pile up simultaneously.
		const jsonBytes = options.serialized ?? Buffer.from(JSON.stringify(source), 'utf8');
		if (this.batchCapBytes > 0 && jsonBytes.length > this.batchCapBytes) {
			throw new SqliteZstdError(
				`batch exceeds the uncompressed cap: ${jsonBytes.length} > ${this.batchCapBytes} bytes`,
			);
		}
		const frame = encodeFrame(this.codec.name, jsonBytes);
		const uncompressedBytes = jsonBytes.length;
		const db = this.db;
		if (db === null) throw new SqliteZstdError(`backend at ${this.path} is closed`);
		const codecName = this.codec.name;
		const ownerEpoch = this.ownerEpoch;
		const ownerInstance = this.ownerInstance;
		const path = this.path;
		let commit: Commit;
		try {
			commit = db.transaction(() => {
				// Ownership first: if another writer took over, THIS handle is
				// stale no matter what the head says — the terminal cause must
				// not be masked by a secondary divergence error.
				if (ownerEpoch !== null) {
					const epochRow = this.metaGetStmt.get('owner_epoch') as { readonly value?: unknown } | undefined;
					if (Number(epochRow?.value) !== ownerEpoch) {
						throw new OwnerLostError(
							`${path}: owner epoch moved (${String(epochRow?.value)} != ${ownerEpoch}); ` +
								'another writer took over this generation',
						);
					}
					const instanceRow = this.metaGetStmt.get('owner_instance') as { readonly value?: unknown } | undefined;
					if (String(instanceRow?.value ?? '') !== ownerInstance) {
						throw new OwnerLostError(
							`${path}: owner instance moved (${String(instanceRow?.value)} != ${ownerInstance}); ` +
								'another writer took over this generation',
						);
					}
				}
				// Re-read the head inside the transaction: the new sequence is
				// derived from the durable head, keeping it strictly monotonic.
				const headRow = this.metaGetStmt.get('head') as { readonly value?: unknown } | undefined;
				const currentHead = Number(headRow?.value);
				if (!Number.isSafeInteger(currentHead) || currentHead < 0 || currentHead !== this.headValue) {
					throw new SqliteZstdError(`${path}: durable head ${String(headRow?.value)} diverged from ${this.headValue}`);
				}
				const seq = (currentHead + 1) as Seq;
				this.insertBatchStmt.run(seq, Date.now(), frame.length, frame);
				let ordinal = 0;
				for (const draft of source) {
					this.insertEntryStmt.run(draft.id, seq, ordinal, seq);
					ordinal += 1;
				}
				this.setMetaStmt.run('head', String(seq));
				this.setMetaStmt.run(
					'resume',
					JSON.stringify({
						batchId: seq,
						seq,
						head: seq,
						entryCount: source.length,
						updatedMs: Date.now(),
					} satisfies ResumeCapsule),
				);
				return {
					seq,
					batchId: seq as unknown as BatchId,
					entryCount: source.length,
					head: seq,
					codec: codecName,
					compressedBytes: frame.length,
					uncompressedBytes,
				} satisfies Commit;
			})();
		} catch (error) {
			// Classify the raw SQLite constraint into the domain error (the
			// transaction has already rolled back; head and rows are untouched).
			if (isEntryIdConstraint(error)) {
				throw new DuplicateEntryError(`${path}: entry id already committed (UNIQUE constraint failed on entries.entry_id)`, {
					cause: error,
				});
			}
			throw error;
		}
		this.headValue = commit.head;
		return commit;
	}

	/**
	 * Takes single-writer ownership inside one transaction: bumps the durable
	 * `owner_epoch` and records this process's pid PLUS an instance marker
	 * (uuid + wall clock). A second writer whose process is alive — including
	 * a second handle in this process — is refused; a stale pid (crashed
	 * writer) is stolen, and so is a pid that is alive only because the OS
	 * recycled it (recorded instance not live in this process).
	 */
	private acquireOwnership(db: SqliteDatabase): void {
		db.transaction(() => {
			const epochRow = this.metaGetStmt.get('owner_epoch') as { readonly value?: unknown } | undefined;
			const epoch = Number(epochRow?.value);
			if (!Number.isSafeInteger(epoch) || epoch < 0) {
				throw new SqliteZstdError(
					`${this.path}: meta.owner_epoch is not a valid epoch (${String(epochRow?.value)})`,
				);
			}
			const pidRow = this.metaGetStmt.get('owner_pid') as { readonly value?: unknown } | undefined;
			const ownerPid = pidRow?.value === undefined || pidRow.value === '' ? undefined : Number(pidRow.value);
			const instanceRow = this.metaGetStmt.get('owner_instance') as { readonly value?: unknown } | undefined;
			const ownerInstance = typeof instanceRow?.value === 'string' && instanceRow.value !== '' ? instanceRow.value : undefined;
			if (ownerPid !== undefined) {
				if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
					throw new SqliteZstdError(
						`${this.path}: meta.owner_pid is not a valid pid (${String(pidRow?.value)})`,
					);
				}
				if (isProcessAlive(ownerPid)) {
					// A live pid whose recorded instance is not live in this
					// process is a recycled pid: the recording writer is gone.
					const pidRecycled =
						ownerPid === process.pid && (ownerInstance === undefined || !liveOwnerInstances.has(ownerInstance));
					if (!pidRecycled) {
						throw new OwnerWriteLockError(
							`${this.path}: another writer owns this generation (pid ${ownerPid}` +
								`${ownerInstance === undefined ? '' : `, instance ${ownerInstance}`}); ` +
								'open a newer generation or wait for it to close',
						);
					}
				}
			}
			const instance = `${randomUUID()}@${Date.now()}`;
			this.setMetaStmt.run('owner_epoch', String(epoch + 1));
			this.setMetaStmt.run('owner_pid', String(process.pid));
			this.setMetaStmt.run('owner_instance', instance);
			this.ownerEpoch = epoch + 1;
			this.ownerInstance = instance;
			liveOwnerInstances.add(instance);
		})();
	}

	/**
	 * Release the pid + instance markers; the epoch stays (it must move).
	 * Failures propagate — `close()` aggregates them and rethrows after
	 * cleanup instead of swallowing silently. A failed release leaves a stale
	 * pid, which open() detects as dead and steals.
	 */
	private releaseOwnership(): void {
		const instance = this.ownerInstance;
		this.ownerEpoch = null;
		this.ownerInstance = null;
		if (instance !== null) liveOwnerInstances.delete(instance);
		const db = this.db;
		if (db === null) return;
		this.setMetaStmt.run('owner_pid', '');
		this.setMetaStmt.run('owner_instance', '');
	}

	/**
	 * Failure path of `openNextGeneration`: the just-constructed instance took
	 * ownership of the new generation but never became usable — release the
	 * ownership and close the handle so the next open is not locked out.
	 */
	private rollbackForFailedOpen(): void {
		try {
			this.releaseOwnership();
		} catch (cause) {
			// The original open failure is rethrown by the caller; a failed
			// rollback leaves a stale pid that open() detects as dead and steals.
			process.emitWarning(`openNextGeneration: ownership rollback failed for ${this.path}: ${String(cause)}`, {
				code: 'SQLITE_ZSTD_OWNERSHIP_ROLLBACK',
			});
		}
		try {
			this.db?.close();
		} catch (cause) {
			process.emitWarning(`openNextGeneration: closing the new generation failed for ${this.path}: ${String(cause)}`, {
				code: 'SQLITE_ZSTD_OWNERSHIP_ROLLBACK',
			});
		}
		this.db = null;
		this.closedFlag = true;
	}

	/** The stored format must be ours; a foreign file is never rewritten. */
	private assertFormat(db: SqliteDatabase): void {
		// Cold path (once per open, possibly before the statement cache exists):
		// inline prepare is deliberate here.
		const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined;
		if (!hasMeta) throw new SqliteZstdError(`${this.path}: not a ${FORMAT_ID} database (no meta table)`);
		const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('format') as
			| { readonly value?: unknown }
			| undefined;
		if (row?.value !== FORMAT_ID) {
			throw new SqliteZstdError(`${this.path}: not a ${FORMAT_ID} database (format: ${String(row?.value)})`);
		}
	}

	/**
	 * Light structural consistency of meta/batches/entries at open (no batch
	 * decoding): the head equals the last stored batch id, no index entry
	 * dangles, and the resume capsule agrees with the head. Divergence fails
	 * the open with a diagnostic instead of serving a shifted log.
	 */
	private assertConsistentSnapshot(db: SqliteDatabase): void {
		const batchStats = db
			.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(batch_id), 0) AS maxBatch FROM batches')
			.get() as { readonly count?: unknown; readonly maxBatch?: unknown } | undefined;
		const entryStats = db.prepare('SELECT COUNT(*) AS count FROM entries').get() as
			| { readonly count?: unknown }
			| undefined;
		const danglingStats = db
			.prepare('SELECT COUNT(*) AS count FROM entries WHERE NOT EXISTS (SELECT 1 FROM batches b WHERE b.batch_id = entries.batch_id)')
			.get() as { readonly count?: unknown } | undefined;
		const batchCount = Number(batchStats?.count);
		const maxBatch = Number(batchStats?.maxBatch);
		const entryCount = Number(entryStats?.count);
		const dangling = Number(danglingStats?.count);
		if (
			!Number.isSafeInteger(batchCount) ||
			batchCount < 0 ||
			!Number.isSafeInteger(maxBatch) ||
			maxBatch < 0 ||
			!Number.isSafeInteger(entryCount) ||
			entryCount < 0 ||
			!Number.isSafeInteger(dangling) ||
			dangling < 0
		) {
			throw new SqliteZstdError(`${this.path}: batches/entries metadata is not readable counts`);
		}
		const head = this.headValue;
		if (maxBatch !== head) {
			throw new SqliteZstdError(
				`${this.path}: meta.head (${head}) disagrees with the last stored batch (${maxBatch}); ` +
					`${batchCount} batches / ${entryCount} index entries on file`,
			);
		}
		if (dangling !== 0) {
			throw new SqliteZstdError(
				`${this.path}: ${dangling} index entries point at batches that do not exist ` +
					`(${batchCount} batches / ${entryCount} index entries on file)`,
			);
		}
		const resumeRow = this.metaGetStmt.get('resume') as { readonly value?: unknown } | undefined;
		if (head === SEQ_AT_START) {
			if (resumeRow?.value !== undefined) {
				throw new SqliteZstdError(`${this.path}: meta.resume exists although the log is empty (head 0)`);
			}
			return;
		}
		if (resumeRow?.value === undefined) {
			throw new SqliteZstdError(`${this.path}: meta.resume is missing although head is ${head}`);
		}
		const resume = parseResumeCapsule(resumeRow.value, this.path);
		if (resume.seq !== head || resume.batchId !== head) {
			throw new SqliteZstdError(
				`${this.path}: meta.resume points at batch ${resume.batchId}/seq ${resume.seq} while head is ${head}`,
			);
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

	/** Prepare every statement once per connection (no per-call re-prepare). */
	private prepareStatements(db: SqliteDatabase): void {
		this.metaGetStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
		this.setMetaStmt = db.prepare(
			'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
		);
		this.insertBatchStmt = db.prepare(
			'INSERT INTO batches (batch_id, created_ms, compressed, payload) VALUES (?, ?, ?, ?)',
		);
		this.insertEntryStmt = db.prepare('INSERT INTO entries (entry_id, seq, ordinal, batch_id) VALUES (?, ?, ?, ?)');
		this.scanBatchesStmt = db.prepare('SELECT batch_id, compressed, payload FROM batches WHERE batch_id > ? ORDER BY batch_id ASC');
		this.batchIndexStmt = db.prepare('SELECT entry_id, ordinal FROM entries WHERE batch_id = ? ORDER BY ordinal ASC');
		this.entryByIdStmt = db.prepare('SELECT entry_id, seq, ordinal, batch_id FROM entries WHERE entry_id = ?');
		this.batchByIdStmt = db.prepare('SELECT batch_id, compressed, payload FROM batches WHERE batch_id = ?');
		this.existingIdsStmt = db.prepare(
			`SELECT entry_id FROM entries WHERE entry_id IN (${ID_FILTER_CHUNK_PARAMS})`,
		);
	}

	/**
	 * Idempotent-append existence filter: drops drafts whose ids are already
	 * committed. One indexed SELECT per chunk; safe against concurrent writers
	 * because the single-writer epoch is re-checked inside the commit
	 * transaction after the filter ran.
	 */
	private filterUncommittedIds(drafts: readonly EntryDraft[]): readonly EntryDraft[] {
		const remaining: EntryDraft[] = [];
		for (let offset = 0; offset < drafts.length; offset += ID_FILTER_CHUNK) {
			const chunk = drafts.slice(offset, offset + ID_FILTER_CHUNK);
			const params: unknown[] = chunk.map((draft) => draft.id);
			while (params.length < ID_FILTER_CHUNK) params.push(null); // unused placeholders never match
			const rows = this.existingIdsStmt.all(...params) as Array<{ readonly entry_id?: unknown }>;
			const committed = new Set<string>();
			for (const row of rows) {
				if (typeof row?.entry_id === 'string') committed.add(row.entry_id);
			}
			for (const draft of chunk) {
				if (!committed.has(draft.id)) remaining.push(draft);
			}
		}
		return remaining;
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

	/** Decompression output bound this backend decodes under. */
	private decodeCapBytes(): number {
		return this.batchCapBytes > 0 ? this.batchCapBytes : DEFAULT_MAX_OUTPUT_LENGTH;
	}

	/**
	 * Decode one batch, memoized: poll-style re-reads of the tail skip the
	 * decompress + JSON.parse entirely. Batches are immutable once written, so
	 * the cache never invalidates; it is bounded in both batches and decoded
	 * bytes and evicts oldest-first.
	 */
	private decodeBatchCached(batch: BatchRow): { readonly entries: Entry[]; readonly byteLength: number } {
		const hit = this.decodedTailCache.get(batch.batchId);
		if (hit !== undefined) {
			// LRU refresh: re-insertion moves the batch to the newest end.
			this.decodedTailCache.delete(batch.batchId);
			this.decodedTailCache.set(batch.batchId, hit);
			return hit;
		}
		const decoded = decodeBatchPayload(batch.payload, batch.batchId, this.decodeCapBytes());
		this.decodedTailCache.set(batch.batchId, decoded);
		this.decodedTailCacheBytes += decoded.byteLength;
		while (
			(this.decodedTailCache.size > DECODED_CACHE_MAX_BATCHES || this.decodedTailCacheBytes > DECODED_CACHE_MAX_BYTES) &&
			this.decodedTailCache.size > 1
		) {
			const oldestId = this.decodedTailCache.keys().next().value;
			if (oldestId === undefined) break;
			const oldest = this.decodedTailCache.get(oldestId);
			this.decodedTailCache.delete(oldestId);
			if (oldest !== undefined) this.decodedTailCacheBytes -= oldest.byteLength;
		}
		return decoded;
	}
}

const DatabaseConstructor = loadSqlite3Constructor();

/** Decoded-batch cache bounds (batches are immutable, so entries never invalidate). */
const DECODED_CACHE_MAX_BATCHES = 64;
const DECODED_CACHE_MAX_BYTES = 4 * 1024 * 1024;

/** Depth limit for JSON payloads, shared by the write and read validation. */
const MAX_JSON_DEPTH = 512;

/** Chunk size of the idempotent-append existence filter. */
const ID_FILTER_CHUNK = 256;
const ID_FILTER_CHUNK_PARAMS = Array.from({ length: ID_FILTER_CHUNK }, () => '?').join(', ');

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
	readonly compressed: number;
	readonly payload: Uint8Array;
};

function parseBatchRow(row: unknown): BatchRow {
	if (!isObject(row)) throw new SqliteZstdError(`unexpected batch row shape: ${typeof row}`);
	if (!isSafeIntegerValue(row.batch_id)) throw new SqliteZstdError(`batch row has an invalid batch_id: ${String(row.batch_id)}`);
	if (!isSafeIntegerValue(row.compressed) || row.compressed < 0) {
		throw new SqliteZstdError(`batch ${String(row.batch_id)} has an invalid compressed length: ${String(row.compressed)}`);
	}
	if (!(row.payload instanceof Uint8Array)) throw new SqliteZstdError(`batch ${String(row.batch_id)} payload is not a blob`);
	return { batchId: row.batch_id, compressed: row.compressed, payload: row.payload };
}

function parseIndexRow(row: unknown): { readonly entryId: string; readonly ordinal: number } | undefined {
	if (!isObject(row) || typeof row.entry_id !== 'string' || !isSafeIntegerValue(row.ordinal)) return undefined;
	return { entryId: row.entry_id, ordinal: row.ordinal };
}

/** Full index row shape used by point reads (`entry_id, seq, ordinal, batch_id`). */
function parseFullIndexRow(
	row: unknown,
): { readonly seq: number; readonly ordinal: number; readonly batchId: number } | undefined {
	if (!isObject(row) || !isSafeIntegerValue(row.seq) || !isSafeIntegerValue(row.ordinal) || !isSafeIntegerValue(row.batch_id)) {
		return undefined;
	}
	return { seq: row.seq, ordinal: row.ordinal, batchId: row.batch_id };
}

/** Decode one stored batch payload into its entries. */
function decodeBatchPayload(
	payload: Uint8Array,
	batchId: number,
	maxOutputLength: number,
): { readonly entries: Entry[]; readonly byteLength: number } {
	const frame = decodeFrame(payload, { maxOutputLength });
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
	if (!('payload' in item)) {
		throw new CorruptFrameError(`batch ${batchId} entry ${ordinal}: payload is missing`);
	}
	// JSON.parse output is structurally JSON by construction (acyclic, finite
	// numbers) — only the depth limit needs checking, iteratively, so an
	// over-deep hand-crafted payload raises CorruptFrameError instead of a
	// stack-climbing RangeError.
	if (exceedsJsonDepth(item.payload, MAX_JSON_DEPTH)) {
		throw new CorruptFrameError(`batch ${batchId} entry ${ordinal}: payload exceeds the JSON depth limit of ${MAX_JSON_DEPTH}`);
	}
	let parentId: string | null | undefined;
	if ('parentId' in item) {
		if (item.parentId !== null && typeof item.parentId !== 'string') {
			throw new CorruptFrameError(`batch ${batchId} entry ${ordinal}: parentId is not a string or null`);
		}
		parentId = item.parentId;
	}
	return {
		id: item.id,
		parentId,
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
	if (draft.parentId !== undefined && draft.parentId !== null && typeof draft.parentId !== 'string') {
		throw new TypeError(`entry ${draft.id}: parentId must be a string or null`);
	}
	if (typeof draft.kind !== 'string' || draft.kind.length === 0) {
		throw new TypeError(`entry ${draft.id}: kind must be a non-empty string`);
	}
	// `payload` is required by the draft type; an absent one surfaces here as
	// the same validation TypeError via the JSON check.
	assertJsonValue(draft.payload, `entry ${draft.id}: payload`);
}

/** Whether the pid could still be a live writer (`EPERM` counts as alive). */
function isProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Parse and validate the `meta.resume` capsule value. */
function parseResumeCapsule(value: unknown, path: string): ResumeCapsule {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(value));
	} catch (cause) {
		throw new SqliteZstdError(`${path}: meta.resume is not valid JSON`, { cause });
	}
	if (
		!isObject(parsed) ||
		!isSafeIntegerValue(parsed.batchId) ||
		!isSafeIntegerValue(parsed.seq) ||
		!isSafeIntegerValue(parsed.head) ||
		!isSafeIntegerValue(parsed.entryCount) ||
		typeof parsed.updatedMs !== 'number' ||
		!Number.isFinite(parsed.updatedMs)
	) {
		throw new SqliteZstdError(`${path}: meta.resume is not a valid resume capsule`);
	}
	return {
		batchId: parsed.batchId,
		seq: parsed.seq as Seq,
		head: parsed.head as Seq,
		entryCount: parsed.entryCount,
		updatedMs: parsed.updatedMs,
	};
}

/**
 * Iterative, depth-limited JSON-value validation for the WRITE path: a cyclic
 * payload raises the validation TypeError (not a stack-climbing RangeError),
 * an over-deep payload is refused at the same depth the read path accepts,
 * and no recursive traversal ever runs on attacker-shaped inputs.
 */
function assertJsonValue(root: unknown, label: string): void {
	type Frame = { readonly container: object; readonly children: Iterator<unknown> };
	const frames: Frame[] = [];
	const onPath = new Set<object>();
	let pending: unknown = root;
	for (;;) {
		if (pending !== null && typeof pending === 'object') {
			if (onPath.has(pending)) {
				throw new TypeError(`${label} must be a JSON value (cyclic structure)`);
			}
			if (frames.length + 1 > MAX_JSON_DEPTH) {
				throw new TypeError(`${label} exceeds the JSON depth limit of ${MAX_JSON_DEPTH}`);
			}
			const container = pending;
			onPath.add(container);
			const children: Iterator<unknown> = Array.isArray(container)
				? (container as readonly unknown[])[Symbol.iterator]()
				: Object.values(container as Record<string, unknown>)[Symbol.iterator]();
			frames.push({ container, children });
		} else if (pending === null || typeof pending === 'boolean' || typeof pending === 'string') {
			// JSON leaf: valid as-is.
		} else if (typeof pending === 'number') {
			if (!Number.isFinite(pending)) {
				throw new TypeError(`${label} must be a JSON value (non-finite number)`);
			}
		} else {
			throw new TypeError(`${label} must be a JSON value (got ${typeof pending})`);
		}
		// Advance to the next pending child, unwinding finished containers.
		let advanced = false;
		while (frames.length > 0) {
			const top = frames[frames.length - 1]!;
			const next = top.children.next();
			if (next.done === true) {
				frames.pop();
				onPath.delete(top.container);
				continue;
			}
			pending = next.value;
			advanced = true;
			break;
		}
		if (!advanced) return;
	}
}

/** Iterative depth check for parsed payloads (read path); true when deeper than `limit`. */
function exceedsJsonDepth(root: unknown, limit: number): boolean {
	const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: root, depth: 1 }];
	while (stack.length > 0) {
		const { value, depth } = stack.pop()!;
		if (depth > limit) return true;
		if (Array.isArray(value)) {
			for (const item of value) stack.push({ value: item, depth: depth + 1 });
		} else if (typeof value === 'object' && value !== null) {
			for (const item of Object.values(value as Record<string, unknown>)) stack.push({ value: item, depth: depth + 1 });
		}
	}
	return false;
}

/** Whether a raw SQLite error is the entries.entry_id unique constraint. */
function isEntryIdConstraint(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as { readonly code?: unknown }).code;
	if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT')) return false;
	return /entries\.entry_id/.test(error.message);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isSafeIntegerValue(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value);
}
