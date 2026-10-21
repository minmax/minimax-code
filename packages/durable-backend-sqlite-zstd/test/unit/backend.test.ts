import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteZstdBackend } from '../../src/index.js';
import { decodeFrame, encodeFrame, getCodec, resolveCodec } from '../../src/codec.js';
import { DuplicateEntryError } from '../../src/errors.js';
import {
	CorruptFrameError,
	FORMAT_ID,
	isZstdSupported,
	MAX_BATCH_UNCOMPRESSED_BYTES,
	OwnerLostError,
	OwnerWriteLockError,
	type Commit,
	type EntryDraft,
	SEQ_AT_START,
	SqliteZstdError,
	SealedGenerationError,
	loadSqlite3Constructor,
} from '../../src/index.js';

const Database = loadSqlite3Constructor();

let workDir: string;

/** Flip the last byte — where the frame checksum lives — to simulate a torn write. */
function flipLastByte(buffer: Buffer): Buffer {
	const torn = Buffer.from(buffer);
	const last = torn.length - 1;
	torn[last] = (torn[last] ?? 0) ^ 0xff;
	return torn;
}

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'sqlite-zstd-'));
});

afterEach(() => {
	bestEffortUnseal(workDir);
	rmSync(workDir, { recursive: true, force: true });
});

/** Sealed files keep their write bits stripped; restore them so removal never fails. */
function bestEffortUnseal(directory: string): void {
	if (!existsSync(directory)) return;
	for (const name of readdirSync(directory)) {
		if (!/^sessions\.g\d+\.db/.test(name)) continue;
		try {
			chmodSync(join(directory, name), 0o644);
		} catch {
			// Removal below is best effort on every platform.
		}
	}
}

function draft(id: string, payload: unknown, kind = 'pi.user'): EntryDraft {
	return { id, kind, payload: payload as EntryDraft['payload'] };
}

function drafts(count: number, offset = 0): EntryDraft[] {
	return Array.from({ length: count }, (_, index) =>
		draft(`e-${offset + index}`, { position: offset + index, note: `запись №${offset + index}` }),
	);
}

function commitSeqs(commits: readonly Commit[]): number[] {
	return commits.map((commit) => commit.seq);
}

describe('codec seam', () => {
	it('resolves zstd when the runtime provides it and falls back to gzip', () => {
		const resolved = resolveCodec();
		expect(resolved.name).toBe(isZstdSupported() ? 'zstd' : 'gzip');
		expect(resolveCodec('gzip').name).toBe('gzip');
		if (isZstdSupported()) {
			expect(resolveCodec('zstd').name).toBe('zstd');
			expect(getCodec('zstd').compress(Buffer.from('x')).length).toBeGreaterThan(0);
		} else {
			expect(() => getCodec('zstd')).toThrow(SqliteZstdError);
		}
	});

	it('round-trips a frame through the envelope', () => {
		const name = isZstdSupported() ? 'zstd' : 'gzip';
		const original = Buffer.from('batch payload 🚀 '.repeat(64), 'utf8');
		const decoded = decodeFrame(encodeFrame(name, original));
		expect(decoded.name).toBe(name);
		expect(decoded.data.equals(original)).toBe(true);
	});

	it('rejects frames with a broken envelope', () => {
		expect(() => decodeFrame(Buffer.from('MZS1'))).toThrow(CorruptFrameError);
		expect(() => decodeFrame(Buffer.from('nope-not-a-frame'))).toThrow(CorruptFrameError);
		expect(() => decodeFrame(Buffer.concat([Buffer.from('MZS1', 'ascii'), Buffer.from([0x7f]), Buffer.alloc(8)]))).toThrow(
			CorruptFrameError,
		);
	});

	it('detects a flipped byte inside the compressed frame', () => {
		if (!isZstdSupported()) return; // gzip path asserts the same guarantee below
		const frame = encodeFrame('zstd', Buffer.from('checksummed content', 'utf8'));
		const torn = flipLastByte(frame); // the frame checksum lives in the last bytes
		expect(() => decodeFrame(torn)).toThrow(CorruptFrameError);
	});

	it('detects a flipped byte in a gzip frame', () => {
		const frame = encodeFrame('gzip', Buffer.from('checksummed content', 'utf8'));
		const torn = flipLastByte(frame);
		expect(() => decodeFrame(torn)).toThrow(CorruptFrameError);
	});

	it('rejects frames cut by 1/2/4/8 bytes via the declared frame length', () => {
		// node:zlib's zstd decoder happily decodes a frame whose trailing
		// checksum bytes were cut off — only the envelope's declared lengths
		// make the truncation detectable.
		const name = isZstdSupported() ? ('zstd' as const) : ('gzip' as const);
		const frame = encodeFrame(name, Buffer.from('declared lengths guard the tail', 'utf8'));
		for (const cut of [1, 2, 4, 8]) {
			expect(() => decodeFrame(frame.subarray(0, frame.length - cut))).toThrow(/frame length mismatch/);
		}
		expect(() => decodeFrame(Buffer.concat([frame, Buffer.alloc(4)]))).toThrow(/frame length mismatch/);
		const decoded = decodeFrame(frame);
		expect(decoded.name).toBe(name);
		expect(decoded.data.toString('utf8')).toBe('declared lengths guard the tail');
	});

	it('still decodes a legacy MZS1 envelope through the checksum alone', () => {
		// The zstd bindings are optional at the @types/node level; mirror the
		// structural view codec.ts compiles with.
		const zstd = zlib as typeof zlib & {
			readonly zstdCompressSync?: (data: Uint8Array, options?: { readonly params?: Readonly<Record<number, number>> }) => Buffer;
			readonly ZSTD_c_checksumFlag?: number;
		};
		if (zstd.zstdCompressSync === undefined || typeof zstd.ZSTD_c_checksumFlag !== 'number') return;
		const content = Buffer.from('legacy envelope content', 'utf8');
		const legacy = Buffer.concat([
			Buffer.from('MZS1', 'ascii'),
			Buffer.from([0x01]), // zstd codec id
			zstd.zstdCompressSync(content, { params: { [zstd.ZSTD_c_checksumFlag]: 1 } }),
		]);
		const decoded = decodeFrame(legacy);
		expect(decoded.name).toBe('zstd');
		expect(decoded.data.equals(content)).toBe(true);
	});

	it('refuses a decompression bomb past the output limit', () => {
		// A few kilobytes of compressed zeros claim megabytes of output: the
		// declared length is checked against the cap before any decompression.
		const bomb = encodeFrame('gzip', Buffer.alloc(4 * 1024 * 1024));
		expect(() => decodeFrame(bomb, { maxOutputLength: 1024 })).toThrow(CorruptFrameError);
		expect(decodeFrame(bomb).data.length).toBe(4 * 1024 * 1024); // within the default limit it decodes
	});
});

