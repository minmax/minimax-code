/**
 * Split-turn tests: when the cut must land inside one user turn, compaction
 * generates TWO summaries (history + turn prefix) and merges them with the
 * exact pi glue; otherwise a single summary is produced.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPACTION_ENTRY_KIND,
  SPLIT_TURN_SEPARATOR,
  compact,
  mergeSplitTurnSummary,
  parseCompactionEntry,
  projectContext,
} from '../../src/index.js';
import type { LogEntry } from '../../src/index.js';
import {
  RecordingSummarizer,
  assistantMessage,
  filler,
  messageEntry,
  stamp,
  toolResultMessage,
  userMessage,
} from './helpers.js';

describe('compact / split turn', () => {
  it('merges history and turn-prefix summaries with the exact glue when one turn exceeds the budget', async () => {
    // Turn B (entries 3..8) is far bigger than the budget: the cut MUST split
    // it, summarizing turn A as history and the B-prefix separately.
    const entries: LogEntry[] = [
      messageEntry(userMessage('start the work')), // 0 turn A
      messageEntry(assistantMessage('ok')), // 1
      messageEntry(toolResultMessage(filler(40_000), 'c0')), // 2  ~10k tokens
      messageEntry(userMessage('fix the build')), // 3 turn B starts here
      messageEntry(assistantMessage('reading logs')), // 4
      messageEntry(toolResultMessage(filler(60_000), 'c1')), // 5  ~15k tokens
      messageEntry(assistantMessage('found the failing test')), // 6
      messageEntry(toolResultMessage(filler(60_000), 'c2')), // 7  ~15k tokens
      messageEntry(assistantMessage('patching now')), // 8
    ];
    const summarizer = new RecordingSummarizer('HISTORY-SUMMARY', 'TURN-PREFIX-SUMMARY');

    const outcome = await compact({ entries, summarizer: summarizer.call, keepRecentTokens: 8_000 });

    expect(outcome).not.toBeNull();
    expect(outcome!.isSplitTurn).toBe(true);
    // Two summarizer calls: history first, then the turn prefix.
    expect(summarizer.callCount).toBe(2);
    expect(outcome!.summary).toBe('HISTORY-SUMMARY\n\n---\n\n**Turn Context (split turn):**\n\nTURN-PREFIX-SUMMARY');
    expect(outcome!.summary).toContain(SPLIT_TURN_SEPARATOR);
    // The history prompt summarized turn A only; the turn-prefix prompt
    // carries the prefix of turn B starting at its user message.
    expect(summarizer.prompts[0]).toContain('[User]: start the work');
    expect(summarizer.prompts[0]).not.toContain('[User]: fix the build');
    expect(summarizer.prompts[1]).toContain('[User]: fix the build');
    expect(summarizer.prompts[1]).not.toContain('[User]: start the work');
    // The kept tail starts at the last assistant of the split turn.
    expect(outcome!.firstKeptEntryId).toBe(entries[8]!.id);
  });

  it('produces a single summary with no separator when the cut lands at a turn boundary', async () => {
    const entries: LogEntry[] = Array.from({ length: 3 }, (_, i) => [
      messageEntry(userMessage(`turn ${i} ${filler(24_000)}`)),
      messageEntry(assistantMessage(`done ${i}`)),
    ]).flat();
    const summarizer = new RecordingSummarizer('PLAIN-SUMMARY');

    const outcome = await compact({ entries, summarizer: summarizer.call, keepRecentTokens: 10_000 });

    expect(outcome).not.toBeNull();
    expect(outcome!.isSplitTurn).toBe(false);
    expect(summarizer.callCount).toBe(1);
    expect(outcome!.summary).toBe('PLAIN-SUMMARY');
    expect(outcome!.summary).not.toContain('**Turn Context');
  });

  it('falls back to the previous checkpoint summary when the split turn has no history', async () => {
    // Compaction #1 establishes a prior summary; after appending one huge new
    // turn, compaction #2 splits it with nothing before it in its boundary.
    const firstLog: LogEntry[] = [
      messageEntry(userMessage(`early ${filler(16_000)}`)),
      messageEntry(assistantMessage('early work')),
      messageEntry(userMessage(`late ${filler(16_000)}`)),
      messageEntry(assistantMessage('late work')),
    ];
    const first = await compact({
      entries: firstLog,
      summarizer: new RecordingSummarizer('PRIOR-SUMMARY').call,
      keepRecentTokens: 2_000,
    });
    expect(first).not.toBeNull();

    const secondLog: LogEntry[] = [
      ...firstLog,
      stamp(first!.draft, 5, 4),
      messageEntry(userMessage('huge new turn')),
      messageEntry(assistantMessage('new work')),
      messageEntry(toolResultMessage(filler(80_000), 'c9')),
      messageEntry(assistantMessage('still working')),
    ];
    const summarizer = new RecordingSummarizer('NEW-TURN-PREFIX');

    const outcome = await compact({ entries: secondLog, summarizer: summarizer.call, keepRecentTokens: 2_000 });

    expect(outcome).not.toBeNull();
    expect(outcome!.isSplitTurn).toBe(true);
    // History phase had no summarizable messages in its boundary -> the
    // previous checkpoint's summary is reused, one summarizer call total.
    expect(summarizer.callCount).toBe(1);
    expect(summarizer.prompts[0]).toContain('[User]: huge new turn');
    expect(outcome!.summary).toBe('PRIOR-SUMMARY\n\n---\n\n**Turn Context (split turn):**\n\nNEW-TURN-PREFIX');
  });

  it('the durable draft carries summary, firstKeptEntryId, frozen system message, and split flag', async () => {
    const entries: LogEntry[] = [
      { id: 'sys-1', kind: 'mcode.system', payload: { text: 'You are mcode.' }, seq: 1 as LogEntry['seq'], ordinal: 0 },
      messageEntry(userMessage(`warmup ${filler(16_000)}`)),
      messageEntry(assistantMessage('warmup done')),
      messageEntry(userMessage('big turn')), // split turn starts here
      messageEntry(assistantMessage('part 1')),
      messageEntry(toolResultMessage(filler(60_000), 'c1')),
      messageEntry(assistantMessage('part 2')),
    ];
    const summarizer = new RecordingSummarizer('H', 'P');

    const outcome = await compact({
      entries,
      summarizer: summarizer.call,
      keepRecentTokens: 4_000,
      entryId: 'compaction-1',
    });

    expect(outcome!.draft.kind).toBe(COMPACTION_ENTRY_KIND);
    expect(outcome!.draft.id).toBe('compaction-1');
    const payload = parseCompactionEntry(outcome!.draft);
    expect(payload).toBeDefined();
    expect(payload!.summary).toBe(`H${SPLIT_TURN_SEPARATOR}P`);
    expect(payload!.firstKeptEntryId).toBe(outcome!.firstKeptEntryId);
    expect(payload!.firstKeptEntryId).toBe(entries[6]!.id);
    expect(payload!.systemMessage).toBe('You are mcode.');
    expect(payload!.isSplitTurn).toBe(true);
    expect(payload!.tokensBefore).toBeGreaterThan(0);
    expect(typeof payload!.createdAtMs).toBe('number');
  });

  it('projection after the split-turn checkpoint keeps the summarized prefix out of the window', async () => {
    const entries: LogEntry[] = [
      messageEntry(userMessage('long running turn')),
      messageEntry(assistantMessage('step 1')),
      messageEntry(toolResultMessage(filler(60_000), 'c1')),
      messageEntry(assistantMessage('step 2')),
    ];
    const outcome = await compact({
      entries,
      summarizer: new RecordingSummarizer('H', 'P').call,
      keepRecentTokens: 4_000,
    });

    const projected = projectContext([...entries, stamp(outcome!.draft, 5, 4)]);
    const roles = projected.messages.map((m) => m.role);
    // The kept suffix is `step 2`; everything earlier collapsed into the
    // merged summary message (role user).
    expect(roles).toEqual(['user', 'assistant']);
    expect(JSON.stringify(projected.messages[0])).toContain('**Turn Context (split turn):**');
    // Append-only: the raw log keeps every original entry plus the checkpoint.
    expect(projected.entries).toHaveLength(entries.length + 1);
  });

  it('returns null when there is nothing to summarize', async () => {
    const summarizer = new RecordingSummarizer();
    const outcome = await compact({
      entries: [messageEntry(userMessage('tiny'))],
      summarizer: summarizer.call,
      keepRecentTokens: 20_000,
    });
    expect(outcome).toBeNull();
    expect(summarizer.callCount).toBe(0);
  });
});

describe('mergeSplitTurnSummary', () => {
  it('does not leave a dangling separator when the turn-prefix summary is empty', () => {
    // A summarizer that returned an empty string used to produce a checkpoint
    // ending in the bare glue; a delimiter without content reads as corrupt.
    expect(mergeSplitTurnSummary('HISTORY', '')).toBe('HISTORY');
    expect(mergeSplitTurnSummary('', '')).toBe('');
    expect(mergeSplitTurnSummary('HISTORY', 'PREFIX')).toBe(
      `HISTORY${SPLIT_TURN_SEPARATOR}PREFIX`,
    );
  });
});
