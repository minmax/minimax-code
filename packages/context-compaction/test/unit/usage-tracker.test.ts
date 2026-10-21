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
  estimateMessageTokens,
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

/** Audit bookkeeping; `evil` embeds a compaction-shaped payload no kind-aware consumer may mistake for a checkpoint. */
function auditEntry(evil = false): LogEntry {
  auditCounter += 1;
  return {
    id: `audit-${auditCounter}`,
    parentId: null,
    // Exactly the bookkeeping kinds that never reach the payload — the
    // finding's scenario had 49.5% of raw-log bytes in these.
    kind: 'mcode.owner-input.received',
    payload: evil
      ? { summary: `evil ${auditCounter}`, firstKeptEntryId: 'm1', systemMessage: `EVIL ${auditCounter}` }
      : { received: 'x'.repeat(400), at: auditCounter },
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

function checkpointEntry(index: number, keptId: string, systemMessage: string | null, seq: number): LogEntry {
  return {
    id: `compaction-${index}`,
    parentId: null,
    kind: 'mcode.compaction',
    payload: {
      summary: `summary ${index} ${'y'.repeat(60)}`,
      firstKeptEntryId: keptId,
      systemMessage,
      isSplitTurn: false,
      tokensBefore: 1000,
      estimatedTokensAfter: 500,
      createdAtMs: 1,
    },
    seq,
    ordinal: 0,
  };
}

/** Streams a random mixed history; yields the prefix after every append. */
function* mixedStream(seed: number, length: number): Generator<LogEntry[]> {
  const lcg = makeLcg(seed);
  const log: LogEntry[] = [];
  const liveIds = (): string[] => log.filter((entry) => entry.kind === 'mcode.message').map((entry) => entry.id);
  // Ids currently hidden by context_edit omissions (to find VISIBLE checkpoints).
  const omittedIds = (): Set<string> => {
    const omitted = new Set<string>();
    for (const entry of log) {
      if (entry.kind !== 'mcode.context_edit') continue;
      const payload = entry.payload as { action?: unknown; targetIds?: unknown };
      if (payload.action !== 'omission' || !Array.isArray(payload.targetIds)) continue;
      for (const id of payload.targetIds) if (typeof id === 'string') omitted.add(id);
    }
    return omitted;
  };
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
      // Sometimes compaction-shaped: only a KIND-aware resync may ignore it.
      log.push(auditEntry(lcg() < 0.3));
    } else if (roll < 0.75) {
      log.push(systemEntry(`system prompt ${i} ${'s'.repeat(40)}`));
    } else if (roll < 0.9) {
      // A checkpoint either over the CURRENT visible window (as compact()
      // would pick one) or — review round 3, medium finding — keeping the
      // PREVIOUS VISIBLE CHECKPOINT itself (cp2 with firstKeptEntryId = cp1):
      // the projection projects the non-winner as empty, and the incremental
      // counters used to keep its member. Checkpoints also freeze the system
      // prompt sometimes (the second medium finding): after a re-expansion
      // resync a later system entry used to override the frozen value.
      const frozen = lcg() < 0.3 ? `frozen ${i} ${'f'.repeat(40)}` : null;
      const visibleCheckpoint = [...log]
        .reverse()
        .find((entry) => entry.kind === 'mcode.compaction' && !omittedIds().has(entry.id));
      if (visibleCheckpoint !== undefined && lcg() < 0.3) {
        log.push(checkpointEntry(i, visibleCheckpoint.id, frozen, log.length + 1));
      } else {
        const live = liveIds();
        if (live.length > 2) {
          const visible = projectContext(log).entries
            .map((projected, index) => ({ projected, entry: log[index]! }))
            .filter(({ projected }) => projected.contextMessages.length > 0 && !projected.isCompaction);
          if (visible.length > 2) {
            const kept = visible[Math.floor(lcg() * visible.length)]!.entry;
            log.push(checkpointEntry(i, kept.id, frozen, log.length + 1));
          }
        }
      }
    } else {
      const live = liveIds();
      const lastCheckpoint = [...log].reverse().find((entry) => entry.kind === 'mcode.compaction');
      if (lcg() < 0.4 && lastCheckpoint !== undefined) {
        // Retract the newest checkpoint: the projection re-expands to raw
        // history — the counters hit the slow re-sync path.
        log.push(omissionEntry([lastCheckpoint.id]));
      } else if (live.length > 2) {
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
        // NaN would silently disable the token trigger (evaluateTriggers
        // answers `none` on NaN) — both counters must stay finite on EVERY
        // prefix, resync or not.
        expect(Number.isFinite(fast.tokens)).toBe(true);
        expect(Number.isFinite(fast.bytes)).toBe(true);
        steps += 1;
      }
      expect(steps).toBe(60);
    });
  }

  it('keeps the token axis finite through EVERY resync scenario', () => {
    const message = (id: string, text: string): LogEntry => ({
      id,
      parentId: null,
      kind: 'mcode.message',
      payload: { role: 'user', content: text },
      seq: 0,
      ordinal: 0,
    });
    const checkpoint = (id: string, kept: string, summary: string): LogEntry => ({
      id,
      parentId: null,
      kind: 'mcode.compaction',
      payload: {
        summary,
        firstKeptEntryId: kept,
        systemMessage: null,
        isSplitTurn: false,
        tokensBefore: 1000,
        estimatedTokensAfter: 100,
        createdAtMs: 1,
      },
      seq: 0,
      ordinal: 0,
    });

    const scenarios: readonly LogEntry[][][] = [
      // Shrunk log (never legal) resyncs with a LIVE winning checkpoint.
      [[message('a', 'x'.repeat(400)), message('b', 'y'.repeat(400)), checkpoint('cp', 'b', 'S'.repeat(40))],
        [message('a', 'x'.repeat(400)), checkpoint('cp', 'a', 'S'.repeat(40))]],
      // Re-expansion: the second checkpoint's firstKept fell out of the window.
      [[message('a', 'x'.repeat(400)), message('b', 'y'.repeat(400)), checkpoint('cp1', 'b', 'first'), checkpoint('cp2', 'a', 'second')]],
      // System-source retraction resync.
      [[{ id: 'sys', parentId: null, kind: 'mcode.system', payload: { text: 's'.repeat(40) }, seq: 0, ordinal: 0 },
        message('a', 'x'.repeat(400)),
        { id: 'edit', parentId: null, kind: 'mcode.context_edit', payload: { action: 'omission', targetIds: ['sys'], reason: 'r' }, seq: 0, ordinal: 0 }]],
    ];

    for (const prefixes of scenarios) {
      const tracker = new WindowUsageTracker();
      for (const prefix of prefixes) {
        tracker.ingest(prefix);
        const usage = tracker.usage();
        // The defect: resync memoized the checkpoint member's tokens as
        // estimateMessageTokens(raw checkpoint payload) — no `role` field,
        // `undefined`, windowTokens poisoned into NaN, evaluateTriggers
        // answering `none` forever.
        expect(Number.isFinite(usage.tokens)).toBe(true);
        expect(Number.isFinite(usage.bytes)).toBe(true);
        expect(usage.tokens).toBe(estimateProjectedContextTokens(prefix).tokens);
        expect(usage.bytes).toBe(windowManifestBytes(prefix));
      }
    }
  });

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