describe('appendBatch -> readDelta round trip', () => {
	it('reads every entry back in commit order with stamped positions', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		const first = await backend.appendBatch(drafts(3, 0));
		const second = await backend.appendBatch(drafts(2, 10));
		const third = await backend.appendBatch([draft('special', { nested: [1, { deep: null }], flag: true }, 'pi.assistant')]);

		expect(commitSeqs([first, second, third])).toEqual([1, 2, 3]);
		expect(backend.head).toBe(3);

		const all = backend.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER);
		expect(all.map((entry) => entry.id)).toEqual(['e-0', 'e-1', 'e-2', 'e-10', 'e-11', 'special']);
		expect(all.map((entry) => entry.seq)).toEqual([1, 1, 1, 2, 2, 3]);
		expect(all.map((entry) => entry.ordinal)).toEqual([0, 1, 2, 0, 1, 0]);
		expect(all[5]).toMatchObject({ kind: 'pi.assistant', payload: { nested: [1, { deep: null }], flag: true } });
		expect(all[0]?.payload).toMatchObject({ position: 0, note: 'запись №0' });
		await backend.close();
	});

	it('windows the delta by afterSeq and by the byte budget', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		const first = await backend.appendBatch(drafts(3, 0));
		const second = await backend.appendBatch(drafts(2, 10));
		await backend.appendBatch(drafts(4, 20));

		const rest = backend.readDelta(first.seq, Number.MAX_SAFE_INTEGER);
		expect(rest.map((entry) => entry.id)).toEqual(['e-10', 'e-11', 'e-20', 'e-21', 'e-22', 'e-23']);

		const both = backend.readDelta(SEQ_AT_START, first.uncompressedBytes + second.uncompressedBytes);
		expect(both).toHaveLength(5);
		const one = backend.readDelta(SEQ_AT_START, first.uncompressedBytes + 1);
		expect(one.map((entry) => entry.seq)).toEqual([1, 1, 1]);
		// Batches are atomic units, but the first batch past afterSeq is always
		// served so a reader can never stall on an over-budget batch.
		const progress = backend.readDelta(first.seq, 1);
		expect(progress.map((entry) => entry.seq)).toEqual([2, 2]);
		expect(backend.readDelta(backend.head, Number.MAX_SAFE_INTEGER)).toEqual([]);
		await backend.close();
	});

	it('validates arguments and entry drafts before writing', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		expect(() => backend.readDelta(0, 0)).toThrow(RangeError);
		expect(() => backend.readDelta(-1, 1024)).toThrow(RangeError);
		expect(() => backend.readDelta(1.5, 1024)).toThrow(RangeError);
		await expect(backend.appendBatch([])).rejects.toThrow(TypeError);
		await expect(backend.appendBatch([draft('', {})])).rejects.toThrow(TypeError);
		await expect(backend.appendBatch([{ id: 'x', kind: 'k', payload: undefined as never }])).rejects.toThrow(TypeError);
		await expect(backend.appendBatch([{ id: 'y', kind: 'k', payload: Number.NaN }])).rejects.toThrow(TypeError);
		expect(backend.head).toBe(SEQ_AT_START);
		await backend.close();
	});

	it('stores the contract schema: one frame per commit, index rows, head', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(3, 0));
		await backend.appendBatch(drafts(2, 10));
		await backend.close();

		const raw = new Database(join(workDir, 'sessions.g1.db'), { readonly: true, fileMustExist: true });
		try {
			const batchColumns = (raw.prepare('PRAGMA table_info(batches)').all() as Array<{ name: string }>).map((column) => column.name);
			expect(batchColumns).toEqual(['batch_id', 'created_ms', 'compressed', 'payload']);
			const indexColumns = (raw.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map((column) => column.name);
			expect(indexColumns).toEqual(['entry_id', 'seq', 'ordinal', 'batch_id']);

			const batches = raw.prepare('SELECT batch_id, created_ms, compressed, payload FROM batches ORDER BY batch_id').all() as Array<{
				batch_id: number;
				created_ms: number;
				compressed: number;
				payload: Buffer;
			}>;
			expect(batches).toHaveLength(2);
			for (const batch of batches) {
				expect(batch.compressed).toBe(batch.payload.length);
				expect(batch.payload.subarray(0, 4).toString('ascii')).toBe('MZS2');
			}
			const indexRows = raw.prepare('SELECT entry_id, seq, ordinal, batch_id FROM entries ORDER BY seq, ordinal').all() as Array<{
				entry_id: string;
				seq: number;
				ordinal: number;
				batch_id: number;
			}>;
			expect(indexRows).toHaveLength(5);
			expect(indexRows[3]).toMatchObject({ entry_id: 'e-10', seq: 2, ordinal: 0, batch_id: 2 });
			const head = raw.prepare("SELECT value FROM meta WHERE key = 'head'").get() as { value: string };
			expect(Number(head.value)).toBe(2);
			const format = raw.prepare("SELECT value FROM meta WHERE key = 'format'").get() as { value: string };
			expect(format.value).toBe(FORMAT_ID);
		} finally {
			raw.close();
		}
	});

	it('keeps failed commits atomic: duplicate ids leave head and rows untouched', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		await expect(backend.appendBatch([draft('e-0', 'duplicate')])).rejects.toThrow(/UNIQUE/i);
		expect(backend.head).toBe(1);
		expect(backend.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER)).toHaveLength(2);
		// The failed batch consumed no sequence: the next commit takes head + 1.
		const next = await backend.appendBatch(drafts(1, 50));
		expect(next.seq).toBe(2);
		await backend.close();
	});

	it('classifies a duplicate entry id as the domain DuplicateEntryError', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		const error = await backend.appendBatch([draft('e-1', 'again')]).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DuplicateEntryError);
		expect((error as Error).cause).toBeDefined(); // raw SQLITE_CONSTRAINT preserved
		expect(backend.head).toBe(1);
		await backend.close();
	});

	it('skips already-committed ids under the idempotent option', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		// A retry replays the WHOLE batch: the committed prefix is skipped, the
		// new tail is committed.
		const retried = await backend.appendBatch([...drafts(2, 0), ...drafts(2, 10)], { idempotent: true });
		expect(retried.entryCount).toBe(2); // only the fresh half was written
		expect(backend.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER).map((entry) => entry.id)).toEqual([
			'e-0',
			'e-1',
			'e-10',
			'e-11',
		]);
		// Fully-committed replay: refused instead of fabricating an empty commit.
		await expect(backend.appendBatch(drafts(2, 0), { idempotent: true })).rejects.toThrow(DuplicateEntryError);
		// Idempotent + serialized cannot combine: the pre-serialized bytes cannot
		// describe a filtered subset.
		await expect(
			backend.appendBatch(drafts(1, 50), { idempotent: true, serialized: Buffer.from('[]') }),
		).rejects.toThrow(TypeError);
		await backend.close();
	});

	it('accepts a pre-serialized batch payload from the adapter path', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		const batch = drafts(2, 0);
		const serialized = Buffer.from(JSON.stringify(batch), 'utf8');
		const commit = await backend.appendBatch(batch, { serialized });
		expect(commit.uncompressedBytes).toBe(serialized.length);
		expect(commit.entryCount).toBe(2);
		expect(backend.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER).map((entry) => entry.id)).toEqual(['e-0', 'e-1']);
		await backend.close();
	});

	it('rejects batches over the uncompressed cap without writing', async () => {
		const backend = SqliteZstdBackend.open(workDir, { maxBatchUncompressedBytes: 128 });
		expect(MAX_BATCH_UNCOMPRESSED_BYTES).toBe(256 * 1024);
		const oversized = Array.from({ length: 16 }, (_, index) => draft(`big-${index}`, 'x'.repeat(32)));
		await expect(backend.appendBatch(oversized)).rejects.toThrow(/uncompressed cap/);
		expect(backend.head).toBe(SEQ_AT_START);
		expect(backend.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER)).toEqual([]);
		await backend.close();
	});

	it('applies stage-time backpressure at the uncompressed cap', async () => {
		const backend = SqliteZstdBackend.open(workDir, { maxBatchUncompressedBytes: 512 });
		backend.stage([draft('s1', 'x'.repeat(100))]);
		// Staging past the cap is refused HERE, not at flush time.
		expect(() => backend.stage([draft('s2', 'x'.repeat(600))])).toThrow(/checkpoint\(\) the open batch first/);
		// The refused stage was atomic: the open batch holds exactly the first entry.
		const flushed = await backend.checkpoint();
		expect(flushed?.entryCount).toBe(1);
		expect(backend.head).toBe(1);
		await backend.close();
	});

	it('raises the validation TypeError for cyclic and over-deep payloads', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		// Iterative validation: a cycle is the TypeError of validation, not a
		// stack-climbing RangeError.
		await expect(backend.appendBatch([draft('cyclic', cyclic)])).rejects.toThrow(TypeError);
		let deep: unknown = 1;
		for (let index = 0; index < 600; index += 1) deep = [deep];
		expect(() => backend.stage([draft('deep', deep)])).toThrow(TypeError);
		expect(backend.head).toBe(SEQ_AT_START);
		expect(backend.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER)).toEqual([]);
		await backend.close();
	});

	it('fails the open when meta.head disagrees with the stored batches', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		await backend.close();
		const raw = new Database(join(workDir, 'sessions.g1.db'), { fileMustExist: true });
		raw.prepare("UPDATE meta SET value = '5' WHERE key = 'head'").run();
		raw.close();
		expect(() => SqliteZstdBackend.open(workDir)).toThrow(/meta\.head \(5\) disagrees with the last stored batch \(1\)/);
	});

	it('fails the open on dangling index entries or a missing resume capsule', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		await backend.close();

		const raw = new Database(join(workDir, 'sessions.g1.db'), { fileMustExist: true });
		// better-sqlite3 enables foreign keys by default; the fault is injected
		// from below the backend's own enforcement.
		raw.exec('PRAGMA foreign_keys = OFF;');
		raw.prepare("INSERT INTO entries (entry_id, seq, ordinal, batch_id) VALUES ('ghost', 1, 9, 42)").run();
		raw.close();
		expect(() => SqliteZstdBackend.open(workDir)).toThrow(/index entries point at batches that do not exist/);

		const raw2 = new Database(join(workDir, 'sessions.g1.db'), { fileMustExist: true });
		raw2.prepare("DELETE FROM entries WHERE entry_id = 'ghost'").run();
		raw2.prepare("DELETE FROM meta WHERE key = 'resume'").run();
		raw2.close();
		expect(() => SqliteZstdBackend.open(workDir)).toThrow(/meta\.resume is missing although head is 1/);
	});
});

