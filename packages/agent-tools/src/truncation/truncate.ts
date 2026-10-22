/**
 * Shared truncation utilities for tool outputs, ported from pi's
 * `core/tools/truncate.ts`.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except the bash tail truncation edge case).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

export interface TruncationResult {
  /** The truncated content. */
  content: string;
  /** Whether truncation occurred. */
  truncated: boolean;
  /** Which limit was hit: "lines", "bytes", or null if not truncated. */
  truncatedBy: 'lines' | 'bytes' | null;
  /** Total number of lines in the original content. */
  totalLines: number;
  /** Total number of bytes in the original content. */
  totalBytes: number;
  /** Number of complete lines in the truncated output. */
  outputLines: number;
  /** Number of bytes in the truncated output. */
  outputBytes: number;
  /** Whether the last line was partially truncated (only for the tail truncation edge case). */
  lastLinePartial: boolean;
  /** Whether the first line exceeded the byte limit (for head truncation). */
  firstLineExceedsLimit: boolean;
  /** The max lines limit that was applied. */
  maxLines: number;
  /** The max bytes limit that was applied. */
  maxBytes: number;
}

export interface TruncationOptions {
  /** Maximum number of lines (default: 2000). */
  maxLines?: number;
  /** Maximum number of bytes (default: 50KB). */
  maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split('\n');
  if (content.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

/** Format bytes as human-readable size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If the first line exceeds the byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = byteLength(content);
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  // Check if no truncation needed.
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  // Check if the first line alone exceeds the byte limit.
  const firstLineBytes = byteLength(lines[0] ?? '');
  if (firstLineBytes > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  // Collect complete lines that fit.
  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';

  for (let i = 0; i < lines.length && i < maxLines; i += 1) {
    const line = lines[i] ?? '';
    const lineBytes = byteLength(line) + (i > 0 ? 1 : 0); // +1 for newline

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }

    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }

  // If we exited due to the line limit.
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines';
  }

  const outputContent = outputLinesArr.join('\n');
  const finalOutputBytes = byteLength(outputContent);

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return a partial first line if the last line of the original content
 * exceeds the byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = byteLength(content);
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  // Check if no truncation needed.
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  // Work backwards from the end.
  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  let lastLinePartial = false;

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i -= 1) {
    const line = lines[i] ?? '';
    const lineBytes = byteLength(line) + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      // Edge case: if we have not added ANY lines yet and this line exceeds
      // maxBytes, take the end of the line (partial).
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
        outputLinesArr.unshift(truncatedLine);
        outputBytesCount = byteLength(truncatedLine);
        lastLinePartial = true;
      }
      break;
    }

    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }

  // If we exited due to the line limit.
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines';
  }

  const outputContent = outputLinesArr.join('\n');
  const finalOutputBytes = byteLength(outputContent);

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 *
 * The suffix cut buffers only a bounded one-unit-of-context slice of the
 * string, never the whole (potentially single-line, tens-of-megabytes)
 * payload: with the context unit a surrogate pair straddling the cut stays
 * intact, so the bounded buffer's tail is byte-identical to the full one and
 * the boundary walk produces exactly the same output.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  if (byteLength(str) <= maxBytes) {
    return str;
  }

  const bounded = str.length <= maxBytes + 1 ? str : str.slice(-(maxBytes + 1));
  const buf = Buffer.from(bounded, 'utf8');

  // Start from the end, skip maxBytes back.
  let start = Math.max(0, buf.length - Math.max(0, maxBytes));

  // Find a valid UTF-8 boundary (start of a character).
  while (start < buf.length && isUtf8Continuation(buf[start])) {
    start += 1;
  }

  return buf.subarray(start).toString('utf8');
}

/**
 * Truncate a single line to max characters, adding a `[truncated]` suffix.
 * Used for grep match lines.
 */
export function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) {
    return { text: line, wasTruncated: false };
  }
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

export interface MiddleTruncationResult {
  /** The start and end of the content with a `…N chars truncated…` marker between them. */
  content: string;
  truncated: boolean;
  /** Characters left out. */
  removedChars: number;
  totalBytes: number;
  totalLines: number;
}

/**
 * Keep the start and the end of `content`, half of `maxBytes` each, and replace
 * the middle with a `…N chars truncated…` marker, like Codex does for tool
 * output. Cuts only at character boundaries.
 */
export function truncateMiddle(content: string, maxBytes: number): MiddleTruncationResult {
  const buf = Buffer.from(content, 'utf8');
  const totalLines = splitLinesForCounting(content).length;
  if (buf.length <= maxBytes) {
    return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
  }
  // Continuation bytes (10xxxxxx) are not character starts.
  const isBoundary = (index: number): boolean =>
    index >= buf.length || !isUtf8Continuation(buf[index] as number);
  let headEnd = Math.floor(maxBytes / 2);
  while (headEnd > 0 && !isBoundary(headEnd)) headEnd -= 1;
  let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
  while (tailStart < buf.length && !isBoundary(tailStart)) tailStart += 1;
  const head = buf.subarray(0, headEnd).toString('utf8');
  const tail = buf.subarray(tailStart).toString('utf8');
  // The buffer was encoded from a JS string, so the removed range is
  // well-formed UTF-8: every code point starts with exactly one lead byte.
  // Counting lead bytes avoids materializing the whole removed middle as a
  // string and a code-point array just to take its length.
  let removedChars = 0;
  for (let index = headEnd; index < tailStart; index += 1) {
    if (!isUtf8Continuation(buf[index] as number)) removedChars += 1;
  }
  return {
    content: `${head}…${removedChars} chars truncated…${tail}`,
    truncated: true,
    removedChars,
    totalBytes: buf.length,
    totalLines,
  };
}

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
