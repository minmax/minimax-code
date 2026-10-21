// Reserved entry kinds of the context projection.
//
// The durable log is kind-agnostic: `Entry.kind` is an application-defined
// discriminator. The projection applies one filter rule and two control
// interpretations on top of that open set:
//
//   - every kind prefixed with `mcode.` is an audit/control entry: it advances
//     the fold position but NEVER becomes an LLM-visible segment;
//   - `mcode.compaction` and `mcode.context_edit` additionally carry payload
//     that rewrites the derived view (compaction cut / pruning); the fold
//     applies them through the same single `foldEntry` step as every other
//     kind, so incremental application stays identical to a full rebuild.
//
// All other kinds are LLM context: one segment per entry, in log order.

/** Prefix of every audit/control kind; such entries never enter the LLM context. */
export const CONTROL_KIND_PREFIX = 'mcode.';

/** Control entry that replaces an older context span with a summary. */
export const COMPACTION_KIND = 'mcode.compaction';

/** Control entry that rewrites (prunes) the current derived context. */
export const CONTEXT_EDIT_KIND = 'mcode.context_edit';

/** Payload of a {@link COMPACTION_KIND} entry. */
export interface CompactionPayload {
	/** Human- or model-readable summary standing in for the dropped prefix. */
	readonly summary: string;
	/** Entry id of the first entry still kept as a segment after the cut. */
	readonly firstKeptEntryId: string;
}

/**
 * The omission variant of a {@link CONTEXT_EDIT_KIND} payload — the format
 * `@mavis/context-compaction` writes (`createOmissionEntryDraft`, the
 * overflow-recovery retraction). An omission HIDES its targets from the
 * derived context; targets that are not current segments (already cut by a
 * compaction, or never projected) stay hidden and do not raise.
 */
export interface OmissionEditPayload {
	readonly action: 'omission';
	/** Ids of the entries the projection must hide. */
	readonly targetIds: readonly string[];
	/** Human-readable cause (the overflow error, for example). Unused by the fold. */
	readonly reason?: unknown;
	/** Wall-clock stamp of the omission. Unused by the fold. */
	readonly createdAtMs?: unknown;
}

/**
 * The strict pruning variant of a {@link CONTEXT_EDIT_KIND} payload (the
 * local `pi-context-edit` shape). Unknown ids REJECT the entry — unlike the
 * omission variant, a strict prune asserts exact knowledge of the window.
 */
export interface PruneEditPayload {
	/** Entry ids to drop from the current derived segments. Unknown ids are rejected. */
	readonly removedEntryIds: readonly string[];
}

/**
 * Payload of a {@link CONTEXT_EDIT_KIND} entry: either the cross-package
 * omission format ({@link OmissionEditPayload}, what `@mavis/context-compaction`
 * writes) or the local strict-prune format ({@link PruneEditPayload}).
 * `asContextEditPayload` throws on any other shape — an unknown variant is a
 * contract breach, never silently ignored.
 */
export type ContextEditPayload = OmissionEditPayload | PruneEditPayload;

/** Whether `kind` marks an audit/control entry that must stay out of the LLM context. */
export function isControlKind(kind: string): boolean {
	return kind.startsWith(CONTROL_KIND_PREFIX);
}

/** Narrows an unknown entry payload to a {@link CompactionPayload}; throws when malformed. */
export function asCompactionPayload(payload: unknown, entryId: string): CompactionPayload {
	if (typeof payload !== 'object' || payload === null) {
		throw new TypeError(`mcode.compaction entry ${entryId}: payload must be an object`);
	}
	const { summary, firstKeptEntryId, systemMessage } = payload as Record<string, unknown>;
	if (typeof summary !== 'string') {
		throw new TypeError(`mcode.compaction entry ${entryId}: payload.summary must be a string`);
	}
	if (typeof firstKeptEntryId !== 'string' || firstKeptEntryId.length === 0) {
		throw new TypeError(`mcode.compaction entry ${entryId}: payload.firstKeptEntryId must be a non-empty string`);
	}
	// The fold never reads `systemMessage` (it is the compaction core's frozen
	// prompt, not the projection's), so an ABSENT field stays legal — this
	// package's declared payload shape carries only the two fields above. A
	// PRESENT but corrupt value, though, is the same writer-contract breach a
	// corrupt summary is: the stricter compaction parsers treat such a
	// checkpoint as malformed (audit noise), so accepting it here would let a
	// record one consumer rejected apply a cut in another.
	if (systemMessage !== undefined && typeof systemMessage !== 'string' && systemMessage !== null) {
		throw new TypeError(`mcode.compaction entry ${entryId}: payload.systemMessage must be a string or null`);
	}
	return { summary, firstKeptEntryId };
}

/** Narrows an unknown entry payload to a {@link ContextEditPayload}; throws when malformed or of an unknown variant. */
export function asContextEditPayload(payload: unknown, entryId: string): ContextEditPayload {
	if (typeof payload !== 'object' || payload === null) {
		throw new TypeError(`mcode.context_edit entry ${entryId}: payload must be an object`);
	}
	const record = payload as Record<string, unknown>;
	// Omission variant (the format `@mavis/context-compaction` writes).
	if (record.action === 'omission') {
		const { targetIds } = record;
		if (!Array.isArray(targetIds) || targetIds.some((id) => typeof id !== 'string')) {
			throw new TypeError(`mcode.context_edit entry ${entryId}: payload.targetIds must be a string array`);
		}
		return { action: 'omission', targetIds };
	}
	// Strict prune variant (the local `pi-context-edit` shape).
	if (record.removedEntryIds !== undefined) {
		if (!Array.isArray(record.removedEntryIds) || record.removedEntryIds.some((id) => typeof id !== 'string')) {
			throw new TypeError(`mcode.context_edit entry ${entryId}: payload.removedEntryIds must be a string array`);
		}
		return { removedEntryIds: record.removedEntryIds };
	}
	throw new TypeError(
		`mcode.context_edit entry ${entryId}: unknown payload variant — expected ` +
			`{action:"omission", targetIds:[...]} or {removedEntryIds:[...]}`,
	);
}
