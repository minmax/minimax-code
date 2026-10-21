/**
 * The compaction pipeline: from the raw append-only log to one durable
 * `mcode.compaction` entry.
 *
 * Steps: project the log, find the cut point (never on a tool result), split
 * the turn if the cut lands mid-turn, generate the history summary (and the
 * turn-prefix summary) through the injected {@link Summarizer}, merge them
 * with the pi split-turn glue, and return the draft of the durable checkpoint
 * entry. The caller appends the draft to the log — nothing here writes.
 *
 * Post-compaction budget: when `tokenBudget` is given, `keepRecentTokens` is
 * clamped (see `resolveKeepRecentTokens`) so the kept tail plus the summary
 * headroom stays inside 90% of the budget; `estimatedTokensAfter` reports the
 * honest measured estimate of that window.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import { findCutPoint } from './cut-point.js';
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  estimateMessageTokens,
  estimateProjectedContextTokens,
  resolveKeepRecentTokens,
} from './estimate.js';
import { projectContext, summarizableMessages } from './project.js';
import {
  NO_PRIOR_HISTORY_TEXT,
  buildSummaryPrompt,
  buildTurnPrefixPrompt,
  mergeSplitTurnSummary,
  serializeConversation,
  withSystemInstructions,
} from './serialize.js';
import {
  COMPACTION_ENTRY_KIND,
  CONTEXT_EDIT_ENTRY_KIND,
  type CompactOptions,
  type CompactionMessage,
  type CompactionOutcome,
  type LogEntry,
  type ProjectedEntry,
} from './types.js';
import { parseCompactionEntry } from './entries.js';

/** Ids for compaction entries when the caller does not supply one. */
function generateEntryId(): string {
  // randomUUID: unique across process restarts, unlike a Date.now()+counter
  // scheme whose ids collide after a restart within the same clock tick.
  return `compaction-${randomUUID()}`;
}

/** Ids the projection currently hides (context_edit omissions). */
function omittedTargetIds(entries: readonly LogEntry[]): Set<string> {
  const omitted = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== CONTEXT_EDIT_ENTRY_KIND) continue;
    const payload = entry.payload as { readonly action?: unknown; readonly targetIds?: unknown } | null;
    if (payload === null || typeof payload !== 'object') continue;
    if (payload.action !== 'omission' || !Array.isArray(payload.targetIds)) continue;
    for (const targetId of payload.targetIds) if (typeof targetId === 'string') omitted.add(targetId);
  }
  return omitted;
}

/**
 * The compaction boundary of a log: index right after the last VISIBLE,
 * well-formed compaction entry. Malformed checkpoints are dead weight the
 * projection ignores, so the cut range must not start after them (that would
 * strand the messages before them outside every future summary); an omitted
 * checkpoint is retracted and its range reopens for re-summarization.
 */
function boundaryStartIndex(entries: readonly LogEntry[]): number {
  const omitted = omittedTargetIds(entries);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (omitted.has(entry.id)) continue;
    if (entry.kind === COMPACTION_ENTRY_KIND && parseCompactionEntry(entry) !== undefined) return i + 1;
  }
  return 0;
}

function previousSummaryOf(entries: readonly LogEntry[]): string | undefined {
  const omitted = omittedTargetIds(entries);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (omitted.has(entry.id)) continue;
    const payload = parseCompactionEntry(entry);
    if (payload !== undefined) return payload.summary;
  }
  return undefined;
}

function flattenMessages(entries: readonly ProjectedEntry[], from: number, to: number): CompactionMessage[] {
  const messages: CompactionMessage[] = [];
  for (let i = from; i < to; i += 1) messages.push(...summarizableMessages(entries[i]!));
  return messages;
}

/**
 * Run one compaction over the log and produce the durable checkpoint draft.
 *
 * Returns `null` when there is nothing to compact (the cut would summarize
 * zero messages) — the caller skips the append instead of writing an empty
 * checkpoint.
 *
 * The summary is produced by the injected `Summarizer`; when the cut splits a
 * user turn, TWO summaries are generated (history + turn prefix) and merged
 * with the exact glue `"\n\n---\n\n**Turn Context (split turn):**\n\n"`.
 */
