import type { ToolResult, ToolResultContent } from '@mavis/agent-core/tools';

import {
  applyDesktopTextLimit,
  withDesktopOutputContinuation,
  type DesktopOutputContinuationHint,
} from '../desktop/output-limit.js';
import type { ToolOutputSpill } from './spill.js';
import { base64SpillFromHook, isCasSpillFatalError } from './cas-spill.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateTail } from './truncate.js';

export interface ToolResultTruncationOptions {
  /**
   * Optional full-output sink (CAS-backed implementation arrives later). When
   * provided and the text is truncated, the complete payload is delegated to
   * `spill` and a returned reference is surfaced in the notice, the
   * continuation hint, and `details.spill_reference`.
   */
  readonly spill?: ToolOutputSpill;
  /** Maximum lines kept (default: 2000). */
  readonly maxLines?: number;
  /** Maximum bytes kept for the head+tail body (default: 50KB). */
  readonly maxBytes?: number;
  /** Share of the body byte budget given to the head, 0..1 (default 0.5). */
  readonly headShare?: number;
  /**
   * Continuation hint stored with the truncation. Defaults to a generic hint
   * that points at the spill reference when one exists.
   */
  readonly continuation?: DesktopOutputContinuationHint;
}

/**
 * Truncate the text of a tool result before it is recorded, ported from pi's
 * truncation limits (2000 lines / 50KB, whichever is hit first).
 *
 * - Text is cut head+tail with a continuation hint, reusing the desktop
 *   output-limit conventions (`desktop_output_truncation` /
 *   `desktop_output_continuation` details).
 * - The full output is delegated to the optional `spill` hook; without the
 *   hook the result is truncated without a full-output reference.
 *
 * Non-text blocks (SE-F1-003, implemented): a result carrying non-text blocks
 * no longer bypasses the seam. Inline base64 `image` blocks are externalized
 * into the spill sink — the store dedups by the sha256 of the decoded bytes,
 * so the same image is never stored twice — and replaced with the canonical
 * `[image: cas://sha256/<digest>#<size>]` text placeholder, the same
 * reference shape and placeholder convention the v2 importer and the wire
 * compiler publish. Blocks that cannot be externalized (no hook, hook
 * without a base64-native put, non-fatal hook failure, or video/documents,
 * which have no inline-base64 contract here) stay untouched, and the text
 * part is truncated exactly like a text-only result.
 *
 * A FATAL store failure (ENOSPC/EDQUOT/EACCES/EPERM/EROFS/EIO — the
 * `@mavis/cas` fatal family) is never converted into an inline block: the
 * image path fails this result loudly (the hook throws
 * `CasSpillFatalError`, which propagates), and the text path rethrows it
 * from {@link spillFullOutput} — a silently unreferenced full payload on a
 * broken volume is the same "worse outcome" the v2 importer refuses.
 */
export async function truncateToolResultText(
  result: ToolResult,
  options: ToolResultTruncationOptions = {},
): Promise<ToolResult> {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const headShare = normalizeHeadShare(options.headShare);

  // Cheap byte gate first: it decides the common short-output case. The line
  // count below is still a single allocation-free pass, and it is needed in
  // every non-returning path (the notice reports it), so no second gate can
  // skip it.
  const originalBytes = byteLength(result.text);
  const originalLines = countLines(result.text);
  const textOverflows = originalLines > maxLines || originalBytes > maxBytes;
  const hasNonText = result.content.some((block) => block.type !== 'text');
  if (!textOverflows && !hasNonText) return result;

  let output: ToolResult;
  if (!textOverflows) {
    // The text fits; only the non-text path below applies.
    output = result;
  } else {
    // Spill first: the notice must know whether a full-output reference exists
    // so the model always keeps a way back to the complete payload.
    const spillReference = await spillFullOutput(options.spill, result.text);
    const notice = buildTruncationNotice({ originalLines, originalBytes, spillReference });

    // Reserve room for the notice so body + notice never exceed maxBytes. The
    // extra byte covers the '\n' join between the head and tail parts.
    const separatorBytes = byteLength('\n\n') * 2 + byteLength('\n');
    const bodyBudget = Math.max(0, maxBytes - byteLength(notice) - separatorBytes);
    const headBudget = Math.max(1, Math.floor(bodyBudget * headShare));
    const tailBudget = Math.max(1, bodyBudget - Math.floor(bodyBudget * headShare));

    const { headSource, tailSource } = partitionForHeadTail(result.text);
    // The line budget is split across the halves so the total kept lines never
    // exceeds maxLines even when the byte limits do not bind.
    const headLines = Math.ceil(maxLines / 2);
    const tailLines = Math.floor(maxLines / 2);
    const head = truncateHead(headSource, { maxLines: headLines, maxBytes: headBudget });
    const tail = truncateTail(tailSource, { maxLines: tailLines, maxBytes: tailBudget });

    // Desktop head_tail_lines convention: the notice sits between the retained
    // head and tail so both ends stay adjacent to their continuation context.
    const pieces = [head.content, notice, tail.content].filter((piece) => piece.length > 0);
    let text = pieces.join('\n\n');
    // A notice can overflow the budget on its own (for example a long spill
    // reference at a small maxBytes); clamp like the desktop limiters do.
    if (byteLength(text) > maxBytes) {
      text = fitUtf8Prefix(text, maxBytes);
    }

    const limited = withDesktopOutputContinuation(
      {
        text,
        returnedBodyLines: head.outputLines + tail.outputLines,
        truncation: {
          truncated: true,
          has_more: true,
          strategy: 'head_tail_lines',
          original_bytes: originalBytes,
          returned_bytes: byteLength(text),
          max_bytes: maxBytes,
        },
      },
      { continuation_hint: options.continuation ?? createGenericContinuationHint(spillReference) },
    );

    const applied = applyDesktopTextLimit(result, limited);
    output =
      spillReference === undefined
        ? applied
        : { ...applied, details: { ...(applied.details ?? {}), spill_reference: spillReference } };
  }

  return hasNonText ? externalizeInlineImages(output, options.spill) : output;
}

