/**
 * Determinism of the per-entry conversion stage (acceptance criterion #1):
 * identical inputs produce byte-identical records, repeatedly and across
 * call orders; role/content rules of the `minimax-m3` dialect hold.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  MINIMAX_M3_DIALECT,
  assemblePayload,
  compileBatchKey,
  compileKey,
  convertBatch,
  convertEntry,
  extractReminderBlocks,
  serializeCompiledEntry,
} from '../../src/index.js';
import { assistantEntry, makeEntry, toolResultEntry, userEntry } from './helpers.js';

function payloadHash(records: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

describe('convertEntry determinism', () => {
  it('produces identical payload bytes over 50 repeated assemblies', () => {
    const entries = [
      userEntry('u1', 'hello'),
      makeEntry('rem1', 'mcode.system-reminder', { text: 'todo changed' }),
      assistantEntry('a1', [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { cmd: 'ls -la' } },
      ]),
      toolResultEntry('t1', 'call_1', 'out'),
      userEntry('u2', `follow up <system-reminder>mem</system-reminder> end`),
    ];
    const expected = payloadHash(assemblePayload(entries).records);
    for (let i = 0; i < 50; i += 1) {
      expect(payloadHash(assemblePayload(entries).records)).toBe(expected);
    }
  });

  it('keeps extraction pure across repeated calls (no regex state leaks)', () => {
    const text = `a <system-reminder>x</system-reminder> b`;
    const first = extractReminderBlocks(text);
    for (let i = 0; i < 10; i += 1) {
      expect(extractReminderBlocks(text)).toEqual(first);
      expect(extractReminderBlocks('no blocks here')).toEqual([]);
    }
  });

  it('produces byte-identical records across repeated conversions', () => {
    const entry = assistantEntry('a1', [
      { type: 'thinking', thinking: 'secret reasoning' },
      { type: 'text', text: 'Answer part one.' },
      { type: 'text', text: 'Answer part two.' },
      {
        type: 'toolCall',
        id: 'call_1',
        name: 'read',
        arguments: { path: '/tmp/x', limit: 10 },
      },
    ]);

    const first = convertEntry(entry);
    const second = convertEntry(entry);
    expect(second).not.toBe(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(serializeCompiledEntry(first!)).toBe(serializeCompiledEntry(second!));
  });

  it('is independent of conversion order of unrelated entries', () => {
    const entries = [
      userEntry('u1', 'hello'),
      assistantEntry('a1', [{ type: 'text', text: 'hi' }]),
      toolResultEntry('t1', 'call_1', 'file body'),
    ];
    const forward = entries.map((entry) => convertEntry(entry));
    const backward = [...entries].reverse().map((entry) => convertEntry(entry));
    const byId = (records: unknown[]) => JSON.stringify(records);
    expect(byId(backward)).toBe(byId([...forward].reverse()));
  });

  it('cuts thinking blocks and joins text blocks with the dialect joiner', () => {
    const record = convertEntry(
      assistantEntry('a1', [
        { type: 'thinking', thinking: 'should not appear' },
        { type: 'text', text: 'one' },
        { type: 'thinking', thinking: 'also dropped' },
        { type: 'text', text: 'two' },
      ]),
    )!;
    expect(record.role).toBe('assistant');
    expect(record.content).toBe('one\n\ntwo');
    expect(record.content).not.toContain('should not appear');
    expect(record.toolCalls).toBeUndefined();
    expect(serializeCompiledEntry(record)).not.toContain('thinking');
  });

  it('projects assistant tool-call deltas into provider function calls', () => {
    const record = convertEntry(
      assistantEntry('a1', [
        { type: 'text', text: 'Reading the file.' },
        { type: 'toolCall', id: 'call_9', name: 'bash', arguments: { cmd: 'ls' } },
      ]),
    )!;
    expect(record.toolCalls).toEqual([
      {
        id: 'call_9',
        type: 'function',
        function: { name: 'bash', arguments: '{"cmd":"ls"}' },
      },
    ]);
    const body = JSON.parse(serializeCompiledEntry(record)) as Record<string, unknown>;
    expect(body['role']).toBe('assistant');
    expect(body['tool_calls']).toEqual(record.toolCalls);
  });

  it('converts toolResult entries to tool records correlated by toolCallId', () => {
    const record = convertEntry(toolResultEntry('t1', 'call_9', 'done', true))!;
    expect(record.role).toBe('tool');
    expect(record.toolCallId).toBe('call_9');
    expect(record.toolName).toBe('read');
    expect(record.isError).toBe(true);
    const body = JSON.parse(serializeCompiledEntry(record)) as Record<string, unknown>;
    expect(body['tool_call_id']).toBe('call_9');
    expect(body['is_error']).toBe(true);
  });

  it('converts system entries to system records and drops empty ones', () => {
    const prompt = makeEntry('s1', 'pi.system', {
      model: [{ role: 'system', content: 'You are a coding agent.' }],
    });
    expect(convertEntry(prompt)!.role).toBe('system');

    // pi-durable positional system entries carry empty content; they are
    // prefix noise and convert to null.
    const positional = makeEntry('s2', 'pi.system', {
      model: [{ role: 'system', content: '' }],
    });
    expect(convertEntry(positional)).toBeNull();
  });

  it('replaces image blocks with deterministic placeholders, never binary data', () => {
    const entry = makeEntry('u1', 'pi.user', {
      model: [
        {
          role: 'user',
          timestamp: 1,
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', data: 'AAAAbase64==', mimeType: 'image/png' },
          ],
        },
      ],
    });
    const record = convertEntry(entry)!;
    expect(record.content).toBe(`look\n\n${MINIMAX_M3_DIALECT.imagePlaceholder('image/png')}`);
    expect(serializeCompiledEntry(record)).not.toContain('AAAAbase64');
  });

  it('returns null for reset boundaries and undecodable payloads', () => {
    expect(convertEntry(makeEntry('r1', 'pi.reset', { model: null }))).toBeNull();
    expect(convertEntry(makeEntry('x1', 'pi.user', 'not-an-object'))).toBeNull();
    expect(convertEntry(makeEntry('x2', 'pi.user', { model: 42 }))).toBeNull();
  });

  it('returns null for user entries with no provider-visible content', () => {
    expect(convertEntry(userEntry('u1', ''))).toBeNull();
    expect(convertEntry(userEntry('u2', '   '))).toBeNull();
    // Real text still converts.
    expect(convertEntry(userEntry('u3', 'real turn'))).not.toBeNull();
  });
});

describe('compile keys', () => {
  it('keys by (entryId, dialect, normalizerVersion)', () => {
    expect(compileKey('e1', MINIMAX_M3_DIALECT)).toBe('e1@minimax-m3#v1');
  });

  it('changes the batch key when a member joins', () => {
    const two = compileBatchKey(['u1', 'u2'], MINIMAX_M3_DIALECT);
    const three = compileBatchKey(['u1', 'u2', 'u3'], MINIMAX_M3_DIALECT);
    expect(two).not.toBe(three);
  });
});

describe('convertBatch', () => {
  it('joins members with the batch joiner and keys by all members', () => {
    const merged = convertBatch([
      userEntry('u1', 'first'),
      userEntry('u2', 'second'),
    ])!;
    expect(merged.role).toBe('user');
    expect(merged.content).toBe('first\n\nsecond');
    expect(merged.sourceEntryIds).toEqual(['u1', 'u2']);
    expect(merged.cacheKey).toBe(compileBatchKey(['u1', 'u2'], MINIMAX_M3_DIALECT));
  });
});
