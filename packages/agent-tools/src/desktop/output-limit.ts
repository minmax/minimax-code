import type { ToolResult, ToolResultContent } from '@mavis/agent-core/tools';

export const DESKTOP_GREP_CONTENT_MAX_BYTES = 16 * 1024;
export const DESKTOP_READ_TEXT_MAX_BYTES = 24 * 1024;
export const DESKTOP_BASH_MAX_BYTES = 24 * 1024;
// Leave room for exit/timing receipts and the readable output reference.
export const DESKTOP_BASH_PREVIEW_BYTES = DESKTOP_BASH_MAX_BYTES - 2048;

export type DesktopOutputLimitStrategy = 'prefix_lines' | 'head_tail_lines';
export type DesktopOutputOffsetUnit = 'line' | 'match' | 'file';

export interface DesktopOutputContinuationHint {
  /**
   * `generic` marks a hint produced by the shared tool-result truncation seam
   * (truncation/tool-result.ts), which has no tool-specific continuation.
   */
  tool: 'read' | 'grep' | 'glob' | 'mavis' | 'bash' | 'task_output' | 'generic';
  preserve_args: readonly string[];
  instruction: string;
}

export interface DesktopOutputTruncation {
  truncated: true;
  has_more: true;
  strategy: DesktopOutputLimitStrategy;
  original_bytes: number;
  returned_bytes: number;
  max_bytes: number;
  next_offset?: number;
  offset_unit?: DesktopOutputOffsetUnit;
  continuation_hint?: DesktopOutputContinuationHint;
}

export interface DesktopOutputContinuation {
  has_more: true;
  next_offset?: number;
  offset_unit?: DesktopOutputOffsetUnit;
  continuation_hint: DesktopOutputContinuationHint;
}

export interface DesktopOutputLimitResult {
  text: string;
  truncation?: DesktopOutputTruncation;
  returnedBodyLines: number;
}

interface NoticeContext {
  readonly originalBytes: number;
  readonly returnedBodyLines: number;
  readonly retainedLines: readonly string[];
}

interface OutputLimitOptions {
  readonly maxBytes: number;
  readonly originalBytes?: number;
  readonly notice: (context: NoticeContext) => string;
}

export function limitDesktopPrefixLines(
  text: string,
  options: OutputLimitOptions,
): DesktopOutputLimitResult {
  const originalBytes = options.originalBytes ?? byteLength(text);
  const inputLines = splitBodyLines(text);
  if (originalBytes <= options.maxBytes) {
    return { text, returnedBodyLines: inputLines.length };
  }

  let bestText = fitUtf8Prefix(
    options.notice({ originalBytes, returnedBodyLines: 0, retainedLines: [] }),
    options.maxBytes,
  );
  let returnedBodyLines = 0;
  // Incremental accounting: the body byte total grows by the line plus one
  // '\n' separator, so each candidate's size is known without re-joining the
  // retained prefix (the naive slice+join per iteration is quadratic). The
  // final body is joined once, after the loop, for the winning count only.
  const retained: string[] = [];
  let bodyBytes = 0;
  let bestNotice: string | undefined;
  for (let count = 1; count <= inputLines.length; count += 1) {
    const line = inputLines[count - 1] ?? '';
    bodyBytes += byteLength(line) + (count > 1 ? 1 : 0);
    // The notice consumes the array synchronously and must not retain it: it
    // keeps growing as the retained prefix extends.
    retained.push(line);
    const notice = options.notice({
      originalBytes,
      returnedBodyLines: count,
      retainedLines: retained,
    });
    // Mirrors joinBodyAndNotice: the '\n\n' separator applies only when both
    // parts are non-empty (a single '' first line yields an empty body).
    const bodyEmpty = count === 1 && line === '';
    const separatorBytes = bodyEmpty || notice === '' ? 0 : 2;
    if (bodyBytes + separatorBytes + byteLength(notice) > options.maxBytes) break;
    bestNotice = notice;
    returnedBodyLines = count;
  }
  if (bestNotice !== undefined) {
    bestText = joinBodyAndNotice(retained.slice(0, returnedBodyLines).join('\n'), bestNotice);
  }

  return buildLimitedResult(
    bestText,
    'prefix_lines',
    originalBytes,
    options.maxBytes,
    returnedBodyLines,
  );
}

