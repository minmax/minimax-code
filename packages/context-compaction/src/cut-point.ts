/**
 * Cut-point detection: where the summarized history may end and the kept
 * recent window may begin.
 *
 * Ported invariant from pi v1.3: a cut is allowed ONLY at user, assistant, or
 * custom messages — NEVER at a tool result, which must always follow its tool
 * call. When the walk backwards from the newest entry crosses the
 * `keepRecentTokens` budget, the cut snaps forward to the closest valid cut
 * point, so trailing tool results keep their preceding assistant turn.
 *
 * @module
 */

import { DEFAULT_KEEP_RECENT_TOKENS, estimateMessageTokens } from './estimate.js';
import type { CompactionMessage, CutPointResult, ProjectedEntry } from './types.js';

/**
 * Whether a cut may land directly at this message. Tool results are
 * categorically excluded; everything conversation-visible is allowed.
 */
export function isCutPointMessage(message: CompactionMessage): boolean {
  switch (message.role) {
    case 'user':
    case 'assistant':
    case 'custom':
      return true;
    case 'toolResult':
      return false;
  }
}

/**
 * Whether this message starts a new user turn. Assistant messages and tool
 * results continue the current turn; compaction summaries (projected as user
 * messages) are turn starts too — the caller excludes compaction entries
 * before consulting this.
 */
export function isTurnStartMessage(message: CompactionMessage): boolean {
  switch (message.role) {
    case 'user':
    case 'custom':
      return true;
    case 'assistant':
    case 'toolResult':
      return false;
  }
}

function entryHasCutPoint(entry: ProjectedEntry): boolean {
  return !entry.isCompaction && entry.contextMessages.some(isCutPointMessage);
}

function isTurnStartEntry(entry: ProjectedEntry): boolean {
  return !entry.isCompaction && entry.contextMessages.some(isTurnStartMessage);
}

/**
 * Index of the user-like entry that starts the turn containing `entryIndex`,
 * or `-1` when none exists at or after `startIndex`.
 */
export function findTurnStartIndex(entries: readonly ProjectedEntry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i -= 1) {
    if (isTurnStartEntry(entries[i]!)) return i;
  }
  return -1;
}

/**
 * Find the cut point that keeps approximately `keepRecentTokens` of the
 * newest context.
 *
 * Algorithm (pi semantics): walk backwards from the newest entry accumulating
 * estimated tokens; stop at the first entry that crosses the budget and cut
 * at the closest valid cut point at or after it. If no entry crosses the
 * budget, the cut falls back to the FIRST valid cut point (headers and other
 * zero-message entries before it get summarized away, which is harmless).
 *
 * Returns the index of the first kept entry, whether the cut splits a turn,
 * and where that turn started.
 */
export function findCutPoint(
  entries: readonly ProjectedEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number = DEFAULT_KEEP_RECENT_TOKENS,
): CutPointResult {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    if (entryHasCutPoint(entries[i]!)) cutPoints.push(i);
  }
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]!;
  for (let i = endIndex - 1; i >= startIndex; i -= 1) {
    const entry = entries[i]!;
    const entryTokens = entry.contextMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (entryTokens === 0) continue;
    accumulatedTokens += entryTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      // Snap forward to the closest valid cut point: trailing tool results may
      // overflow the budget by themselves — then their assistant tool call is
      // kept rather than falling back to the first message.
      cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1]!;
      break;
    }
  }

  // Pull the cut back over adjacent metadata entries (context-invisible) so
  // they are not stranded in the summarized range; stop at compaction
  // boundaries and at anything context-visible.
  while (cutIndex > startIndex) {
    const previous = entries[cutIndex - 1]!;
    if (previous.isCompaction || previous.contextMessages.length > 0) break;
    cutIndex -= 1;
  }

  const startsTurn = isTurnStartEntry(entries[cutIndex]!);
  const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  };
}
