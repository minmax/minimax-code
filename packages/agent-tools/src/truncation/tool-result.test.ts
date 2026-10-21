import { describe, expect, it } from 'vitest';

import type { ToolResult, ToolResultContent } from '@mavis/agent-core/tools';

import type { ToolOutputSpill } from './spill.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from './truncate.js';
import { truncateToolResultText } from './tool-result.js';

function textResult(text: string, content: ToolResultContent[] = [{ type: 'text', text }]): ToolResult {
  return {
    tool_name: 'bash',
    text,
    content,
    details: {},
  };
}

function longText(lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_, index) => `row-${String(index).padStart(4, '0')}-${'x'.repeat(60)}`,
  ).join('\n');
}

function spillMock(reference?: string, error?: Error): { spill: ToolOutputSpill; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    spill: {
      spill: async (payload: string) => {
        calls.push(payload);
        if (error) throw error;
        return reference;
      },
    },
  };
}

describe('truncateToolResultText', () => {
  it('returns short text-only results unchanged', async () => {
    const result = textResult('all good');
    const truncated = await truncateToolResultText(result);
    expect(truncated).toBe(result);
  });

  it('truncates a mixed-block result even without a spill hook (image stays inline)', async () => {
    const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
    const text = longText(5000);
    const result = textResult(text, [{ type: 'text', text }, image]);
    const truncated = await truncateToolResultText(result);

    expect(Buffer.byteLength(truncated.text, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(truncated.text).toContain('[output truncated:');
    expect(truncated.content[1]).toBe(image);
  });

  it('externalizes inline images through the spill sink while truncating the text (SE-F1-003)', async () => {
    const spilled: string[] = [];
    const spill: ToolOutputSpill & { spillBase64(base64: string): Promise<string | undefined> } = {
      spill: async () => undefined,
      spillBase64: async (base64) => {
        spilled.push(base64);
        return `cas://sha256/${'a'.repeat(64)}#${Buffer.from(base64, 'base64').byteLength}`;
      },
    };
    const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
    const text = longText(5000);
    const truncated = await truncateToolResultText(textResult(text, [{ type: 'text', text }, image]), {
      spill,
    });

    expect(spilled).toEqual(['aGVsbG8=']);
    expect(truncated.content[1]).toEqual({
      type: 'text',
      text: `[image: cas://sha256/${'a'.repeat(64)}#5]`,
    });
    expect(Buffer.byteLength(truncated.text, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(truncated.text).toContain('[output truncated:');
  });

  it('keeps blocks inline when the hook lacks a base64 put or the store fails', async () => {
    const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
    const text = longText(5000);
    const mixed = (): ToolResult => textResult(text, [{ type: 'text', text }, image]);

    // Plain ToolOutputSpill without spillBase64 → image stays inline.
    const plain = await truncateToolResultText(mixed(), {
      spill: { spill: async () => 'cas://sha256/full-output' },
    });
    expect(plain.content[1]).toBe(image);
    expect(plain.text).toContain('[output truncated:');

    // Base64-capable hook whose store fails → degrade to inline.
    const failing = await truncateToolResultText(mixed(), {
      spill: { spill: async () => undefined, spillBase64: async () => undefined },
    });
    expect(failing.content[1]).toBe(image);
  });

  it('leaves video blocks untouched while externalizing sibling images', async () => {
    const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
    const video = { type: 'video' as const, data: 'dmlk', mimeType: 'video/mp4' };
    const result = textResult('tiny', [{ type: 'text', text: 'tiny' }, video, image]);
    const truncated = await truncateToolResultText(result, {
      spill: {
        spill: async () => undefined,
        spillBase64: async () => `cas://sha256/${'b'.repeat(64)}#3`,
      },
    });

    expect(truncated).not.toBe(result);
    expect(truncated.content[1]).toBe(video);
    expect(truncated.content[2]).toEqual({
      type: 'text',
      text: `[image: cas://sha256/${'b'.repeat(64)}#3]`,
    });
    expect(truncated.text).toBe('tiny');
  });

  it('truncates oversized text head+tail under the pi defaults', async () => {
    const original = longText(5000);
    const truncated = await truncateToolResultText(textResult(original));

    expect(Buffer.byteLength(truncated.text, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(truncated.text.startsWith(`row-0000-${'x'.repeat(60)}`)).toBe(true);
    expect(truncated.text.endsWith(`row-4999-${'x'.repeat(60)}`)).toBe(true);
    expect(truncated.text).not.toContain('row-2500-');
    expect(truncated.text).toContain('[output truncated: head+tail shown;');

    const record = truncated.details?.desktop_output_truncation as Record<string, unknown>;
    expect(record).toMatchObject({
      truncated: true,
      has_more: true,
      strategy: 'head_tail_lines',
      original_bytes: Buffer.byteLength(original, 'utf8'),
      max_bytes: DEFAULT_MAX_BYTES,
    });
    const continuation = truncated.details
      ?.desktop_output_continuation as Record<string, unknown>;
    expect(continuation).toMatchObject({ has_more: true });
    expect((continuation.continuation_hint as Record<string, unknown>).tool).toBe('generic');
  });

  it('truncates by line count before the byte limit', async () => {
    // 3000 short lines: the 2000-line limit hits long before 50KB.
    const original = longText(3000);
    const truncated = await truncateToolResultText(textResult(original));
    expect(truncated.text).toContain('row-0000-');
    expect(truncated.text).toContain('row-2999-');
    expect(truncated.text).not.toContain('row-2000-');
  });

  it('keeps at most maxLines lines in total when only the line limit binds', async () => {
    // 3001 tiny lines stay far below 50KB, so the line limit alone binds.
    const original = Array.from({ length: 3001 }, (_, index) => `line-${index}`).join('\n');
    expect(Buffer.byteLength(original, 'utf8')).toBeLessThan(DEFAULT_MAX_BYTES);
    const truncated = await truncateToolResultText(textResult(original));

    const keptLines = truncated.text
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('[output truncated')).length;
    expect(keptLines).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(truncated.text).toContain('line-0\n');
    expect(truncated.text).toContain('line-3000');
    expect(truncated.text).not.toContain('line-1500\n');
  });

  it('partitions a payload with a trailing newline into the same head and tail lines', async () => {
    // 7 lines (trailing newline included): the middle line lands in neither
    // half, and the retained text is byte-identical to the line-array split.
    const original = `${Array.from({ length: 7 }, (_, index) => `line-${index}`).join('\n')}\n`;
    const truncated = await truncateToolResultText(textResult(original), {
      maxLines: 4,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    expect(truncated.text).toBe(
      'line-0\nline-1\n\n' +
        `[output truncated: head+tail shown; original_lines=7; ` +
        `original_bytes=${Buffer.byteLength(original, 'utf8')}. Rerun with narrower ` +
        'arguments if the omitted remainder is needed.]\n\n' +
        'line-5\nline-6',
    );
  });

  it('truncates a single oversized line without replacement characters', async () => {
    // One 150KB line: the byte limit binds, the partition degenerates to a
    // whole-payload tail, and the cut must stay on UTF-8 boundaries.
    const original = `${'ж'.repeat(30000)}${'x'.repeat(30000)}${'ж'.repeat(30000)}`;
    const truncated = await truncateToolResultText(textResult(original));

    expect(Buffer.byteLength(truncated.text, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(truncated.text).not.toContain('\uFFFD');
    expect(truncated.text.endsWith('ж'.repeat(16))).toBe(true);
    expect(truncated.text).toContain('[output truncated:');
  });

  it('delegates the full payload to the spill hook and surfaces the reference', async () => {
    const original = longText(5000);
    const spill = spillMock('cas://sha256/abc123');
    const truncated = await truncateToolResultText(textResult(original), { spill: spill.spill });

    expect(spill.calls).toEqual([original]);
    expect(truncated.text).toContain('Full output: cas://sha256/abc123.');

    const continuation = truncated.details
      ?.desktop_output_continuation as { continuation_hint?: { instruction?: string } };
    expect(continuation.continuation_hint?.instruction).toContain('cas://sha256/abc123');
    expect(truncated.details?.spill_reference).toBe('cas://sha256/abc123');
  });

  it('keeps working when the spill hook returns undefined', async () => {
    const spill = spillMock(undefined);
    const truncated = await truncateToolResultText(textResult(longText(5000)), {
      spill: spill.spill,
    });

    expect(spill.calls).toHaveLength(1);
    expect(truncated.text).not.toContain('Full output:');
    expect(truncated.details?.spill_reference).toBeUndefined();
    expect(truncated.text).toContain('Rerun with narrower arguments');
  });

  it('keeps working when the spill hook throws', async () => {
    const spill = spillMock(undefined, new Error('cas offline'));
    const truncated = await truncateToolResultText(textResult(longText(5000)), {
      spill: spill.spill,
    });

    expect(truncated.text).toContain('[output truncated:');
    expect(truncated.details?.spill_reference).toBeUndefined();
  });

  it('does not spill text that fits the limits', async () => {
    const spill = spillMock('cas://sha256/abc123');
    await truncateToolResultText(textResult('tiny'), { spill: spill.spill });
    expect(spill.calls).toHaveLength(0);
  });

  it('honours custom limits and a caller-provided continuation hint', async () => {
    const original = Array.from({ length: 50 }, (_, index) => `line-${index}`).join('\n');
    const truncated = await truncateToolResultText(textResult(original), {
      maxLines: 10,
      maxBytes: DEFAULT_MAX_BYTES,
      continuation: {
        tool: 'read',
        preserve_args: ['path'],
        instruction: 'Read the source file to see every line.',
      },
    });

    expect(truncated.text).toContain('line-0\n');
    expect(truncated.text).toContain('line-49');
    expect(truncated.text).not.toContain('line-25\n');
    expect(truncated.details?.desktop_output_truncation).toMatchObject({
      max_bytes: DEFAULT_MAX_BYTES,
    });
    const continuation = truncated.details
      ?.desktop_output_continuation as { continuation_hint?: Record<string, unknown> };
    expect(continuation.continuation_hint).toEqual({
      tool: 'read',
      preserve_args: ['path'],
      instruction: 'Read the source file to see every line.',
    });
  });

  it('never exceeds maxBytes even with a long spill reference in the notice', async () => {
    const spill = spillMock(`cas://sha256/${'f'.repeat(400)}`);
    const truncated = await truncateToolResultText(textResult(longText(5000)), {
      spill: spill.spill,
      maxBytes: 4096,
    });
    expect(Buffer.byteLength(truncated.text, 'utf8')).toBeLessThanOrEqual(4096);
    expect(truncated.details?.spill_reference).toBe(`cas://sha256/${'f'.repeat(400)}`);
  });

  it('clamps to maxBytes when the notice alone overflows the budget', async () => {
    // A 400-char reference inside a 256-byte budget: the notice itself is
    // larger than maxBytes, so the final text is UTF-8-prefixed to 256 bytes.
    const spill = spillMock(`cas://sha256/${'f'.repeat(400)}`);
    const truncated = await truncateToolResultText(textResult(longText(5000)), {
      spill: spill.spill,
      maxBytes: 256,
    });
    expect(Buffer.byteLength(truncated.text, 'utf8')).toBeLessThanOrEqual(256);
    expect(truncated.text).not.toContain('\uFFFD');
  });
});
