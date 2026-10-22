/**
 * Shared contract types of the context-compaction package.
 *
 * The package is a semantic port of the pi v1.3 compaction core (see the
 * package README): a pure module that decides WHERE a context window may be
 * cut, produces a structured summary through an injected {@link Summarizer},
 * and records the result as a durable, append-only entry in the session log.
 *
 * The durable shapes declared here (`DurableEntryDraft`, the `mcode.*` entry
 * kinds) are structurally compatible with `EntryDraft` of
 * `@mavis/durable-backend-sqlite-zstd`, the same way the storage worker pins
 * its own copy of the wave contract: the package compiles and tests
 * standalone, without importing the SQLite backend at runtime.
 *
 * @module
 */

// ============================================================================
// Messages
// ============================================================================

/** A piece of user/assistant content. Images are estimated, not decoded. */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** A placeholder block for an image; token estimation charges a flat char cost. */
export interface ImageBlock {
  readonly type: 'image';
}

/**
 * A reasoning block. It OCCUPIES context (token estimation counts it) but is
 * EXCLUDED from summarizer serialization — replayed thinking is rarely part of
 * the model's live context, and including it can make the summary request
 * larger than the window it summarizes.
 */
export interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
}

/** A tool invocation emitted by the assistant. */
export interface ToolCallBlock {
  readonly type: 'toolCall';
  readonly name: string;
  readonly arguments: unknown;
}

export type UserContent = string | readonly (TextBlock | ImageBlock)[];

export interface UserMessage {
  readonly role: 'user';
  readonly content: UserContent;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: readonly (TextBlock | ThinkingBlock | ToolCallBlock)[];
  /**
   * Provider-reported usage of the turn that produced this message. The last
   * valid usage anchors the token estimate of the whole window (see
   * `estimateContextTokens`); `totalTokens` wins, the component fields are the
   * fallback.
   */
  readonly usage?: ProviderUsage;
  /** `aborted`/`error` messages carry no trustworthy usage anchor. */
  readonly stopReason?: 'stop' | 'length' | 'aborted' | 'error' | string;
}

export interface ToolResultMessage {
  readonly role: 'toolResult';
  readonly content: readonly (TextBlock | ImageBlock)[];
  /** Id of the tool call this result answers, when known. */
  readonly toolCallId?: string;
}

/**
 * An application-defined message. It counts as a turn boundary (the cut point
 * logic may cut at it), mirroring pi's `custom` role.
 */
export interface CustomMessage {
  readonly role: 'custom';
  readonly customType: string;
  readonly text?: string;
}

export type CompactionMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

