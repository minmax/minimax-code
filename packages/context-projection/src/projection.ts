// Context manifest: the derived view over the durable delta log.
//
// `buildProjection` is a left fold over entries in log order — no leaf→root
// walk of any entry graph. The same single `foldEntry` step drives both the
// one-shot fold and the incremental {@link ProjectionService}, so applying N
// commits incrementally yields a manifest structurally equal to a full
// rebuild over the whole log by construction; the equivalence is still pinned
// by a dedicated unit test.

// Types come straight from the backend's `src/types.ts` — the module the
// wave-1 contract pins — rather than through the package's `.` export,
// because the export's `import` condition resolves to `dist/index.js`, which
// does not exist until the integrator builds the workspace (and its `index.ts`
// would also drag `backend.ts` into the program). Switching to the package
// specifier is a two-line change once `dist/` exists.

import type { Entry, Seq } from '../../durable-backend-sqlite-zstd/src/types.js';
import { SEQ_AT_START } from '../../durable-backend-sqlite-zstd/src/types.js';

import {
	COMPACTION_KIND,
	CONTEXT_EDIT_KIND,
	asCompactionPayload,
	asContextEditPayload,
	isControlKind,
} from './kinds.js';

/** Error raised when a log slice violates the projection contract. */
export class ProjectionError extends Error {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'ProjectionError';
	}
}

/** The branded start-of-log sequence, as the backend's `SEQ_AT_START` constant. */
const SEQ_AT_LOG_START = SEQ_AT_START as Seq;

/**
 * One LLM-visible context page of the manifest.
 *
 * Segments are handles, not content: the projection never holds entry
 * payloads, only their identity, discriminator and size. `entryId` is the
 * `Entry.id` of the source entry (the durable backend names it `id`; the
 * manifest vocabulary calls it `entryId`).
 */
export interface Segment {
	/** `Entry.id` of the entry this segment was derived from. */
	readonly entryId: string;
	/** UTF-8 byte length of the canonical JSON serialization of the entry payload. */
	readonly byteLen: number;
	/** Entry kind, verbatim from the log. */
	readonly kind: string;
}

/** Compaction mark recorded in the manifest. */
export interface CompactionMark {
	/** Summary standing in for the context dropped by the compaction. */
	readonly summary: string;
	/** Entry id of the first entry still kept as a segment after the cut. */
	readonly firstKeptEntryId: string;
}

/** Position of one entry in the log: batch sequence plus ordinal inside the batch. */
export interface LogPosition {
	readonly seq: Seq;
	readonly ordinal: number;
}

/** Watermark of the projection: the log position the fold has caught up to. */
export type Watermark = LogPosition;

/** Watermark of a projection over an empty log: before the first commit (`SEQ_AT_START`, no ordinal). */
export const WATERMARK_AT_START: Watermark = { seq: SEQ_AT_LOG_START, ordinal: -1 };

/** The full derived context view; equal by construction to any incremental application. */
export interface ContextManifest {
	/**
	 * Log head the fold has caught up to: the `seq` of the last folded entry,
	 * `SEQ_AT_START` over an empty log. For the `sqlite-zstd` backend this is
	 * always equal to the last commit's `head` (`Commit.head === Commit.seq`).
	 */
	readonly head: Seq;
	/** LLM-visible context pages in log order; audit/control (`mcode.*`) entries never appear here. */
	readonly segments: readonly Segment[];
	/**
	 * Σ `byteLen` over {@link segments} — the byte size of the projection
	 * WINDOW, maintained incrementally (O(delta) per commit; a compaction
	 * subtracts the cut prefix). This is the byte truth the compaction
	 * trigger's byte axis consumes; it is NOT the provider payload size (the
	 * wire compiler's `CompiledBody.totalBytes` measures the normalized
	 * segments actually sent).
	 */
	readonly windowBytes: number;
	/** Last compaction applied to the context, if any; later compactions replace earlier ones. */
	readonly compaction?: CompactionMark;
	/**
	 * `entryId` of the last applied LLM-visible entry — the anchor usage
	 * accounting resumes from. Never regresses, even when a compaction cuts the
	 * anchored entry's segment; `null` before the first LLM-visible entry.
	 */
	readonly usageAnchor: string | null;
	/** Exact log position (seq, ordinal) the fold has caught up to. */
	readonly watermark: Watermark;
}

/** The immutable fold state shared by the one-shot fold and the incremental service. */
export interface ProjectionState {
	readonly head: Seq;
	readonly watermark: Watermark;
	/** LLM-visible segments in log order; compaction cuts and context edits rewrite this list. */
	readonly segments: readonly Segment[];
	/** Σ `byteLen` over `segments`; maintained incrementally by {@link foldEntry}. */
	readonly windowBytes: number;
	readonly compaction: CompactionMark | null;
	readonly usageAnchor: string | null;
}

/** Fold state over an empty log. */
export const EMPTY_STATE: ProjectionState = {
	head: SEQ_AT_LOG_START,
	watermark: WATERMARK_AT_START,
	segments: [],
	windowBytes: 0,
	compaction: null,
	usageAnchor: null,
};

/** UTF-8 byte length of the canonical JSON serialization of a payload. */
function payloadByteLen(entry: Entry): number {
	return Buffer.byteLength(JSON.stringify(entry.payload), 'utf8');
}

/**
 * Whether `(seq, ordinal)` strictly advances over `previous` in log order:
 * ascending `seq` may start at any ordinal — a projection slice may begin
 * mid-batch (e.g. a resume from a capsule) — while ordinals inside one batch
 * must be contiguous.
 */
