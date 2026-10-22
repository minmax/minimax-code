/**
 * Overflow-recovery tests: exactly one retry after exactly one compaction, a
 * `mcode.context_edit` omission for the failed attempt's entries on the
 * terminal failure, and no retry for non-overflow errors.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTEXT_EDIT_ENTRY_KIND,
  compact,
  createCompactionEntryDraft,
  createOmissionEntryDraft,
  isContextOverflowError,
  parseCompactionEntry,
  projectContext,
  runWithOverflowRecovery,
} from '../../src/index.js';
import type { CompactionEntryPayload, DurableEntryDraft, LogEntry } from '../../src/index.js';
import { MemoryLog, RecordingSummarizer, assistantMessage, filler, messageEntry, stamp, userMessage } from './helpers.js';

/** A well-formed compaction checkpoint draft over the given base id. */
function checkpointDraft(id: string, firstKeptEntryId: string, summary: string): DurableEntryDraft {
  const payload: CompactionEntryPayload = {
    summary,
    firstKeptEntryId,
    systemMessage: null,
    isSplitTurn: false,
    tokensBefore: 1,
    estimatedTokensAfter: 1,
    createdAtMs: 0,
  };
  return createCompactionEntryDraft(id, payload);
}

function overflowError(): Error {
  return new Error('Request failed: maximum context length of 128000 tokens exceeded');
}

describe('isContextOverflowError', () => {
  it('recognizes the common provider phrasings', () => {
    expect(isContextOverflowError(new Error('prompt is too long'))).toBe(true);
    expect(isContextOverflowError(new Error('context_length_exceeded'))).toBe(true);
    expect(isContextOverflowError(new Error('input is too many tokens'))).toBe(true);
    expect(
      isContextOverflowError(
        new Error("This model's maximum context length is 128000 tokens. However, you requested 200000 tokens"),
      ),
    ).toBe(true);
    expect(isContextOverflowError(new Error('context window exceeded'))).toBe(true);
  });

  it('recognizes overflow hidden in the cause chain', () => {
    const cause = new Error('prompt is too long');
    expect(isContextOverflowError(new Error('request failed', { cause }))).toBe(true);
  });

  // Regression (wave-2 review): the walk used to stop at depth 4, so an error
  // wrapped in 4+ layers (SDK client -> transport -> provider -> ...) lost its
  // overflow verdict and recovery never ran.
  it('recognizes overflow through a deeply nested cause chain', () => {
    let error: Error = new Error('prompt is too long');
    for (let depth = 0; depth < 8; depth += 1) {
      error = new Error(`wrapper-${depth}`, { cause: error });
    }
    expect(isContextOverflowError(error)).toBe(true);
  });

  // Regression (wave-2 review): some providers fail with a bare `{ status:
  // 413 }` — no message, no code. The detector used to read `status` but never
  // act on it, so no compaction ran and the session wedged on the overflow.
  it('treats a bare 413 status as an overflow verdict', () => {
    expect(isContextOverflowError({ status: 413 })).toBe(true);
    expect(isContextOverflowError({ status: '413' })).toBe(true);
    expect(isContextOverflowError({ status: 413, cause: new Error('boom') })).toBe(true);
    expect(isContextOverflowError(new Error('wrapped', { cause: { status: 413 } }))).toBe(true);
    // Other statuses are not an overflow verdict on their own.
    expect(isContextOverflowError({ status: 400 })).toBe(false);
    expect(isContextOverflowError({ status: 429 })).toBe(false);
  });

  it('rejects unrelated failures', () => {
    expect(isContextOverflowError(new Error('401 unauthorized'))).toBe(false);
    expect(isContextOverflowError(new Error('rate limit exceeded, retry later'))).toBe(false);
    expect(isContextOverflowError(new Error('socket hang up'))).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });
});

