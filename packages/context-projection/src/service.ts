// Incremental projection service.
//
// The service keeps the manifest fold warm: `apply()` folds ONLY the entries
// of the incoming commit into the cached state (the head-keyed incremental
// cache idea of pi-durable da866ada1), so the steady-state cost is
// O(entries of the commit). A full refold of the retained log happens ONLY
// when a commit carries a control entry that rewrites the derived view
// (`mcode.compaction` / `mcode.context_edit`); the single shared fold step
// keeps the result identical to `buildProjection` over the whole log.
//
// The backend `Commit` is a write result and does not carry the batch
// entries, while the projection fold needs their content — so `apply` takes
// the commit ENRICHED with its entries (`CommitWithEntries`), the pair the
// caller of `appendBatch` already has in hand.

// Types come straight from the backend's `src/types.ts` — see the note in
// `projection.ts` for why the package specifier is avoided for now.

import type { Commit, Entry, Seq } from '../../durable-backend-sqlite-zstd/src/types.js';
import { SEQ_AT_START } from '../../durable-backend-sqlite-zstd/src/types.js';

import { COMPACTION_KIND, CONTEXT_EDIT_KIND } from './kinds.js';
import {
	type ContextManifest,
	EMPTY_STATE,
	type ProjectionState,
	type Segment,
	ProjectionError,
	foldAll,
	foldEntry,
	toManifest,
} from './projection.js';
import type { ResidencyPolicy } from './residency.js';

/** A backend commit enriched with the entries stored in its batch. */
export type CommitWithEntries = Commit & { readonly entries: readonly Entry[] };

/** Result of applying one commit to the projection. */
export interface ApplyResult {
	/** The commit that was applied, verbatim. */
	readonly commit: Commit;
	/** Manifest snapshot after the commit; structurally equal to a full rebuild. */
	readonly manifest: ContextManifest;
	/**
	 * The derived view of ONLY the new entries: the segments of the post-apply
	 * manifest attributed to this commit's entries (control entries contribute
	 * none — they are filtered out of the LLM context).
	 */
	readonly delta: readonly Segment[];
	/** Whether the commit forced a full refold (compaction / context edit). */
	readonly rebuilt: boolean;
}

/**
 * Projection-level resume capsule: everything a consumer needs to resume the
 * derived context WITHOUT walking the log leaf→root — read the capsule, then
 * `buildProjection` the slice from `firstKeptEntryId` to `head`.
 *
 * Distinct from the backend's storage-level `ResumeCapsule`, which describes
 * the last durable batch.
 */
export interface ResumeCapsule {
	/** Log head the projection has caught up to. */
	readonly head: Seq;
	/** First entry still kept as a segment after the last compaction; `null` without compaction. */
	readonly firstKeptEntryId: string | null;
	/** Entry id usage accounting resumes from; `null` before the first LLM-visible entry. */
	readonly usageAnchor: string | null;
	/** Sequence of the last applied commit; `SEQ_AT_START` before the first commit. */
	readonly appliedSeq: Seq;
}

/** Options of {@link ProjectionService}. */
export interface ProjectionServiceOptions {
	/**
	 * Context MMU hook. Absent (default): every page is resident and `fault()`
	 * resolves segments locally from the manifest.
	 */
	readonly residency?: ResidencyPolicy;
}

/**
 * Incremental projector over one durable log. Apply commits in order; the
 * manifest, the resume capsule and the LLM context view stay current without
 * ever re-reading applied entries — except on the rare control commits that
 * rewrite the derived view, which trigger a full refold.
 */
export class ProjectionService {
	private state: ProjectionState = EMPTY_STATE;
	private readonly log: Entry[] = [];
	private lastSeq: Seq = SEQ_AT_START as Seq;
	private readonly residency: ResidencyPolicy | undefined;

	constructor(options?: ProjectionServiceOptions) {
		this.residency = options?.residency;
	}

