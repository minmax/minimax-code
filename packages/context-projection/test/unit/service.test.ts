import { describe, expect, it } from 'vitest';

import { SEQ_AT_START } from '../../../durable-backend-sqlite-zstd/src/types.js';
import type { Entry } from '../../../durable-backend-sqlite-zstd/src/types.js';

import { ProjectionError, ProjectionService, buildProjection } from '../../src/index.js';
import type { ApplyResult, CommitWithEntries } from '../../src/index.js';
import {
	auditEntry,
	commitOf,
	compactionEntry,
	editEntry,
	llmEntry,
	makeLcg,
	nextId,
} from './helpers.js';

const LLM_KINDS = ['pi.user', 'pi.assistant', 'pi.tool-result'] as const;

describe('incremental equivalence (apply×N = full rebuild)', () => {
	it('matches buildProjection after every commit and at the end of a mixed control stream', () => {
		const lcg = makeLcg(0x2f6e2b1);
		const service = new ProjectionService();
		const log: Entry[] = [];
		const applied: ApplyResult[] = [];

		for (let seq = 1; seq <= 12; seq += 1) {
			// Deterministic control commits: a compaction at seq 4, a context edit at seq 9.
			const forceControl = seq === 4 || seq === 9;
			const batch: Entry[] = [];
			const size = 1 + Math.floor(lcg() * 4);
			for (let position = 0; position < size; position += 1) {
				const roll = lcg();
				// Validity oracle for control payloads: the CURRENT derived context
				// (log prefix + entries already generated for this batch).
				const current = buildProjection([...log, ...batch]);
				if ((forceControl && position === 0) || roll < 0.12) {
					const segments = current.segments;
					if (roll < 0.06 && segments.length > 0) {
						const kept = segments[Math.floor(lcg() * segments.length)]!;
						batch.push(compactionEntry(seq, batch.length, `summary-${nextId('s')}`, kept.entryId));
						continue;
					}
					if (segments.length > 1) {
						const removals = segments
							.filter(() => lcg() < 0.3)
							.slice(0, 2)
							.map((segment) => segment.entryId);
						if (removals.length > 0) {
							batch.push(editEntry(seq, batch.length, removals));
							continue;
						}
					}
				}
				if (roll < 0.3) {
					batch.push(auditEntry(seq, batch.length));
				} else {
					const kind = LLM_KINDS[Math.floor(lcg() * LLM_KINDS.length)]!;
					batch.push(llmEntry(kind, { text: `payload-${seq}-${batch.length}` }, seq, batch.length));
				}
			}

			log.push(...batch);
			const result = service.apply(commitOf(seq, batch));
			applied.push(result);

			// The criterion, checked after EVERY apply: the incrementally
			// maintained manifest is identical to a full rebuild of the log.
			expect(service.manifest()).toEqual(buildProjection(log));
		}

		expect(service.manifest()).toEqual(buildProjection(log));
		// The stream actually exercised both rebuild triggers: the forced ones
		// plus any the generator rolled.
		const rebuiltSeqs = applied.filter((result) => result.rebuilt).map((result) => result.commit.seq);
		expect(rebuiltSeqs).toContain(4);
		expect(rebuiltSeqs).toContain(9);
	});

	it('matches a full rebuild for a plain LLM-only stream of many commits', () => {
		const service = new ProjectionService();
		const log: Entry[] = [];
		for (let seq = 1; seq <= 25; seq += 1) {
			const batch = [
				llmEntry('pi.user', { text: `u${seq}` }, seq, 0),
				llmEntry('pi.assistant', { text: `a${seq}` }, seq, 1),
				auditEntry(seq, 2),
			];
			log.push(...batch);
			service.apply(commitOf(seq, batch));
			// The criterion after EVERY apply, not only at the end of the stream.
			expect(service.manifest()).toEqual(buildProjection(log));
		}
		expect(service.manifest()).toEqual(buildProjection(log));
		expect(service.manifest().segments).toHaveLength(50);
	});

	it('leaves the service untouched when a control commit fails, so the retry succeeds', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		service.apply(commitOf(1, [a]));

		// A compaction referencing an unknown entry throws mid-fold…
		const bad = compactionEntry(2, 0, 'summary', 'missing-entry');
		expect(() => service.apply(commitOf(2, [bad]))).toThrow(ProjectionError);
		// …and the failed batch must not have entered the retained log: the
		// capsule still sits at seq 1.
		expect(service.capsule().appliedSeq).toBe(1);

		// The corrected retry of the SAME sequence succeeds.
		const compaction = compactionEntry(2, 0, 'summary of u1', a.id);
		const retry = service.apply(commitOf(2, [compaction]));
		expect(retry.rebuilt).toBe(true);
		expect(service.capsule().appliedSeq).toBe(2);

		// A later control commit's full refold also sees a clean prefix —
		// exactly the log of the succeeded applies.
		const b = llmEntry('pi.assistant', { text: 'a1' }, 3, 0);
		service.apply(commitOf(3, [b]));
		const edit = editEntry(4, 0, [a.id]);
		const fourth = service.apply(commitOf(4, [edit]));
		expect(fourth.rebuilt).toBe(true);
		expect(fourth.manifest.segments.map((segment) => segment.entryId)).toEqual([b.id]);
		expect(service.manifest()).toEqual(
			buildProjection([a, compaction, b, edit]),
		);
	});

	it('reports only the new entries as the delta of each apply', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'a1' }, 1, 1);
		const first = service.apply(commitOf(1, [a, b]));

		expect(first.delta).toEqual([
			{ entryId: a.id, byteLen: Buffer.byteLength(JSON.stringify(a.payload), 'utf8'), kind: 'pi.user' },
			{ entryId: b.id, byteLen: Buffer.byteLength(JSON.stringify(b.payload), 'utf8'), kind: 'pi.assistant' },
		]);

		// A control commit contributes no segments of its own; the compaction
		// summarizes `a` away, keeping `b` and everything after it.
		const c = llmEntry('pi.user', { text: 'u2' }, 2, 0);
		service.apply(commitOf(2, [c]));
		const compaction = compactionEntry(3, 0, 'summary of a', b.id);
		const third = service.apply(commitOf(3, [compaction]));
		expect(third.delta).toEqual([]);
		expect(third.rebuilt).toBe(true);
		expect(third.manifest.segments.map((segment) => segment.entryId)).toEqual([b.id, c.id]);
	});
});

