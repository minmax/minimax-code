/**
 * Token and byte estimation for the compaction triggers.
 *
 * Token estimation is the pi heuristic: a valid provider usage anchors the
 * window total, and only messages newer than the anchor are estimated with
 * the conservative `chars/4` rule. An image block costs a flat 4800
 * characters (the same constant pi uses). Byte estimation is the second,
 * independent trigger axis: the sum of serialized entry lengths of the
 * session manifest.
 *
 * @module
 */

import { projectContext } from './project.js';
import {
  COMPACTION_ENTRY_KIND,
  CONTEXT_EDIT_ENTRY_KIND,
  type AssistantMessage,
  type CompactionBudgets,
  type CompactionLevel,
  type CompactionMessage,
  type ContextUsageEstimate,
  type LogEntry,
  type ProjectedContext,
  type TriggerEvaluation,
  type TriggerReason,
} from './types.js';

/** Flat character cost charged for one image block in token estimates. */
export const ESTIMATED_IMAGE_CHARS = 4800;

/** Characters per token of the `chars/4` heuristic; deliberately conservative. */
export const CHARS_PER_TOKEN = 4;

/** Default background (non-blocking) trigger ratio. */
export const DEFAULT_BACKGROUND_THRESHOLD_RATIO = 0.75;

/** Default blocking trigger ratio; compaction also guarantees ≤ this ratio after. */
export const DEFAULT_BLOCKING_THRESHOLD_RATIO = 0.9;

/** Default `keepRecentTokens` of the cut point. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20000;

/** Tokens reserved for the summary itself by the ≤90% clamp. */
export const DEFAULT_SUMMARY_HEADROOM_TOKENS = 2048;

function estimateTextAndImageChars(content: string | readonly { type: string; text?: string }[]): number {
  if (typeof content === 'string') return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text' && block.text) chars += block.text.length;
    else if (block.type === 'image') chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator);
}

/**
 * Estimate the token count of one message with the `chars/4` heuristic.
 * Thinking blocks count — they occupy the live context — while zero-token
 * messages simply return 0.
 */
export function estimateMessageTokens(message: CompactionMessage): number {
  switch (message.role) {
    case 'user':
      return ceilDiv(estimateTextAndImageChars(message.content), CHARS_PER_TOKEN);
    case 'assistant': {
      const assistant = message as AssistantMessage;
      let chars = 0;
      for (const block of assistant.content) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'thinking') chars += block.thinking.length;
        else if (block.type === 'toolCall') chars += block.name.length + JSON.stringify(block.arguments ?? null).length;
      }
      return ceilDiv(chars, CHARS_PER_TOKEN);
    }
    case 'toolResult':
      return ceilDiv(estimateTextAndImageChars(message.content), CHARS_PER_TOKEN);
    case 'custom':
      return ceilDiv(message.text?.length ?? 0, CHARS_PER_TOKEN);
  }
}

/** Total context tokens of a usage record: `totalTokens` wins, components are the fallback. */
export function calculateUsageTokens(usage: {
  readonly totalTokens?: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}): number {
  const total = usage.totalTokens ?? 0;
  if (total > 0) return total;
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** A usage anchor must be a successful assistant turn with a positive total. */
function validUsageAnchor(message: CompactionMessage): number | undefined {
  if (message.role !== 'assistant') return undefined;
  const assistant = message as AssistantMessage;
  if (assistant.stopReason === 'aborted' || assistant.stopReason === 'error') return undefined;
  if (!assistant.usage) return undefined;
  const tokens = calculateUsageTokens(assistant.usage);
  return tokens > 0 ? tokens : undefined;
}

/** Whether the message carries a usable usage anchor (exported for projection-level checks). */
export function hasValidUsageAnchor(message: CompactionMessage): boolean {
  return validUsageAnchor(message) !== undefined;
}

/**
 * Estimate context tokens from a message list, using the last valid assistant
 * usage as the anchor for everything before it and `chars/4` for the trailing
 * messages. Without an anchor the whole list is estimated.
 */
export function estimateContextTokens(messages: readonly CompactionMessage[]): ContextUsageEstimate {
  let usageAnchorIndex: number | null = null;
  let usageTokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const anchor = validUsageAnchor(messages[i]!);
    if (anchor !== undefined) {
      usageAnchorIndex = i;
      usageTokens = anchor;
      break;
    }
  }

  if (usageAnchorIndex === null) {
    let estimated = 0;
    for (const message of messages) estimated += estimateMessageTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, usageAnchorIndex: null };
  }

  let trailingTokens = 0;
  for (let i = usageAnchorIndex + 1; i < messages.length; i += 1) {
    trailingTokens += estimateMessageTokens(messages[i]!);
  }
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, usageAnchorIndex };
}

/**
 * Estimate PROJECTED context tokens without trusting a usage captured before
 * a later edit or compaction (pi's `estimateProjectedContextTokens` rule).
 *
 * A usage anchor inside a projected window counts the WHOLE window as it was
 * when the provider reported it — including everything a checkpoint since
 * summarized away. So: if any `mcode.compaction` or `mcode.context_edit`
 * entry sits AFTER the entry carrying the anchor (or no anchor exists at
 * all), the window is estimated PURELY (chars/4 over the projected
 * messages), the frozen system message included — the anchor path leaves it
 * out because the provider's `totalTokens` already counted it.
 */