/** Provider usage subset the estimator understands. All fields are optional. */
export interface ProviderUsage {
  readonly totalTokens?: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

// ============================================================================
// Durable entries
// ============================================================================

/**
 * One record of the append-only session log. Structurally compatible with
 * `EntryDraft` of `@mavis/durable-backend-sqlite-zstd` (`id`/`kind`/`payload`
 * with optional `parentId`); declared locally so this package never depends
 * on the backend at compile time or runtime.
 */
export interface DurableEntryDraft {
  /** Stable application identity, unique across the whole log. */
  readonly id: string;
  /** Log position of the predecessor entry; `null`/`undefined` for the first. */
  readonly parentId?: string | null;
  /** Application-defined discriminator — one of the `mcode.*` kinds below. */
  readonly kind: string;
  /** JSON payload stored inside the batch frame. */
  readonly payload: unknown;
}

/** A stored log entry: draft content plus whatever position the backend stamped. */
export interface LogEntry extends DurableEntryDraft {
  readonly seq: number;
  readonly ordinal: number;
}

/** Entry kind carrying one conversation message; payload is a `CompactionMessage`. */
export const MESSAGE_ENTRY_KIND = 'mcode.message';

/** Entry kind carrying the frozen system prompt; payload is `{ text: string }`. */
export const SYSTEM_ENTRY_KIND = 'mcode.system';

/**
 * Entry kind of a compaction checkpoint: the summary, the first entry id that
 * survives it, and the system prompt frozen at compaction time. Appending it
 * never rewrites history — projection derives the short window, the original
 * entries stay in the log.
 */
export const COMPACTION_ENTRY_KIND = 'mcode.compaction';

/**
 * Entry kind of a context edit; `action: 'omission'` hides the target entries
 * from projection (for example a failed overflow-recovery attempt that reached
 * the log but must not be replayed into the model context).
 */
export const CONTEXT_EDIT_ENTRY_KIND = 'mcode.context_edit';

/** Payload of a `mcode.compaction` entry. */
export interface CompactionEntryPayload {
  readonly summary: string;
  /** Id of the first entry (in log order) that stays visible after this compaction. */
  readonly firstKeptEntryId: string;
  /** System prompt frozen at compaction time; replayed verbatim by projection. */
  readonly systemMessage: string | null;
  /** Whether the cut split a user turn (two summaries were merged). */
  readonly isSplitTurn: boolean;
  /** Estimated context tokens before the compaction. */
  readonly tokensBefore: number;
  /** Estimated context tokens the window occupies after the compaction. */
  readonly estimatedTokensAfter: number;
  readonly createdAtMs: number;
}

/** Payload of a `mcode.context_edit` omission entry. */
export interface ContextEditOmissionPayload {
  readonly action: 'omission';
  /** Ids of the entries the projection must hide. */
  readonly targetIds: readonly string[];
  /** Human-readable cause, e.g. the overflow error message. */
  readonly reason: string;
  readonly createdAtMs: number;
}

// ============================================================================
// Projection
// ============================================================================

/**
 * One entry as the compaction algorithms see it: the durable entry plus the
 * context messages it currently contributes. `contextMessages` is empty for
 * omitted entries and pure metadata; compaction entries contribute their
 * summary as a single user message.
 */
export interface ProjectedEntry {
  readonly id: string;
  /** True when this projected entry IS a compaction checkpoint. */
  readonly isCompaction: boolean;
  readonly contextMessages: readonly CompactionMessage[];
}

/** Result of projecting the raw log into the model-visible window. */
export interface ProjectedContext {
  /** Frozen system prompt (`mcode.system` / last compaction), `null` when none. */
  readonly systemMessage: string | null;
  /** Conversation messages in order, omissions and compactions applied. */
  readonly messages: readonly CompactionMessage[];
  /** Per-entry projection, aligned 1:1 with the raw input entries. */
  readonly entries: readonly ProjectedEntry[];
}

// ============================================================================
// Cut points
// ============================================================================

/** Result of `findCutPoint`. */
export interface CutPointResult {
  /** Index of the first projected entry to keep. */
  readonly firstKeptEntryIndex: number;
  /** Index of the user-like message that started the split turn, or `-1`. */
  readonly turnStartIndex: number;
  /** Whether the cut lands mid-turn (the turn prefix gets its own summary). */
  readonly isSplitTurn: boolean;
}

// ============================================================================
// Estimation and triggers
// ============================================================================

/** Usage-anchored estimate of a context window. */
export interface ContextUsageEstimate {
  /** Total estimated context tokens (anchor + trailing, or pure estimate). */
  readonly tokens: number;
  /** Tokens reported by the usage anchor itself. */
  readonly usageTokens: number;
  /** Estimated tokens of the messages after the anchor. */
  readonly trailingTokens: number;
  /** Index of the anchor message, `null` when no valid usage was found. */
  readonly usageAnchorIndex: number | null;
}

/** Which trigger axis fired. */
export type TriggerAxis = 'tokens' | 'bytes';

/** Compaction level a trigger evaluation selects. */
export type CompactionLevel = 'none' | 'background' | 'blocking';

/** One crossed threshold, reported by `evaluateTriggers`. */
export interface TriggerReason {
  readonly axis: TriggerAxis;
  /** Measured usage on this axis. */
  readonly usage: number;
  /** Budget of this axis. */
  readonly budget: number;
  /** `usage / budget`. */
  readonly ratio: number;
  /** The crossed threshold ratio (background or blocking). */
  readonly threshold: number;
}

export interface TriggerEvaluation {
  readonly level: CompactionLevel;
  readonly reasons: readonly TriggerReason[];
}

/** Budgets and thresholds of the double trigger (tokens AND bytes). */
export interface CompactionBudgets {
  /**
   * Context window in tokens; the primary trigger axis. `0` (or any
   * non-positive budget) DISABLES the axis — the trigger can never fire on
   * it — rather than treating the usage as always over budget.
   */
  readonly tokenBudget: number;
  /**
   * Byte budget of the session manifest (sum of serialized entry lengths);
   * when set, it triggers independently of the token axis. As with
   * `tokenBudget`, `0` disables the axis.
   */
  readonly byteBudget?: number;
  /** Background compaction starts at this usage ratio. Default 0.75. */
  readonly backgroundThresholdRatio?: number;
  /** Compaction becomes blocking at this usage ratio. Default 0.90. */
  readonly blockingThresholdRatio?: number;
}

// ============================================================================
// Compaction
// ============================================================================

/**
 * The summary backend, injected by the caller. Given one prompt string it
 * returns the summary text. Keeping this a plain async function (instead of a
 * model/API client) makes the whole pipeline testable and provider-agnostic.
 */
export type Summarizer = (prompt: string) => Promise<string>;

export interface CompactOptions {
  /** Raw session log entries, oldest first. */
  readonly entries: readonly LogEntry[];
  readonly summarizer: Summarizer;
  /**
   * Recent-context budget for the cut point. Default 20000. When
   * `tokenBudget` is also given, the effective value is clamped so the
   * post-compaction window fits inside 90% of the budget.
   */
  readonly keepRecentTokens?: number;
  /**
   * Context window in tokens. Enables the ≤90% clamp of `keepRecentTokens`
   * and the `estimatedTokensAfter` computation of the outcome.
   */
  readonly tokenBudget?: number;
  /** Tokens the summary itself may occupy; the ≤90% clamp reserves this. Default 2048. */
  readonly summaryHeadroomTokens?: number;
  /**
   * System prompt to freeze into the compaction entry. Default: the system
   * message of the projected context.
   */
  readonly systemMessage?: string | null;
  /** Optional extra focus appended to the summarizer prompt. */
  readonly customInstructions?: string;
  /** Id of the produced compaction entry. Default: generated. */
  readonly entryId?: string;
  /** Clock for the payload timestamp. Default `Date.now`. */
  readonly now?: () => number;
}

export interface CompactionOutcome {
  /** Id of the compaction entry (`draft.id`). */
  readonly entryId: string;
  /** Durable draft ready for `appendBatch` — kind `mcode.compaction`. */
  readonly draft: DurableEntryDraft;
  /** Full summary text (split-turn already merged). */
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly isSplitTurn: boolean;
  readonly tokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly systemMessage: string | null;
}

// ============================================================================
// Control-plane priorities
// ============================================================================

/**
 * Control-plane priority of a commit/append, P0 (most urgent) through P4
 * (background). The background compaction scheduler appends its checkpoint at
 * P4 and yields the writer to everything below.
 */
export type ControlPlanePriority = 0 | 1 | 2 | 3 | 4;

/** Priority used by the background compaction scheduler. */
export const BACKGROUND_COMPACTION_PRIORITY: ControlPlanePriority = 4;
