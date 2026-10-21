import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  compile,
  createLruSegmentCache,
  imagePlaceholderLink,
  MINIMAX_M3_DIALECT,
} from '../../src/index.js';
import type { Entry } from '../../src/index.js';

const PNG_BYTES = Buffer.from('fake-png-bytes-for-the-fixture');

/** Fixture covering all four per-entry stages plus thinking/image blocks. */
function fixtureEntries(): Entry[] {
  return [
    { entryId: 'sys-1', kind: 'system', content: 'You are a coding agent.' },
    {
      entryId: 'tools-1',
      kind: 'tool-deltas',
      tools: [
        {
          name: 'read_file',
          description: 'Reads a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
        { name: 'bash' },
      ],
    },
    {
      entryId: 'msg-1',
      kind: 'text',
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image', data: PNG_BYTES.toString('base64'), mimeType: 'image/png' },
      ],
    },
    {
      entryId: 'msg-2',
      kind: 'text',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal chain of thought' },
        { type: 'text', text: 'It is a test image.' },
        { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } },
      ],
    },
    {
      entryId: 'res-1',
      kind: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read_file',
      isError: false,
      content: [
        { type: 'image_ref', blob: 'cas://sha256/deadbeef#12' },
        { type: 'text', text: 'file contents' },
      ],
    },
  ];
}

const MANIFEST = fixtureEntries().map((entry) => ({ entryId: entry.entryId }));

/** Splits a compiled body into its JSONL records. */
function parseBody(body: Buffer): unknown[] {
  const text = body.toString('utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe('wire compiler determinism', () => {
  it('compiles byte-for-byte identically across cold, warm, and isolated-cache runs', () => {
    const warm = createLruSegmentCache(64);
    const entries = fixtureEntries();

    const cold = compile(MANIFEST, entries, { maxBytes: 1 << 20, cache: warm });
    const warmRerun = compile(MANIFEST, entries, { maxBytes: 1 << 20, cache: warm });
    const isolated = compile(MANIFEST, entries, {
      maxBytes: 1 << 20,
      cache: createLruSegmentCache(64),
    });

    expect(cold.segments.map((stat) => stat.cacheHit)).toEqual([false, false, false, false, false]);
    expect(warmRerun.segments.map((stat) => stat.cacheHit)).toEqual([true, true, true, true, true]);
    expect(warmRerun.body.equals(cold.body)).toBe(true);
    expect(isolated.body.equals(cold.body)).toBe(true);
    expect(warmRerun.totalBytes).toBe(cold.totalBytes);
    expect(cold.totalBytes).toBe(cold.body.length);
  });

  it('produces the documented normalized shapes for every per-entry stage', () => {
    const { body } = compile(MANIFEST, fixtureEntries(), {
      maxBytes: 1 << 20,
      cache: createLruSegmentCache(64),
    });
    const [system, tools, user, assistant, toolResult] = parseBody(body) as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    // system
    expect(system).toEqual({ role: 'system', content: 'You are a coding agent.' });

    // tool-deltas: fixed key order fields, definitions without extras dropped
    expect(tools).toEqual({
      role: 'tool-deltas',
      tools: [
        {
          name: 'read_file',
          description: 'Reads a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
        { name: 'bash' },
      ],
    });

    // user: inline base64 image becomes a deterministic cas:// placeholder link
    const expectedDigest = createHash('sha256').update(PNG_BYTES).digest('hex');
    expect(user).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'text', text: imagePlaceholderLink(`cas://sha256/${expectedDigest}#${PNG_BYTES.length}`) },
      ],
    });

    // assistant: thinking block stripped, text and toolCall preserved
    expect(assistant).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'It is a test image.' },
        { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } },
      ],
    });

    // toolResult: image_ref keeps its stored link as placeholder text
    expect(toolResult).toEqual({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read_file',
      content: [
        { type: 'text', text: imagePlaceholderLink('cas://sha256/deadbeef#12') },
        { type: 'text', text: 'file contents' },
      ],
      isError: false,
    });
  });

  it('reports per-segment sha256 stats matching the body slices in manifest order', () => {
    const { body, segments } = compile(MANIFEST, fixtureEntries(), {
      maxBytes: 1 << 20,
      cache: createLruSegmentCache(64),
    });

    expect(segments.map((stat) => stat.entryId)).toEqual(MANIFEST.map((ref) => ref.entryId));
    let offset = 0;
    for (const stat of segments) {
      const slice = body.subarray(offset, offset + stat.bytes);
      expect(createHash('sha256').update(slice).digest('hex')).toBe(stat.sha256);
      offset += stat.bytes;
    }
    expect(offset).toBe(body.length);
  });

  it('assembles the body strictly in manifest order, not entries order', () => {
    const entries = fixtureEntries();
    const forward = compile(MANIFEST, entries, { maxBytes: 1 << 20, cache: createLruSegmentCache(64) });
    const reversed = compile(
      [...MANIFEST].reverse(),
      entries,
      { maxBytes: 1 << 20, cache: createLruSegmentCache(64) },
    );

    expect(reversed.segments.map((stat) => stat.entryId)).toEqual([...MANIFEST].reverse().map((ref) => ref.entryId));
    // Same four segments (same hashes), different order → different bytes.
    expect(reversed.body.equals(forward.body)).toBe(false);
    expect([...reversed.segments].map((stat) => stat.sha256).sort()).toEqual(
      [...forward.segments].map((stat) => stat.sha256).sort(),
    );
  });

  it('keeps the default dialect stable by name and normalizer version', () => {
    expect(MINIMAX_M3_DIALECT.name).toBe('minimax-m3');
    expect(MINIMAX_M3_DIALECT.normalizerVersion).toBe('1');
  });
});
