/**
 * `@mavis/durable-seam`
 * ---------------------
 *
 * The mandatory steering seam (Ф1): transaction-scoped composition over the
 * wave-1 durable storage contract —
 *
 * - `acceptOwnerInput` (T_accept): submission + `mcode.owner-input.received`
 *   receipt + delivery-index update in ONE commit, deduped by
 *   `(conversationId, requestId)` through the entry index, with
 *   `REQUEST_ID_CONFLICT` on a payload change;
 * - `prepareRelease` (T_release): the durable, replayable prepared
 *   background outcome of a foreground wait under a `stateVersion` CAS;
 * - `finalizeTool` (T_complete): the single tool-result of one `toolCallId`,
 *   idempotently reproduced after a crash between the release phases.
 *
 * The seam implements no inbox of its own, writes no SQL, and replaces no
 * loop: it composes the storage contract's atomic batch commits, indexed
 * point reads, and owner-epoch fencing. See `README.md` for the entry kinds
 * and the recovery model.
 *
 * @module
 */

export { DurableSeam } from './seam.js';
export {
	DEFAULT_MAX_INPUT_BYTES,
	SEAM_ENTRY_KINDS,
	type AcceptOwnerInputResult,
	type BackgroundOutcome,
	type DeliveryView,
	type DurableSeamOptions,
	type FinalizeToolInput,
	type FinalizeToolResult,
	type ForegroundWaitDraft,
	type JsonValue,
	type OpenWaitResult,
	type OwnerInputDraft,
	type PrepareReleaseInput,
	type PreparedRelease,
	type RecoveryOptions,
	type RecoveryReport,
	type SeamWaitView,
	type SettleDeliveryInput,
	type SettleDeliveryResult,
	type WaitState,
	type WhenBusy,
} from './types.js';
export {
	InputTooLargeError,
	InvalidInputError,
	RequestIdConflictError,
	SeamError,
	SeamOwnerLostError,
	SeamStorageError,
	ToolResultConflictError,
	UnknownWaitError,
	VersionConflictError,
	WaitIdConflictError,
	WaitTerminalError,
	type SeamErrorCode,
} from './errors.js';
export {
	receiptEntryId,
	requestKeyHash,
	settledEntryId,
	snapshotEntryId,
	submissionEntryId,
	toolResultEntryId,
	waitOpenedEntryId,
	waitPreparedEntryId,
} from './ids.js';
export { hashJson, hashString, canonicalJson } from './canonical.js';
export type { DurableLogPort, PortCommit, PortDelta, PortEntry, PortEntryDraft } from './port.js';
export { sqliteZstdDurableLogPort, type SqliteZstdBackendLike } from './sqlite-zstd-port.js';
export {
	encodeSnapshotPayload,
	parseSnapshotPayload,
	probeLatestSnapshot,
	type SnapshotDeliveryRecord,
	type SnapshotPayload,
	type SnapshotWaitRecord,
} from './snapshot.js';
