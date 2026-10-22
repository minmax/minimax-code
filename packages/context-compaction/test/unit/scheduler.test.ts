/**
 * Scheduler and writer-gate tests: the 75% background / 90% blocking levels,
 * the background job never holding the writer during its summarizer call,
 * and P0–P4 priority ordering of the gate.
 */

import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_COMPACTION_PRIORITY,
  COMPACTION_ENTRY_KIND,
  createBackgroundCompactionScheduler,
  createWriterGate,
  estimateContextTokens,
  projectContext,
} from '../../src/index.js';
import type { LogEntry } from '../../src/index.js';
import { MemoryLog, RecordingSummarizer, assistantMessage, filler, messageEntry, toolResultMessage, userMessage } from './helpers.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Window of ~`tokens` tokens anchored by a usage record. */
function windowAtTokens(tokens: number): LogEntry[] {
  return [
    messageEntry(userMessage('question')),
    messageEntry(assistantMessage(filler(tokens * 4), { totalTokens: tokens })),
  ];
}

function createScheduler(
  entries: LogEntry[],
  summarizer: RecordingSummarizer,
  overrides: { tokenBudget?: number; byteBudget?: number; gate?: ReturnType<typeof createWriterGate> } = {},
) {
  const log = new MemoryLog();
  log.entries.push(...entries);
  const scheduler = createBackgroundCompactionScheduler({
    budgets: {
      tokenBudget: overrides.tokenBudget ?? 100_000,
      ...(overrides.byteBudget === undefined ? {} : { byteBudget: overrides.byteBudget }),
    },
    session: {
      entries: log.entries,
      append: async (drafts) => {
        await log.append(drafts);
      },
    },
    summarizer: summarizer.call,
    ...(overrides.gate === undefined ? {} : { gate: overrides.gate }),
  });
  return { scheduler, log };
}

