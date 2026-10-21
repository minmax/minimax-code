/**
 * Compaction outcome tests: the ≤90%-of-budget criterion, the durable entry
 * shape, append-only projection across two compactions, and the summarizer
 * serialization contract (toolResult ≤ 2000 chars, thinking excluded).
 */

import { describe, expect, it } from 'vitest';

import {
  COMPACTION_ENTRY_KIND,
  TOOL_RESULT_MAX_CHARS,
  compact,
  estimateContextTokens,
  projectContext,
  serializeConversation,
} from '../../src/index.js';
import type { LogEntry } from '../../src/index.js';
import {
  MemoryLog,
  RecordingSummarizer,
  assistantMessage,
  filler,
  messageEntry,
  stamp,
  toolResultMessage,
  userMessage,
} from './helpers.js';

describe('the ≤90% criterion', () => {
  it('compaction shrinks the window to at most 90% of the token budget', async () => {
    const tokenBudget = 100_000;
    // ~92% of the budget: two heavy turns anchored by a usage record.
    const entries: LogEntry[] = [
      messageEntry(userMessage('kick off')),
      messageEntry(assistantMessage('on it')),
      messageEntry(userMessage(`first ${filler(240_000)}`)), // ~60k tokens
      messageEntry(assistantMessage('first done')),
      messageEntry(userMessage(`second ${filler(100_000)}`)), // ~25k tokens
      messageEntry(assistantMessage('second done', { totalTokens: 92_000 })),
    ];
    const before = estimateContextTokens(projectContext(entries).messages).tokens;
    expect(before).toBeGreaterThanOrEqual(92_000);

    const summarizer = new RecordingSummarizer('STRUCTURED CHECKPOINT');
    const outcome = await compact({ entries, summarizer: summarizer.call, tokenBudget });

    expect(outcome).not.toBeNull();
    // THE criterion: the post-compaction window fits inside 90% of the budget.
    expect(outcome!.estimatedTokensAfter).toBeLessThanOrEqual(0.9 * tokenBudget);
    // ...and it really did shrink the window.
    expect(outcome!.estimatedTokensAfter).toBeLessThan(before);
    // The measured number is honest: summary message (21 chars -> 6 tokens)
    // plus the kept tail (user 25002 + assistant 3).
    expect(outcome!.estimatedTokensAfter).toBe(25_011);
    // Projection after the checkpoint: summary + kept tail, nothing else.
    const projectedAfter = projectContext([...entries, stamp(outcome!.draft, 7, 6)]);
    expect(projectedAfter.messages).toHaveLength(3);
    expect(JSON.stringify(projectedAfter.messages[0])).toContain('STRUCTURED CHECKPOINT');
  });

  it('reports tokensBefore from the usage-anchored estimate', async () => {
    const entries: LogEntry[] = [
      messageEntry(userMessage(`a ${filler(16_000)}`)),
      messageEntry(assistantMessage('mid', { totalTokens: 4_042 })),
      messageEntry(userMessage(`b ${filler(8_000)}`)),
    ];
    const outcome = await compact({
      entries,
      summarizer: new RecordingSummarizer('S').call,
      keepRecentTokens: 1_000,
    });
    expect(outcome!.tokensBefore).toBe(4_042 + Math.ceil(8_002 / 4));
  });
});