/**
 * Replace inline base64 image blocks with `[image: cas://…]` text placeholders
 * backed by the spill sink. Best-effort per block: a hook without a
 * base64-native put, or a non-fatal failing store (reported by the hook's
 * diagnostics channel), keeps that block inline. A FATAL store error
 * (`CasSpillFatalError`) propagates — the result is never completed with the
 * image left inline. Video and document blocks have no inline-base64
 * contract here and always stay.
 */
async function externalizeInlineImages(
  result: ToolResult,
  spill: ToolOutputSpill | undefined,
): Promise<ToolResult> {
  if (!spill) return result;
  const spillBase64 = base64SpillFromHook(spill);
  if (!spillBase64) return result;
  let externalized = false;
  const content = await Promise.all(
    result.content.map(async (block): Promise<ToolResultContent> => {
      if (block.type !== 'image' || block.data.length === 0) return block;
      const reference = await spillBase64(block.data);
      if (reference === undefined) return block;
      externalized = true;
      return { type: 'text', text: `[image: ${reference}]` };
    }),
  );
  if (!externalized) return result;
  return { ...result, content };
}

/** Build the default continuation hint for a truncated result. */
export function createGenericContinuationHint(
  spillReference?: string,
): DesktopOutputContinuationHint {
  return {
    tool: 'generic',
    preserve_args: [],
    instruction: spillReference
      ? `The output was truncated; the complete output is available at ${spillReference}. Retrieve it before relying on the preview alone.`
      : 'The output was truncated; rerun the tool with narrower arguments if the omitted remainder is needed.',
  };
}

/**
 * Split the payload into non-overlapping head and tail sources at the middle
 * line so head and tail truncation can never duplicate or overwrite content.
 *
 * The halves are plain string slices around the offset of the middle line:
 * no `split('\n')` of the whole payload and no join of the halves. The only
 * adjustment is dropping one trailing '\n' from each slice, which keeps them
 * byte-identical to the line-array join this used to perform.
 */
function partitionForHeadTail(content: string): { headSource: string; tailSource: string } {
  const middle = Math.floor(countLines(content) / 2);
  if (middle === 0) {
    return { headSource: '', tailSource: withoutTrailingNewline(content) };
  }
  // Walk to the start of line `middle`: every '\n' terminates one line.
  let lineBreaks = 0;
  let offset = 0;
  while (lineBreaks < middle && offset < content.length) {
    if (content.charCodeAt(offset) === 10) lineBreaks += 1;
    offset += 1;
  }
  return {
    headSource: withoutTrailingNewline(content.slice(0, offset)),
    tailSource: withoutTrailingNewline(content.slice(offset)),
  };
}

function withoutTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function buildTruncationNotice(context: {
  originalLines: number;
  originalBytes: number;
  spillReference?: string;
}): string {
  const spillPart = context.spillReference
    ? ` Full output: ${context.spillReference}.`
    : ' Rerun with narrower arguments if the omitted remainder is needed.';
  return (
    `[output truncated: head+tail shown; original_lines=${context.originalLines}; ` +
    `original_bytes=${context.originalBytes}.${spillPart}]`
  );
}

/**
 * Delegate the full payload to the spill hook. Best-effort: a non-fatal
 * failing sink keeps the result usable without a full-output reference. A
 * fatal store error (`CasSpillFatalError`) is rethrown — on a broken volume
 * the truncation must not pretend the complete payload is retrievable.
 */
async function spillFullOutput(
  spill: ToolOutputSpill | undefined,
  payload: string,
): Promise<string | undefined> {
  if (!spill) return undefined;
  try {
    return await spill.spill(payload);
  } catch (error) {
    if (isCasSpillFatalError(error)) throw error;
    return undefined;
  }
}

function normalizeHeadShare(headShare: number | undefined): number {
  if (headShare === undefined || !Number.isFinite(headShare)) return 0.5;
  return Math.min(1, Math.max(0, headShare));
}

/**
 * Line count with pi semantics: a trailing '\n' does not start a new line.
 * Single allocation-free pass — no split of the whole payload into an array.
 */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return content.endsWith('\n') ? lines - 1 : lines;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function fitUtf8Prefix(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && isUtf8Continuation(buffer[end])) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}
