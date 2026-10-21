/**
 * `@mavis/context-projection`
 * ---------------------------
 *
 * Derived context view over the durable delta log: a one-shot manifest fold
 * (`buildProjection`), an incremental projector with a head-keyed cache
 * (`ProjectionService`), a projection-level resume capsule, and the Context
 * MMU residency hook. Entries come from `@mavis/durable-backend-sqlite-zstd`
 * (types only — this package never touches the storage backend).
 *
 * @module
 */

export {
	COMPACTION_KIND,
	CONTEXT_EDIT_KIND,
	CONTROL_KIND_PREFIX,
	type CompactionPayload,
	type ContextEditPayload,
	type OmissionEditPayload,
	type PruneEditPayload,
	asCompactionPayload,
	asContextEditPayload,
	isControlKind,
} from './kinds.js';
export {
	EMPTY_STATE,
	type CompactionMark,
	type ContextManifest,
	ProjectionError,
	type LogPosition,
	type ProjectionState,
	type Segment,
	type Watermark,
	WATERMARK_AT_START,
	buildProjection,
	foldAll,
	foldEntry,
	toManifest,
} from './projection.js';
export {
	type ApplyResult,
	type CommitWithEntries,
	ProjectionService,
	type ProjectionServiceOptions,
	type ResumeCapsule,
} from './service.js';
export { type ResidencyPolicy } from './residency.js';