describe('writer gate priorities', () => {
  it('grants waiters by priority: P0 before P4, FIFO within a priority', async () => {
    const gate = createWriterGate();
    const order: string[] = [];
    const release = await gate.acquire(2);
    expect(gate.held).toBe(true);

    const p4 = gate.acquire(4).then((r) => {
      order.push('P4');
      return r;
    });
    const p0 = gate.acquire(0).then((r) => {
      order.push('P0');
      return r;
    });
    const p0b = gate.acquire(0).then((r) => {
      order.push('P0b');
      return r;
    });
    await Promise.resolve(); // let the waiters register
    expect(gate.waiting).toEqual([2, 0, 0, 0, 1]);

    release();
    await p0.then((r) => r());
    await p0b.then((r) => r());
    await p4.then((r) => r());
    expect(order).toEqual(['P0', 'P0b', 'P4']);
    expect(gate.held).toBe(false);
  });

  it('withGate releases even when the body throws', async () => {
    const gate = createWriterGate();
    await expect(
      gate.withGate(1, async () => {
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    expect(gate.held).toBe(false);
    const release = await gate.acquire(1);
    release();
  });

  it('a double release grants exactly one waiter — mutual exclusion holds', async () => {
    const gate = createWriterGate();
    const release = await gate.acquire(1);
    let granted = 0;
    let w1Release: (() => void) | undefined;
    let w2Release: (() => void) | undefined;
    const w1 = gate.acquire(2).then((r) => {
      granted += 1;
      w1Release = r;
    });
    const w2 = gate.acquire(2).then((r) => {
      granted += 1;
      w2Release = r;
    });
    await Promise.resolve(); // let both waiters register

    release();
    release(); // BUG probe: a second release must be a no-op
    await w1;
    expect(granted).toBe(1); // only ONE waiter entered
    expect(gate.held).toBe(true); // the gate is still held by w1

    w1Release!();
    await w2;
    expect(granted).toBe(2);
    // The second waiter holds the writer until IT releases.
    expect(gate.held).toBe(true);
    w2Release!();
    expect(gate.held).toBe(false);
  });
});

describe('BackgroundCompactionScheduler triggers', () => {
  it('does nothing below the background threshold', () => {
    const summarizer = new RecordingSummarizer('S');
    const { scheduler } = createScheduler(windowAtTokens(74_000), summarizer, { tokenBudget: 100_000 });
    const notification = scheduler.notify();
    expect(notification.level).toBe('none');
    expect(notification.started).toBe(false);
    expect(notification.job).toBeNull();
    expect(summarizer.callCount).toBe(0);
  });

  it('starts a background job at 75% that the caller may drop', async () => {
    const summarizer = new RecordingSummarizer('S');
    const { scheduler, log } = createScheduler(windowAtTokens(75_000), summarizer, { tokenBudget: 100_000 });
    const notification = scheduler.notify();
    expect(notification.level).toBe('background');
    expect(notification.started).toBe(true);
    // Fire and forget is safe: the job promise never becomes unhandled.
    const outcome = await notification.job;
    expect(outcome).not.toBeNull();
    expect(summarizer.callCount).toBe(1);
    expect(log.entries.at(-1)!.kind).toBe(COMPACTION_ENTRY_KIND);
  });

  it('deduplicates: a second notification joins the in-flight job', async () => {
    const summarizer = new RecordingSummarizer('S');
    const gate = createWriterGate();
    const { scheduler } = createScheduler(windowAtTokens(76_000), summarizer, { tokenBudget: 100_000, gate });

    const release = await gate.acquire(0); // keep the first job from finishing its append
    const first = scheduler.notify();
    expect(first.started).toBe(true);
    const second = scheduler.notify();
    expect(second.started).toBe(false);
    expect(second.job).toBe(first.job);

    release();
    await first.job;
    await second.job;
  });

  it('reports the blocking level at 90% and the caller awaits the job', async () => {
    const summarizer = new RecordingSummarizer('S');
    const { scheduler } = createScheduler(windowAtTokens(91_000), summarizer, { tokenBudget: 100_000 });
    const notification = scheduler.notify();
    expect(notification.level).toBe('blocking');
    const outcome = await notification.job;
    expect(outcome).not.toBeNull();
  });

  it('byte axis alone triggers: huge manifest with tiny token usage', async () => {
    const summarizer = new RecordingSummarizer('S');
    // ~40k tokens across 200 entries: the byte budget trips in the 75–90%
    // band long before the token budget (100M), and the window still has
    // enough content for a real summary.
    const bigText = 'x'.repeat(800);
    const entries: LogEntry[] = Array.from({ length: 200 }, (_, i) => messageEntry(userMessage(`${bigText} ${i}`)));
    const { scheduler } = createScheduler(entries, summarizer, { tokenBudget: 100_000_000, byteBudget: 220_000 });
    const notification = scheduler.notify();
    expect(notification.level).toBe('background');
    expect(notification.evaluation.reasons[0]).toMatchObject({ axis: 'bytes' });
    await notification.job;
    expect(summarizer.callCount).toBe(1);
  });

  // Regression (wave-2 review): runBlocking used to await the in-flight
  // background job and then start a SECOND pass — re-summarizing the window
  // the background checkpoint had just cut (a wasted model call on the 90%
  // path). The joined checkpoint itself is the blocking compaction.
  it('runBlocking joins an in-flight background checkpoint without a second pass', async () => {
    const summarizer = new RecordingSummarizer('S');
    let release!: () => void;
    const summarizerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let summarizerCalls = 0;
    const gated = async (prompt: string): Promise<string> => {
      summarizerCalls += 1;
      await summarizerGate;
      return summarizer.call(prompt);
    };

    const log = new MemoryLog();
    log.entries.push(...windowAtTokens(30_000));
    // 30k of a 40k budget = 75%: the background trigger fires and the job
    // reaches the summarizer call synchronously within notify().
    const scheduler = createBackgroundCompactionScheduler({
      budgets: { tokenBudget: 40_000 },
      session: {
        entries: log.entries,
        append: async (drafts) => {
          await log.append(drafts);
        },
      },
      summarizer: gated,
    });

    // A background job is in flight when the blocking request arrives; the
    // gate makes that deterministic (notify() reaches the summarizer call
    // synchronously).
    const notification = scheduler.notify();
    expect(summarizerCalls).toBe(1);
    const blocking = scheduler.runBlocking();
    release();
    const joined = await blocking;
    const backgroundOutcome = await notification.job;

    expect(joined).not.toBeNull();
    expect(joined).toBe(backgroundOutcome);
    expect(summarizerCalls).toBe(1); // no duplicate pass
    expect(log.entries.filter((entry) => entry.kind === COMPACTION_ENTRY_KIND)).toHaveLength(1);
  });

  it('runBlocking compacts immediately regardless of the triggers', async () => {
    const summarizer = new RecordingSummarizer('S');
    // 30k anchored tokens: below every trigger, big enough to summarize.
    const { scheduler, log } = createScheduler(windowAtTokens(30_000), summarizer, { tokenBudget: 100_000 });
    const outcome = await scheduler.runBlocking();
    expect(outcome).not.toBeNull();
    expect(summarizer.callCount).toBe(1);
    expect(log.entries.at(-1)!.kind).toBe(COMPACTION_ENTRY_KIND);
  });

  it('resolves the job with null when the projected window has nothing to summarize', async () => {
    const summarizer = new RecordingSummarizer('S');
    // 80% trigger from the anchor, but the visible window is three tokens:
    // nothing to summarize, the job resolves null instead of writing an
    // empty checkpoint.
    const entries: LogEntry[] = [
      messageEntry(userMessage('tiny')),
      messageEntry(assistantMessage('x', { totalTokens: 80_000 })),
    ];
    const { scheduler } = createScheduler(entries, summarizer, { tokenBudget: 100_000 });
    const notification = scheduler.notify();
    expect(notification.level).toBe('background');
    const outcome = await notification.job;
    expect(outcome).toBeNull();
    expect(summarizer.callCount).toBe(0);
  });
});

describe('BackgroundCompactionScheduler writer discipline', () => {
  it('never holds the writer during the summarizer call; urgent commits sail through', async () => {
    const summarizer = new RecordingSummarizer('S');
    const gate = createWriterGate();

    const summarizerStarted = deferred();
    const finishSummarizer = deferred();
    let gateHeldDuringSummarize: boolean | undefined;
    const slowSummarizer = async (prompt: string): Promise<string> => {
      gateHeldDuringSummarize = gate.held; // MUST be false: no writer held while summarizing
      summarizerStarted.resolve();
      await finishSummarizer.promise;
      return summarizer.call(prompt);
    };

    const log = new MemoryLog();
    log.entries.push(...windowAtTokens(80_000));
    const scheduler = createBackgroundCompactionScheduler({
      budgets: { tokenBudget: 100_000 },
      session: {
        entries: log.entries,
        append: async (drafts) => {
          await log.append(drafts);
        },
      },
      summarizer: slowSummarizer,
      gate,
    });

    const notification = scheduler.notify();
    expect(notification.level).toBe('background');

    // While the summarizer runs, the writer is free and an urgent commit lands.
    await summarizerStarted.promise;
    expect(gateHeldDuringSummarize).toBe(false);
    await gate.withGate(0, async () => {
      log.entries.push(messageEntry(userMessage('urgent commit')));
    });

    // Let the job finish: append takes the gate itself and completes after.
    finishSummarizer.resolve();
    const outcome = await notification.job;
    expect(outcome).not.toBeNull();
    expect(log.entries.at(-1)!.kind).toBe(COMPACTION_ENTRY_KIND);
    expect(gate.held).toBe(false);
  });

  it('an urgent waiter queued while the background append holds the gate goes first on release', async () => {
    const gate = createWriterGate();
    const order: string[] = [];
    let urgent: Promise<void>;
    let anotherBackground: Promise<void>;
    // The background append holds the gate while the urgent commit and a
    // second background append queue up; on release, P0 must go before P4.
    await gate.withGate(BACKGROUND_COMPACTION_PRIORITY, async () => {
      urgent = gate.withGate(0, async () => {
        order.push('urgent');
      });
      anotherBackground = gate.withGate(4, async () => {
        order.push('background-late');
      });
      order.push('background-append');
    });
    await urgent!;
    await anotherBackground!;
    expect(order).toEqual(['background-append', 'urgent', 'background-late']);
  });

  it('usage() reflects the projected window, not the raw log size', () => {
    const summarizer = new RecordingSummarizer('S');
    const entries = windowAtTokens(80_000);
    const { scheduler } = createScheduler(entries, summarizer, { tokenBudget: 100_000 });
    const usage = scheduler.usage();
    const projected = projectContext(entries);
    expect(usage.tokens).toBe(estimateContextTokens(projected.messages).tokens);
    expect(usage.tokens).toBe(80_000);
  });

  it('after a checkpoint the stale usage anchor does not re-fire the triggers', async () => {
    const summarizer = new RecordingSummarizer('S');
    // Anchor says 92k while the post-checkpoint window is ~8.8k tokens (one
    // unsplittable trailing tool result): the review probe showed the stale
    // anchor keeping the scheduler at ~100k of a 12k budget forever.
    const entries: LogEntry[] = [
      messageEntry(userMessage(filler(16_000))), // 4000 tokens
      messageEntry(assistantMessage('a0')),
      messageEntry(userMessage('q')),
      messageEntry(assistantMessage('running', { totalTokens: 92_000 })),
      messageEntry(toolResultMessage(filler(35_200), 'c1')), // 8800 tokens, never a cut point
    ];
    const { scheduler, log } = createScheduler(entries, summarizer, { tokenBudget: 12_000 });
    expect(scheduler.usage().tokens).toBe(100_800); // stale-anchor driven before compaction

    await scheduler.runBlocking();
    expect(log.entries.at(-1)!.kind).toBe(COMPACTION_ENTRY_KIND);

    const usageAfter = scheduler.usage();
    expect(usageAfter.tokens).toBeLessThan(10_000); // honest window, no stale anchor
    expect(scheduler.evaluate().level).toBe('none'); // triggers went quiet
  });
});
