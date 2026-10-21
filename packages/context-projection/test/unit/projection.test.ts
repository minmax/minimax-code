import { describe, expect, it } from 'vitest';

import { SEQ_AT_START } from '../../../durable-backend-sqlite-zstd/src/types.js';

import {
	WATERMARK_AT_START,
	buildProjection,
	foldEntry,
	EMPTY_STATE,
	ProjectionError,
	toManifest,
} from '../../src/index.js';
import { auditEntry, compactionEntry, editEntry, llmEntry, seqOf } from './helpers.js';

describe('buildProjection (one-shot fold)', () => {
	it('projects the empty log to the start-of-log manifest', () => {
		expect(buildProjection([])).toEqual({
			head: SEQ_AT_START,
			segments: [],
			usageAnchor: null,
			watermark: WATERMARK_AT_START,
		});
		// The optional compaction key is absent, not undefined-valued.
		expect('compaction' in buildProjection([])).toBe(false);
	});

	it('appends one segment per LLM-visible entry, in log order', () => {
		const a = llmEntry('pi.user', { text: 'hello' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'hi there' }, 1, 1);
		const manifest = buildProjection([a, b]);

		expect(manifest.head).toBe(1);
		expect(manifest.segments).toEqual([
			{ entryId: a.id, byteLen: Buffer.byteLength(JSON.stringify(a.payload), 'utf8'), kind: 'pi.user' },
			{ entryId: b.id, byteLen: Buffer.byteLength(JSON.stringify(b.payload), 'utf8'), kind: 'pi.assistant' },
		]);
		expect(manifest.usageAnchor).toBe(b.id);
		expect(manifest.watermark).toEqual({ seq: 1, ordinal: 1 });
		expect(manifest.compaction).toBeUndefined();
	});

	it('filters audit/control entries out of the LLM context while the fold still advances', () => {
		const user = llmEntry('pi.user', { text: 'prompt' }, 3, 0);
		const audit = auditEntry(3, 1);
		const manifest = buildProjection([user, audit]);

		expect(manifest.segments.map((segment) => segment.entryId)).toEqual([user.id]);
		// Watermark and head advance over the audit entry…
		expect(manifest.watermark).toEqual({ seq: 3, ordinal: 1 });
		expect(manifest.head).toBe(3);
		// …but the usage anchor stays on the last LLM-visible entry.
		expect(manifest.usageAnchor).toBe(user.id);
	});

	it('measures byteLen as the UTF-8 byte length of the serialized payload', () => {
		const cyrillic = llmEntry('pi.user', { text: 'привет' }, 1, 0);
		const manifest = buildProjection([cyrillic]);
		expect(manifest.segments[0]).toEqual({
			entryId: cyrillic.id,
			byteLen: Buffer.byteLength(JSON.stringify(cyrillic.payload), 'utf8'),
			kind: 'pi.user',
		});
	});

	it('rejects a slice that does not strictly advance in log order', () => {
		const first = llmEntry('pi.user', { text: 'a' }, 1, 0);
		// Replay of the same (seq, ordinal) position.
		const replayed: typeof first = { ...first, id: 'other' };
		expect(() => buildProjection([first, replayed])).toThrow(ProjectionError);
	});

	it('accepts a slice that starts mid-batch but requires contiguity within a batch', () => {
		// A resume slice may begin at any ordinal of its first batch…
		const mid = llmEntry('pi.user', { text: 'a' }, 5, 2);
		const next = llmEntry('pi.assistant', { text: 'b' }, 5, 3);
		expect(() => buildProjection([mid, next])).not.toThrow();
		// …while a skipped ordinal inside the SAME batch is rejected…
		const skippedOrdinal: typeof mid = { ...mid, id: 'other', ordinal: 4 };
		expect(() => buildProjection([mid, skippedOrdinal])).toThrow(ProjectionError);
		// …and a replay of an older position is rejected too.
		expect(() => buildProjection([mid, next, mid])).toThrow(ProjectionError);
	});
});