describe('head monotonicity', () => {
	it('keeps the sequence strictly increasing across commits and reopens', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		const commits: Commit[] = [];
		for (let round = 0; round < 3; round += 1) commits.push(await backend.appendBatch(drafts(2, round * 10)));
		expect(commitSeqs(commits)).toEqual([1, 2, 3]);
		expect(backend.head).toBe(3);
		await backend.close();

		const reopened = SqliteZstdBackend.open(workDir);
		expect(reopened.generation).toBe(1);
		expect(reopened.head).toBe(3); // head survives reopen; no reset to zero
		const next = await reopened.appendBatch(drafts(2, 100));
		expect(next.seq).toBe(4);
		expect(reopened.head).toBe(4);
		expect(reopened.readDelta(3, Number.MAX_SAFE_INTEGER).map((entry) => entry.id)).toEqual(['e-100', 'e-101']);
		await reopened.close();
	});

	it('advances the head only when the open batch is flushed', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		backend.stage(drafts(2, 0));
		expect(backend.head).toBe(SEQ_AT_START);
		expect(backend.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER)).toEqual([]);

		const flushed = await backend.checkpoint();
		expect(flushed?.seq).toBe(1);
		expect(flushed?.entryCount).toBe(2);
		expect(backend.head).toBe(1);
		expect(await backend.checkpoint()).toBeUndefined(); // nothing staged: no write, no commit

		// appendBatch and the open batch share one monotonic sequence.
		backend.stage(drafts(1, 10));
		const direct = await backend.appendBatch(drafts(1, 20));
		expect(direct.seq).toBe(2);
		const stagedFlush = await backend.checkpoint();
		expect(stagedFlush?.seq).toBe(3);
		expect(backend.head).toBe(3);
		await backend.close();
	});

	it('flushes the open batch on close and rejects operations afterwards', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		backend.stage(drafts(2, 0));
		await backend.close();
		await expect(backend.appendBatch(drafts(1, 50))).rejects.toThrow(SqliteZstdError);
		expect(() => backend.head).toThrow(SqliteZstdError);

		const reopened = SqliteZstdBackend.open(workDir);
		expect(reopened.head).toBe(1);
		expect(reopened.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER)).toHaveLength(2);
		await reopened.close();
		await backend.close(); // idempotent
	});
});