export function limitDesktopHeadTailLines(
  text: string,
  options: OutputLimitOptions,
): DesktopOutputLimitResult {
  const originalBytes = byteLength(text);
  const inputLines = splitBodyLines(text);
  if (originalBytes <= options.maxBytes) {
    return { text, returnedBodyLines: inputLines.length };
  }

  const notice = fitUtf8Prefix(
    options.notice({ originalBytes, returnedBodyLines: 0, retainedLines: [] }),
    options.maxBytes,
  );
  const separatorBytes = byteLength('\n\n') * 2;
  const bodyBudget = Math.max(0, options.maxBytes - byteLength(notice) - separatorBytes);
  const headBudget = Math.floor(bodyBudget * 0.45);
  const tailBudget = bodyBudget - headBudget;

  const wholeHead = takeWholeLinesFromStart(inputLines, headBudget);
  const oversizedHead =
    wholeHead.count === 0 && byteLength(inputLines[0] ?? '') > headBudget
      ? fitUtf8Prefix(inputLines[0] ?? '', headBudget)
      : '';
  const head = oversizedHead ? { text: oversizedHead, count: 0 } : wholeHead;

  const tailInput = inputLines.slice(wholeHead.count);
  const wholeTail = takeWholeLinesFromEnd(tailInput, tailBudget);
  const boundaryIndex = tailInput.length - wholeTail.count - 1;
  const oversizedTailLine = boundaryIndex >= 0 ? (tailInput[boundaryIndex] ?? '') : '';
  const tailJoinBytes = wholeTail.text.length > 0 ? byteLength('\n') : 0;
  const tailFragmentBudget = Math.max(0, tailBudget - byteLength(wholeTail.text) - tailJoinBytes);
  const oversizedTail =
    byteLength(oversizedTailLine) > tailBudget && tailFragmentBudget > 0
      ? fitUtf8Suffix(oversizedTailLine, tailFragmentBudget)
      : '';
  const tail = oversizedTail
    ? {
        text: wholeTail.text ? `${oversizedTail}\n${wholeTail.text}` : oversizedTail,
        count: wholeTail.count,
      }
    : wholeTail;

  const pieces = [head.text, notice, tail.text].filter((piece) => piece.length > 0);
  let limitedText = pieces.join('\n\n');
  if (byteLength(limitedText) > options.maxBytes) {
    limitedText = fitUtf8Prefix(limitedText, options.maxBytes);
  }

  return buildLimitedResult(
    limitedText,
    'head_tail_lines',
    originalBytes,
    options.maxBytes,
    wholeHead.count + wholeTail.count + (oversizedHead ? 1 : 0) + (oversizedTail ? 1 : 0),
  );
}

export function applyDesktopTextLimit(
  result: ToolResult,
  limited: DesktopOutputLimitResult,
): ToolResult {
  if (!limited.truncation) return result;

  let replaced = false;
  const content: ToolResultContent[] = [];
  for (const block of result.content) {
    if (block.type !== 'text') {
      content.push(block);
      continue;
    }
    if (replaced) continue;
    replaced = true;
    content.push({ ...block, text: limited.text });
  }
  if (!replaced) content.unshift({ type: 'text', text: limited.text });

  const continuation = limited.truncation.continuation_hint
    ? createDesktopOutputContinuation({
        ...(limited.truncation.next_offset === undefined
          ? {}
          : { next_offset: limited.truncation.next_offset }),
        ...(limited.truncation.offset_unit === undefined
          ? {}
          : { offset_unit: limited.truncation.offset_unit }),
        continuation_hint: limited.truncation.continuation_hint,
      })
    : undefined;

  return {
    ...result,
    text: limited.text,
    content,
    details: {
      ...(result.details ?? {}),
      desktop_output_truncation: limited.truncation,
      ...(continuation ? { desktop_output_continuation: continuation } : {}),
    },
  };
}

