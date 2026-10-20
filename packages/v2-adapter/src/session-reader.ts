import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import {
  decodeV2Envelope,
  isV2ImageBlock,
  V2SessionFormatError,
  type V2ContentBlock,
  type V2Envelope,
} from './envelope.js';

/** Name of the canonical history file inside a v2 session directory. */
export const V2_MESSAGES_FILE = 'messages.jsonl';

export interface V2SessionStats {
  /** Size of `messages.jsonl` in bytes (from the filesystem). */
  readonly bytes: number;
  /** Number of non-empty history lines, counted by a streaming scan. */
  readonly lines: number;
}

/** Callback invoked once per decoded envelope, in file order. */
export type V2EnvelopeVisitor = (envelope: V2Envelope) => void | Promise<void>;

export interface V2SessionReader {
  /** Absolute-ish path of the streamed `messages.jsonl` (inside `sessionDir`). */
  readonly messagesPath: string;
  /**
   * Streams the history line by line and hands each decoded envelope to
   * `visit`. The file is never fully materialized: only the current line is
   * held in memory, and an async `visit` applies backpressure. Blank lines are
   * skipped. Throws {@link V2SessionFormatError} for a malformed line.
   */
  readEnvelopes(visit: V2EnvelopeVisitor): Promise<void>;
  stats(): Promise<V2SessionStats>;
  /**
   * Streams every envelope into `target.putEntry` in file order, replacing
   * inline `image` content blocks through the {@link V2ImportOptions.onImage}
   * hook. The source session is never modified.
   */
  importTo(target: V2ImportTarget, options?: V2ImportOptions): Promise<ImportStats>;
}

/** Import sink for an imported v2 history; called once per envelope. */
export interface V2ImportTarget {
  putEntry(envelope: V2Envelope): Promise<void>;
}

/**
 * Image externalization hook: the CAS integration point of the import.
 *
 * It receives the raw base64 payload of an `image` content block (a CAS
 * implementation decodes it with `Buffer.from(base64, 'base64')` before
 * `CAS.putImage`). Returning a blob descriptor replaces the block with
 * `{ type: 'image_ref', blob }`; returning `undefined` keeps the block inline.
 */
export type V2ImageHook = (base64: string) => Promise<string | undefined>;

export interface V2ImportOptions {
  readonly onImage?: V2ImageHook;
}

export interface ImportStats {
  /** Source file size in bytes. */
  readonly bytes: number;
  /** Non-empty source lines streamed. */
  readonly lines: number;
  /** Envelopes delivered to `putEntry`. */
  readonly envelopes: number;
  /** Inline `image` content blocks seen across all envelopes. */
  readonly imageBlocks: number;
  /** Image blocks replaced with `image_ref` (hook returned a descriptor). */
  readonly imagesMigrated: number;
  /** Image blocks kept inline (hook returned `undefined`). */
  readonly imagesInline: number;
}

/**
 * Opens a legacy v2 session directory (`messages.jsonl` and siblings) for
 * read-only streaming. Opening performs no I/O; the directory contents are
 * never modified by any reader method.
 */
export function openV2Session(sessionDir: string): V2SessionReader {
  if (typeof sessionDir !== 'string' || sessionDir.length === 0) {
    throw new TypeError('sessionDir must be a non-empty directory path');
  }
  const messagesPath = join(sessionDir, V2_MESSAGES_FILE);
  return {
    messagesPath,
    readEnvelopes: (visit) => readEnvelopes(messagesPath, visit),
    stats: () => readStats(messagesPath),
    importTo: (target, options) => importTo(messagesPath, target, options),
  };
}

async function readEnvelopes(
  messagesPath: string,
  visit: V2EnvelopeVisitor,
): Promise<void> {
  await forEachHistoryLine(messagesPath, (line, lineNo) => {
    return visit(parseHistoryLine(line, messagesPath, lineNo));
  });
}

async function readStats(messagesPath: string): Promise<V2SessionStats> {
  const [fileStat, lines] = await Promise.all([
    stat(messagesPath),
    forEachHistoryLine(messagesPath, () => {}),
  ]);
  return { bytes: fileStat.size, lines };
}

async function importTo(
  messagesPath: string,
  target: V2ImportTarget,
  options?: V2ImportOptions,
): Promise<ImportStats> {
  const onImage = options?.onImage;
  const { size } = await stat(messagesPath);
  const counters = { envelopes: 0, imageBlocks: 0, imagesMigrated: 0, imagesInline: 0 };
  let lines = 0;
  await forEachHistoryLine(messagesPath, async (line, lineNo) => {
    lines = lineNo;
    const envelope = parseHistoryLine(line, messagesPath, lineNo);
    const entry = await externalizeImages(envelope, onImage, counters);
    await target.putEntry(entry);
    counters.envelopes += 1;
  });
  return { bytes: size, lines, ...counters };
}

/**
 * Streams the history file one line at a time through a readline interface.
 * Only the current line is held in memory, so multi-megabyte base64 lines
 * never accumulate into a whole-file buffer; awaiting `visit` keeps the
 * consumer in control of the pace. Returns the number of non-empty lines.
 */
async function forEachHistoryLine(
  messagesPath: string,
  visit: (line: string, lineNo: number) => void | Promise<void>,
): Promise<number> {
  const input = createReadStream(messagesPath);
  const rl = createInterface({ input, crlfDelay: Infinity });
  let lines = 0;
  try {
    for await (const line of rl) {
      // Tolerate stray blank lines; canonical records never start with
      // whitespace. The regex fails on the first character of a real line,
      // so checking costs nothing on the megabyte-scale lines.
      if (line.length === 0 || /^\s*$/u.test(line)) continue;
      lines += 1;
      await visit(line, lines);
    }
  } finally {
    // Release the descriptor even when a visitor or parse throws mid-stream.
    rl.close();
    input.destroy();
  }
  return lines;
}

function parseHistoryLine(line: string, filePath: string, lineNo: number): V2Envelope {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    // V8 may include the source payload in SyntaxError.message. Never surface
    // it in diagnostics: lines can hold megabytes of base64.
    throw new V2SessionFormatError(filePath, lineNo, 'invalid JSON');
  }
  return decodeV2Envelope(value, filePath, lineNo);
}

/**
 * Copy-on-write image migration: envelopes without replacements are passed
 * through untouched; a replaced block becomes
 * `{ type: 'image_ref', blob: <descriptor> }`. With no hook the walk only
 * counts the image blocks for the import stats.
 */
async function externalizeImages(
  envelope: V2Envelope,
  onImage: V2ImageHook | undefined,
  counters: { imageBlocks: number; imagesMigrated: number; imagesInline: number },
): Promise<V2Envelope> {
  const content = envelope.message.content;
  if (content === undefined) return envelope;
  let migrated: V2ContentBlock[] | undefined;
  for (const [index, block] of content.entries()) {
    if (!isV2ImageBlock(block)) continue;
    counters.imageBlocks += 1;
    if (onImage === undefined) continue;
    const blob = await onImage(block.data);
    if (blob === undefined) {
      // The hook declined; the block stays inline base64.
      counters.imagesInline += 1;
      continue;
    }
    counters.imagesMigrated += 1;
    (migrated ??= [...content])[index] = { type: 'image_ref', blob };
  }
  if (migrated === undefined) return envelope;
  return { ...envelope, message: { ...envelope.message, content: migrated } };
}