describe('torn tail', () => {
	it('never serves a batch whose frame failed the checksum', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		await backend.appendBatch(drafts(2, 10));
		const last = await backend.appendBatch(drafts(2, 20));
		await backend.close();

		// The corrupting connection is deliberately read-write: it stands in
		// for a torn or bit-rotted write reaching the file.
		const raw = new Database(join(workDir, 'sessions.g1.db'), { fileMustExist: true });
		const stored = raw.prepare('SELECT payload FROM batches WHERE batch_id = ?').get(last.seq) as { payload: Buffer };
		const torn = flipLastByte(stored.payload); // flip a checksum byte: the frame cannot verify
		raw.prepare('UPDATE batches SET payload = ? WHERE batch_id = ?').run(torn, last.seq);
		raw.close();

		const reopened = SqliteZstdBackend.open(workDir, { generation: 1 });
		expect(reopened.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER).map((entry) => entry.id)).toEqual(['e-0', 'e-1', 'e-10', 'e-11']);
		expect(reopened.readDelta(last.seq - 1, Number.MAX_SAFE_INTEGER)).toEqual([]); // tail gone: nothing readable past the tear
		await reopened.close();
	});

	it('never serves a batch with a truncated payload', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		const last = await backend.appendBatch(drafts(2, 10));
		await backend.close();

		const raw = new Database(join(workDir, 'sessions.g1.db'), { fileMustExist: true });
		const stored = raw.prepare('SELECT payload FROM batches WHERE batch_id = ?').get(last.seq) as { payload: Buffer };
		raw.prepare('UPDATE batches SET payload = ? WHERE batch_id = ?').run(stored.payload.subarray(0, 3), last.seq);
		raw.close();

		const reopened = SqliteZstdBackend.open(workDir, { generation: 1 });
		expect(reopened.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER)).toHaveLength(2);
		await reopened.close();
	});

	it('reports an explicit torn-tail verdict for frames cut by 1/2/4/8 bytes', async () => {
		for (const cut of [1, 2, 4, 8] as const) {
			const dir = join(workDir, `cut-${cut}`);
			const backend = SqliteZstdBackend.open(dir);
			await backend.appendBatch(drafts(2, 0));
			const last = await backend.appendBatch(drafts(2, 10));
			await backend.close();

			const raw = new Database(join(dir, 'sessions.g1.db'), { fileMustExist: true });
			const stored = raw.prepare('SELECT payload FROM batches WHERE batch_id = ?').get(last.seq) as { payload: Buffer };
			raw
				.prepare('UPDATE batches SET payload = ? WHERE batch_id = ?')
				.run(stored.payload.subarray(0, stored.payload.length - cut), last.seq);
			raw.close();

			const reopened = SqliteZstdBackend.open(dir, { generation: 1 });
			const checked = reopened.readDeltaChecked(SEQ_AT_START, 1 << 20);
			// The torn tail is an explicit verdict, never a silent end of log.
			expect(checked.tornTail?.batchId).toBe(last.seq);
			expect(checked.tornTail?.reason).toMatch(/mismatch|torn|decompression/);
			expect(checked.entries.map((entry) => entry.id)).toEqual(['e-0', 'e-1']);
			expect(checked.nextAfterSeq).toBe(1);
			// The compat wrapper keeps serving the intact prefix.
			expect(reopened.readDelta(SEQ_AT_START, 1 << 20).map((entry) => entry.id)).toEqual(['e-0', 'e-1']);
			await reopened.close();
		}
	});

	it('distinguishes a budget stop from a torn tail and from the end of the log', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		const first = await backend.appendBatch(drafts(3, 0));
		const second = await backend.appendBatch(drafts(2, 10));

		const whole = backend.readDeltaChecked(SEQ_AT_START, Number.MAX_SAFE_INTEGER);
		expect(whole.tornTail).toBeNull();
		expect(whole.nextAfterSeq).toBe(second.seq);
		expect(whole.entries).toHaveLength(5);

		const windowed = backend.readDeltaChecked(SEQ_AT_START, first.uncompressedBytes);
		expect(windowed.tornTail).toBeNull();
		expect(windowed.entries).toHaveLength(3);
		expect(windowed.nextAfterSeq).toBe(first.seq);

		const exhausted = backend.readDeltaChecked(second.seq, 1 << 20);
		expect(exhausted.entries).toEqual([]);
		expect(exhausted.nextAfterSeq).toBeNull();
		expect(exhausted.tornTail).toBeNull();
		await backend.close();
	});

	it('treats an over-deep stored payload as a torn tail, not a crash', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		const last = await backend.appendBatch(drafts(2, 10));
		await backend.close();

		let deep: unknown = 1;
		for (let index = 0; index < 600; index += 1) deep = [deep];
		const raw = new Database(join(workDir, 'sessions.g1.db'), { fileMustExist: true });
		const evil = encodeFrame(isZstdSupported() ? 'zstd' : 'gzip', Buffer.from(JSON.stringify(deep), 'utf8'));
		raw.prepare('UPDATE batches SET payload = ? WHERE batch_id = ?').run(evil, last.seq);
		raw.close();

		const reopened = SqliteZstdBackend.open(workDir, { generation: 1 });
		const checked = reopened.readDeltaChecked(SEQ_AT_START, 1 << 20);
		expect(checked.entries.map((entry) => entry.seq)).toEqual([1, 1]);
		expect(checked.tornTail?.batchId).toBe(last.seq);
		await reopened.close();
	});

	it('keeps serving intact payloads on index disagreement and reports it via verify()', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		await backend.appendBatch(drafts(2, 10));
		await backend.appendBatch(drafts(2, 20));
		await backend.close();

		const raw = new Database(join(workDir, 'sessions.g1.db'), { fileMustExist: true });
		raw.prepare('DELETE FROM entries WHERE batch_id = 2 AND ordinal = 1').run();
		raw.close();

		const reopened = SqliteZstdBackend.open(workDir, { generation: 1 });
		// Hot reads stay cheap: intact payloads are served; the per-ordinal
		// index agreement walk is a deliberate verify() call, not a per-read cost.
		expect(reopened.readDelta(SEQ_AT_START, 1 << 20).map((entry) => entry.seq)).toEqual([1, 1, 2, 2, 3, 3]);
		const report = reopened.verify();
		expect(report.batchesChecked).toBe(3);
		expect(report.issues).toHaveLength(1);
		expect(report.issues[0]).toMatchObject({ batchId: 2 });
		expect(report.issues[0]?.issue).toMatch(/entry index has 1 rows, payload has 2 entries/);
		await reopened.close();
	});

	it('verifies an intact log with an empty issue list', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		await backend.appendBatch(drafts(3, 10));
		const report = backend.verify();
		expect(report).toEqual({ batchesChecked: 2, entriesChecked: 5, issues: [] });
		await backend.close();
	});
});