describe('runWithOverflowRecovery', () => {
  it('does nothing on a clean first attempt', async () => {
    let compactions = 0;
    const { result, report } = await runWithOverflowRecovery({
      attempt: async () => 'ok',
      compact: async () => {
        compactions += 1;
      },
    });
    expect(result).toBe('ok');
    expect(report.compacted).toBe(false);
    expect(report.omissionDraft).toBeUndefined();
    expect(compactions).toBe(0);
  });

  it('compacts once and retries exactly once after an overflow, succeeding', async () => {
    let attempts = 0;
    let compactions = 0;
    const { result, report } = await runWithOverflowRecovery({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) throw overflowError();
        return 'recovered';
      },
      compact: async () => {
        compactions += 1;
      },
    });
    expect(result).toBe('recovered');
    expect(attempts).toBe(2);
    expect(compactions).toBe(1);
    expect(report.compacted).toBe(true);
    expect(report.omissionDraft).toBeUndefined();
  });

  it('propagates non-overflow errors without compaction or retry', async () => {
    let attempts = 0;
    let compactions = 0;
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          attempts += 1;
          throw new Error('boom');
        },
        compact: async () => {
          compactions += 1;
        },
      }),
    ).rejects.toThrow('boom');
    expect(attempts).toBe(1);
    expect(compactions).toBe(0);
  });

  it('records a context_edit omission for the failed attempt and rethrows after the terminal retry', async () => {
    const log = new MemoryLog();
    const failedAttemptEntryIds = ['attempt-1', 'attempt-2'];
    let attempts = 0;
    let compactions = 0;

    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          attempts += 1;
          throw overflowError(); // both attempts overflow
        },
        compact: async () => {
          compactions += 1;
        },
        failedAttemptEntryIds: () => failedAttemptEntryIds,
        appendEntry: (draft) => log.append([draft]),
      }),
    ).rejects.toThrow(/context length/i);

    // Exactly one compaction and exactly two attempts — no second retry.
    expect(attempts).toBe(2);
    expect(compactions).toBe(1);
    // The omission hides every failed-attempt entry.
    expect(log.entries).toHaveLength(1);
    const omission = log.entries[0]!;
    expect(omission.kind).toBe(CONTEXT_EDIT_ENTRY_KIND);
    expect(omission.payload).toMatchObject({ action: 'omission', targetIds: failedAttemptEntryIds });
    expect(String(omission.payload && (omission.payload as { reason?: string }).reason)).toContain(
      'overflow recovery failed',
    );

    // And the projection actually hides the omitted entries.
    const projected = projectContext([
      messageEntry(userMessage('before')),
      { id: 'attempt-1', kind: 'mcode.message', payload: userMessage('ghost'), seq: 2 as LogEntry['seq'], ordinal: 1 },
      omission,
    ]);
    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0]).toEqual(userMessage('before'));
  });

  it('integrates end to end: real compaction appends the checkpoint, then the retry succeeds', async () => {
    const log = new MemoryLog();
    const summarizer = new RecordingSummarizer('CHECKPOINT');
    await log.append([
      messageEntry(userMessage('warmup')),
      messageEntry(assistantMessage('warmup done')),
      messageEntry(userMessage(`heavy ${filler(40_000)}`)),
      messageEntry(assistantMessage('done')),
    ]);
    const before = [...log.entries];

    let attempts = 0;
    const { result } = await runWithOverflowRecovery({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) throw overflowError();
        return 'done after compaction';
      },
      compact: async () => {
        const outcome = await compact({
          entries: log.entries,
          summarizer: summarizer.call,
          keepRecentTokens: 1_000,
        });
        if (outcome !== null) await log.append([outcome.draft]);
      },
      failedAttemptEntryIds: () => [],
      appendEntry: (draft: DurableEntryDraft) => log.append([draft]),
    });

    expect(result).toBe('done after compaction');
    expect(attempts).toBe(2);
    expect(summarizer.callCount).toBe(1);
    // The checkpoint was appended once; the original entries are untouched.
    expect(log.entries).toHaveLength(before.length + 1);
    expect(log.entries.slice(0, before.length)).toEqual(before);
  });

  it('a custom detector overrides the default heuristic', async () => {
    let attempts = 0;
    await expect(
      runWithOverflowRecovery({
        attempt: async () => {
          attempts += 1;
          throw new Error('prompt is too long');
        },
        isOverflowError: () => false,
        compact: async () => undefined,
      }),
    ).rejects.toThrow('prompt is too long');
    expect(attempts).toBe(1);
  });

  it('generates unique omission ids even within the same millisecond', async () => {
    // Review round 3: `omission-${Date.now()}` collides for two omissions
    // recorded in the same millisecond; the id discipline is `randomUUID`
    // (see `generateLogEntryId`), duplicate entry ids corrupt the log.
    const log = new MemoryLog();
    const now = (): number => 42; // frozen clock: every omission lands in "the same" ms
    const terminalFailure = async (): Promise<void> => {
      await expect(
        runWithOverflowRecovery({
          attempt: async () => {
            throw overflowError();
          },
          compact: async () => undefined,
          failedAttemptEntryIds: () => ['attempt-x'],
          appendEntry: (draft) => log.append([draft]),
          now,
        }),
      ).rejects.toThrow(/context length/i);
    };
    await terminalFailure();
    await terminalFailure();
    expect(log.entries).toHaveLength(2);
    expect(log.entries[0]!.id).toMatch(/^omission-/);
    expect(log.entries[1]!.id).toMatch(/^omission-/);
    expect(log.entries[0]!.id).not.toBe(log.entries[1]!.id);
  });

  it('createCompactionEntryDraft round-trips through parseCompactionEntry', () => {
    const draft = checkpointDraft('c1', 'e9', 's');
    expect(draft.kind).toBe('mcode.compaction');
    const parsed = parseCompactionEntry(draft);
    expect(parsed).toMatchObject({ summary: 's', firstKeptEntryId: 'e9', isSplitTurn: false });
    expect(parseCompactionEntry({ ...draft, kind: 'mcode.message' })).toBeUndefined();
  });
});

