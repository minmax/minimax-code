//
// T_accept tests: atomic composition of submission + receipt + delivery
// index in ONE commit, durable dedup by (conversationId, requestId), and
// REQUEST_ID_CONFLICT on a payload change — over the in-memory port AND the
// real sqlite-zstd backend (owner-epoch rollback included).
//

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	DurableSeam,
	InputTooLargeError,
	InvalidInputError,
	RequestIdConflictError,
	SEAM_ENTRY_KINDS,
	SeamOwnerLostError,
	hashJson,
	receiptEntryId,
	submissionEntryId,
	type DurableLogPort,
} from '../../src/index.js';
import { InMemoryDurableLog, join, loadSqlite3Constructor, mkdtempSync, openSqliteBackend, tmpdir, type SqliteZstdBackend } from '../helpers.js';

function input(overrides: Partial<Parameters<DurableSeam['acceptOwnerInput']>[0]> = {}) {
	return {
		conversationId: 'conv-1',
		requestId: 'req-1',
		content: { text: 'continue with the long task' },
		whenBusy: 'steer' as const,
		...overrides,
	};
}

describe('acceptOwnerInput — atomic composition (in-memory port)', () => {
	let log: InMemoryDurableLog;
	let seam: DurableSeam;

	beforeEach(async () => {
		log = new InMemoryDurableLog();
		seam = await DurableSeam.open(log);
	});

	it('commits submission + receipt + delivery index as ONE commit', async () => {
		const result = await seam.acceptOwnerInput(input());

		expect(result.status).toBe('committed');
		expect(result.commitSeq).toBe(1);
		expect(result.submissionId).toBe(submissionEntryId('conv-1', 'req-1'));
		expect(result.inputEntryId).toBe(receiptEntryId('conv-1', 'req-1'));

		// Exactly one batch, holding all three records atomically.
		expect(log.batches).toHaveLength(1);
		const kinds = log.batches[0]!.map((entry) => entry.kind);
		expect(kinds).toEqual([
			SEAM_ENTRY_KINDS.submission,
			SEAM_ENTRY_KINDS.receipt,
			SEAM_ENTRY_KINDS.snapshot,
		]);

		const receipt = log.entries.get(result.inputEntryId)!;
		expect(receipt.kind).toBe('mcode.owner-input.received');
		// The receipt is immutable provenance: no model, no head, no edits.
		const payload = receipt.payload as Record<string, unknown>;
		expect(Object.keys(payload)).not.toContain('model');
		expect(Object.keys(payload)).not.toContain('head');
		expect(Object.keys(payload)).not.toContain('edits');
		expect(payload['contentHash']).toBe(hashJson(input().content));
		expect(seam.listActiveDeliveries()).toEqual([
			{
				conversationId: 'conv-1',
				requestId: 'req-1',
				submissionId: result.submissionId,
				inputEntryId: result.inputEntryId,
			},
		]);
	});

	it('replays the ORIGINAL ids and commit for the same payload (dedup)', async () => {
		const first = await seam.acceptOwnerInput(input());
		const repeat = await seam.acceptOwnerInput(input({ content: { text: 'continue with the long task' } }));

		expect(repeat.status).toBe('replayed');
		expect(repeat.submissionId).toBe(first.submissionId);
		expect(repeat.inputEntryId).toBe(first.inputEntryId);
		expect(repeat.commitSeq).toBe(first.commitSeq);
		// A dedup hit writes no second commit.
		expect(log.batches).toHaveLength(1);
		expect(log.head()).toBe(first.commitSeq);
	});

	it('raises REQUEST_ID_CONFLICT for a different payload under the same key', async () => {
		await seam.acceptOwnerInput(input());
		const before = log.head();

		try {
			await seam.acceptOwnerInput(input({ content: { text: 'DIFFERENT payload' } }));
			expect.fail('expected RequestIdConflictError');
		} catch (error) {
			expect(error).toBeInstanceOf(RequestIdConflictError);
			expect((error as RequestIdConflictError).code).toBe('REQUEST_ID_CONFLICT');
		}
		// Nothing was written by the conflicted attempt.
		expect(log.head()).toBe(before);
		expect(log.batches).toHaveLength(1);
	});

	it('treats whenBusy/actor/route as part of the dedup payload', async () => {
		await seam.acceptOwnerInput(input());

		// Same content but a different routing wish is a DIFFERENT payload.
		await expect(seam.acceptOwnerInput(input({ whenBusy: 'followUp' }))).rejects.toMatchObject({
			code: 'REQUEST_ID_CONFLICT',
		});
		// So are actor and route changes.
		await expect(seam.acceptOwnerInput(input({ actor: 'other' }))).rejects.toMatchObject({
			code: 'REQUEST_ID_CONFLICT',
		});
		await expect(seam.acceptOwnerInput(input({ route: 'copy-to-child' }))).rejects.toMatchObject({
			code: 'REQUEST_ID_CONFLICT',
		});
		// The full original payload still replays.
		const replay = await seam.acceptOwnerInput(input());
		expect(replay.status).toBe('replayed');
		expect(replay.whenBusy).toBe('steer');
		expect(log.batches).toHaveLength(1);
	});

	it('refuses oversized inputs with explicit backpressure before any durable attempt', async () => {
		const limited = await DurableSeam.open(log, { maxInputBytes: 1024 });
		const big = { text: 'x'.repeat(2048) };

		try {
			await limited.acceptOwnerInput(input({ requestId: 'big', content: big }));
			expect.fail('expected InputTooLargeError');
		} catch (error) {
			expect(error).toBeInstanceOf(InputTooLargeError);
			expect((error as InputTooLargeError).code).toBe('INPUT_TOO_LARGE');
			expect((error as InputTooLargeError).limitBytes).toBe(1024);
			expect((error as InputTooLargeError).bytes).toBeGreaterThan(1024);
		}
		// Nothing was written by the refused attempt.
		expect(log.head()).toBe(0);
		expect(log.batches).toHaveLength(0);
	});

	it('dedupes and conflicts purely from the entry index after a restart', async () => {
		const first = await seam.acceptOwnerInput(input());

		// A brand-new seam instance (fresh registry, same durable log).
		const restarted = await DurableSeam.open(log);

		const replay = await restarted.acceptOwnerInput(input());
		expect(replay.status).toBe('replayed');
		expect(replay.commitSeq).toBe(first.commitSeq);

		await expect(restarted.acceptOwnerInput(input({ content: 'other' }))).rejects.toMatchObject({
			code: 'REQUEST_ID_CONFLICT',
		});
	});

	it('rolls back atomically when the append fails before committing', async () => {
		log.failNextAppend(new Error('simulated crash before commit'));
		await expect(seam.acceptOwnerInput(input())).rejects.toThrow('simulated crash before commit');

		// No partial state: log, entry index, and projection are untouched.
		expect(log.head()).toBe(0);
		expect(log.batches).toHaveLength(0);
		expect(log.entries.get(receiptEntryId('conv-1', 'req-1'))).toBeUndefined();
		expect(seam.listActiveDeliveries()).toEqual([]);

		// The retry after the "crash" proceeds normally.
		const retry = await seam.acceptOwnerInput(input());
		expect(retry.status).toBe('committed');
		expect(retry.commitSeq).toBe(1);
	});

	it('refuses to write after the owner epoch moved, then recovers', async () => {
		log.stealOwnership();
		await expect(seam.acceptOwnerInput(input())).rejects.toBeInstanceOf(SeamOwnerLostError);
		expect(log.head()).toBe(0);

		log.restoreOwnership();
		const result = await seam.acceptOwnerInput(input());
		expect(result.status).toBe('committed');
	});

	it('serializes concurrent same-key accepts into one commit', async () => {
		const release = log.holdNextAppend();
		const first = seam.acceptOwnerInput(input());
		const second = seam.acceptOwnerInput(input());

		release();
		const [a, b] = await Promise.all([first, second]);

		const statuses = [a.status, b.status].sort();
		expect(statuses).toEqual(['committed', 'replayed']);
		expect(a.submissionId).toBe(b.submissionId);
		expect(log.batches).toHaveLength(1);
	});

	it('validates arguments before any durable attempt', async () => {
		await expect(seam.acceptOwnerInput(input({ requestId: '' }))).rejects.toMatchObject({
			code: 'INVALID_INPUT',
		});
		await expect(seam.acceptOwnerInput(input({ whenBusy: 'queue' as never }))).rejects.toBeInstanceOf(
			InvalidInputError,
		);
		await expect(seam.acceptOwnerInput(input({ requestId: 'x', content: 'ok' }))).resolves.toBeTruthy();
	});
});