describe('format generations', () => {
	it('creates g1 for an empty directory and opens the highest generation by default', async () => {
		const first = SqliteZstdBackend.open(workDir);
		expect(first.generation).toBe(1);
		expect(first.path).toBe(join(workDir, 'sessions.g1.db'));
		expect(existsSync(join(workDir, 'sessions.g1.db'))).toBe(true);
		await first.appendBatch(drafts(1, 0));
		await first.close();

		const second = SqliteZstdBackend.openNextGeneration(workDir);
		expect(second.generation).toBe(2);
		expect(second.head).toBe(SEQ_AT_START); // a new generation starts empty
		const commit = await second.appendBatch(drafts(1, 100));
		expect(commit.seq).toBe(1);
		await second.close();

		const latest = SqliteZstdBackend.open(workDir);
		expect(latest.generation).toBe(2);
		expect(latest.head).toBe(1);
		await latest.close();
	});

	it('sealing a generation keeps reads and refuses writes', async () => {
		const first = SqliteZstdBackend.open(workDir);
		const committed = await first.appendBatch(drafts(2, 0));
		const second = secondGeneration();
		expect(first.sealed).toBe(true);
		await expect(first.appendBatch(drafts(1, 50))).rejects.toThrow(SealedGenerationError);
		expect(() => first.stage(drafts(1, 51))).toThrow(SealedGenerationError);
		await expect(first.checkpoint()).rejects.toThrow(SealedGenerationError);
		// Sealed generations stay readable, byte-for-byte.
		expect(first.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER).map((entry) => entry.id)).toEqual(['e-0', 'e-1']);
		expect(first.head).toBe(committed.seq);

		if (process.platform !== 'win32') {
			const mode = statSync(join(workDir, 'sessions.g1.db')).mode;
			expect(mode & 0o222).toBe(0); // no write bits for anyone
		}
		await first.close();

		// A fresh handle on the sealed file opens read-only and stays sealed.
		const reopened = SqliteZstdBackend.open(workDir, { generation: 1 });
		expect(reopened.sealed).toBe(true);
		expect(reopened.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER)).toHaveLength(2);
		await expect(reopened.appendBatch(drafts(1, 60))).rejects.toThrow(SealedGenerationError);
		await reopened.close();

		// The writer that asked for the new generation is unsealed and fresh.
		expect(second.sealed).toBe(false);
		const commit = await second.appendBatch(drafts(1, 100));
		expect(commit.seq).toBe(1); // a new generation numbers its own log from one
		expect(second.head).toBe(1);
		await second.close();
	});

	it('flushes a staged open batch when a newer generation seals the handle', async () => {
		const first = SqliteZstdBackend.open(workDir);
		first.stage(drafts(2, 0));
		secondGeneration();
		expect(first.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER)).toHaveLength(2);
		expect(first.head).toBe(1);
		await first.close();
	});

	it('merges the WAL before sealing: a byte-copy of the .db alone is complete', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2, 0));
		await backend.appendBatch(drafts(2, 10));
		backend.seal();

		// The WAL was checkpointed (truncated) BEFORE the write bits were
		// stripped, so nothing committed is left only in the sidecar file.
		const walPath = join(workDir, 'sessions.g1.db-wal');
		if (existsSync(walPath)) expect(statSync(walPath).size).toBe(0);

		// Byte-copy the .db alone (no -wal/-shm) into a fresh directory: every
		// committed entry must be readable from the copy.
		const copyDir = mkdtempSync(join(tmpdir(), 'sqlite-zstd-copy-'));
		try {
			copyFileSync(join(workDir, 'sessions.g1.db'), join(copyDir, 'sessions.g1.db'));
			const copied = SqliteZstdBackend.open(copyDir, { generation: 1 });
			expect(copied.head).toBe(2);
			expect(copied.readDelta(SEQ_AT_START, 1 << 20).map((entry) => entry.id)).toEqual(['e-0', 'e-1', 'e-10', 'e-11']);
			await copied.close();
		} finally {
			bestEffortUnseal(copyDir);
			rmSync(copyDir, { recursive: true, force: true });
		}
		await backend.close();
	});

	it('rolls the new generation back when sealing a live handle fails mid-open', async () => {
		const first = SqliteZstdBackend.open(workDir);
		await first.appendBatch([draft('dup', 'committed')]);
		first.stage([draft('dup', 'staged duplicate')]); // fails the seal-time flush

		// Sealing `first` fails inside openNextGeneration: the half-built new
		// generation must not keep the writer lock or leak its handle.
		expect(() => secondGeneration()).toThrow(DuplicateEntryError);

		const next = SqliteZstdBackend.open(workDir);
		expect(next.generation).toBe(2);
		expect(next.head).toBe(SEQ_AT_START); // ownership was rolled back: writable again
		const commit = await next.appendBatch(drafts(1, 100));
		expect(commit.seq).toBe(1);
		await next.close();

		// The failing handle stays fail-closed: its staged batch is re-raised by
		// close() (after full cleanup), and the handle ends up closed.
		await expect(first.close()).rejects.toThrow(DuplicateEntryError);
		await expect(first.appendBatch(drafts(1, 200))).rejects.toThrow(SqliteZstdError);
	});

	it('rejects opening a generation that does not exist', () => {
		const backend = SqliteZstdBackend.open(workDir);
		expect(backend.generation).toBe(1);
		expect(() => SqliteZstdBackend.open(workDir, { generation: 7 })).toThrow(SqliteZstdError);
		return backend.close();
	});

	it('reads batches written by mixed codecs through the envelope', async () => {
		const preferred = isZstdSupported() ? undefined : ('gzip' as const);
		const backend = SqliteZstdBackend.open(workDir, preferred ? { codec: preferred } : {});
		await backend.appendBatch(drafts(2, 0));
		await backend.close();

		const other: 'gzip' | 'zstd' = isZstdSupported() ? 'gzip' : 'zstd';
		if (other === 'zstd' && !isZstdSupported()) return; // cannot force zstd without runtime support
		const mixed = SqliteZstdBackend.open(workDir, { codec: other });
		const commit = await mixed.appendBatch(drafts(2, 10));
		expect(commit.codec).toBe(other);
		const delta = mixed.readDelta(SEQ_AT_START, Number.MAX_SAFE_INTEGER);
		expect(delta.map((entry) => entry.id)).toEqual(['e-0', 'e-1', 'e-10', 'e-11']);
		await mixed.close();

		const raw = new Database(join(workDir, 'sessions.g1.db'), { readonly: true, fileMustExist: true });
		const payloads = (raw.prepare('SELECT batch_id, payload FROM batches ORDER BY batch_id').all() as Array<{ payload: Buffer }>).map(
			(row) => decodeFrame(row.payload).name,
		);
		raw.close();
		const expectedFirst = isZstdSupported() ? 'zstd' : 'gzip';
		expect(payloads).toEqual([expectedFirst, other]);
	});

	it('rejects a foreign file format instead of rewriting it', async () => {
		const foreign = new Database(join(workDir, 'sessions.g1.db'));
		foreign.exec('CREATE TABLE other (x)');
		foreign.close();
		expect(() => SqliteZstdBackend.open(workDir)).toThrow(new RegExp(FORMAT_ID));
		expect(readFileSync(join(workDir, 'sessions.g1.db'), 'latin1')).toContain('other');
	});
});

