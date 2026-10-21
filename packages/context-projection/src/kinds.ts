// Reserved entry kinds of the context projection.
//
// The durable log is kind-agnostic: `Entry.kind` is an application-defined
// discriminator. The projection applies one filter rule and two control
// interpretations on top of that open set:
//
//   - every kind prefixed with `mcode.` is an audit/control entry: it advances
//     the fold position but NEVER becomes an LLM-visible segment;
//   - `mcode.compaction` and `mcode.context_edit` additionally carry payload
//     that rewrites the derived view, so the incremental cache is dropped and
//     the manifest is fully refolded when they are applied.
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

/** Payload of a {@link CONTEXT_EDIT_KIND} entry. */
export interface ContextEditPayload {
	/** Entry ids to drop from the current derived segments. Unknown ids are rejected. */
	readonly removedEntryIds?: readonly string[];
}

/** Whether `kind` marks an audit/control entry that must stay out of the LLM context. */
export function isControlKind(kind: string): boolean {
	return kind.startsWith(CONTROL_KIND_PREFIX);
}

/** Narrows an unknown entry payload to a {@link CompactionPayload}; throws when malformed. */
export function asCompactionPayload(payload: unknown, entryId: string): CompactionPayload {
	if (typeof payload !== 'object' || payload === null) {
		throw new TypeError(`mcode.compaction entry ${entryId}: payload must be an object`);
	}
	const { summary, firstKeptEntryId } = payload as Record<string, unknown>;
	if (typeof summary !== 'string') {
		throw new TypeError(`mcode.compaction entry ${entryId}: payload.summary must be a string`);
	}
	if (typeof firstKeptEntryId !== 'string' || firstKeptEntryId.length === 0) {
		throw new TypeError(`mcode.compaction entry ${entryId}: payload.firstKeptEntryId must be a non-empty string`);
	}
	return { summary, firstKeptEntryId };
}

/** Narrows an unknown entry payload to a {@link ContextEditPayload}; throws when malformed. */
export function asContextEditPayload(payload: unknown, entryId: string): ContextEditPayload {
	if (typeof payload !== 'object' || payload === null) {
		throw new TypeError(`mcode.context_edit entry ${entryId}: payload must be an object`);
	}
	const { removedEntryIds } = payload as Record<string, unknown>;
	if (removedEntryIds !== undefined) {
		if (!Array.isArray(removedEntryIds) || removedEntryIds.some((id) => typeof id !== 'string')) {
			throw new TypeError(`mcode.context_edit entry ${entryId}: payload.removedEntryIds must be a string array`);
		}
	}
	return { removedEntryIds };
}