	/**
	 * Applies one committed batch. The commit must be the immediate successor
	 * of the previously applied one (the backend never leaves sequence gaps),
	 * and its entries must be exactly the batch contents.
	 *
	 * Atomic on failure: every throw below (replay, gap, mismatch, or a
	 * control payload that violates the projection contract) happens BEFORE
	 * any state mutation, so the service stays exactly as it was and the
	 * corrected commit can be retried at the same sequence.
	 */
	apply(commit: CommitWithEntries): ApplyResult {
		const { entries } = commit;
		if (commit.head !== commit.seq) {
			// Backend invariant (`Commit.head === Commit.seq` for sqlite-zstd).
			throw new ProjectionError(`commit ${commit.seq}: head ${commit.head} differs from seq`);
		}
		if (entries.length === 0 || commit.entryCount !== entries.length) {
			throw new ProjectionError(
				`commit ${commit.seq}: entryCount ${commit.entryCount} does not match ${entries.length} supplied entries`,
			);
		}
		const expectedSeq = (this.lastSeq + 1) as Seq;
		if (commit.seq !== expectedSeq) {
			throw new ProjectionError(
				`commit ${commit.seq} is not the successor of the applied log (expected ${expectedSeq})`,
			);
		}
		for (const entry of entries) {
			if (entry.seq !== commit.seq) {
				throw new ProjectionError(
					`entry ${entry.id} carries seq ${entry.seq}, outside its commit ${commit.seq}`,
				);
			}
		}

		// Full rebuild ONLY on the control kinds that rewrite the derived view;
		// everything else folds incrementally into the cached state.
		const rebuilt = entries.some(
			(entry) => entry.kind === COMPACTION_KIND || entry.kind === CONTEXT_EDIT_KIND,
		);
		// Fold FIRST, mutate LAST: the fold can throw (malformed control
		// payload, unknown compaction target), and a failed apply must leave
		// the retained log and the cached state untouched — otherwise the
		// poisoned log would rethrow stale errors on every later rebuild.
		let state = this.state;
		if (rebuilt) {
			state = foldAll([...this.log, ...entries]);
		} else {
			for (const entry of entries) {
				state = foldEntry(state, entry);
			}
		}
		this.log.push(...entries);
		this.state = state;
		this.lastSeq = commit.seq;

		const manifest = toManifest(state);
		const own = new Set(entries.map((entry) => entry.id));
		return {
			commit,
			manifest,
			delta: manifest.segments.filter((segment) => own.has(segment.entryId)),
			rebuilt,
		};
	}

	/** Current manifest snapshot (fresh arrays; safe to retain across applies). */
	manifest(): ContextManifest {
		return toManifest(this.state);
	}

	/** Resume capsule for the current fold position. */
	capsule(): ResumeCapsule {
		return {
			head: this.state.head,
			firstKeptEntryId: this.state.compaction?.firstKeptEntryId ?? null,
			usageAnchor: this.state.usageAnchor,
			appliedSeq: this.lastSeq,
		};
	}

	/**
	 * LLM context view: the manifest segments — audit/control (`mcode.*`)
	 * entries never become segments, so the kind filter holds by construction.
	 */
	llmSegments(): readonly Segment[] {
		return [...this.state.segments];
	}

	/**
	 * Residency-aware LLM context: materializes every non-resident page through
	 * the policy's `onFault`. With the default all-resident behavior (no policy)
	 * this resolves to {@link llmSegments} without any fault.
	 */
	async llmContext(): Promise<readonly Segment[]> {
		if (this.residency === undefined) {
			return this.llmSegments();
		}
		const pages: Segment[] = [];
		for (const segment of this.state.segments) {
			pages.push(this.residency.resident(segment.entryId) ? segment : await this.residency.onFault(segment.entryId));
		}
		return pages;
	}

	/** Whether the page for this entry id is resident (default: always). */
	resident(entryId: string): boolean {
		return this.residency === undefined ? true : this.residency.resident(entryId);
	}

	/**
	 * Materializes the segment for an entry id: through the policy's `onFault`
	 * when a policy is installed, otherwise locally from the manifest (throws
	 * {@link ProjectionError} for an unknown id).
	 */
	async fault(entryId: string): Promise<Segment> {
		if (this.residency !== undefined) {
			return this.residency.onFault(entryId);
		}
		const segment = this.state.segments.find((candidate) => candidate.entryId === entryId);
		if (segment === undefined) {
			throw new ProjectionError(`no resident segment for entry ${JSON.stringify(entryId)}`);
		}
		return segment;
	}
}