/** Open the next generation; declared as a function so each call site reads clearly. */
function secondGeneration(): SqliteZstdBackend {
	return SqliteZstdBackend.openNextGeneration(workDir);
}

describe('single-writer owner epoch', () => {
	it('refuses a second writable open while the first writer is alive and frees the lock on close', async () => {
		const first = SqliteZstdBackend.open(workDir);
		expect(() => SqliteZstdBackend.open(workDir)).toThrow(OwnerWriteLockError);
		expect(() => SqliteZstdBackend.open(workDir)).toThrow(/another writer owns this generation/);

		await first.close();
		const second = SqliteZstdBackend.open(workDir);
		await second.appendBatch(drafts(1));
		expect(second.head).toBe(1);
		await second.close();
	});

	it('steals the lock of a crashed writer (stale pid) and breaks the loser terminally', async () => {
		const crashed = SqliteZstdBackend.open(workDir);
		// Simulate the writer dying without cleanup: its recorded pid becomes
		// one that cannot be alive (beyond every platform's pid range).
		const raw = new Database(join(workDir, 'sessions.g1.db'), { timeout: 5000 });
		raw.prepare("UPDATE meta SET value = '99999999' WHERE key = 'owner_pid'").run();
		raw.close();

		const takeover = SqliteZstdBackend.open(workDir); // steals the stale lock
		await takeover.appendBatch(drafts(1));

		// The stale handle's view is broken for good: writes refuse instead of
		// racing the new owner with retries.
		await expect(crashed.appendBatch(drafts(1))).rejects.toThrow(OwnerLostError);
		await expect(crashed.appendBatch(drafts(1))).rejects.toThrow(OwnerLostError);

		await takeover.close();
		await crashed.close();
	});

	it('steals the lock of a recycled pid whose recorded instance is not live', async () => {
		const first = SqliteZstdBackend.open(workDir);
		// Simulate pid reuse: the recorded pid is THIS process (alive) but the
		// recorded instance marker is unknown — the recording writer is gone.
		const raw = new Database(join(workDir, 'sessions.g1.db'), { timeout: 5000 });
		raw.prepare("UPDATE meta SET value = ? WHERE key = 'owner_pid'").run(String(process.pid));
		raw.prepare("UPDATE meta SET value = 'ghost-instance@0' WHERE key = 'owner_instance'").run();
		raw.close();

		const takeover = SqliteZstdBackend.open(workDir); // must not refuse a recycled pid
		const commit = await takeover.appendBatch(drafts(1));
		expect(commit.seq).toBe(1);
		await takeover.close();
		await first.close();
	});

	it('exposes the enforced batch cap', () => {
		const backend = SqliteZstdBackend.open(workDir);
		expect(backend.maxBatchUncompressedBytes).toBe(MAX_BATCH_UNCOMPRESSED_BYTES);
		const custom = SqliteZstdBackend.openNextGeneration(workDir, { maxBatchUncompressedBytes: 1024 });
		expect(custom.maxBatchUncompressedBytes).toBe(1024);
		backend.close();
		custom.close();
	});
});

