/**
 * Cut-point invariant tests: a cut NEVER lands on a tool result, the kept
 * tail approximates keepRecentTokens (default 20000), and split-turn
 * detection drives the cut to the turn start.
 */

import { describe, expect, it } from 'vitest';

import { estimateMessageTokens, findCutPoint, isCutPointMessage, projectContext } from '../../src/index.js';
import type { LogEntry, ProjectedEntry } from '../../src/index.js';
import {
  assistantMessage,
  customMessage,
  filler,
  messageEntry,
  toolResultMessage,
  userMessage,
} from './helpers.js';

function project(entries: LogEntry[]): readonly ProjectedEntry[] {
  return projectContext(entries).entries;
}

function entryTokens(entry: ProjectedEntry): number {
  return entry.contextMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/**
 * THE cut-point invariant: the first kept context-visible entry is never a
 * tool result — a cut must never separate a tool result from its call.
 */
function assertNoToolResultCut(projected: readonly ProjectedEntry[], firstKeptEntryIndex: number): void {
  expect(firstKeptEntryIndex).toBeLessThanOrEqual(projected.length);
  const firstKept = projected[firstKeptEntryIndex];
  if (firstKept === undefined) return;
  if (firstKept.contextMessages.length > 0) {
    expect(firstKept.contextMessages[0]!.role, 'cut must never land on a toolResult').not.toBe('toolResult');
  }
}

/** Turn builder: user + assistant (+ optional tool result), as a real turn looks. */
function turn(index: number, userChars: number, toolResultChars = 0): LogEntry[] {
  const entries = [
    messageEntry(userMessage(`turn ${index}: ${filler(userChars)}`)),
    messageEntry(assistantMessage(`working on ${index}`)),
  ];
  if (toolResultChars > 0) {
    entries.push(messageEntry(toolResultMessage(filler(toolResultChars), `call-${index}`)));
  }
  return entries;
}

describe('isCutPointMessage', () => {
  it('allows user, assistant, and custom; rejects toolResult', () => {
    expect(isCutPointMessage(userMessage('hi'))).toBe(true);
    expect(isCutPointMessage(assistantMessage('hi'))).toBe(true);
    expect(isCutPointMessage(customMessage('hook', 'text'))).toBe(true);
    expect(isCutPointMessage(toolResultMessage('out'))).toBe(false);
  });
});

describe('findCutPoint', () => {
  it('keeps roughly keepRecentTokens of the newest context', () => {
    // Each turn is ~4000 (user) + ~5 (assistant) + ~2000 (tool result) tokens.
    const entries: LogEntry[] = [];
    for (let i = 0; i < 10; i += 1) entries.push(...turn(i, 16_000, 8_000));
    const projected = project(entries);

    const cut = findCutPoint(projected, 0, projected.length, 20_000);
    assertNoToolResultCut(projected, cut.firstKeptEntryIndex);

    const keptTokens = projected.slice(cut.firstKeptEntryIndex).reduce((sum, entry) => sum + entryTokens(entry), 0);
    // Cut granularity is one turn: the kept tail is within one turn of the budget.
    expect(keptTokens).toBeGreaterThanOrEqual(20_000 - 6_100);
    expect(keptTokens).toBeLessThanOrEqual(20_000 + 6_100);
  });

  it('never cuts at a tool result even when trailing tool results exceed the budget alone', () => {
    const entries: LogEntry[] = [
      ...turn(0, 200),
      messageEntry(userMessage('now a huge tool result')),
      messageEntry(assistantMessage('running the tool')),
      messageEntry(toolResultMessage(filler(120_000), 'call-huge')), // 30k tokens alone > budget
    ];
    const projected = project(entries);
    const cut = findCutPoint(projected, 0, projected.length, 20_000);
    assertNoToolResultCut(projected, cut.firstKeptEntryIndex);
    // The cut snapped to the assistant tool call that precedes the result.
    expect(projected[cut.firstKeptEntryIndex]!.contextMessages[0]!.role).toBe('assistant');
  });

  it('defaults keepRecentTokens to 20000', () => {
    const entries: LogEntry[] = [];
    for (let i = 0; i < 8; i += 1) entries.push(...turn(i, 16_000));
    const projected = project(entries);

    const withDefault = findCutPoint(projected, 0, projected.length);
    const withExplicit = findCutPoint(projected, 0, projected.length, 20_000);
    expect(withDefault.firstKeptEntryIndex).toBe(withExplicit.firstKeptEntryIndex);
  });

  it('falls back to the first valid cut point when the window is below the budget', () => {
    const projected = project(turn(0, 800));
    const cut = findCutPoint(projected, 0, projected.length, 20_000);
    expect(cut.firstKeptEntryIndex).toBe(0);
    expect(cut.isSplitTurn).toBe(false);
  });

  it('returns startIndex when no entry holds a valid cut point', () => {
    const projected = project([messageEntry(toolResultMessage('orphan'))]);
    const cut = findCutPoint(projected, 0, projected.length, 100);
    expect(cut.firstKeptEntryIndex).toBe(0);
    expect(cut.isSplitTurn).toBe(false);
    expect(cut.turnStartIndex).toBe(-1);
  });

  it('honors startIndex (boundary after an existing compaction)', () => {
    const entries: LogEntry[] = [];
    for (let i = 0; i < 6; i += 1) entries.push(...turn(i, 16_000, 4_000));
    const projected = project(entries);
    const start = 6; // the first two turns are already behind a checkpoint

    const cut = findCutPoint(projected, start, projected.length, 20_000);
    assertNoToolResultCut(projected, cut.firstKeptEntryIndex);
    expect(cut.firstKeptEntryIndex).toBeGreaterThanOrEqual(start);
  });

  it('detects a split turn and points at the user turn start', () => {
    const entries: LogEntry[] = [
      messageEntry(userMessage('one long turn')),
      messageEntry(assistantMessage('step 1')),
      messageEntry(toolResultMessage(filler(40_000), 'c1')),
      messageEntry(assistantMessage('step 2')),
      messageEntry(toolResultMessage(filler(40_000), 'c2')),
      messageEntry(assistantMessage('step 3')),
    ];
    const projected = project(entries);
    const cut = findCutPoint(projected, 0, projected.length, 8_000);
    expect(cut.isSplitTurn).toBe(true);
    expect(cut.turnStartIndex).toBe(0);
    expect(projected[cut.turnStartIndex]!.contextMessages[0]).toEqual(userMessage('one long turn'));
    // Split-turn cuts still respect the tool-result invariant.
    assertNoToolResultCut(projected, cut.firstKeptEntryIndex);
  });

  it('is not a split turn when the cut lands exactly at a turn start', () => {
    const entries: LogEntry[] = [
      ...turn(0, 12_000, 8_000),
      ...turn(1, 12_000, 8_000),
      ...turn(2, 12_000, 8_000),
    ];
    const projected = project(entries);
    const cut = findCutPoint(projected, 0, projected.length, 20_000);
    expect(cut.isSplitTurn).toBe(false);
    expect(cut.turnStartIndex).toBe(-1);
    assertNoToolResultCut(projected, cut.firstKeptEntryIndex);
  });

  it('sweeps randomized logs: the tool-result invariant and suffix shape always hold', () => {
    // mulberry32 — deterministic 32-bit PRNG, no float-precision collapse.
    let state = 0x2f6e2b1;
    const random = () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    };

    for (let iteration = 0; iteration < 300; iteration += 1) {
      const entries: LogEntry[] = [];
      const turnCount = 1 + Math.floor(random() * 6);
      for (let t = 0; t < turnCount; t += 1) {
        entries.push(messageEntry(userMessage(`t${t} ${filler(40 + Math.floor(random() * 4000))}`)));
        const steps = Math.floor(random() * 4);
        for (let s = 0; s <= steps; s += 1) {
          entries.push(messageEntry(assistantMessage(`a${t}.${s} ${filler(Math.floor(random() * 2000))}`)));
          entries.push(messageEntry(toolResultMessage(filler(Math.floor(random() * 12_000)), `c-${t}-${s}`)));
        }
        if (random() < 0.3) entries.push(messageEntry(customMessage('hook', `h${t}`)));
      }
      const projected = project(entries);
      const keepRecentTokens = 200 + Math.floor(random() * 6000);
      const cut = findCutPoint(projected, 0, projected.length, keepRecentTokens);

      assertNoToolResultCut(projected, cut.firstKeptEntryIndex);
      // The kept range is a suffix; turn-start bookkeeping is consistent.
      if (cut.isSplitTurn) {
        expect(cut.turnStartIndex).toBeGreaterThanOrEqual(0);
        expect(cut.turnStartIndex).toBeLessThan(cut.firstKeptEntryIndex);
      } else {
        expect(cut.turnStartIndex).toBe(-1);
      }
    }
  });
});