describe('checkpoint retraction by omission', () => {
  it('an omission targeting the winning checkpoint hides it: the full raw history is visible again', () => {
    const base: LogEntry[] = [
      messageEntry(userMessage('before 1')),
      messageEntry(assistantMessage('before 2')),
    ];
    const checkpoint = stamp(checkpointDraft('cp-1', base[0]!.id, 'TINY-SUMMARY'), 3, 2);
    const omission = stamp(createOmissionEntryDraft('omit-cp', ['cp-1'], 'overflow recovery failed'), 4, 3);

    const projected = projectContext([...base, checkpoint, omission]);
    // The retracted checkpoint neither collapses history nor leaves its
    // summary in the window.
    expect(projected.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(projected.messages)).not.toContain('TINY-SUMMARY');
  });

  it('with the later checkpoint omitted, the earlier one wins again', () => {
    const base: LogEntry[] = [
      messageEntry(userMessage('t0')),
      messageEntry(assistantMessage('a0')),
      messageEntry(userMessage('t1')),
      messageEntry(assistantMessage('a1')),
    ];
    const cp1 = stamp(checkpointDraft('cp-1', base[0]!.id, 'FIRST-SUMMARY'), 5, 4);
    const cp2 = stamp(checkpointDraft('cp-2', base[2]!.id, 'SECOND-SUMMARY'), 6, 5);
    const omission = stamp(createOmissionEntryDraft('omit-cp2', ['cp-2'], 'retracted'), 7, 6);

    // Without the omission the newer checkpoint wins: [summary2, t1, a1].
    expect(projectContext([...base, cp1, cp2]).messages).toHaveLength(3);

    // With cp-2 retracted, cp-1 collapses nothing before its first-kept entry
    // (t0), so the full history returns with cp-1's summary leading it.
    const projected = projectContext([...base, cp1, cp2, omission]);
    expect(projected.messages).toHaveLength(5);
    expect(JSON.stringify(projected.messages[0])).toContain('FIRST-SUMMARY');
    expect(JSON.stringify(projected.messages)).not.toContain('SECOND-SUMMARY');
  });

  it('compaction after retraction re-summarizes the reopened range', async () => {
    const log = new MemoryLog();
    await log.append([
      messageEntry(userMessage(`t0 ${filler(16_000)}`)),
      messageEntry(assistantMessage('a0')),
      messageEntry(userMessage(`t1 ${filler(16_000)}`)),
      messageEntry(assistantMessage('a1')),
    ]);
    const checkpoint = stamp(checkpointDraft('cp-1', log.entries[0]!.id, 'TINY-SUMMARY'));
    await log.append([checkpoint]);
    await log.append([createOmissionEntryDraft('omit-cp', ['cp-1'], 'retracted')]);

    // The retracted checkpoint leaves the boundary open: compact summarizes
    // from the very beginning of the log again.
    const summarizer = new RecordingSummarizer('FRESH-SUMMARY');
    const outcome = await compact({ entries: log.entries, summarizer: summarizer.call, keepRecentTokens: 1_000 });
    expect(outcome).not.toBeNull();
    expect(summarizer.prompts[0]).toContain('[User]: t0');
    expect(outcome!.firstKeptEntryId).toBe(log.entries[2]!.id);
  });
});
