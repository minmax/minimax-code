/**
 * System-reminder tail positioning (acceptance criterion #3) and the
 * non-mutation invariant (node `mcode-system-reminder`, adapt decision):
 * reminder records always sit AFTER the stable cache prefix, and converting
 * new reminders never changes a single byte of previously compiled prefix
 * records.
 */

import { describe, expect, it } from 'vitest';

import {
  MINIMAX_M3_DIALECT,
  assemblePayload,
  buildReminderTail,
  convertEntry,
  convertEntryTails,
  extractReminderBlocks,
  serializeCompiledEntry,
} from '../../src/index.js';
import { makeEntry, resetEntrySeq, userEntry } from './helpers.js';

const REMINDER = '<system-reminder>todo state changed</system-reminder>';

describe('dedicated reminder entries become tail records', () => {
  it('positions reminder entries after the prefix regardless of log position', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      userEntry('u1', 'first user turn'),
      makeEntry('rem1', 'mcode.system-reminder', { text: 'todo state changed' }),
      userEntry('u2', 'second user turn'),
      makeEntry('rem2', 'mcode.system-reminder', { text: 'memory updated' }),
    ]);

    expect(payload.records.map((record) => record.entryId)).toEqual([
      'u1',
      'u2',
      'rem1',
      'rem2',
    ]);
    expect(payload.prefix.map((record) => record.entryId)).toEqual(['u1', 'u2']);
    expect(payload.tails.map((record) => record.entryId)).toEqual(['rem1', 'rem2']);
    expect(payload.tails.every((record) => record.tail)).toBe(true);
    expect(payload.prefix.every((record) => !record.tail)).toBe(true);
    expect(payload.tails[0]!.content).toContain('<system-reminder>');
    expect(payload.tails[0]!.content).toContain('todo state changed');
    expect(payload.stats.reminderTails).toBe(2);
  });

  it('wraps raw reminder text but keeps already-wrapped bytes as-is', () => {
    const wrapped = buildReminderTail(
      'rem1',
      'mcode.system-reminder',
      'plain text',
      MINIMAX_M3_DIALECT,
    );
    expect(wrapped.content).toBe('<system-reminder>\nplain text\n</system-reminder>');

    const pre = buildReminderTail(
      'rem2',
      'mcode.system-reminder',
      '<system-reminder>already tagged</system-reminder>',
      MINIMAX_M3_DIALECT,
    );
    expect(pre.content).toBe('<system-reminder>already tagged</system-reminder>');
  });
});

describe('embedded reminder blocks split out of user text', () => {
  it('splits blocks into tails and keeps residual user bytes', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      userEntry('u1', `please continue\n\n${REMINDER}\n\nthanks`),
    ]);

    const users = payload.records.filter((record) => record.role === 'user' && !record.tail);
    expect(users).toHaveLength(1);
    expect(users[0]!.content).toBe('please continue\n\n\n\nthanks');
    expect(users[0]!.content).not.toContain('<system-reminder>');

    expect(payload.tails).toHaveLength(1);
    expect(payload.tails[0]!.entryId).toBe('u1#reminder:0');
    expect(payload.tails[0]!.content).toBe(REMINDER);
    expect(payload.tails[0]!.tail).toBe(true);
  });

  it('never mutates old user messages: growing reminders leave prefix bytes stable', () => {
    resetEntrySeq();
    const history = [userEntry('u1', 'turn one'), userEntry('u2', 'turn two')];
    const before = assemblePayload(history);
    const prefixBefore = before.prefix.map(serializeCompiledEntry);

    // A later request appends a user entry carrying a reminder block.
    const grown = assemblePayload([
      ...history,
      userEntry('u3', `turn three ${REMINDER}`),
    ]);

    const prefixAfter = grown.prefix
      .filter((record) => record.entryId !== 'u3')
      .map(serializeCompiledEntry);
    expect(prefixAfter).toEqual(prefixBefore);
    // And the reminder sits strictly after the whole prefix.
    expect(grown.tails.map((record) => record.entryId)).toEqual(['u3#reminder:0']);
  });

  it('drops the user record when reminder blocks consumed the whole text', () => {
    const record = convertEntry(userEntry('u1', `${REMINDER}`));
    expect(record).toBeNull();
    const tails = convertEntryTails(userEntry('u1', `${REMINDER}`));
    expect(tails.map((tail) => tail.entryId)).toEqual(['u1#reminder:0']);
  });

  it('extracts multiple blocks in order', () => {
    const text = `a ${REMINDER} b <system-reminder>second</system-reminder> c`;
    expect(extractReminderBlocks(text)).toEqual([
      REMINDER,
      '<system-reminder>second</system-reminder>',
    ]);
  });
});
