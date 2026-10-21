/**
 * Per-entry convert-to-llm stage of the hybrid agent context path.
 *
 * Public surface:
 * - {@link convertEntry} — the deterministic per-entry stage the wire
 *   compiler memoizes by `(entryId, dialect, normalizerVersion)`;
 * - {@link MINIMAX_M3_DIALECT} / {@link compileKey} — the built-in dialect
 *   and its cache-key rule;
 * - {@link assemblePayload} / {@link assembleManifestPayload} — ordered
 *   assembly with audit/control exclusion, placed-entry dedup, immediate-send
 *   batching and reminder tails, over a raw entry list or over the projection
 *   window (`ContextManifest`);
 * - helpers the wire compiler and the input-delivery-status projection reuse.
 */

export type {
  AssembleStats,
  AssembledPayload,
  CompiledEntry,
  Dialect,
  DurableEntry,
  JsonValue,
  ProviderRole,
  ProviderToolCall,
} from './types.js';
export type { Segment } from './types.js';
// Note: `ContextManifest` is deliberately NOT re-exported here. The name is
// already public from `@mavis/wire-compiler` with an INCOMPATIBLE shape (the
// wire window: a readonly segment-reference array, `wire-compiler/src/types.ts`),
// while `assembleManifestPayload` consumes the projection manifest (an object
// with head/segments/compaction). Import that one from
// `@mavis/context-projection` — its canonical owner.
export type {
  DecodedEntryPayload,
  DecodedMessage,
  DecodedPart,
  DecodedRole,
  DecodedToolCall,
} from './decode.js';
export {
  MINIMAX_M3_DIALECT,
  compileBatchKey,
  compileKey,
} from './dialect.js';
export { decodeEntryPayload } from './decode.js';
export {
  isAuditControlKind,
  isPlacedEntryKind,
  isReminderEntryKind,
  isVisibleControlKind,
} from './audit.js';
export {
  convertBatch,
  convertEntry,
  convertEntryTails,
  type DecodedImagePart,
  type ImageRendering,
} from './convert-entry.js';
export {
  buildCompiledEntry,
  buildReminderTail,
  containsReminderBlock,
  extractReminderBlocks,
  serializeCompiledEntry,
  splitUserReminders,
} from './reminders.js';
export { assemblePayload, assembleManifestPayload, type AssembleOptions } from './assemble.js';