export function estimateProjectedContextTokens(entries: readonly LogEntry[]): ContextUsageEstimate {
  const projected = projectContext(entries);
  const anchorEstimate = estimateContextTokens(projected.messages);

  // The anchor message must sit in a raw entry; any newer checkpoint or
  // omission invalidates it.
  let anchorEntryIndex = -1;
  for (let i = projected.entries.length - 1; i >= 0; i -= 1) {
    if (projected.entries[i]!.contextMessages.some(hasValidUsageAnchor)) {
      anchorEntryIndex = i;
      break;
    }
  }
  if (anchorEntryIndex === -1) return pureEstimate(projected);
  for (let i = anchorEntryIndex + 1; i < entries.length; i += 1) {
    const kind = entries[i]!.kind;
    if (kind === COMPACTION_ENTRY_KIND || kind === CONTEXT_EDIT_ENTRY_KIND) return pureEstimate(projected);
  }
  return anchorEstimate;
}

/**
 * Pure-estimate path: chars/4 over the projected messages plus the frozen
 * system prompt — no anchor, `usageTokens` 0 (pi's fallback convention).
 */
function pureEstimate(projected: ProjectedContext): ContextUsageEstimate {
  let tokens = 0;
  for (const message of projected.messages) tokens += estimateMessageTokens(message);
  if (projected.systemMessage !== null) {
    tokens += estimateMessageTokens({ role: 'custom', customType: 'system', text: projected.systemMessage });
  }
  return { tokens, usageTokens: 0, trailingTokens: tokens, usageAnchorIndex: null };
}

/**
 * Byte size of the RAW append-only log: the sum of serialized entry lengths —
 * UTF-8 bytes (`Buffer.byteLength`), NOT UTF-16 code units.
 *
 * LEGACY measure, kept for its unit tests and diagnostics. It is NOT the
 * compaction trigger's byte axis anymore: the raw sum counts audit/control
 * bookkeeping that never reaches the payload and entries a checkpoint already
 * summarized away, and it never RESETS after a compaction — every later
 * notify re-fired blocking forever. The trigger axis is the PROJECTED WINDOW
 * size (`WindowUsageTracker`, incrementally maintained; slow reference
 * `windowManifestBytes`), and the provider-payload truth is the wire
 * compiler's `CompiledBody.totalBytes`.
 */
export function estimateManifestBytes(entries: readonly LogEntry[]): number {
  let bytes = 0;
  for (const entry of entries) bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8');
  return bytes;
}

/**
 * Evaluate the double trigger against the budgets.
 *
 * Returns `blocking` when ANY axis reached the blocking ratio, `background`
 * when ANY axis reached the background ratio (and none reached blocking), and
 * `none` otherwise. The token and byte axes are independent: a small token
 * count with a huge manifest still triggers.
 */
export function evaluateTriggers(
  usage: { readonly tokens: number; readonly bytes?: number },
  budgets: CompactionBudgets,
): TriggerEvaluation {
  const backgroundRatio = budgets.backgroundThresholdRatio ?? DEFAULT_BACKGROUND_THRESHOLD_RATIO;
  const blockingRatio = budgets.blockingThresholdRatio ?? DEFAULT_BLOCKING_THRESHOLD_RATIO;
  if (backgroundRatio > blockingRatio) {
    throw new RangeError(`backgroundThresholdRatio (${backgroundRatio}) must not exceed blockingThresholdRatio (${blockingRatio})`);
  }

  const axes: Array<{ axis: 'tokens' | 'bytes'; usage: number; budget: number }> = [
    { axis: 'tokens', usage: usage.tokens, budget: budgets.tokenBudget },
  ];
  if (budgets.byteBudget !== undefined) {
    axes.push({ axis: 'bytes', usage: usage.bytes ?? 0, budget: budgets.byteBudget });
  }

  let level: CompactionLevel = 'none';
  const reasons: TriggerReason[] = [];
  for (const { axis, usage: value, budget } of axes) {
    if (budget <= 0) continue;
    const ratio = value / budget;
    const threshold = ratio >= blockingRatio ? blockingRatio : ratio >= backgroundRatio ? backgroundRatio : undefined;
    if (threshold === undefined) continue;
    if (threshold === blockingRatio) level = 'blocking';
    else if (level === 'none') level = 'background';
    reasons.push({ axis, usage: value, budget, ratio, threshold });
  }
  return { level, reasons };
}

/**
 * Clamp `keepRecentTokens` so the kept tail plus the summary headroom stays
 * inside `ratio * tokenBudget` (the post-compaction ≤90% guarantee). The
 * result never exceeds the caller's requested value and never goes negative.
 */
export function resolveKeepRecentTokens(
  keepRecentTokens: number,
  tokenBudget: number,
  summaryHeadroomTokens: number = DEFAULT_SUMMARY_HEADROOM_TOKENS,
  postCompactionRatio: number = DEFAULT_BLOCKING_THRESHOLD_RATIO,
): number {
  const limit = Math.max(0, Math.floor(tokenBudget * postCompactionRatio) - summaryHeadroomTokens);
  return Math.max(0, Math.min(keepRecentTokens, limit));
}