describe('settleDelivery — bounded active index', () => {
	let log: InMemoryDurableLog;
	let seam: DurableSeam;

	beforeEach(async () => {
		log = new InMemoryDurableLog();
		seam = await DurableSeam.open(log);
	});

	it('removes terminal entries from the active index, idempotently', async () => {
		await seam.acceptOwnerInput(input({ requestId: 'r1' }));
		const second = await seam.acceptOwnerInput(input({ requestId: 'r2' }));

		const settled = await seam.settleDelivery({ conversationId: 'conv-1', requestId: 'r1' });
		expect(settled.status).toBe('committed');

		const active = seam.listActiveDeliveries();
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({ requestId: 'r2', inputEntryId: second.inputEntryId });

		const replay = await seam.settleDelivery({ conversationId: 'conv-1', requestId: 'r1' });
		expect(replay.status).toBe('replayed');
		expect(seam.listActiveDeliveries()).toHaveLength(1);
	});

	it('refuses to settle an input that was never accepted', async () => {
		await expect(seam.settleDelivery({ conversationId: 'conv-1', requestId: 'ghost' })).rejects.toMatchObject({
			code: 'UNKNOWN_INPUT',
		});
	});
});

describe('acceptOwnerInput — real sqlite-zstd backend', () => {
	let directory: string;
	const openBackends: SqliteZstdBackend[] = [];

	// Each test opens its own handles on a fresh directory; the afterEach net
	// closes whatever a failed test left behind.
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'durable-seam-'));
		openBackends.length = 0;
	});

	afterEach(async () => {
		for (const backend of openBackends.splice(0)) {
			await backend.close().catch(() => undefined);
		}
	});

	async function closeOpenBackends(): Promise<void> {
		for (const backend of openBackends.splice(0)) {
			await backend.close();
		}
	}

	async function openSeam(): Promise<{ readonly seam: DurableSeam; readonly port: DurableLogPort }> {
		const opened = openSqliteBackend(directory);
		openBackends.push(opened.backend);
		return { seam: await DurableSeam.open(opened.port), port: opened.port };
	}

	it('accepts, dedupes, and conflicts across a close/reopen restart', async () => {
		const first = await openSeam();
		const accepted = await first.seam.acceptOwnerInput(input());
		await closeOpenBackends();

		const restarted = await openSeam();

		const replay = await restarted.seam.acceptOwnerInput(input());
		expect(replay.status).toBe('replayed');
		expect(replay.commitSeq).toBe(accepted.commitSeq);
		expect(replay.submissionId).toBe(accepted.submissionId);
		expect(replay.inputEntryId).toBe(accepted.inputEntryId);

		await expect(restarted.seam.acceptOwnerInput(input({ content: { text: 'changed' } }))).rejects.toMatchObject({
			code: 'REQUEST_ID_CONFLICT',
		});
	});

	it('rolls the atomic accept back when the owner epoch moves underneath', async () => {
		const { seam, port } = await openSeam();
		const headBefore = port.head();

		// A foreign writer bumps the durable owner epoch behind our handle:
		// the next commit transaction must refuse and roll back.
		const Database = loadSqlite3Constructor();
		const raw = new Database(join(directory, 'sessions.g1.db'));
		raw.exec("UPDATE meta SET value = '999' WHERE key = 'owner_epoch'");
		raw.close();

		await expect(seam.acceptOwnerInput(input())).rejects.toMatchObject({ code: 'OWNER_LOST' });

		// Atomic rollback: no submission, no receipt, no snapshot, no head move.
		expect(port.head()).toBe(headBefore);
		expect(port.getEntry(receiptEntryId('conv-1', 'req-1'))).toBeUndefined();
		expect(port.getEntry(submissionEntryId('conv-1', 'req-1'))).toBeUndefined();
	});

	it('derives the explicit input budget from the storage batch cap', async () => {
		// Batch cap 16 KiB → the effective input budget is 16 KiB − 8 KiB
		// seam overhead = 8 KiB; a 64 KiB paste must fail with
		// INPUT_TOO_LARGE here, not with an opaque batch-cap STORAGE_FAILURE
		// at commit time.
		const capped = openSqliteBackend(mkdtempSync(join(tmpdir(), 'durable-seam-capped-')), {
			maxBatchUncompressedBytes: 16 * 1024,
		});
		openBackends.push(capped.backend);
		const seam = await DurableSeam.open(capped.port);

		const error = await seam
			.acceptOwnerInput(input({ requestId: 'paste', content: { text: 'y'.repeat(64 * 1024) } }))
			.then(
				() => null,
				(e) => e,
			);
		expect(error).toBeInstanceOf(InputTooLargeError);
		expect(error.code).toBe('INPUT_TOO_LARGE');
		expect(error.limitBytes).toBe(8 * 1024);

		// A small input commits normally under the same cap.
		const ok = await seam.acceptOwnerInput(input({ requestId: 'small', content: { text: 'tiny' } }));
		expect(ok.status).toBe('committed');
	});

	it('keeps the accept snapshot bounded while many inputs settle', async () => {
		// Batch cap 16 KiB: an unbounded snapshot (one record per accepted
		// input, ~250 B each) would blow the cap within ~40 accepts and wedge
		// every later seam commit.
		const capped = openSqliteBackend(mkdtempSync(join(tmpdir(), 'durable-seam-capped-')), {
			maxBatchUncompressedBytes: 16 * 1024,
		});
		openBackends.push(capped.backend);
		const seam = await DurableSeam.open(capped.port);

		for (let i = 0; i < 80; i += 1) {
			const requestId = `r${i}`;
			await seam.acceptOwnerInput(input({ requestId, content: { text: `input ${i}` } }));
			await seam.settleDelivery({ conversationId: 'conv-1', requestId });
		}

		// Every commit went through, and each settled input left the bounded
		// index instead of accumulating in the snapshot.
		expect(seam.listActiveDeliveries()).toEqual([]);
		expect(capped.port.head()).toBe(160);
	});
});
