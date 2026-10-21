/**
 * Per-entry convert-to-llm stage of the hybrid agent context path.
 *
 * Public surface:
 * - {@link convertEntry} — the deterministic per-entry stage the wire
 *   compiler memoizes by `(entryId, dialect, normalizerVersion)`;
 * - {@link MINIMAX_M3_DIALECT} / {@link compileKey} — the built-in dialect
 *   and its cache-key rule;
 * - {@link assemblePayload} — ordered assembly with audit/control exclusion,
 *   placed-entry dedup, immediate-send batching and reminder tails;
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
  Segment,
} from './types.js';
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
} from './convert-entry.js';
export {
  buildCompiledEntry,
  buildReminderTail,
  containsReminderBlock,
  extractReminderBlocks,
  serializeCompiledEntry,
  splitUserReminders,
} from './reminders.js';
export { assemblePayload, type AssembleOptions } from './assemble.js';