function advancesLogPosition(previous: LogPosition, seq: Seq, ordinal: number): boolean {
	return seq > previous.seq || (seq === previous.seq && ordinal === previous.ordinal + 1);
}

/**
 * Folds ONE entry into the state. This is the single definition of the
 * projection semantics; both `buildProjection` and `ProjectionService.apply`
 * go through it, which is what makes incremental application identical to a
 * full rebuild.
 *
 * - LLM-visible entries append one segment and advance the usage anchor.
 * - `mcode.*` audit/control entries never become segments; the two control
 *   kinds additionally rewrite the segment list (compaction cut / pruning).
 * - Every entry advances the watermark and the head.
 */
export function foldEntry(state: ProjectionState, entry: Entry): ProjectionState {
	if (!advancesLogPosition(state.watermark, entry.seq, entry.ordinal)) {
		throw new ProjectionError(
			`entry ${entry.id} (seq ${entry.seq}, ordinal ${entry.ordinal}) does not advance ` +
				`the log position (seq ${state.watermark.seq}, ordinal ${state.watermark.ordinal}): ` +
				'entries must be in ascending (seq, ordinal) order and contiguous within a batch',
		);
	}

	const base: ProjectionState = {
		head: entry.seq,
		watermark: { seq: entry.seq, ordinal: entry.ordinal },
		segments: state.segments,
		windowBytes: state.windowBytes,
		compaction: state.compaction,
		usageAnchor: state.usageAnchor,
	};

	if (!isControlKind(entry.kind)) {
		const byteLen = payloadByteLen(entry);
		const segment: Segment = { entryId: entry.id, byteLen, kind: entry.kind };
		return {
			...base,
			segments: [...state.segments, segment],
			windowBytes: state.windowBytes + byteLen,
			usageAnchor: entry.id,
		};
	}

	// Audit/control entry: filtered out of the LLM context; only the two
	// control kinds rewrite the derived view. Both maintain `windowBytes`
	// over the REMOVED entries only — O(cut), never a fold of the whole log.
	switch (entry.kind) {
		case COMPACTION_KIND: {
			const { summary, firstKeptEntryId } = asCompactionPayload(entry.payload, entry.id);
			const cutIndex = state.segments.findIndex((segment) => segment.entryId === firstKeptEntryId);
			if (cutIndex < 0) {
				throw new ProjectionError(
					`mcode.compaction entry ${entry.id}: firstKeptEntryId ${JSON.stringify(firstKeptEntryId)} ` +
						'is not a segment of the current context',
				);
			}
			let cutBytes = 0;
			for (let i = 0; i < cutIndex; i += 1) cutBytes += state.segments[i]!.byteLen;
			return {
				...base,
				segments: state.segments.slice(cutIndex),
				windowBytes: state.windowBytes - cutBytes,
				compaction: { summary, firstKeptEntryId },
			};
		}
		case CONTEXT_EDIT_KIND: {
			const payload = asContextEditPayload(entry.payload, entry.id);
			if ('action' in payload) {
				// Omission variant: hide whatever targets are current segments;
				// targets already gone (cut by a compaction, or never projected)
				// stay hidden without raising — the writer cannot know the fold's
				// exact window when it records the retraction.
				if (payload.targetIds.length === 0) return base;
				const hidden = new Set(payload.targetIds);
				const kept = state.segments.filter((segment) => !hidden.has(segment.entryId));
				if (kept.length === state.segments.length) return base;
				const keptBytes = kept.reduce((sum, segment) => sum + segment.byteLen, 0);
				return { ...base, segments: kept, windowBytes: keptBytes };
			}
			const { removedEntryIds } = payload;
			if (removedEntryIds.length === 0) return base;
			const removed = new Set(removedEntryIds);
			const kept = state.segments.filter((segment) => !removed.has(segment.entryId));
			if (kept.length + removed.size !== state.segments.length) {
				const known = new Set(state.segments.map((segment) => segment.entryId));
				const unknown = removedEntryIds.filter((id) => !known.has(id));
				throw new ProjectionError(
					`mcode.context_edit entry ${entry.id}: removedEntryIds not in the current context: ` +
						unknown.map((id) => JSON.stringify(id)).join(', '),
				);
			}
			const keptBytes = kept.reduce((sum, segment) => sum + segment.byteLen, 0);
			return { ...base, segments: kept, windowBytes: keptBytes };
		}
		default:
			// Plain audit entry: observed by the watermark only.
			return base;
	}
}

/** Folds a whole log-order slice of entries from the empty state. */
export function foldAll(entries: readonly Entry[]): ProjectionState {
	let state = EMPTY_STATE;
	for (const entry of entries) {
		state = foldEntry(state, entry);
	}
	return state;
}

/** Freezes a fold state into the public manifest shape (fresh arrays, optional compaction key). */
export function toManifest(state: ProjectionState): ContextManifest {
	const manifest: { -readonly [K in keyof ContextManifest]: ContextManifest[K] } = {
		head: state.head,
		segments: [...state.segments],
		windowBytes: state.windowBytes,
		usageAnchor: state.usageAnchor,
		watermark: { ...state.watermark },
	};
	if (state.compaction !== null) {
		manifest.compaction = { ...state.compaction };
	}
	return manifest;
}

/**
 * Projects a whole slice of entries into a {@link ContextManifest} with one
 * left fold — no leaf→root traversal of an entry graph. The slice must be in
 * ascending log order (contiguous within each batch); the fold rejects any
 * position that does not strictly advance.
 */
export function buildProjection(entries: readonly Entry[]): ContextManifest {
	return toManifest(foldAll(entries));
}