describe('review round 3 regressions', () => {
  const message = (id: string, text: string): LogEntry => ({
    id,
    parentId: null,
    kind: 'mcode.message',
    payload: { role: 'user', content: text },
    seq: 0,
    ordinal: 0,
  });
  const checkpoint = (id: string, kept: string, summary: string, systemMessage: string | null = null): LogEntry => ({
    id,
    parentId: null,
    kind: 'mcode.compaction',
    payload: {
      summary,
      firstKeptEntryId: kept,
      systemMessage,
      isSplitTurn: false,
      tokensBefore: 1000,
      estimatedTokensAfter: 100,
      createdAtMs: 1,
    },
    seq: 0,
    ordinal: 0,
  });
  const system = (id: string, text: string): LogEntry => ({
    id,
    parentId: null,
    kind: 'mcode.system',
    payload: { text },
    seq: 0,
    ordinal: 0,
  });
  const omission = (id: string, targetIds: string[]): LogEntry => ({
    id,
    parentId: null,
    kind: 'mcode.context_edit',
    payload: { action: 'omission', targetIds, reason: 'r' },
    seq: 0,
    ordinal: 0,
  });

  function assertTracksSlow(prefixes: readonly LogEntry[][]): void {
    const tracker = new WindowUsageTracker();
    for (const prefix of prefixes) {
      tracker.ingest(prefix);
      const usage = tracker.usage();
      expect(usage.tokens).toBe(estimateProjectedContextTokens(prefix).tokens);
      expect(usage.bytes).toBe(windowManifestBytes(prefix));
      expect(Number.isFinite(usage.tokens)).toBe(true);
    }
  }

  it('a checkpoint keeping the previous checkpoint: the non-winner leaves the window', () => {
    // Review medium finding 1: cp2 with firstKeptEntryId = cp1 keeps cp1's
    // summary member in the incremental window, while the projection projects
    // the non-winning checkpoint as EMPTY — the counters silently diverged
    // (probe: fast={tokens:104,bytes:714} vs slow={tokens:2,bytes:144}).
    const log: LogEntry[] = [
      message('m1', 'x'.repeat(400)),
      message('m2', 'y'.repeat(400)),
      checkpoint('cp1', 'm2', 'S1'.repeat(20)),
      checkpoint('cp2', 'cp1', 'S2'.repeat(20)),
    ];
    // Every prefix must match, the last one exactly: only cp2's summary is
    // the window, cp1's member is gone.
    assertTracksSlow(log.map((_, end) => log.slice(0, end + 1)));
    const tracker = new WindowUsageTracker();
    tracker.ingest(log);
    const slow = projectContext(log);
    const summaryMessages = slow.messages.filter((m) => m.role === 'user' && typeof m.content === 'string');
    expect(summaryMessages).toHaveLength(1);
    expect(tracker.usage().tokens).toBe(estimateMessageTokens(summaryMessages[0]!));
  });

  it('the frozen system prompt survives a re-expansion resync and later system entries', () => {
    // Review medium finding 2: frozen-cp1 → re-expansion resync (cp2 keeps an
    // entry already summarized away) → retraction of cp2 → NEW system entry.
    // resync used to reset systemFrozen unconditionally, so the new system
    // entry overrode systemText while the projection kept the frozen value.
    const log: LogEntry[] = [
      system('sys1', 's'.repeat(40)),
      message('m0', 'w'.repeat(400)),
      message('m1', 'x'.repeat(400)),
      checkpoint('cp1', 'm1', 'S1'.repeat(20), 'FROZEN-PROMPT'),
      // m0 is behind cp1: outside the tracker window -> resync on ingest.
      checkpoint('cp2', 'm0', 'S2'.repeat(20)),
      omission('edit1', ['cp2']),
      // Post-resync system entry: must NOT override the frozen prompt.
      system('sys2', 't'.repeat(40)),
    ];
    assertTracksSlow(log.map((_, end) => log.slice(0, end + 1)));
    // And the final system text is the FROZEN one, on both sides.
    expect(projectContext(log).systemMessage).toBe('FROZEN-PROMPT');
  });

  it('a frozen checkpoint also wins in the pure incremental path (no resync)', () => {
    const log: LogEntry[] = [
      system('sys1', 's'.repeat(40)),
      message('m1', 'x'.repeat(400)),
      checkpoint('cp1', 'm1', 'S1'.repeat(20), 'FROZEN-PROMPT'),
      system('sys2', 't'.repeat(40)),
    ];
    assertTracksSlow(log.map((_, end) => log.slice(0, end + 1)));
  });

  it('the resync frozen rule only trusts mcode.compaction KIND, not payload shape', () => {
    // Review round 4: the resync winner loop parsed payloads without a kind
    // check, so audit bookkeeping carrying a coincidentally compaction-shaped
    // payload ({summary, firstKeptEntryId, systemMessage: 'EVIL-FREEZE'})
    // froze the tracker on a system prompt the projection never applies; the
    // probe diverged at fast={tokens:200,bytes:856} vs slow={tokens:210,bytes:907}.
    const fake: LogEntry = {
      id: 'fake',
      parentId: null,
      kind: 'mcode.owner-input.received',
      payload: { summary: 'x', firstKeptEntryId: 'm1', systemMessage: 'EVIL-FREEZE' },
      seq: 0,
      ordinal: 0,
    };
    const log: LogEntry[] = [
      system('sys1', 's'.repeat(40)),
      message('m1', 'x'.repeat(400)),
      message('m2', 'y'.repeat(400)),
      fake,
      // Retracting the system source forces the resync whose winner loop used
      // to trip over the fake payload.
      omission('edit1', ['sys1']),
      system('sys2', 't'.repeat(40)),
    ];
    assertTracksSlow(log.map((_, end) => log.slice(0, end + 1)));
    // The projection's truth: no real checkpoint, sys1 retracted -> sys2 wins.
    // With the bug, the tracker froze on EVIL-FREEZE after the resync and
    // ignored sys2, so the last prefix diverged on both axes.
    expect(projectContext(log).systemMessage).toBe('t'.repeat(40));
  });

  it('a malformed message payload counts nothing and stays finite', () => {
    // Review low finding: a role-less `mcode.message` payload ran the
    // estimator off its exhaustive switch -> NaN -> token trigger dead.
    const bad: LogEntry = { id: 'bad', parentId: null, kind: 'mcode.message', payload: { broken: true }, seq: 0, ordinal: 0 };
    const log: LogEntry[] = [message('m1', 'x'.repeat(400)), bad, message('m2', 'y'.repeat(400))];
    assertTracksSlow(log.map((_, end) => log.slice(0, end + 1)));
    // The projection skips it too — dead weight, identically on both sides.
    const projected = projectContext(log);
    expect(projected.messages).toHaveLength(2);
    expect(projected.entries[1]!.contextMessages).toHaveLength(0);
  });

  it('memoized measurements are pruned to the live window', () => {
    // Review low finding: token/byte memos grew O(log) forever.
    const tracker = new WindowUsageTracker();
    const entries: LogEntry[] = [];
    for (let i = 0; i < 200; i += 1) entries.push(message(`m${i}`, 'x'.repeat(400)));
    entries.push(checkpoint('cp', 'm198', 'S'.repeat(40)));
    tracker.ingest(entries);
    const windowMembers = projectContext(entries).entries.filter((entry) => entry.contextMessages.length > 0).length;
    // Each live member memoizes at most one token estimate and one byte size;
    // everything summarized away is dropped.
    expect(tracker.memoSize).toBeLessThanOrEqual(2 * windowMembers);
    // And it stays bounded as the session continues.
    for (let i = 200; i < 260; i += 1) tracker.ingest([...entries, message(`n${i}`, 'y'.repeat(400))]);
    const grown = [...entries, ...Array.from({ length: 60 }, (_, i) => message(`n${200 + i}`, 'y'.repeat(400)))];
    tracker.ingest(grown);
    const membersNow = projectContext(grown).entries.filter((entry) => entry.contextMessages.length > 0).length;
    expect(tracker.memoSize).toBeLessThanOrEqual(2 * membersNow);
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
