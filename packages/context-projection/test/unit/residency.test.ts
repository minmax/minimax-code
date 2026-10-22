import { describe, expect, it } from 'vitest';

import { ProjectionError, ProjectionService } from '../../src/index.js';
import type { ResidencyPolicy, Segment } from '../../src/index.js';
import { auditEntry, commitOf, compactionEntry, llmEntry } from './helpers.js';

function segmentOf(entry: ReturnType<typeof llmEntry>): Segment {
	return {
		entryId: entry.id,
		byteLen: Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'),
		kind: entry.kind,
	};
}

describe('default residency (no policy)', () => {
	it('treats every page as resident and faults resolve locally from the manifest', async () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'a1' }, 1, 1);
		const audit = auditEntry(1, 2);
		const c = llmEntry('pi.user', { text: 'u2' }, 2, 0);
		service.apply(commitOf(1, [a, b, audit]));
		service.apply(commitOf(2, [c]));

		const expected = [segmentOf(a), segmentOf(b), segmentOf(c)];

		expect(service.resident(a.id)).toBe(true);
		expect(service.llmSegments()).toEqual(expected);
		await expect(service.llmContext()).resolves.toEqual(expected);
		await expect(service.fault(b.id)).resolves.toEqual(segmentOf(b));
		await expect(service.fault('missing-entry')).rejects.toThrow(ProjectionError);
	});

	it('never serves audit/control entries through the context view', () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		service.apply(commitOf(1, [a, auditEntry(1, 1)]));
		const kinds = service.llmSegments().map((segment) => segment.kind);
		expect(kinds).toEqual(['pi.user']);
		expect(kinds.every((kind) => !kind.startsWith('mcode.'))).toBe(true);
	});
});

describe('custom residency policy', () => {
	it('keeps resident pages local and materializes demoted pages through onFault', async () => {
		const service = new ProjectionService();
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'a1' }, 1, 1);
		const c = llmEntry('pi.user', { text: 'u2' }, 2, 0);
		service.apply(commitOf(1, [a, b]));
		service.apply(commitOf(2, [c]));

		// The policy demotes exactly one page and serves it from its own store
		// under a materialized discriminator.
		const demotedId = a.id;
		const materialized: Segment = { entryId: demotedId, byteLen: -1, kind: 'materialized' };
		const faults: string[] = [];
		const policy: ResidencyPolicy = {
			resident: (entryId) => entryId !== demotedId,
			onFault: async (entryId) => {
				faults.push(entryId);
				return materialized;
			},
		};
		const managed = new ProjectionService({ residency: policy });
		managed.apply(commitOf(1, [a, b]));
		managed.apply(commitOf(2, [c]));

		expect(managed.resident(demotedId)).toBe(false);
		expect(managed.resident(b.id)).toBe(true);

		const context = await managed.llmContext();
		// Exactly the demoted page went through the fault path; resident pages
		// come from the manifest untouched.
		expect(faults).toEqual([demotedId]);
		expect(context).toEqual([materialized, segmentOf(b), segmentOf(c)]);

		// The policy owns materialization; the service never resolves locally.
		await expect(managed.fault(demotedId)).resolves.toEqual(materialized);
	});

	it('survives a compaction cut with a policy installed (full refold path)', async () => {
		const policy: ResidencyPolicy = {
			resident: () => false,
			onFault: async (entryId) => ({ entryId, byteLen: 0, kind: 'materialized' }),
		};
		const service = new ProjectionService({ residency: policy });
		const a = llmEntry('pi.user', { text: 'u1' }, 1, 0);
		const b = llmEntry('pi.assistant', { text: 'a1' }, 1, 1);
		service.apply(commitOf(1, [a, b]));
		service.apply(commitOf(2, [compactionEntry(2, 0, 'summary of a', b.id)]));

		const context = await service.llmContext();
		expect(context.map((segment) => segment.entryId)).toEqual([b.id]);
		expect(context[0]).toEqual({ entryId: b.id, byteLen: 0, kind: 'materialized' });
	});
});
