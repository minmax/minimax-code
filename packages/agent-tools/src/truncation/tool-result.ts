import type { ToolResult } from '@mavis/agent-core/tools';

import {
  applyDesktopTextLimit,
  withDesktopOutputContinuation,
  type DesktopOutputContinuationHint,
} from '../desktop/output-limit.js';
import type { ToolOutputSpill } from './spill.js';
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
 * - Results carrying non-text blocks (images, video, documents) are returned
 *   untouched: their spill path is owned by the CAS integrator at a later
 *   step.
 */
export async function truncateToolResultText(
  result: ToolResult,
  options: ToolResultTruncationOptions = {},
): Promise<ToolResult> {
  if (result.content.some((block) => block.type !== 'text')) return result;

  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const headShare = normalizeHeadShare(options.headShare);

  const originalBytes = byteLength(result.text);
  const originalLines = countLines(result.text);
  if (originalLines <= maxLines && originalBytes <= maxBytes) return result;

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
  if (!spillReference) return applied;
  return {
    ...applied,
    details: { ...(applied.details ?? {}), spill_reference: spillReference },
  };
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
 */
function partitionForHeadTail(content: string): { headSource: string; tailSource: string } {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  const middle = Math.floor(lines.length / 2);
  return {
    headSource: lines.slice(0, middle).join('\n'),
    tailSource: lines.slice(middle).join('\n'),
  };
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
 * Delegate the full payload to the spill hook. Best-effort: a failing sink
 * keeps the result usable without a full-output reference.
 */
async function spillFullOutput(
  spill: ToolOutputSpill | undefined,
  payload: string,
): Promise<string | undefined> {
  if (!spill) return undefined;
  try {
    return await spill.spill(payload);
  } catch {
    return undefined;
  }
}

function normalizeHeadShare(headShare: number | undefined): number {
  if (headShare === undefined || !Number.isFinite(headShare)) return 0.5;
  return Math.min(1, Math.max(0, headShare));
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines.length;
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