export async function compact(options: CompactOptions): Promise<CompactionOutcome | null> {
  const { entries, summarizer } = options;
  const now = options.now ?? Date.now;
  const projected = projectContext(entries);

  const start = boundaryStartIndex(entries);
  const tokenBudget = options.tokenBudget;
  const keepRecentTokens =
    tokenBudget !== undefined
      ? resolveKeepRecentTokens(
          options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
          tokenBudget,
          options.summaryHeadroomTokens,
        )
      : (options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS);

  const cut = findCutPoint(projected.entries, start, entries.length, keepRecentTokens);
  const firstKeptEntry = projected.entries[cut.firstKeptEntryIndex];
  if (firstKeptEntry === undefined) return null;

  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const historyMessages = flattenMessages(projected.entries, start, historyEnd);
  const turnPrefixMessages = cut.isSplitTurn
    ? flattenMessages(projected.entries, cut.turnStartIndex, cut.firstKeptEntryIndex)
    : [];
  if (historyMessages.length === 0 && turnPrefixMessages.length === 0) return null;

  // History summary. A split turn whose cut lands at the very first turn of
  // the window has nothing before it: fall back to the previous checkpoint's
  // summary (or the explicit placeholder).
  let historySummary: string;
  if (historyMessages.length > 0) {
    const conversation = serializeConversation(historyMessages);
    const prompt = withSystemInstructions(
      buildSummaryPrompt(conversation, previousSummaryOf(entries), options.customInstructions),
    );
    historySummary = await summarizer(prompt);
  } else {
    historySummary = previousSummaryOf(entries) ?? NO_PRIOR_HISTORY_TEXT;
  }

  const isSplitTurn = cut.isSplitTurn && turnPrefixMessages.length > 0;
  let summary = historySummary;
  if (isSplitTurn) {
    const turnPrefixConversation = serializeConversation(turnPrefixMessages);
    const turnPrefixSummary = await summarizer(
      withSystemInstructions(buildTurnPrefixPrompt(turnPrefixConversation, options.customInstructions)),
    );
    summary = mergeSplitTurnSummary(historySummary, turnPrefixSummary);
  }

  const systemMessage = options.systemMessage !== undefined ? options.systemMessage : projected.systemMessage;

  // Post-compaction window: the new summary message + everything kept. The
  // checkpoint makes any surviving usage anchor stale (see
  // `estimateProjectedContextTokens`), so this is the pure-estimate path and
  // the frozen system prompt counts here.
  const keptMessages = flattenMessages(projected.entries, cut.firstKeptEntryIndex, projected.entries.length);
  const summaryMessage: CompactionMessage = { role: 'user', content: summary };
  let estimatedTokensAfter = estimateMessageTokens(summaryMessage);
  for (const message of keptMessages) estimatedTokensAfter += estimateMessageTokens(message);
  if (systemMessage !== null) {
    estimatedTokensAfter += estimateMessageTokens({ role: 'custom', customType: 'system', text: systemMessage });
  }

  // Before-side accounting mirrors the after-side: anchor path (usage
  // totalTokens) already includes the system prompt, the pure path adds it
  // explicitly — same convention as pi's `estimateProjectedContextTokens`.
  const tokensBefore = estimateProjectedContextTokens(entries).tokens;
  const entryId = options.entryId ?? generateEntryId();
  const draft = {
    id: entryId,
    kind: COMPACTION_ENTRY_KIND,
    payload: {
      summary,
      firstKeptEntryId: firstKeptEntry.id,
      systemMessage,
      isSplitTurn,
      tokensBefore,
      estimatedTokensAfter,
      createdAtMs: now(),
    },
  } as const;

  return {
    entryId,
    draft,
    summary,
    firstKeptEntryId: firstKeptEntry.id,
    isSplitTurn,
    tokensBefore,
    estimatedTokensAfter,
    systemMessage,
  };
}
