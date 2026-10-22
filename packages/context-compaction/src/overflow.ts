/**
 * Overflow recovery: the exactly-once retry after a context-overflow failure.
 *
 * Semantics ported from pi v1.3: when a model turn fails because the context
 * window overflowed, the runner compacts once and retries the turn EXACTLY
 * once. A second failure is terminal — the failed attempt's entries (if any
 * reached the log) are hidden behind a `mcode.context_edit` omission entry,
 * and the error propagates to the caller. No attempt is ever retried twice,
 * and no omission is recorded for a successful recovery.
 *
 * @module
 */

import { createOmissionEntryDraft, generateLogEntryId } from './entries.js';
import type { DurableEntryDraft } from './types.js';

/**
 * Default overflow detector: conservative substring heuristics over the error
 * text (and any nested `cause`), matching the common provider phrasings for a
 * full context window. Anything not matching is NOT an overflow and must not
 * trigger a compaction.
 */
export function isContextOverflowError(error: unknown): boolean {
  const texts: string[] = [];
  let current: unknown = error;
  // Deep wrapper chains are normal in this stack (SDK client -> transport ->
  // provider error -> cause), so the walk is bounded far beyond the typical
  // nesting; the cap only exists to survive a (pathological) circular cause.
  for (let depth = 0; current !== undefined && current !== null && depth < 16; depth += 1) {
    if (typeof current === 'string') {
      texts.push(current);
      break;
    }
    if (typeof current !== 'object') break;
    const record = current as { message?: unknown; status?: unknown; code?: unknown; cause?: unknown };
    if (typeof record.message === 'string') texts.push(record.message);
    if (typeof record.code === 'string') texts.push(record.code);
    // HTTP 413 (Content Too Large) is an overflow verdict on its own: some
    // providers fail the request with a bare `{ status: 413 }` (no message,
    // no code), and refusing to compact on it would wedge the session.
    if (record.status === 413 || record.status === '413') return true;
    current = record.cause;
  }
  const text = texts.join('\n');
  if (text.length === 0) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

const OVERFLOW_PATTERNS: RegExp[] = [
  /context (?:window|length)[^\n]{0,40}(?:exceed|exceeded|overflow|too (?:long|large|many))/i,
  /(?:exceed|exceeded)[^\n]{0,40}context (?:window|length)/i,
  /prompt (?:is )?too long/i,
  /too many (?:input )?tokens/i,
  /maximum context length/i,
  /context_length_exceeded/i,
  /request too large/i,
  /content length limit/i,
];

/** What the recovery did, reported to the caller for logging/telemetry. */
export interface OverflowRecoveryReport {
  /** True when the first attempt failed with an overflow and compaction ran. */
  readonly compacted: boolean;
  /** Error of the failed retry, when the recovery itself failed. */
  readonly retryError?: unknown;
  /** Omission draft created for the failed attempt's entries, if any. */
  readonly omissionDraft?: DurableEntryDraft;
}

export interface OverflowRecoveryOptions<T> {
  /** The model turn to protect. */
  attempt: () => Promise<T>;
  /** Overrides the default overflow heuristic when provided. */
  isOverflowError?: (error: unknown) => boolean;
  /**
   * Perform a compaction and durably append its checkpoint. Called at most
   * once per recovery — never on a clean first attempt, never twice.
   */
  compact: () => Promise<unknown>;
  /**
   * Ids of the log entries the FAILED attempt produced (an aborted assistant
   * attempt may already have committed messages). An omission entry hiding
   * them is appended after the terminal retry failure.
   */
  failedAttemptEntryIds?: () => readonly string[];
  /**
   * Durably append one entry (the omission). Required together with
   * `failedAttemptEntryIds` for omission recording; with neither, a terminal
   * retry failure simply propagates.
   */
  appendEntry?: (draft: DurableEntryDraft) => Promise<void> | void;
  /** Clock for the omission timestamp. Default `Date.now`. */
  now?: () => number;
  /** Id of the omission entry. Default: generated. */
  omissionEntryId?: string;
}

/**
 * Run `attempt` with exactly-once overflow recovery.
 *
 * - First attempt succeeds -> returned, nothing else happens.
 * - First attempt fails with a non-overflow error -> the error propagates,
 *   no compaction, no retry.
 * - First attempt fails with an overflow -> `compact()` runs once, the
 *   attempt retries once.
 * - Retry succeeds -> result returned, no omission recorded.
 * - Retry fails -> `failedAttemptEntryIds()` + `appendEntry()` record a
 *   `mcode.context_edit` omission hiding the failed attempt, and the retry
 *   error propagates.
 */
export async function runWithOverflowRecovery<T>(
  options: OverflowRecoveryOptions<T>,
): Promise<{ result: T; report: OverflowRecoveryReport }> {
  const isOverflow = options.isOverflowError ?? isContextOverflowError;

  let firstError: unknown;
  try {
    return { result: await options.attempt(), report: { compacted: false } };
  } catch (error) {
    if (!isOverflow(error)) throw error;
    firstError = error;
  }

  // Exactly one compaction, exactly one retry.
  await options.compact();
  try {
    const result = await options.attempt();
    return { result, report: { compacted: true } };
  } catch (retryError) {
    const report: { compacted: boolean; retryError: unknown; omissionDraft?: DurableEntryDraft } = {
      compacted: true,
      retryError,
    };
    const targetIds = options.failedAttemptEntryIds?.() ?? [];
    if (options.appendEntry !== undefined && targetIds.length > 0) {
      const reason = `overflow recovery failed after compaction: ${String(
        firstError instanceof Error ? firstError.message : firstError,
      )}; retry failed: ${String(retryError instanceof Error ? retryError.message : retryError)}`;
      const omissionDraft = createOmissionEntryDraft(
        // randomUUID discipline (see `generateLogEntryId`): a
        // `omission-${Date.now()}` id collides when two omissions are recorded
        // within the same millisecond, and duplicate entry ids corrupt the log.
        options.omissionEntryId ?? generateLogEntryId('omission'),
        targetIds,
        reason,
        options.now,
      );
      await options.appendEntry(omissionDraft);
      report.omissionDraft = omissionDraft;
    }
    throw retryError;
  }
}