describe('apply validation', () => {
	it('rejects replays, gaps, mismatched seq, wrong counts, and empty batches', () => {
		const service = new ProjectionService();
		const entry = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		service.apply(commitOf(1, [entry]));

		expect(() => service.apply(commitOf(1, [llmEntry('pi.user', { text: 'x' }, 1, 0)]))).toThrow(ProjectionError);
		expect(() => service.apply(commitOf(3, [llmEntry('pi.user', { text: 'x' }, 3, 0)]))).toThrow(ProjectionError);

		const wrongSeq = llmEntry('pi.user', { text: 'x' }, 9, 0);
		expect(() => service.apply(commitOf(2, [wrongSeq]))).toThrow(ProjectionError);

		const batch = commitOf(2, [llmEntry('pi.user', { text: 'x' }, 2, 0)]);
		const mislabeled: CommitWithEntries = { ...batch, entryCount: 2 };
		expect(() => service.apply(mislabeled)).toThrow(ProjectionError);

		const empty = commitOf(2, []);
		expect(() => service.apply(empty)).toThrow(ProjectionError);
	});

	// Regression (wave-2 review): the fold tolerates a mid-batch START on
	// purpose (a resume slice may begin in the middle of a batch), so an
	// internal ordinal gap was caught while a wrong ordinal BASE slipped
	// through — `apply` accepted a whole-batch commit whose first entry
	// carried ordinal 1 and parked the watermark on a nonexistent position.
	it('rejects a whole batch whose first entry does not carry ordinal 0', () => {
		const service = new ProjectionService();
		service.apply(commitOf(1, [llmEntry('pi.user', { text: 'u1' }, 1, 0)]));

		const cutStart = commitOf(2, [
			llmEntry('pi.user', { text: 'mid-batch tail' }, 2, 1),
			llmEntry('pi.assistant', { text: 'a' }, 2, 2),
		]);
		expect(() => service.apply(cutStart)).toThrow(ProjectionError);

		// Atomic: the rejected commit left the service untouched.
		expect(service.capsule().appliedSeq).toBe(1);
		expect(service.manifest().watermark).toEqual({ seq: 1, ordinal: 0 });

		// The corrected whole batch applies at the same sequence.
		service.apply(commitOf(2, [
			llmEntry('pi.user', { text: 'head' }, 2, 0),
			llmEntry('pi.assistant', { text: 'tail' }, 2, 1),
		]));
		expect(service.capsule().appliedSeq).toBe(2);
		expect(service.manifest().watermark).toEqual({ seq: 2, ordinal: 1 });
	});

	it('rejects a commit whose head differs from its seq (backend invariant)', () => {
		const service = new ProjectionService();
		const commit = commitOf(1, [llmEntry('pi.user', { text: 'u1' }, 1, 0)]);
		const diverged: CommitWithEntries = { ...commit, head: 5 as typeof commit.head };
		expect(() => service.apply(diverged)).toThrow(ProjectionError);
	});
});