describe('compaction slice', () => {
	it('cuts every segment before firstKeptEntryId and records the mark', () => {
		const a = llmEntry('pi.user', { text: 'old' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'kept' }, 1, 1);
		const c = llmEntry('pi.user', { text: 'newer' }, 2, 0);
		// `a` is summarized away: the first KEPT entry is `b`.
		const compaction = compactionEntry(2, 1, 'summary of a', b.id);

		const manifest = buildProjection([a, b, c, compaction]);
		expect(manifest.segments.map((segment) => segment.entryId)).toEqual([b.id, c.id]);
		expect(manifest.compaction).toEqual({ summary: 'summary of a', firstKeptEntryId: b.id });
		// The usage anchor never regresses below the cut.
		expect(manifest.usageAnchor).toBe(c.id);
	});

	it('keeps segments at and after firstKeptEntryId, cutting exactly the prefix', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'b' }, 1, 1);
		const compaction = compactionEntry(2, 0, 'summary of a', b.id);
		const manifest = buildProjection([a, b, compaction]);
		expect(manifest.segments.map((segment) => segment.entryId)).toEqual([b.id]);
	});

	it('lets a later compaction replace an earlier one', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'b' }, 1, 1);
		const first = compactionEntry(2, 0, 'first summary', a.id);
		const second = compactionEntry(3, 0, 'second summary', b.id);

		const manifest = buildProjection([a, b, first, second]);
		expect(manifest.compaction).toEqual({ summary: 'second summary', firstKeptEntryId: b.id });
		expect(manifest.segments.map((segment) => segment.entryId)).toEqual([b.id]);
	});

	it('rejects an unknown firstKeptEntryId', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const compaction = compactionEntry(2, 0, 'summary', 'missing-entry');
		expect(() => buildProjection([a, compaction])).toThrow(ProjectionError);
	});

	it('rejects a malformed compaction payload', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const bad = compactionEntry(2, 0, 'summary', a.id);
		const malformed: typeof bad = { ...bad, payload: { summary: 42 } };
		expect(() => buildProjection([a, malformed])).toThrow(TypeError);
	});
});

describe('context_edit pruning', () => {
	it('removes exactly the listed segments', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'b' }, 1, 1);
		const c = llmEntry('pi.user', { text: 'c' }, 2, 0);
		const edit = editEntry(2, 1, [a.id, c.id]);

		const manifest = buildProjection([a, b, c, edit]);
		expect(manifest.segments.map((segment) => segment.entryId)).toEqual([b.id]);
		expect(manifest.usageAnchor).toBe(c.id);
	});

	it('treats an edit without removals as a no-op that still advances the fold', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const edit = editEntry(2, 0, []);
		const manifest = buildProjection([a, edit]);
		expect(manifest.segments).toHaveLength(1);
		expect(manifest.watermark).toEqual({ seq: 2, ordinal: 0 });
	});

	it('rejects removal of an id outside the current context', () => {
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const edit = editEntry(2, 0, ['missing-entry']);
		expect(() => buildProjection([a, edit])).toThrow(ProjectionError);
	});
});

describe('watermark', () => {
	it('starts at WATERMARK_AT_START and records the exact (seq, ordinal) position', () => {
		expect(WATERMARK_AT_START).toEqual({ seq: SEQ_AT_START, ordinal: -1 });

		const a = llmEntry('pi.user', { text: 'a' }, 7, 0);
		const b = llmEntry('pi.assistant', { text: 'b' }, 7, 1);
		const c = llmEntry('pi.user', { text: 'c' }, 8, 0);
		expect(buildProjection([a, b, c]).watermark).toEqual({ seq: 8, ordinal: 0 });
	});

	it('advances over audit-only slices', () => {
		const audit = auditEntry(5, 2);
		expect(buildProjection([audit]).watermark).toEqual({ seq: 5, ordinal: 2 });
		expect(buildProjection([audit]).segments).toEqual([]);
	});

	it('is updated by the same fold step that the service uses', () => {
		// foldEntry is the single semantics definition shared with the service;
		// the one-shot fold must agree with manual stepping from the empty state.
		const a = llmEntry('pi.user', { text: 'a' }, 1, 0);
		const b = auditEntry(1, 1);
		let state = EMPTY_STATE;
		state = foldEntry(state, a);
		state = foldEntry(state, b);
		expect(buildProjection([a, b])).toEqual(toManifest(state));
	});
});

describe('sequence guards', () => {
	it('accepts seqOf-branded positions from the backend contract', () => {
		const entry = llmEntry('pi.user', { text: 'a' }, seqOf(1) as unknown as number, 0);
		expect(buildProjection([entry]).head).toBe(1);
	});
});
