/**
 * WindowUsageTracker property tests (wave-2 review, correctness findings 1+2):
 *
 * - the byte axis counts the PROJECTED WINDOW, not the raw append-only log:
 *   audit/control bookkeeping contributes nothing and a checkpoint RESETS the
 *   axis to its kept tail;
 * - the incremental counters equal the slow reference after EVERY ingest
 *   prefix of randomized mixed streams (messages with usage anchors, systems,
 *   audits, checkpoints, omissions) — `estimateProjectedContextTokens().tokens`
 *   and `windowManifestBytes()`;
 * - a compaction whose firstKeptEntryId fell out of the window re-expands
 *   through one slow re-sync instead of miscounting.
 */

import { describe, expect, it } from 'vitest';

import {
  WindowUsageTracker,
  createBackgroundCompactionScheduler,
  estimateProjectedContextTokens,
  projectContext,
  windowManifestBytes,
} from '../../src/index.js';
import type { LogEntry } from '../../src/index.js';
import { MemoryLog, RecordingSummarizer, assistantMessage, filler, messageEntry, toolResultMessage, userMessage } from './helpers.js';

/** Deterministic LCG in [0, 1). */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

let auditCounter = 0;

function auditEntry(): LogEntry {
  auditCounter += 1;
  return {
    id: `audit-${auditCounter}`,
    parentId: null,
    // Exactly the bookkeeping kinds that never reach the payload — the
    // finding's scenario had 49.5% of raw-log bytes in these.
    kind: 'mcode.owner-input.received',
    payload: { received: 'x'.repeat(400), at: auditCounter },
    seq: auditCounter,
    ordinal: 0,
  };
}

function systemEntry(text: string): LogEntry {
  auditCounter += 1;
  return { id: `system-${auditCounter}`, parentId: null, kind: 'mcode.system', payload: { text }, seq: auditCounter, ordinal: 0 };
}

function omissionEntry(targetIds: string[]): LogEntry {
  auditCounter += 1;
  return {
    id: `edit-${auditCounter}`,
    parentId: null,
    kind: 'mcode.context_edit',
    payload: { action: 'omission', targetIds, reason: 'test retraction', createdAtMs: 1 },
    seq: auditCounter,
    ordinal: 0,
  };
}

/** Streams a random mixed history; yields the prefix after every append. */
function* mixedStream(seed: number, length: number): Generator<LogEntry[]> {
  const lcg = makeLcg(seed);
  const log: LogEntry[] = [];
  const liveIds = (): string[] => log.filter((entry) => entry.kind === 'mcode.message').map((entry) => entry.id);
  for (let i = 0; i < length; i += 1) {
    const roll = lcg();
    if (roll < 0.5) {
      const tokens = 1 + Math.floor(lcg() * 200);
      log.push(
        messageEntry(
          lcg() < 0.4
            ? assistantMessage(filler(tokens * 4), { totalTokens: tokens })
            : userMessage(filler(tokens * 4)),
        ),
      );
    } else if (roll < 0.65) {
      log.push(auditEntry());
    } else if (roll < 0.75) {
      log.push(systemEntry(`system prompt ${i} ${'s'.repeat(40)}`));
    } else if (roll < 0.9) {
      const live = liveIds();
      if (live.length > 2) {
        // A checkpoint over the CURRENT projected entries (as compact() would
        // pick one): firstKept is a live message entry of the visible window.
        const visible = projectContext(log).entries
          .map((projected, index) => ({ projected, entry: log[index]! }))
          .filter(({ projected }) => projected.contextMessages.length > 0 && !projected.isCompaction);
        if (visible.length > 2) {
          const kept = visible[Math.floor(lcg() * visible.length)]!.entry;
          log.push({
            id: `compaction-${i}`,
            parentId: null,
            kind: 'mcode.compaction',
            payload: {
              summary: `summary ${i} ${'y'.repeat(60)}`,
              firstKeptEntryId: kept.id,
              systemMessage: null,
              isSplitTurn: false,
              tokensBefore: 1000,
              estimatedTokensAfter: 500,
              createdAtMs: 1,
            },
            seq: log.length + 1,
            ordinal: 0,
          });
        }
      }
    } else {
      const live = liveIds();
      if (live.length > 2) {
        log.push(omissionEntry([live[Math.floor(lcg() * live.length)]!]));
      }
    }
    yield [...log];
  }
}

