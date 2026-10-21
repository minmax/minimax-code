/**
 * Conversation serialization and summarizer prompts.
 *
 * Ported behaviors from pi v1.3: tool results are truncated to 2000
 * characters (the summary does not need full payloads), thinking blocks are
 * excluded entirely (visible text, tool calls, and tool results record what
 * happened), and the conversation is flattened to text inside
 * `<conversation>` tags so the model summarizes instead of continuing.
 *
 * @module
 */

import type { CompactionMessage, ToolCallBlock } from './types.js';

/** Maximum characters of one tool result in the serialized conversation. */
export const TOOL_RESULT_MAX_CHARS = 2000;

/** Truncate long text keeping the head, with an explicit marker of the loss. */
function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function textOf(content: string | readonly { type: string; text?: string }[] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

function formatToolCall(block: ToolCallBlock): string {
  const args = block.arguments && typeof block.arguments === 'object' ? (block.arguments as Record<string, unknown>) : {};
  const argsStr = Object.entries(args)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
  return `${block.name}(${argsStr})`;
}

/**
 * Serialize messages to plain text for the summarizer.
 *
 * - user text -> `[User]: ...`
 * - assistant text -> `[Assistant]: ...`, tool calls -> `[Assistant tool calls]: name(...)`
 * - tool results -> `[Tool result]: ...` truncated to {@link TOOL_RESULT_MAX_CHARS}
 * - thinking blocks are omitted everywhere
 * - empty messages contribute nothing
 */
export function serializeConversation(messages: readonly CompactionMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        const text = textOf(message.content);
        if (text) parts.push(`[User]: ${text}`);
        break;
      }
      case 'assistant': {
        const text = textOf(message.content);
        if (text) parts.push(`[Assistant]: ${text}`);
        const toolCalls = message.content.filter((block): block is ToolCallBlock => block.type === 'toolCall');
        if (toolCalls.length > 0) {
          parts.push(`[Assistant tool calls]: ${toolCalls.map(formatToolCall).join('; ')}`);
        }
        break;
      }
      case 'toolResult': {
        const text = textOf(message.content);
        if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
        break;
      }
      case 'custom': {
        if (message.text) parts.push(`[${message.customType}]: ${message.text}`);
        break;
      }
    }
  }

  return parts.join('\n\n');
}

// ============================================================================
// Prompts
// ============================================================================

/** Role instruction prepended to every summarizer prompt. */
export const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a context summarization assistant. Read the conversation between a user and an AI assistant ' +
  'and produce a structured summary following the exact format specified. Do NOT continue the conversation. ' +
  'Do NOT answer questions from the conversation. ONLY output the structured summary.';

/** Structured checkpoint format of the history summary. */
export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? One item per task the session covers.]

## Constraints & Preferences
- [Constraints, preferences, or requirements mentioned by the user, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Blockers, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered next actions]

## Critical Context
- [Data, file paths, names, and error messages needed to continue, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Update rules when a previous summary already exists (iterative compaction). */
export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to merge into the existing summary in <previous-summary>.

RULES:
- PRESERVE all still-relevant information from the previous summary.
- ADD new progress, decisions, and context from the new messages.
- MOVE completed items from "In Progress" to "Done"; refresh "Next Steps".
- PRESERVE exact file paths, function names, and error messages.
- Drop anything that is no longer relevant.

Use the same EXACT format as the previous summary (Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context). Keep each section concise.`;

/** Prompt for the prefix of a turn the cut had to split. */
export const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are the earlier part of ONE user turn. The later part of the turn is kept separately and must NOT be reconstructed.

Create a concise checkpoint of the request and of the progress visible above. It will be placed before the later messages so the conversation can continue seamlessly.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer later messages.`;

/** Build the full history-summary prompt around the serialized conversation. */
export function buildSummaryPrompt(
  conversationText: string,
  previousSummary?: string,
  customInstructions?: string,
): string {
  let base = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) base = `${base}\n\nAdditional focus: ${customInstructions}`;

  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  return prompt + base;
}

/** Build the turn-prefix summary prompt for a split turn. */
export function buildTurnPrefixPrompt(conversationText: string, customInstructions?: string): string {
  const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : '';
  return `<conversation>\n${conversationText}\n</conversation>\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}${focus}`;
}

/** The glue of a split-turn summary: history first, then the turn context. */
export const SPLIT_TURN_SEPARATOR = '\n\n---\n\n**Turn Context (split turn):**\n\n';

/** Merge the history summary and the turn-prefix summary of a split turn. */
export function mergeSplitTurnSummary(historySummary: string, turnPrefixSummary: string): string {
  return `${historySummary}${SPLIT_TURN_SEPARATOR}${turnPrefixSummary}`;
}

/** Fallback history text when a split turn has nothing before it to summarize. */
export const NO_PRIOR_HISTORY_TEXT = 'No prior history.';

/** Wrap system instructions + task into the single prompt string the Summarizer receives. */
export function withSystemInstructions(prompt: string): string {
  return `${SUMMARIZATION_SYSTEM_PROMPT}\n\n${prompt}`;
}