export function createDesktopOutputContinuation(
  continuation: Omit<DesktopOutputContinuation, 'has_more'>,
): DesktopOutputContinuation {
  return { has_more: true, ...continuation };
}

export function withDesktopOutputContinuation(
  limited: DesktopOutputLimitResult,
  continuation: Omit<DesktopOutputContinuation, 'has_more'>,
): DesktopOutputLimitResult {
  if (!limited.truncation) return limited;
  return {
    ...limited,
    truncation: {
      ...limited.truncation,
      ...continuation,
    },
  };
}

function buildLimitedResult(
  text: string,
  strategy: DesktopOutputLimitStrategy,
  originalBytes: number,
  maxBytes: number,
  returnedBodyLines: number,
): DesktopOutputLimitResult {
  return {
    text,
    returnedBodyLines,
    truncation: {
      truncated: true,
      has_more: true,
      strategy,
      original_bytes: originalBytes,
      returned_bytes: byteLength(text),
      max_bytes: maxBytes,
    },
  };
}

function splitBodyLines(text: string): string[] {
  const body = text.replace(/\n+$/, '');
  return body ? body.split('\n') : [];
}

function takeWholeLinesFromStart(
  lines: readonly string[],
  maxBytes: number,
): { text: string; count: number } {
  // Incremental byte accounting mirrors the joined candidate's length:
  // every accepted line after the first costs its bytes plus one '\n'.
  const kept: string[] = [];
  let keptBytes = 0;
  for (const line of lines) {
    const lineBytes = byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (keptBytes + lineBytes > maxBytes) break;
    kept.push(line);
    keptBytes += lineBytes;
  }
  return { text: kept.join('\n'), count: kept.length };
}

function takeWholeLinesFromEnd(
  lines: readonly string[],
  maxBytes: number,
): { text: string; count: number } {
  // Mirrored accounting: the last accepted line costs its bytes alone, every
  // earlier one adds a '\n'. Collected in reverse, flipped once at the end so
  // there is no per-line unshift copy.
  const collected: string[] = [];
  let keptBytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const lineBytes = byteLength(line) + (collected.length > 0 ? 1 : 0);
    if (keptBytes + lineBytes > maxBytes) break;
    collected.push(line);
    keptBytes += lineBytes;
  }
  collected.reverse();
  return { text: collected.join('\n'), count: collected.length };
}

function joinBodyAndNotice(body: string, notice: string): string {
  if (!body) return notice;
  if (!notice) return body;
  return `${body}\n\n${notice}`;
}

function fitUtf8Prefix(text: string, maxBytes: number): string {
  // Byte-length first: no copy is made just to discover the text already fits.
  if (byteLength(text) <= maxBytes) return text;
  // The text overflows. Every UTF-16 code unit encodes to at least one UTF-8
  // byte, so the first `maxBytes` code units always carry at least `maxBytes`
  // bytes: buffering that bounded slice never copies the whole (potentially
  // single-line) payload. A surrogate pair split at the slice edge decodes to
  // U+FFFD at or after the cut, and the boundary walk below lands on the same
  // offset as it would with the full buffer.
  const bounded = text.length <= maxBytes ? text : text.slice(0, maxBytes);
  const buffer = Buffer.from(bounded, 'utf8');
  let end = Math.min(Math.max(0, maxBytes), buffer.length);
  while (end > 0 && isUtf8Continuation(buffer[end])) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function fitUtf8Suffix(text: string, maxBytes: number): string {
  // Byte-length first: no copy is made just to discover the text already fits.
  if (byteLength(text) <= maxBytes) return text;
  // The text overflows. The bounded slice keeps one leading code unit of
  // context so a surrogate pair straddling the cut stays intact: its bytes
  // are then encoded identically to the full buffer, the last `maxBytes`
  // bytes of both buffers coincide, and the boundary walk below lands on the
  // same offset it would with the whole (potentially single-line) payload.
  const bounded = text.length <= maxBytes + 1 ? text : text.slice(-(maxBytes + 1));
  const buffer = Buffer.from(bounded, 'utf8');
  let start = Math.max(0, buffer.length - Math.max(0, maxBytes));
  while (start < buffer.length && isUtf8Continuation(buffer[start])) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