describe('WindowUsageTracker equals the slow reference on every prefix', () => {
  for (const seed of [0x1a2b3c4d, 0x0badf00d, 0x13579bdf]) {
    it(`random mixed stream (seed ${seed})`, () => {
      const tracker = new WindowUsageTracker();
      let steps = 0;
      for (const prefix of mixedStream(seed, 60)) {
        tracker.ingest(prefix);
        const fast = tracker.usage();
        const slowTokens = estimateProjectedContextTokens(prefix).tokens;
        const slowBytes = windowManifestBytes(prefix);
        expect(fast.tokens).toBe(slowTokens);
        expect(fast.bytes).toBe(slowBytes);
        steps += 1;
      }
      expect(steps).toBe(60);
    });
  }

  it('audit/control bookkeeping never enters the byte axis', () => {
    const tracker = new WindowUsageTracker();
    const message = messageEntry(userMessage(filler(400)));
    tracker.ingest([message, auditEntry(), auditEntry(), auditEntry()]);
    const usage = tracker.usage();
    // Only the message payload counts — not the three ~400-byte audit payloads.
    expect(usage.bytes).toBe(Buffer.byteLength(JSON.stringify(message.payload), 'utf8'));
  });

  it('a checkpoint resets the byte axis to the kept tail', () => {
    const tracker = new WindowUsageTracker();
    const old = messageEntry(userMessage(filler(4000)));
    const kept = messageEntry(toolResultMessage(filler(400)));
    const checkpoint = {
      id: 'cp-1',
      parentId: null,
      kind: 'mcode.compaction',
      payload: {
        summary: 'summary',
        firstKeptEntryId: kept.id,
        systemMessage: null,
        isSplitTurn: false,
        tokensBefore: 1000,
        estimatedTokensAfter: 100,
        createdAtMs: 1,
      },
      seq: 3,
      ordinal: 0,
    };
    tracker.ingest([old, kept]);
    const before = tracker.usage().bytes;
    expect(before).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(kept.payload), 'utf8'),
    );
    tracker.ingest([old, kept, checkpoint]);
    const after = tracker.usage();
    expect(after.bytes).toBe(
      Buffer.byteLength(JSON.stringify(checkpoint.payload), 'utf8') +
        Buffer.byteLength(JSON.stringify(kept.payload), 'utf8'),
    );
  });

  it('re-expands an omitted checkpoint through one slow re-sync', () => {
    const tracker = new WindowUsageTracker();
    const a = messageEntry(userMessage(filler(400)));
    const b = messageEntry(userMessage(filler(400)));
    const checkpoint = {
      id: 'cp-2',
      parentId: null,
      kind: 'mcode.compaction',
      payload: {
        summary: 'first',
        firstKeptEntryId: b.id,
        systemMessage: null,
        isSplitTurn: false,
        tokensBefore: 200,
        estimatedTokensAfter: 100,
        createdAtMs: 1,
      },
      seq: 3,
      ordinal: 0,
    };
    const omission = {
      id: 'edit-1',
      parentId: null,
      kind: 'mcode.context_edit',
      payload: { action: 'omission', targetIds: [checkpoint.id], reason: 'retract the checkpoint' },
      seq: 4,
      ordinal: 0,
    };
    // The omission RETRACTS the checkpoint: the projection falls back to the
    // full raw history — entries the tracker had already cut come back.
    const prefixes: LogEntry[][] = [[a], [a, b], [a, b, checkpoint], [a, b, checkpoint, omission]];
    for (const prefix of prefixes) {
      tracker.ingest(prefix);
      expect(tracker.usage().tokens).toBe(estimateProjectedContextTokens(prefix).tokens);
      expect(tracker.usage().bytes).toBe(windowManifestBytes(prefix));
    }
  });

  it('a shrunk log re-syncs instead of miscounting', () => {
    const tracker = new WindowUsageTracker();
    tracker.ingest([messageEntry(userMessage(filler(400))), auditEntry()]);
    // A shorter array than already consumed (never legal for the live log)
    // must re-sync from scratch, not keep the stale counters.
    const replacement: LogEntry[] = [messageEntry(userMessage(filler(800)))];
    tracker.ingest(replacement);
    expect(tracker.usage().tokens).toBe(estimateProjectedContextTokens(replacement).tokens);
    expect(tracker.usage().bytes).toBe(windowManifestBytes(replacement));
  });
});

describe('scheduler byte axis resets after a byte-triggered compaction', () => {
  // The review's runtime repro: after a byte-triggered compaction, the next
  // notify() with NO new entries must not re-fire blocking forever.
  it('notify() goes quiet after the checkpoint instead of re-firing blocking', async () => {
    const summarizer = new RecordingSummarizer('S');
    const log = new MemoryLog();
    // ~220 KB of raw payload, half of it audit bookkeeping: the old raw-log
    // axis crossed any budget and never came back down.
    const entries: LogEntry[] = [];
    for (let i = 0; i < 40; i += 1) {
      entries.push(messageEntry(userMessage(`${'x'.repeat(2600)} ${i}`)));
      entries.push(auditEntry());
    }
    log.entries.push(...entries);
    const byteBudget = 130_000;
    const scheduler = createBackgroundCompactionScheduler({
      budgets: { tokenBudget: 1_000_000_000, byteBudget },
      session: { entries: log.entries, append: async (drafts) => { await log.append(drafts); } },
      summarizer: summarizer.call,
    });

    const first = scheduler.notify();
    expect(first.evaluation.reasons.map((reason) => reason.axis)).toContain('bytes');
    expect(first.started).toBe(true);
    const outcome = await first.job;
    expect(outcome).not.toBeNull();
    expect(log.entries.at(-1)!.kind).toBe('mcode.compaction');

    // The axis now measures the window: below every threshold, with no new
    // entries at all.
    const usageAfter = scheduler.usage();
    expect(usageAfter.bytes).toBe(windowManifestBytes(log.entries));
    expect(usageAfter.bytes).toBeLessThan(byteBudget * 0.75);
    const second = scheduler.notify();
    expect(second.level).toBe('none');
    expect(second.started).toBe(false);
    expect(second.job).toBeNull();
    // And it stays quiet.
    const third = scheduler.notify();
    expect(third.level).toBe('none');
  });
});