describe('capsule', () => {
	it('tracks the resume position through compaction', () => {
		const service = new ProjectionService();
		expect(service.capsule()).toEqual({
			head: SEQ_AT_START,
			firstKeptEntryId: null,
			compaction: null,
			usageAnchor: null,
			appliedSeq: SEQ_AT_START,
		});

		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'a1' }, 1, 1);
		service.apply(commitOf(1, [a, b]));
		expect(service.capsule()).toEqual({
			head: 1,
			firstKeptEntryId: null,
			compaction: null,
			usageAnchor: b.id,
			appliedSeq: 1,
		});

		const compaction = compactionEntry(2, 0, 'summary of a', b.id);
		service.apply(commitOf(2, [compaction]));
		expect(service.capsule()).toEqual({
			head: 2,
			firstKeptEntryId: b.id,
			compaction: { summary: 'summary of a', firstKeptEntryId: b.id },
			usageAnchor: b.id,
			appliedSeq: 2,
		});
	});
});

describe('fromCapsule (lazy open on the retained slice)', () => {
	/** Entries of the applied log from `firstKeptEntryId` (when set) to the head — the storage range read. */
	function retainedSlice(log: readonly Entry[], firstKeptEntryId: string | null): Entry[] {
		if (firstKeptEntryId === null) return [...log];
		const start = log.findIndex((entry) => entry.id === firstKeptEntryId);
		return start === -1 ? [] : log.slice(start);
	}

	it('round-trips a compacted history: the resumed manifest equals the live one', () => {
		const service = new ProjectionService();
		const log: Entry[] = [];
		let seq = 0;
		const append = (entries: Entry[]) => {
			seq += 1;
			log.push(...entries);
			service.apply(commitOf(seq, entries));
		};

		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'a1' }, 1, 1);
		append([a, b]);
		append([compactionEntry(2, 0, 'summary of a', b.id)]);
		const c = llmEntry('pi.user', { text: 'u2' }, 3, 0);
		append([c, auditEntry(3, 1)]);

		const resumed = ProjectionService.fromCapsule(service.capsule(), retainedSlice(log, service.capsule().firstKeptEntryId));
		expect(resumed.manifest()).toEqual(service.manifest());
		expect(resumed.capsule()).toEqual(service.capsule());

		// The resumed service continues the log: the next commit applies and
		// stays identical to a full rebuild over the whole log.
		seq += 1;
		const d = llmEntry('pi.assistant', { text: 'a2' }, seq, 0);
		log.push(d);
		const applied = resumed.apply(commitOf(seq, [d]));
		expect(applied.delta.map((segment) => segment.entryId)).toEqual([d.id]);
		expect(resumed.manifest()).toEqual(buildProjection(log));
	});

	it('resumes a fresh session from the start-of-log capsule', () => {
		const service = new ProjectionService();
		const resumed = ProjectionService.fromCapsule(service.capsule(), []);
		expect(resumed.manifest()).toEqual(buildProjection([]));
		expect(resumed.capsule().appliedSeq).toBe(SEQ_AT_START);
	});

	it('resumes an uncompacted window slice (the capsule describes the retained window)', () => {
		const service = new ProjectionService();
		const log: Entry[] = [];
		for (let seq = 1; seq <= 4; seq += 1) {
			const batch = [llmEntry('pi.user', { text: `u${seq}` }, seq, 0), auditEntry(seq, 1)];
			log.push(...batch);
			service.apply(commitOf(seq, batch));
		}
		const capsule = service.capsule();
		expect(capsule.firstKeptEntryId).toBeNull();
		const windowSlice = log.slice(-2); // the fixed window the storage layer serves
		const resumed = ProjectionService.fromCapsule(capsule, windowSlice);
		expect(resumed.manifest().segments.map((segment) => segment.entryId)).toEqual([windowSlice[0]!.id]);
		expect(resumed.capsule().appliedSeq).toBe(capsule.appliedSeq);
	});

	it('rejects a slice inconsistent with its capsule', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'a1' }, 1, 1);
		service.apply(commitOf(1, [a, b]));
		const compaction = compactionEntry(2, 0, 'summary of a', b.id);
		service.apply(commitOf(2, [compaction]));
		const capsule = service.capsule();
		const slice = retainedSliceOf([a, b, compaction], capsule.firstKeptEntryId);

		// Slice missing the first kept entry.
		expect(() => ProjectionService.fromCapsule(capsule, slice.slice(1))).toThrow(ProjectionError);
		// Slice folded past the capsule head.
		const extra = llmEntry('pi.user', { text: 'u2' }, 3, 0);
		expect(() => ProjectionService.fromCapsule(capsule, [...slice, extra])).toThrow(ProjectionError);
		// firstKeptEntryId without a compaction mark (and the reverse).
		expect(() =>
			ProjectionService.fromCapsule({ ...capsule, compaction: null }, slice),
		).toThrow(ProjectionError);
		// Stale usage anchor.
		expect(() =>
			ProjectionService.fromCapsule({ ...capsule, usageAnchor: 'stale' }, slice),
		).toThrow(ProjectionError);
		// appliedSeq behind the slice head.
		expect(() =>
			ProjectionService.fromCapsule({ ...capsule, appliedSeq: (capsule.appliedSeq - 1) as typeof capsule.appliedSeq }, slice),
		).toThrow(ProjectionError);

		function retainedSliceOf(log: Entry[], firstKeptEntryId: string | null): Entry[] {
			const start = firstKeptEntryId === null ? 0 : log.findIndex((entry) => entry.id === firstKeptEntryId);
			return log.slice(start);
		}
	});
});

