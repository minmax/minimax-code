/**
 * Double-trigger tests: the token axis (usage anchor + chars/4 trailing,
 * image = 4800 characters) and the byte axis (Σ serialized entry lengths of
 * the manifest) trigger independently, with 75% background and 90% blocking
 * thresholds; and the ≤90% post-compaction clamp resolves keepRecentTokens.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BACKGROUND_THRESHOLD_RATIO,
  DEFAULT_BLOCKING_THRESHOLD_RATIO,
  DEFAULT_KEEP_RECENT_TOKENS,
  ESTIMATED_IMAGE_CHARS,
  compact,
  createCompactionEntryDraft,
  createOmissionEntryDraft,
  estimateContextTokens,
  estimateManifestBytes,
  estimateMessageTokens,
  estimateProjectedContextTokens,
  evaluateTriggers,
  isCompactionMessagePayload,
  projectContext,
  resolveKeepRecentTokens,
} from '../../src/index.js';
import type { LogEntry } from '../../src/index.js';
import { assistantMessage, filler, messageEntry, stamp, userMessage } from './helpers.js';

describe('token estimation', () => {
  it('anchors at the last valid usage and estimates only the trailing messages at chars/4', () => {
    const messages = [
      userMessage(filler(4_000)), // would be 1000 tokens alone
      assistantMessage('anchored', { totalTokens: 50_000 }),
      userMessage(filler(2_000)), // 500 tokens trailing
      assistantMessage(filler(400)), // 100 tokens trailing
    ];

    const estimate = estimateContextTokens(messages);

    expect(estimate.usageAnchorIndex).toBe(1);
    expect(estimate.usageTokens).toBe(50_000);
    expect(estimate.trailingTokens).toBe(600);
    expect(estimate.tokens).toBe(50_600);
  });

  it('falls back to a pure chars/4 estimate without a usage anchor', () => {
    const messages = [userMessage(filler(400)), assistantMessage(filler(200))];
    const estimate = estimateContextTokens(messages);
    expect(estimate.usageAnchorIndex).toBeNull();
    expect(estimate.tokens).toBe(150);
  });

  it('ignores aborted, error, and zero-usage assistant messages as anchors', () => {
    const aborted = { ...assistantMessage('x'), stopReason: 'aborted', usage: { totalTokens: 99_999 } };
    const errored = { ...assistantMessage('y'), stopReason: 'error', usage: { totalTokens: 99_999 } };
    const zero = assistantMessage('z', { totalTokens: 0 });
    const good = assistantMessage('good', { totalTokens: 1_000 });

    expect(estimateContextTokens([aborted, good]).usageAnchorIndex).toBe(1);
    expect(estimateContextTokens([errored, good]).usageAnchorIndex).toBe(1);
    expect(estimateContextTokens([zero, good]).usageAnchorIndex).toBe(1);
    expect(estimateContextTokens([good, zero]).usageAnchorIndex).toBe(0);
  });

  it('charges an image block 4800 characters (1200 tokens)', () => {
    const image = { role: 'user', content: [{ type: 'image' }] } as const;
    expect(estimateMessageTokens(image)).toBe(ESTIMATED_IMAGE_CHARS / 4);
    expect(ESTIMATED_IMAGE_CHARS).toBe(4800);

    const mixed = {
      role: 'user',
      content: [{ type: 'text', text: filler(200) }, { type: 'image' }],
    } as const;
    expect(estimateMessageTokens(mixed)).toBe(50 + ESTIMATED_IMAGE_CHARS / 4);
  });

  it('counts thinking in the estimate but the anchor dominates when present', () => {
    const thinkingAssistant = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: filler(400) }, { type: 'text', text: 'ok' }],
    } as const;
    expect(estimateMessageTokens(thinkingAssistant)).toBe(101);
  });

  it('returns a hard 0 (never undefined) for a payload an unknown role falls through on', () => {
    // A corrupt role-less payload must not poison window totals into NaN.
    expect(estimateMessageTokens({ broken: true } as never)).toBe(0);
    expect(Number.isFinite(estimateMessageTokens({ role: 'martian' } as never))).toBe(true);
  });
});

describe('isCompactionMessagePayload', () => {
  it('accepts the four message roles with walkable content', () => {
    expect(isCompactionMessagePayload({ role: 'user', content: 'text' })).toBe(true);
    expect(isCompactionMessagePayload({ role: 'user', content: [{ type: 'text', text: 'a' }] })).toBe(true);
    expect(isCompactionMessagePayload({ role: 'assistant', content: [{ type: 'text', text: 'a' }] })).toBe(true);
    expect(isCompactionMessagePayload({ role: 'toolResult', content: [{ type: 'image' }] })).toBe(true);
    expect(isCompactionMessagePayload({ role: 'custom', customType: 'hook', text: 'x' })).toBe(true);
  });

  it('rejects role-less, unknown-role, and non-walkable payloads', () => {
    expect(isCompactionMessagePayload({ broken: true })).toBe(false);
    expect(isCompactionMessagePayload({ role: 'martian', content: 'x' })).toBe(false);
    expect(isCompactionMessagePayload({ role: 'user', content: 42 })).toBe(false);
    expect(isCompactionMessagePayload({ role: 'assistant', content: 'plain string' })).toBe(false);
    expect(isCompactionMessagePayload({ role: 'custom' })).toBe(false);
    expect(isCompactionMessagePayload(null)).toBe(false);
    expect(isCompactionMessagePayload('user')).toBe(false);
  });
});

describe('byte axis', () => {
  it('sums serialized entry lengths as UTF-8 bytes', () => {
    const entries: LogEntry[] = [messageEntry(userMessage('one')), messageEntry(userMessage('two'))];
    const expected = entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0);
    expect(estimateManifestBytes(entries)).toBe(expected);
    expect(estimateManifestBytes([])).toBe(0);
  });

  it('measures non-ASCII payloads as real bytes, not UTF-16 code units', () => {
    // Cyrillic: 2 UTF-8 bytes per character but 1 UTF-16 code unit — a
    // code-unit sum would under-measure by 2x and trip a byte budget late.
    const entry = messageEntry(userMessage('кириллица'.repeat(20)));
    const codeUnits = JSON.stringify(entry).length;
    const utf8Bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    expect(utf8Bytes).toBeGreaterThan(codeUnits);
    expect(estimateManifestBytes([entry])).toBe(utf8Bytes);
  });
});

describe('evaluateTriggers (double trigger)', () => {
  const budgets = { tokenBudget: 100_000, byteBudget: 1_000_000 };

  it('stays none below the background ratio on both axes', () => {
    const evaluation = evaluateTriggers({ tokens: 74_999, bytes: 749_999 }, budgets);
    expect(evaluation.level).toBe('none');
    expect(evaluation.reasons).toEqual([]);
  });

  it('fires background at 75% of the token axis only', () => {
    const evaluation = evaluateTriggers({ tokens: 75_000, bytes: 0 }, budgets);
    expect(evaluation.level).toBe('background');
    expect(evaluation.reasons).toHaveLength(1);
    expect(evaluation.reasons[0]).toMatchObject({ axis: 'tokens', threshold: 0.75 });
  });

  it('fires background at 75% of the byte axis even with few tokens', () => {
    const evaluation = evaluateTriggers({ tokens: 100, bytes: 800_000 }, budgets);
    expect(evaluation.level).toBe('background');
    expect(evaluation.reasons[0]).toMatchObject({ axis: 'bytes', threshold: 0.75 });
  });

  it('escalates to blocking at 90% of either axis', () => {
    expect(evaluateTriggers({ tokens: 90_000, bytes: 0 }, budgets).level).toBe('blocking');
    expect(evaluateTriggers({ tokens: 0, bytes: 900_000 }, budgets).level).toBe('blocking');
    // Both axes below their blocking ratio but one above background stays background.
    expect(evaluateTriggers({ tokens: 80_000, bytes: 850_000 }, budgets).level).toBe('background');
  });

  it('uses the default ratios 0.75 / 0.90', () => {
    expect(DEFAULT_BACKGROUND_THRESHOLD_RATIO).toBe(0.75);
    expect(DEFAULT_BLOCKING_THRESHOLD_RATIO).toBe(0.9);
    const evaluation = evaluateTriggers({ tokens: 90_000 }, { tokenBudget: 100_000 });
    expect(evaluation.level).toBe('blocking');
  });

  it('rejects inverted thresholds', () => {
    expect(() =>
      evaluateTriggers({ tokens: 1 }, { tokenBudget: 10, backgroundThresholdRatio: 0.95, blockingThresholdRatio: 0.9 }),
    ).toThrow(RangeError);
  });
});

describe('resolveKeepRecentTokens (the ≤90% clamp)', () => {
  it('keeps the requested value when it already fits the budget', () => {
    expect(resolveKeepRecentTokens(20_000, 100_000)).toBe(20_000);
    expect(DEFAULT_KEEP_RECENT_TOKENS).toBe(20_000);
  });

  it('clamps so kept tail + summary headroom stays within 90% of the budget', () => {
    // 90% of 5000 = 4500; minus the 2048-token summary headroom -> 2452.
    expect(resolveKeepRecentTokens(20_000, 5_000)).toBe(2_452);
  });

  it('never returns a negative limit for tiny budgets', () => {
    expect(resolveKeepRecentTokens(20_000, 1_000)).toBeGreaterThanOrEqual(0);
    expect(resolveKeepRecentTokens(20_000, 1)).toBe(0);
  });
});

describe('estimateProjectedContextTokens (stale-anchor invalidation)', () => {
  it('matches the plain estimate while no checkpoint or omission is newer than the anchor', () => {
    const entries: LogEntry[] = [
      messageEntry(userMessage(filler(4_000))),
      messageEntry(assistantMessage('anchored', { totalTokens: 50_000 })),
      messageEntry(userMessage(filler(2_000))),
    ];
    const projected = projectContext(entries);
    expect(estimateProjectedContextTokens(entries)).toEqual(estimateContextTokens(projected.messages));
    expect(estimateProjectedContextTokens(entries).tokens).toBe(50_500);
  });

  it('does not trust a usage anchor behind a checkpoint: measures the short window honestly', async () => {
    // The regression from review: without invalidation the ~4k-token window
    // after the checkpoint reported the stale 92k anchor and re-fired the
    // 75%/90% triggers forever.
    const entries: LogEntry[] = [
      messageEntry(userMessage(filler(16_000))), // 4000 tokens
      messageEntry(assistantMessage('a0')),
      messageEntry(userMessage(filler(16_000))), // 4000 tokens
      messageEntry(assistantMessage('a1')),
      messageEntry(userMessage('q2')),
      messageEntry(assistantMessage('ok', { totalTokens: 92_000 })),
    ];
    const outcome = await compact({ entries, summarizer: async () => 'S', keepRecentTokens: 2_000 });
    expect(outcome).not.toBeNull();
    const log: LogEntry[] = [...entries, stamp(outcome!.draft, 7, 6)];

    const projected = projectContext(log);
    const staleAnchorEstimate = estimateContextTokens(projected.messages).tokens;
    expect(staleAnchorEstimate).toBeGreaterThan(90_000); // the raw anchor lies
    expect(estimateProjectedContextTokens(log).tokens).toBeLessThan(10_000);
    // The honest number equals the pure projection estimate plus system.
    const pure = projected.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    expect(estimateProjectedContextTokens(log).tokens).toBe(pure);
  });

  it('a context_edit omission after the anchor invalidates it too', () => {
    const ghost = messageEntry(userMessage('ghost turn'));
    const anchored = messageEntry(assistantMessage('anchored', { totalTokens: 77_000 }));
    const entries: LogEntry[] = [
      ghost,
      anchored,
      stamp(createOmissionEntryDraft('omit-1', [ghost.id], 'retracted attempt'), 3, 2),
    ];
    const projected = projectContext(entries);
    expect(projected.messages.map((m) => m.role)).toEqual(['assistant']);
    expect(estimateProjectedContextTokens(entries).tokens).toBe(2); // 'anchored' -> 2 tokens
  });

  it('the pure path includes the frozen system message (pi fallback convention)', () => {
    const entries: LogEntry[] = [
      { id: 'sys', kind: 'mcode.system', payload: { text: filler(400) }, seq: 1 as LogEntry['seq'], ordinal: 0 },
      messageEntry(userMessage(filler(400))),
    ];
    // No anchor at all -> pure path -> system tokens (100) added.
    const estimate = estimateProjectedContextTokens(entries);
    expect(estimate.usageAnchorIndex).toBeNull();
    expect(estimate.tokens).toBe(200);
  });

  it('an unused checkpoint draft validates and keeps ids parseable', () => {
    const draft = createCompactionEntryDraft('cp-x', {
      summary: 's',
      firstKeptEntryId: 'e1',
      systemMessage: null,
      isSplitTurn: false,
      tokensBefore: 1,
      estimatedTokensAfter: 1,
      createdAtMs: 0,
    });
    expect(draft.kind).toBe('mcode.compaction');
  });
});