describe('resume capsule and entry-id reads', () => {
	it('refreshes the resume capsule atomically with every commit', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		expect(backend.readResume()).toBeNull(); // nothing committed yet

		await backend.appendBatch(drafts(2));
		expect(backend.readResume()).toMatchObject({ batchId: 1, seq: 1, head: 1, entryCount: 2 });
		await backend.appendBatch(drafts(3, 2));
		const capsule = backend.readResume();
		expect(capsule).toMatchObject({ batchId: 2, seq: 2, head: 2, entryCount: 3 });
		expect(typeof capsule?.updatedMs).toBe('number');
		backend.close();

		// The capsule survives reopen and is readable without decoding batches.
		const reopened = SqliteZstdBackend.open(workDir);
		expect(reopened.readResume()).toMatchObject({ seq: 2, head: 2 });
		reopened.close();
	});

	it('serves a point read by entry id and a window read anchored at it', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch(drafts(2)); // e-0, e-1
		await backend.appendBatch(drafts(2, 2)); // e-2, e-3

		expect(backend.getEntry('e-2')?.seq).toBe(2);
		expect(backend.getEntry('e-2')?.ordinal).toBe(0);
		expect(backend.getEntry('e-3')?.ordinal).toBe(1);
		expect(backend.getEntry('missing')).toBeUndefined();
		expect(() => backend.getEntry('')).toThrow(TypeError);

		// Reads are batch-granular (batches are atomic units): a non-inclusive
		// anchor serves batches strictly AFTER the anchor's batch.
		expect(backend.readDeltaFrom('e-2', 1024 * 1024)).toEqual([]);
		expect(
			backend.readDeltaFrom('e-2', 1024 * 1024, { inclusive: true }).map((entry) => entry.id),
		).toEqual(['e-2', 'e-3']);
		expect(backend.readDeltaFrom('e-0', 1024 * 1024).map((entry) => entry.id)).toEqual(['e-2', 'e-3']);
		expect(backend.readDeltaFrom('e-1', 1024 * 1024).map((entry) => entry.id)).toEqual(['e-2', 'e-3']);
		expect(() => backend.readDeltaFrom('missing', 1024)).toThrow(/does not exist/);
		backend.close();
	});

	it('preserves parentId through the stored frame', async () => {
		const backend = SqliteZstdBackend.open(workDir);
		await backend.appendBatch([
			draft('parent', { n: 0 }),
			{ ...draft('child', { n: 1 }), parentId: 'parent' },
		]);
		const delta = backend.readDelta(0, 1024 * 1024);
		expect(delta.map((entry) => entry.parentId)).toEqual([undefined, 'parent']);
		expect(backend.getEntry('child')?.parentId).toBe('parent');
		backend.close();
	});
});