describe('no retained log (bounded RAM)', () => {
	it('holds no raw-entry retention: the service state is the derived window only', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		service.apply(commitOf(1, [a]));
		// The wave-2 review pins the structural property: no internal raw-log
		// array survives an apply — RAM is bounded by the window, not history.
		const internals = service as unknown as Record<string, unknown>;
		expect(internals.log).toBeUndefined();
		expect(internals.state).toBeDefined();
	});

	it('stays equivalent to a full rebuild across many control commits on a long stream', () => {
		const service = new ProjectionService();
		const log: Entry[] = [];
		let seq = 0;
		// A long plain stream, then a compaction, then more — the control
		// commit must NOT re-fold (nor need) the dropped prefix.
		for (let i = 0; i < 50; i += 1) {
			seq += 1;
			const batch = [llmEntry('pi.user', { text: `u${i}` }, seq, 0)];
			log.push(...batch);
			service.apply(commitOf(seq, batch));
		}
		const mid = log[25]!;
		seq += 1;
		const compaction = compactionEntry(seq, 0, 'summary', mid.id);
		log.push(compaction);
		service.apply(commitOf(seq, [compaction]));
		for (let i = 0; i < 10; i += 1) {
			seq += 1;
			const batch = [llmEntry('pi.assistant', { text: `a${i}` }, seq, 0), auditEntry(seq, 1)];
			log.push(...batch);
			service.apply(commitOf(seq, batch));
		}
		expect(service.manifest()).toEqual(buildProjection(log));
		// Only the kept window is manifest-visible.
		expect(service.manifest().segments).toHaveLength(25 + 10);
	});
});