describe('durable entry and append-only projection', () => {
  it('the checkpoint is one append-only entry; the original log is never touched', async () => {
    const log = new MemoryLog();
    await log.append([
      messageEntry(userMessage(`first ${filler(24_000)}`)),
      messageEntry(assistantMessage('first done')),
      messageEntry(userMessage(`second ${filler(24_000)}`)),
      messageEntry(assistantMessage('second done')),
    ]);
    const raw = [...log.entries];

    const outcome = await compact({
      entries: log.entries,
      summarizer: new RecordingSummarizer('CHECKPOINT').call,
      keepRecentTokens: 2_000,
    });
    await log.append([outcome!.draft]);

    // Nothing rewritten: the original entries are byte-identical, in place.
    expect(log.entries.slice(0, raw.length)).toEqual(raw);
    expect(log.entries).toHaveLength(raw.length + 1);
    expect(log.entries.at(-1)!.kind).toBe(COMPACTION_ENTRY_KIND);

    // Projection derives the short window from the appended checkpoint:
    // summary + kept tail (the 'second ...' turn).
    const projected = projectContext(log.entries);
    expect(projected.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    expect(JSON.stringify(projected.messages[0])).toContain('CHECKPOINT');
    expect(JSON.stringify(projected.messages[1])).toContain('second');
  });

  it('a second compaction summarizes the new turns and keeps the window short', async () => {
    const log = new MemoryLog();
    await log.append([
      messageEntry(userMessage(`t0 ${filler(16_000)}`)),
      messageEntry(assistantMessage('a0')),
      messageEntry(userMessage(`t1 ${filler(16_000)}`)),
      messageEntry(assistantMessage('a1')),
    ]);
    const first = await compact({
      entries: log.entries,
      summarizer: new RecordingSummarizer('FIRST-SUMMARY').call,
      keepRecentTokens: 2_000,
    });
    await log.append([first!.draft]);
    const afterFirst = projectContext(log.entries);

    await log.append([
      messageEntry(userMessage(`t2 ${filler(2_000)}`)),
      messageEntry(assistantMessage('a2')),
      messageEntry(userMessage(`t3 ${filler(24_000)}`)),
      messageEntry(assistantMessage('a3', { totalTokens: 6_500 })),
    ]);
    const beforeSecond = projectContext(log.entries);
    const summarizer = new RecordingSummarizer('SECOND-SUMMARY');
    const second = await compact({
      entries: log.entries,
      summarizer: summarizer.call,
      keepRecentTokens: 2_000,
    });
    expect(second).not.toBeNull();
    // The update prompt carried the previous summary for iterative merging.
    expect(summarizer.prompts[0]).toContain('<previous-summary>');
    expect(summarizer.prompts[0]).toContain('FIRST-SUMMARY');
    // The new checkpoint summarizes only the boundary content (t2/a2).
    expect(summarizer.prompts[0]).not.toContain('t0');
    await log.append([second!.draft]);

    const afterSecond = projectContext(log.entries);
    // kept tail = the t3 turn (its user message is firstKeptEntryId).
    expect(afterSecond.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    expect(JSON.stringify(afterSecond.messages[0])).toContain('SECOND-SUMMARY');
    // The window shrank while the raw log only grew (append-only).
    expect(beforeSecond.messages.length).toBe(7);
    expect(afterSecond.messages.length).toBe(3);
    expect(afterSecond.messages.length).toBeLessThan(beforeSecond.messages.length);
    expect(log.entries.length).toBe(10);
  });

  it('unknown firstKeptEntryId is a hard projection error', async () => {
    const bogus = stamp(
      {
        id: 'bad',
        kind: COMPACTION_ENTRY_KIND,
        payload: { summary: 's', firstKeptEntryId: 'missing', systemMessage: null, isSplitTurn: false, tokensBefore: 0, estimatedTokensAfter: 0, createdAtMs: 0 },
      },
      1,
      0,
    );
    expect(() => projectContext([messageEntry(userMessage('hi')), bogus])).toThrow(/firstKeptEntryId/);
  });

  it('a malformed checkpoint is dead weight: compact still summarizes the messages before it', async () => {
    // Regression from review: the boundary used to start after ANY entry with
    // the compaction kind, so a corrupted payload stranded the messages before
    // it outside every future summary (compact returned null forever).
    const malformed = stamp(
      { id: 'broken-cp', kind: COMPACTION_ENTRY_KIND, payload: { broken: true } },
      3,
      2,
    );
    const entries: LogEntry[] = [
      messageEntry(userMessage(`early ${filler(16_000)}`)),
      messageEntry(assistantMessage('early answer')),
      malformed,
      messageEntry(userMessage(`late ${filler(16_000)}`)),
      messageEntry(assistantMessage('late answer')),
    ];
    const summarizer = new RecordingSummarizer('RECOVERED-SUMMARY');

    const outcome = await compact({ entries, summarizer: summarizer.call, keepRecentTokens: 1_000 });

    expect(outcome).not.toBeNull();
    expect(summarizer.prompts[0]).toContain('[User]: early');
    expect(outcome!.firstKeptEntryId).toBe(entries[3]!.id);
    // The malformed entry never collapses history (its payload is ignored),
    // but it still marks a cut boundary: the metadata extension must not put
    // a corrupt checkpoint id into firstKeptEntryId.
    const projected = projectContext(entries);
    expect(projected.entries[2]!.isCompaction).toBe(true);
    expect(projected.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('an unsplittable trailing tool result overshoots the 90% target, reported honestly', async () => {
    // Documented best-effort boundary of the ≤90% target (README): the cut
    // can never split a tool result from its call, so a giant trailing tool
    // result stays in the kept tail even past the clamp.
    const tokenBudget = 40_000;
    const entries: LogEntry[] = [
      messageEntry(userMessage('start')),
      messageEntry(assistantMessage('on it')),
      messageEntry(userMessage('run the huge tool')),
      messageEntry(assistantMessage('running the tool')),
      messageEntry(toolResultMessage(filler(152_000), 'c-huge')), // 38_000 tokens
    ];
    const outcome = await compact({
      entries,
      summarizer: new RecordingSummarizer('S').call,
      tokenBudget,
    });

    expect(outcome).not.toBeNull();
    // 90% of 40k = 36k; the kept tail (assistant 4 + merged summary 11 +
    // tool result 38_000 tokens) exceeds it: 38_015.
    expect(outcome!.estimatedTokensAfter).toBe(38_015);
    expect(outcome!.estimatedTokensAfter).toBeGreaterThan(0.9 * tokenBudget);
    // The clamp did its part (keepRecent stayed 20_000 < 33_952): the
    // overshoot is pure cut granularity, honestly reported.
  });

  it('tokensBefore includes the frozen system prompt in the pure (no-anchor) path', async () => {
    const entries: LogEntry[] = [
      { id: 'sys', kind: 'mcode.system', payload: { text: 'You are mcode.' }, seq: 1 as LogEntry['seq'], ordinal: 0 },
      messageEntry(userMessage(filler(16_000))), // 4000 tokens
      messageEntry(assistantMessage('a0')),
      messageEntry(userMessage(filler(16_000))), // 4000 tokens
      messageEntry(assistantMessage('a1')),
    ];
    const outcome = await compact({
      entries,
      summarizer: new RecordingSummarizer('S').call,
      keepRecentTokens: 1_000,
    });
    expect(outcome).not.toBeNull();
    // Pure path: conversation 8002 tokens + system 14 chars -> 4 tokens.
    expect(outcome!.tokensBefore).toBe(8_006);
    // ...and the after-side adds the same system prompt (symmetry).
    expect(outcome!.systemMessage).toBe('You are mcode.');
  });

  it('generated default entry ids are unique across compactions', async () => {
    const entries: LogEntry[] = [
      messageEntry(userMessage(`t0 ${filler(16_000)}`)),
      messageEntry(assistantMessage('a0')),
      messageEntry(userMessage(`t1 ${filler(16_000)}`)),
      messageEntry(assistantMessage('a1')),
    ];
    const first = await compact({ entries, summarizer: async () => 'S1', keepRecentTokens: 1_000 });
    const second = await compact({ entries, summarizer: async () => 'S2', keepRecentTokens: 1_000 });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.entryId).not.toBe(second!.entryId);
    expect(first!.entryId).toMatch(/^compaction-/);
  });
});

describe('serializeConversation contract', () => {
  it('truncates tool results to 2000 characters with an explicit marker', () => {
    const long = filler(TOOL_RESULT_MAX_CHARS + 500);
    const text = serializeConversation([
      userMessage('run it'),
      assistantMessage('running'),
      toolResultMessage(long),
    ]);
    expect(text).toContain('[User]: run it');
    expect(text).toContain('[Assistant]: running');
    expect(text).toContain('[Tool result]:');
    expect(text).toContain('[... 500 more characters truncated]');
    const resultLine = text.split('[Tool result]: ')[1]!;
    // The serialized tool result never exceeds the cap plus the marker.
    expect(resultLine.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + '[... 500 more characters truncated]'.length + 2);
  });

  it('excludes thinking blocks and keeps tool calls as name(args)', () => {
    const text = serializeConversation([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'SECRET REASONING' },
          { type: 'text', text: 'let me check' },
          { type: 'toolCall', name: 'read', arguments: { path: '/tmp/x.ts' } },
        ],
      },
    ]);
    expect(text).not.toContain('SECRET REASONING');
    expect(text).toContain('[Assistant]: let me check');
    expect(text).toContain('[Assistant tool calls]: read(path="/tmp/x.ts")');
  });

  it('drops empty messages', () => {
    expect(serializeConversation([userMessage(''), assistantMessage('')])).toBe('');
  });
});
