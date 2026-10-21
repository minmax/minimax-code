/**
 * The wire-bridge test (wave-2 review, architecture finding): a durable log
 * entry flows `durable entry → convert-to-llm (convertEntry) → wire-compiler
 * segment` and the compiler's segment is BYTE-IDENTICAL to the pinned
 * per-entry serialization `serializeCompiledEntry` (+ trailing newline) —
 * one per-entry stage, not two parallel contracts.
 */

import { describe, expect, it } from 'vitest';

import {
  convertEntry,
  serializeCompiledEntry,
} from '../../../convert-to-llm/src/index.js';
import type { DurableEntry } from '../../../convert-to-llm/src/index.js';
import {
  COMPILED_RECORD_NORMALIZER_VERSION,
  compile,
  compiledEntrySegment,
  compiledEntryToWireEntry,
  compiledRecordDialect,
  createLruSegmentCache,
} from '../../src/index.js';

let seq = 0;

function entry(id: string, kind: string, payload: Record<string, unknown>): DurableEntry {
  seq += 1;
  return { id, kind, payload: payload as DurableEntry['payload'], seq, ordinal: 0, parentId: null };
}

/** One durable entry of every pi.* shape conversion understands. */
function corpus(): DurableEntry[] {
  return [
    entry('sys-1', 'pi.system', { model: [{ role: 'system', content: 'You are a coding agent.' }] }),
    entry('u-1', 'pi.user', { model: [{ role: 'user', content: 'list the files' }] }),
    entry('a-1', 'pi.assistant', {
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'text', text: 'running ls' },
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls -la' } },
          ],
        },
      ],
    }),
    entry('t-1', 'pi.tool-result', {
      model: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'total 0' }], isError: false }],
    }),
    entry('a-2', 'pi.assistant', {
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: {}, stopReason: 'stop' }],
    }),
    entry('rem-1', 'mcode.system-reminder', { model: [{ role: 'user', content: '<system-reminder>steer</system-reminder>' }] }),
    // Audit kinds convert to null and must not appear in the wire body.
    entry('aud-1', 'mcode.owner-input.received', { model: [{ role: 'user', content: 'raw input' }] }),
  ];
}

describe('bridge: durable entry → convert-to-llm → wire-compiler segment', () => {
  it('compiles every record byte-identically to serializeCompiledEntry, in manifest order', () => {
    const records = corpus()
      .map((durable) => convertEntry(durable))
      .filter((record) => record !== null);
    // The audit entry dropped out; everything else became a record.
    expect(records.map((record) => record.entryId)).toEqual(['sys-1', 'u-1', 'a-1', 't-1', 'a-2', 'rem-1']);

    const wireEntries = records.map(compiledEntryToWireEntry);
    const manifest = wireEntries.map((wireEntry) => ({ entryId: wireEntry.entryId }));
    const { body, segments, totalBytes } = compile(manifest, wireEntries, {
      maxBytes: 1 << 20,
      dialect: compiledRecordDialect(),
      cache: createLruSegmentCache(64),
    });

    const expected = Buffer.concat(records.map(compiledEntrySegment));
    expect(body.equals(expected)).toBe(true);
    expect(totalBytes).toBe(expected.length);
    expect(segments.map((stat) => stat.entryId)).toEqual(records.map((record) => record.entryId));

    // Per-segment: the compiled line IS the pinned serialization + '\n'.
    let offset = 0;
    records.forEach((record, index) => {
      const line = `${serializeCompiledEntry(record)}\n`;
      const slice = body.subarray(offset, offset + segments[index]!.bytes);
      expect(slice.toString('utf8')).toBe(line);
      expect(segments[index]!.bytes).toBe(Buffer.byteLength(line, 'utf8'));
      offset += segments[index]!.bytes;
    });
  });

  it('the pinned serialization matches the OpenAI record shape with fixed key order', () => {
    const records = corpus()
      .map((durable) => convertEntry(durable))
      .filter((record) => record !== null);
    const byId = new Map(records.map((record) => [record.entryId, record]));

    const parsed = JSON.parse((compiledEntrySegment(byId.get('a-1')!).toString('utf8')));
    expect(parsed).toEqual({
      role: 'assistant',
      content: 'running ls',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) },
        },
      ],
    });
    const tool = JSON.parse(compiledEntrySegment(byId.get('t-1')!).toString('utf8'));
    expect(tool).toEqual({
      role: 'tool',
      content: 'total 0',
      tool_call_id: 'call-1',
      name: 'bash',
      is_error: false,
    });
  });

  it('cache keys carry the same identity in both notations', () => {
    expect(COMPILED_RECORD_NORMALIZER_VERSION).toBe('1');
    const durable = corpus()[0]!;
    const record = convertEntry(durable);
    expect(record).not.toBeNull();
    // record.cacheKey: `${entryId}@${name}#v${version}` — the compiler's
    // segment key is the same triple, JSON-encoded.
    expect(record!.cacheKey).toBe(`${record!.entryId}@minimax-m3#v1`);
    const wireEntry = compiledEntryToWireEntry(record!);
    expect(wireEntry.entryId).toBe(record!.entryId);
  });

  it('warm compaction of converted records reuses cached segments without re-hashing', () => {
    const records = corpus()
      .map((durable) => convertEntry(durable))
      .filter((record) => record !== null);
    const wireEntries = records.map(compiledEntryToWireEntry);
    const manifest = wireEntries.map((wireEntry) => ({ entryId: wireEntry.entryId }));
    const cache = createLruSegmentCache(64);
    const opts = { maxBytes: 1 << 20, dialect: compiledRecordDialect(), cache } as const;

    const cold = compile(manifest, wireEntries, opts);
    expect(cold.segments.every((stat) => stat.cacheHit === false)).toBe(true);
    expect(cold.segments.every((stat) => typeof stat.sha256 === 'string')).toBe(true);

    const warm = compile(manifest, wireEntries, opts);
    expect(warm.segments.every((stat) => stat.cacheHit === true)).toBe(true);
    expect(warm.segments.every((stat) => stat.sha256 === undefined)).toBe(true);
    expect(warm.body.equals(cold.body)).toBe(true);
  });
});
