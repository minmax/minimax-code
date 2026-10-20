import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  truncateHead,
  truncateLine,
  truncateMiddle,
  truncateTail,
} from './truncate.js';

function lines(count: number, render: (index: number) => string): string {
  return `${Array.from({ length: count }, (_, index) => render(index)).join('\n')}\n`;
}

describe('truncation defaults', () => {
  it('matches the pi limits', () => {
    expect(DEFAULT_MAX_LINES).toBe(2000);
    expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
    expect(GREP_MAX_LINE_LENGTH).toBe(500);
  });
});

describe('formatSize', () => {
  it('formats bytes, kilobytes, and megabytes', () => {
    expect(formatSize(512)).toBe('512B');
    expect(formatSize(2048)).toBe('2.0KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0MB');
  });
});

describe('truncateHead', () => {
  it('returns content unchanged when both limits hold', () => {
    const content = lines(10, (index) => `row-${index}`);
    const result = truncateHead(content);
    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toBeNull();
    expect(result.content).toBe(content);
    expect(result.totalLines).toBe(10);
    expect(result.outputLines).toBe(10);
  });

  it('keeps the first maxLines complete lines', () => {
    const content = lines(30, (index) => `row-${index}`);
    const result = truncateHead(content, { maxLines: 10 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('lines');
    expect(result.content).toBe(lines(10, (index) => `row-${index}`).replace(/\n$/, ''));
    expect(result.outputLines).toBe(10);
    expect(result.totalLines).toBe(30);
    expect(result.lastLinePartial).toBe(false);
  });

  it('keeps only whole lines that fit the byte limit', () => {
    const content = `${'a'.repeat(10)}\n${'b'.repeat(10)}\n${'c'.repeat(10)}`;
    // The newline is charged to the following line's budget (pi semantics):
    // after line 1 the count is 10, adding line 2 costs 10 + 1 = 11 > 15.
    const result = truncateHead(content, { maxBytes: 15 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('bytes');
    expect(result.content).toBe('aaaaaaaaaa');
    expect(result.outputLines).toBe(1);
  });

  it('returns empty content with firstLineExceedsLimit when line one exceeds maxBytes', () => {
    const content = `${'x'.repeat(40)}\nsmall\n`;
    const result = truncateHead(content, { maxBytes: 16 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('bytes');
    expect(result.content).toBe('');
    expect(result.outputLines).toBe(0);
    expect(result.firstLineExceedsLimit).toBe(true);
  });
});

describe('truncateTail', () => {
  it('returns content unchanged when both limits hold', () => {
    const content = lines(5, (index) => `row-${index}`);
    const result = truncateTail(content, { maxLines: 10 });
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it('keeps the last maxLines complete lines', () => {
    const content = lines(30, (index) => `row-${index}`);
    const result = truncateTail(content, { maxLines: 10 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('lines');
    expect(result.content).toBe(
      lines(10, (index) => `row-${index + 20}`).replace(/\n$/, ''),
    );
    expect(result.outputLines).toBe(10);
  });

  it('keeps whole lines from the end within the byte limit', () => {
    const content = `${'a'.repeat(10)}\n${'b'.repeat(10)}\n${'c'.repeat(10)}`;
    // Mirrored accounting: the last line fits free, the next one up costs
    // 10 + 1 = 11 and would push the total past 15.
    const result = truncateTail(content, { maxBytes: 15 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('bytes');
    expect(result.content).toBe('cccccccccc');
    expect(result.outputLines).toBe(1);
  });

  it('takes the end of the last line when it alone exceeds maxBytes', () => {
    const content = `small\n${'y'.repeat(40)}`;
    const result = truncateTail(content, { maxBytes: 16 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('bytes');
    expect(result.lastLinePartial).toBe(true);
    expect(result.outputLines).toBe(1);
    expect(result.content.endsWith('yyyy')).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(16);
  });

  it('keeps multi-byte characters intact on the partial-line edge case', () => {
    const content = `prefix\n${'ж'.repeat(30)}`;
    const result = truncateTail(content, { maxBytes: 20 });
    expect(result.lastLinePartial).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(20);
    expect(result.content.includes('ж')).toBe(true);
  });
});

describe('truncateLine', () => {
  it('keeps lines at or below the default 500-char grep limit', () => {
    const line = 'match'.repeat(10);
    expect(truncateLine(line)).toEqual({ text: line, wasTruncated: false });
  });

  it('cuts long lines to maxChars with a [truncated] suffix', () => {
    const line = 'z'.repeat(600);
    const result = truncateLine(line);
    expect(result.wasTruncated).toBe(true);
    expect(result.text).toBe(`${'z'.repeat(500)}... [truncated]`);
  });

  it('honours a custom maxChars', () => {
    const result = truncateLine('abcdef', 3);
    expect(result).toEqual({ text: 'abc... [truncated]', wasTruncated: true });
  });
});

describe('truncateMiddle', () => {
  it('returns content unchanged within the byte limit', () => {
    const content = 'hello world';
    expect(truncateMiddle(content, 32)).toEqual({
      content,
      truncated: false,
      removedChars: 0,
      totalBytes: 11,
      totalLines: 1,
    });
  });

  it('replaces the middle with a chars-truncated marker', () => {
    const content = Array.from({ length: 100 }, (_, index) => `row-${String(index).padStart(3, '0')}`).join('\n');
    const result = truncateMiddle(content, 64);
    expect(result.truncated).toBe(true);
    expect(result.removedChars).toBeGreaterThan(0);
    expect(result.content).toContain(' chars truncated…');
    expect(result.content.startsWith('row-000')).toBe(true);
    expect(result.content.endsWith('row-099')).toBe(true);
    expect(result.totalLines).toBe(100);
  });

  it('cuts only at UTF-8 character boundaries', () => {
    const content = 'ж'.repeat(40);
    const result = truncateMiddle(content, 30);
    expect(result.truncated).toBe(true);
    // 15 bytes is not a character boundary for 2-byte chars, so the head is
    // cut back to 14 bytes = 7 characters; the tail starts at byte 66 = 33rd
    // character, leaving 7 characters. The marker itself sits on top of the
    // byte budget (pi semantics).
    expect(result.content.startsWith('ж'.repeat(7))).toBe(true);
    expect(result.content.endsWith('ж'.repeat(7))).toBe(true);
    expect(Buffer.from(result.content, 'utf8').length).toBeLessThanOrEqual(52);
    expect(result.content).not.toContain('\uFFFD');
  });
});
