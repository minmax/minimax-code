// Deterministic factories for log entries and enriched commits in the
// projection unit tests. Ids and payloads are generated sequentially so the
// suites are reproducible.

import type { Commit, Entry, JsonValue, Seq } from '../../../durable-backend-sqlite-zstd/src/types.js';

import type { CommitWithEntries } from '../../src/service.js';

let counter = 0;

/** Fresh unique entry id. */
export function nextId(prefix = 'e'): string {
	counter += 1;
	return `${prefix}-${counter}`;
}

/** Wraps a plain number into the backend's branded `Seq`. */
export function seqOf(value: number): Seq {
	return value as Seq;
}

/** LLM-visible entry (a `pi.*` kind by convention of the log). */
export function llmEntry(kind: string, payload: JsonValue, seq: number, ordinal: number): Entry {
	return { id: nextId('llm'), parentId: null, kind, payload, seq: seqOf(seq), ordinal };
}

/** Audit entry (`mcode.audit`): filtered out of the LLM context, advances the fold. */
export function auditEntry(seq: number, ordinal: number): Entry {
	return {
		id: nextId('audit'),
		parentId: null,
		kind: 'mcode.audit',
		payload: { note: `audit-${ordinal}` },
		seq: seqOf(seq),
		ordinal,
	};
}

/** Compaction control entry: cuts every segment before `firstKeptEntryId`. */
export function compactionEntry(
	seq: number,
	ordinal: number,
	summary: string,
	firstKeptEntryId: string,
): Entry {
	return {
		id: nextId('compaction'),
		parentId: null,
		kind: 'mcode.compaction',
		payload: { summary, firstKeptEntryId },
		seq: seqOf(seq),
		ordinal,
	};
}

/** Context-edit control entry: prunes `removedEntryIds` from the derived segments. */
export function editEntry(seq: number, ordinal: number, removedEntryIds: string[]): Entry {
	return {
		id: nextId('edit'),
		parentId: null,
		kind: 'mcode.context_edit',
		payload: { removedEntryIds },
		seq: seqOf(seq),
		ordinal,
	};
}

/** Builds the backend-shaped commit of `entries`, enriched with them. */
export function commitOf(seq: number, entries: readonly Entry[]): CommitWithEntries {
	const uncompressedBytes = entries.reduce(
		(sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'),
		0,
	);
	const commit: Commit = {
		seq: seqOf(seq),
		batchId: seq as Commit['batchId'],
		entryCount: entries.length,
		head: seqOf(seq),
		codec: 'zstd',
		compressedBytes: uncompressedBytes,
		uncompressedBytes,
	};
	return { ...commit, entries };
}

/** Deterministic LCG in [0, 1) so the randomized equivalence test is reproducible. */
export function makeLcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}
