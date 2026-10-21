/**
 * Context compaction for long agent sessions.
 *
 * A semantic port of the pi v1.3 compaction core over the durable entry log:
 * cut points that never split a tool result from its call, split-turn
 * summaries, overflow recovery with exactly one retry, and a background
 * scheduler with the double trigger (tokens AND bytes) and P0–P4 control
 * plane priorities. See `README.md` for the design contract.
 *
 * @module
 */

export * from './types.js';
export {
  CHARS_PER_TOKEN,
  DEFAULT_BACKGROUND_THRESHOLD_RATIO,
  DEFAULT_BLOCKING_THRESHOLD_RATIO,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_SUMMARY_HEADROOM_TOKENS,
  ESTIMATED_IMAGE_CHARS,
  calculateUsageTokens,
  estimateContextTokens,
  estimateManifestBytes,
  estimateMessageTokens,
  estimateProjectedContextTokens,
  evaluateTriggers,
  hasValidUsageAnchor,
  resolveKeepRecentTokens,
} from './estimate.js';
export {
  findCutPoint,
  findTurnStartIndex,
  isCutPointMessage,
  isTurnStartMessage,
} from './cut-point.js';
export {
  SPLIT_TURN_SEPARATOR,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  TOOL_RESULT_MAX_CHARS,
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  buildSummaryPrompt,
  buildTurnPrefixPrompt,
  mergeSplitTurnSummary,
  serializeConversation,
  withSystemInstructions,
} from './serialize.js';
export {
  UnknownFirstKeptEntryError,
  projectContext,
  summarizableMessages,
  windowManifestBytes,
} from './project.js';
export {
  createCompactionEntryDraft,
  createMessageEntryDraft,
  createOmissionEntryDraft,
  createSystemEntryDraft,
  generateLogEntryId,
  parseCompactionEntry,
} from './entries.js';
export { compact } from './compact.js';
export {
  isContextOverflowError,
  runWithOverflowRecovery,
} from './overflow.js';
export type { GateRelease, WriterGate } from './gate.js';
export { createWriterGate } from './gate.js';
export { WindowUsageTracker } from './usage-tracker.js';
export type { WindowUsage } from './usage-tracker.js';
export type {
  BackgroundCompactionScheduler,
  BackgroundCompactionSchedulerOptions,
  SchedulerNotification,
  SchedulerSession,
} from './scheduler.js';
export { createBackgroundCompactionScheduler } from './scheduler.js';
