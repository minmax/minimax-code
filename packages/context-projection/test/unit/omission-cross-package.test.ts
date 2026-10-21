// Cross-package bridge test (wave-2 review, architecture finding):
// the omission record `@mavis/context-compaction` WRITES
// (`createOmissionEntryDraft` → `{action:"omission", targetIds, reason}`)
// must REMOVE segments when folded by THIS package's projection — the
// "projection-as-truth" contract. A silent format mismatch here would let a
// failed overflow-recovery attempt stay visible to the model.
//
// The import is workspace-relative (no `@mavis/*` specifier): wave-2 packages
// do not link each other in `node_modules` until the integrator registers
// them — same precedent as `src/projection.ts` importing the backend types.

import { describe, expect, it } from 'vitest';

import { createOmissionEntryDraft } from '../../../context-compaction/src/index.js';
import { SEQ_AT_START } from '../../../durable-backend-sqlite-zstd/src/types.js';
import type { Entry, JsonValue, Seq } from '../../../durable-backend-sqlite-zstd/src/types.js';

import { ProjectionService, buildProjection } from '../../src/index.js';
import { commitOf } from './helpers.js';

/** Backend-shaped entry at an explicit log position. */
function entry(id: string, kind: string, payload: JsonValue, seq: number, ordinal: number): Entry {
	return { id, parentId: null, kind, payload, seq: seq as Seq, ordinal };
}

/** Backend-shaped commit enriched with its entries (the `apply` input). */
function commit(seq: number, entries: readonly Entry[]) {
	return { ...commitOf(seq, entries), entries };
}

describe('omission written by context-compaction prunes context-projection segments', () => {
	it('the overflow-recovery omission draft hides its targets from the derived context', () => {
		const service = new ProjectionService();
		const a = entry('llm-a', 'pi.user', { text: 'question' }, 1, 0);
		const b = entry('llm-b', 'pi.assistant', { text: 'answer' }, 1, 1);
		service.apply(commit(1, [a, b]));
		expect(service.manifest().segments.map((segment) => segment.entryId)).toEqual([a.id, b.id]);

		// Exactly the draft `runWithOverflowRecovery` appends after a terminal
		// retry failure — the writer side of the contract.
		const omissionDraft = createOmissionEntryDraft(
			'omission-1',
			[a.id, b.id],
			'overflow recovery failed after compaction: window full; retry failed: window full',
		);
		expect(omissionDraft.payload).toMatchObject({ action: 'omission', targetIds: [a.id, b.id] });
		const omission = entry(omissionDraft.id, omissionDraft.kind, omissionDraft.payload as JsonValue, 2, 0);
		service.apply(commit(2, [omission]));

		// The failed attempt's segments are gone from the projection…
		expect(service.manifest().segments).toEqual([]);
		expect(service.manifest().windowBytes).toBe(0);
		// …and from the LLM context view.
		expect(service.llmSegments()).toEqual([]);
	});

	it('an omission hiding part of the window keeps the manifest consistent with a full rebuild', () => {
		const a = entry('llm-a', 'pi.user', { text: 'keep me' }, 1, 0);
		const b = entry('llm-b', 'pi.tool-result', { toolCallId: 'c1', content: 'stale' }, 1, 1);
		const c = entry('llm-c', 'mcode.audit', { note: 'bookkeeping' }, 2, 0);
		const omission = entry('omission-2', 'mcode.context_edit', { action: 'omission', targetIds: [b.id], reason: 'prune stale tool result' }, 2, 1);
		const log = [a, b, c, omission];

		const service = new ProjectionService();
		service.apply(commit(1, [a, b]));
		service.apply(commit(2, [c, omission]));

		expect(service.manifest()).toEqual(buildProjection(log));
		expect(service.manifest().segments.map((segment) => segment.entryId)).toEqual([a.id]);
	});

	it('capsule round-trip preserves the omission-pruned window', () => {
		const a = entry('llm-a', 'pi.user', { text: 'q' }, 1, 0);
		const b = entry('llm-b', 'pi.assistant', { text: 'stale' }, 1, 1);
		const omission = entry('omission-3', 'mcode.context_edit', { action: 'omission', targetIds: [b.id], reason: 'retraction' }, 2, 0);
		const service = new ProjectionService();
		service.apply(commit(1, [a, b]));
		service.apply(commit(2, [omission]));

		// The retained window the storage layer would serve for this capsule:
		// every entry since the window start — the omission re-applies over its
		// target during the fold, so the pruned view is reproduced exactly.
		const slice = [a, b, omission];
		const resumed = ProjectionService.fromCapsule(service.capsule(), slice);
		expect(resumed.manifest()).toEqual(service.manifest());
		expect(resumed.capsule().head).toBe(2);
		expect(resumed.capsule().appliedSeq).toBe(2);
		expect(resumed.capsule().usageAnchor).toBe(b.id);
		// The fresh-service capsule still starts at the log start.
		expect(new ProjectionService().capsule().appliedSeq).toBe(SEQ_AT_START);
	});
});
