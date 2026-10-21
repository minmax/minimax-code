import { createReadStream } from 'node:fs';
import { join } from 'node:path';

import {
  decodeV2Envelope,
  isV2ImageBlock,
  V2SessionFormatError,
  type V2ContentBlock,
  type V2Envelope,
} from './envelope.js';
import {
  parseCasSpillRef,
  resolveImageHook,
  type CasIssueListener,
  type CasUnavailablePolicy,
  type CasImageOption,
} from './cas-image-hook.js';

/** Name of the canonical history file inside a v2 session directory. */
export const V2_MESSAGES_FILE = 'messages.jsonl';

/**
 * Hard cap on the bytes a single history line may occupy. A canonical record
 * with inline images stays well below this; anything above it is a corrupt or
 * hostile file, and buffering it unbounded would be a denial of service. The
 * scanner fails the offending line with {@link V2SessionFormatError} instead
 * of materializing it.
 */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface V2SessionStats {
  /**
   * Byte length of `messages.jsonl` observed during the same scan that
   * counted `lines` — one consistent snapshot, not a separate `stat()` call
   * that a concurrent writer could desynchronize.
   */
  readonly bytes: number;
  /** Number of non-empty history lines, counted by the same streaming scan. */
  readonly lines: number;
  /**
   * Records that failed envelope validation during the scan. Always `0`
   * unless validation ran; pass `validate: false` for a cheap size/line
   * count of a file already known to be well-formed.
   */
  readonly malformedLines: number;
}

export interface V2StatsOptions {
  /**
   * Validate every record (default `true`): each line is decoded and counted
   * in `malformedLines` instead of a broken file passing silently behind a
   * stub visitor.
   */
  readonly validate?: boolean;
  /** Line-length cap; see {@link MAX_LINE_BYTES}. */
  readonly maxLineBytes?: number;
}

/** Result of a streaming read: records delivered and malformed lines skipped. */
export interface ReadEnvelopesResult {
  /** Non-empty records handed to the visitor. */
  readonly lines: number;
  /** Malformed records skipped (`formatErrors: 'skip'` only; `0` in strict mode). */
  readonly skipped: number;
}

export interface ReadEnvelopesOptions {
  /**
   * Policy for a malformed line: `'strict'` (default) rejects the whole read
   * with the first {@link V2SessionFormatError}; `'skip'` reports the error
   * through `onFormatError` and continues with the next record, so one bad
   * line no longer fails an entire history read.
   */
  readonly formatErrors?: 'strict' | 'skip';
  /** Receives every skipped {@link V2SessionFormatError} in `'skip'` mode. */
  readonly onFormatError?: (error: V2SessionFormatError) => void;
  /** Line-length cap; see {@link MAX_LINE_BYTES}. */
  readonly maxLineBytes?: number;
}

/** Visitor invoked per decoded record: the line, its 1-based record number, and its physical line in the file. */
export type V2EnvelopeVisitor = (envelope: V2Envelope, lineNo: number, physicalLine: number) => void | Promise<void>;

export interface V2SessionReader {
  /** Absolute-ish path of the streamed `messages.jsonl` (inside `sessionDir`). */
  readonly messagesPath: string;
  /**
   * Streams the history line by line and hands each decoded envelope to
   * `visit`. The file is never fully materialized: only the current line is
   * held in memory (bounded by `maxLineBytes`), and an async `visit` applies
   * backpressure. Blank lines are skipped. Malformed lines follow the
   * `formatErrors` policy (`'strict'` throws, `'skip'` reports and continues).
   */
  readEnvelopes(
    visit: V2EnvelopeVisitor,
    options?: ReadEnvelopesOptions,
  ): Promise<ReadEnvelopesResult>;
  stats(options?: V2StatsOptions): Promise<V2SessionStats>;
  /**
   * Streams every record into the target in file order, replacing inline
   * `image` content blocks through the image hook. Supports resume (`resumeAfterLine`)
   * and, for targets implementing `putEntries`, ordered batch delivery. The
   * source session is never modified.
   */
  importTo(target: V2ImportTarget, options?: V2ImportOptions): Promise<ImportStats>;
}

/** Import sink for an imported v2 history. */
export interface V2ImportTarget {
  /** Called once per envelope in file order (always, when `putEntries` is absent). */
  putEntry(envelope: V2Envelope): Promise<void>;
  /**
   * Optional batch sink: when present, `importTo` delivers records in ordered
   * batches of `batchSize` instead of one call per line, letting the target
   * wrap a batch in a single transaction. Either this or `putEntry` must be
   * able to hold the whole import — a batch that throws fails the import.
   */
  putEntries?(envelopes: readonly V2Envelope[]): Promise<void>;
}

/**
 * Image externalization hook: the CAS integration point of the import.
 *
 * Contract: the hook receives the raw base64 payload of an `image` content
 * block and returns a canonical `cas://sha256/<digest>#<size>` descriptor —
 * one that {@link parseCasSpillRef} accepts — or `undefined` to keep the
 * block inline. A hook that returns anything else is treated as a decline
 * (the block stays inline and is counted as such), so a broken custom hook
 * can never write a foreign descriptor into the durable log. Decoding and
 * storage belong entirely to the hook; the import never inspects the bytes.
 */
export type V2ImageHook = (base64: string) => Promise<string | undefined>;

/**
 * Import options. Image externalization is ON by default: without an explicit
 * `onImage`, inline base64 `image` blocks are stored in the CAS at the
 * durable data root and replaced with `image_ref` blocks (see
 * `resolveImageHook`). Pass `cas: null` (or an explicit `onImage`) to change
 * that: `cas` may be a store instance, a CAS root directory, or `null`.
 */
export interface V2ImportOptions {
	readonly onImage?: V2ImageHook;
	/** Store instance, CAS root directory, or `null` to keep images inline. */
	readonly cas?: CasImageOption;
	/**
	 * Policy when the CAS cannot be opened at all: `'fail'` (default) rejects
	 * the import with `CasSpillError`; `'keep-inline'` reports the issue to
	 * `onIssue` and keeps every image inline — an explicit degradation, never
	 * a silent one.
	 */
	readonly casUnavailable?: CasUnavailablePolicy;
	/** Receives every non-fatal CAS issue (degradations, rejected payloads). */
	readonly onIssue?: CasIssueListener;
	/**
	 * Resume cursor: records with a line number <= this value are skipped, so
	 * an interrupted import continues where the previous run stopped. Pair it
	 * with a target that commits atomically per batch; `ImportStats.lastLine`
	 * of the previous run is the cursor to pass here.
	 */
	readonly resumeAfterLine?: number;
	/** Batch size for targets implementing `putEntries` (default 128). */
	readonly batchSize?: number;
	/** Line-length cap; see {@link MAX_LINE_BYTES}. */
	readonly maxLineBytes?: number;
}

export interface ImportStats {
  /** Source byte length, observed during the same scan as `lines`. */
  readonly bytes: number;
  /** Records consumed by this run (after the resume cursor was applied). */
  readonly lines: number;
  /** Records delivered to the target. */
  readonly envelopes: number;
  /** Inline `image` content blocks seen across all delivered envelopes. */
  readonly imageBlocks: number;
  /** Image blocks replaced with a canonical `image_ref` descriptor. */
  readonly imagesMigrated: number;
  /**
   * Image blocks kept inline: the hook declined, returned a non-canonical
   * descriptor, or was absent (`cas: null`). With {@link imageBlocks} and
   * {@link imagesMigrated} this always satisfies
   * `imageBlocks === imagesMigrated + imagesInline`.
   */
  readonly imagesInline: number;
  /** Line number of the last record seen; pass as `resumeAfterLine` to resume. `0` when nothing was consumed. */
  readonly lastLine: number;
}

/** Default batch size for targets implementing `putEntries`. */
const DEFAULT_IMPORT_BATCH_SIZE = 128;

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
    readEnvelopes: (visit, options) => readEnvelopes(messagesPath, visit, options),
    stats: (options) => readStats(messagesPath, options),
    importTo: (target, options) => importTo(messagesPath, target, options),
  };
}

async function readEnvelopes(
  messagesPath: string,
  visit: V2EnvelopeVisitor,
  options?: ReadEnvelopesOptions,
): Promise<ReadEnvelopesResult> {
  const skip = options?.formatErrors === 'skip';
  let lines = 0;
  let skipped = 0;
  await scanHistory(
    messagesPath,
    async (line, lineNo, physicalLine) => {
      let envelope: V2Envelope;
      try {
        envelope = parseHistoryLine(line, messagesPath, physicalLine);
      } catch (error) {
        if (!skip || !(error instanceof V2SessionFormatError)) throw error;
        skipped += 1;
        options?.onFormatError?.(error);
        return;
      }
      lines += 1;
      await visit(envelope, lineNo, physicalLine);
    },
    options?.maxLineBytes,
  );
  return { lines, skipped };
}

async function readStats(messagesPath: string, options?: V2StatsOptions): Promise<V2SessionStats> {
  const validate = options?.validate !== false;
  let malformedLines = 0;
  const counters = await scanHistory(
    messagesPath,
    (line, _lineNo, physicalLine) => {
      if (!validate) return;
      try {
        parseHistoryLine(line, messagesPath, physicalLine);
      } catch {
        // Counted, not swallowed: a broken file reports malformedLines > 0
        // instead of passing behind a stub visitor.
        malformedLines += 1;
      }
    },
    options?.maxLineBytes,
  );
  return { bytes: counters.bytes, lines: counters.lines, malformedLines };
}

async function importTo(
  messagesPath: string,
  target: V2ImportTarget,
  options?: V2ImportOptions,
): Promise<ImportStats> {
  // Default ON: without an explicit hook, image blocks are externalized to
  // the CAS (see `resolveImageHook`); `cas: null` keeps them inline.
  const onImage =
    options?.onImage ??
    (await resolveImageHook(options?.cas, {
      onIssue: options?.onIssue,
      casUnavailable: options?.casUnavailable,
    }));
  const resumeAfterLine = options?.resumeAfterLine ?? 0;
  const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE);
  const counters = { envelopes: 0, imageBlocks: 0, imagesMigrated: 0, imagesInline: 0 };
  let lines = 0;
  let lastLine = 0;
  // Batch delivery only when the target opted in; otherwise the per-envelope
  // contract (and its ordering/await semantics) is preserved exactly.
  const putEntries = target.putEntries;
  const batch = putEntries === undefined ? null : ([] as V2Envelope[]);
  const deliver = async (envelope: V2Envelope): Promise<void> => {
    counters.envelopes += 1;
    if (putEntries === undefined || batch === null) {
      await target.putEntry(envelope);
      return;
    }
    batch.push(envelope);
    if (batch.length >= batchSize) {
      await putEntries(batch);
      batch.length = 0;
    }
  };
  const scanCounters = await scanHistory(
    messagesPath,
    async (line, lineNo, physicalLine) => {
      // The cursor tracks the last record SEEN (skipped or consumed), so a
      // run that consumes nothing still reports a cursor that resumes after
      // the file's end instead of rewinding the next run to line 1.
      lastLine = lineNo;
      if (lineNo <= resumeAfterLine) return; // resume: already imported
      const envelope = parseHistoryLine(line, messagesPath, physicalLine);
      const entry = await externalizeImages(envelope, onImage, counters, options?.onIssue);
      lines += 1;
      await deliver(entry);
    },
    options?.maxLineBytes,
  );
  if (batch !== null && putEntries !== undefined && batch.length > 0) {
    await putEntries(batch);
  }
  return { bytes: scanCounters.bytes, lines, lastLine, ...counters };
}

interface ScanCounters {
  readonly bytes: number;
  readonly physicalLines: number;
  readonly lines: number;
}

const NEWLINE = 0x0a;

/**
 * Streams the history file one line at a time with a byte-bounded splitter.
 * Only the current line is held in memory and never more than `maxLineBytes`
 * of it, so a corrupt one-line-gigabyte file fails with a format error
 * instead of being materialized. Blank lines are dropped before counting or
 * visiting; the visitor receives the line, its 1-based record number, and
 * its 1-based physical line in the file (diagnostics point where an editor
 * would). Awaiting `visit` keeps the consumer in control of the pace, so a
 * growing file (a FIFO writer) streams without end-of-file.
 */
async function scanHistory(
  messagesPath: string,
  visit: (line: string, lineNo: number, physicalLine: number) => void | Promise<void>,
  maxLineBytes: number = MAX_LINE_BYTES,
): Promise<ScanCounters> {
  const input = createReadStream(messagesPath);
  let carry: Buffer[] = []; // cross-chunk remainder of the line being read
  let carryBytes = 0;
  let bytes = 0;
  let physicalLines = 0;
  let lines = 0;
  try {
    for await (const chunk of input) {
      const data = chunk as Buffer; // no encoding set: chunks are Buffers
      bytes += data.length;
      let start = 0;
      for (;;) {
        const nl = data.indexOf(NEWLINE, start);
        if (nl === -1) {
          carry.push(data.subarray(start));
          carryBytes += data.length - start;
          break;
        }
        const raw =
          carry.length === 0
            ? data.subarray(start, nl)
            : Buffer.concat([...carry, data.subarray(start, nl)]);
        carry.length = 0;
        carryBytes = 0;
        start = nl + 1;
        physicalLines += 1;
        await emitLine(raw, physicalLines);
      }
      if (carryBytes > maxLineBytes) throw lineTooLong(physicalLines + 1);
    }
    if (carryBytes > 0) {
      // Final line without a trailing newline.
      physicalLines += 1;
      await emitLine(Buffer.concat(carry), physicalLines);
    }
  } finally {
    // Release the descriptor even when a visitor or parse throws mid-stream.
    input.destroy();
  }
  return { bytes, physicalLines, lines };

  function lineTooLong(physicalLine: number): V2SessionFormatError {
    return new V2SessionFormatError(messagesPath, physicalLine, `line exceeds ${maxLineBytes} bytes`);
  }

  async function emitLine(raw: Buffer, physicalLine: number): Promise<void> {
    if (raw.length > maxLineBytes) throw lineTooLong(physicalLine);
    let line = raw.toString('utf8');
    if (line.endsWith('\r')) line = line.slice(0, -1); // CRLF counts as one break
    // Tolerate stray blank lines; canonical records never start with
    // whitespace. The regex fails on the first character of a real line,
    // so checking costs nothing on megabyte-scale lines. Dropped here, they
    // never shift record numbering or format-error line numbers.
    if (line.length === 0 || /^\s*$/u.test(line)) return;
    lines += 1;
    await visit(line, lines, physicalLine);
  }
}

function parseHistoryLine(line: string, filePath: string, physicalLine: number): V2Envelope {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    // V8 may include the source payload in SyntaxError.message. Never surface
    // it in diagnostics: lines can hold megabytes of base64.
    throw new V2SessionFormatError(filePath, physicalLine, 'invalid JSON');
  }
  return decodeV2Envelope(value, filePath, physicalLine);
}

/**
 * Image migration, in place: each envelope was decoded from the current line
 * and is exclusively owned by this import (the source file is never
 * touched), so a replaced block is written into the decoded content array
 * directly — no defensive envelope or content copies on the migration path.
 * Every image block is accounted exactly once: migrated to a canonical
 * `image_ref`, or kept inline (hook absent, hook declined, hook produced a
 * non-canonical descriptor), so
 * `imageBlocks === imagesMigrated + imagesInline` holds after every run.
 */
async function externalizeImages(
  envelope: V2Envelope,
  onImage: V2ImageHook | undefined,
  counters: { imageBlocks: number; imagesMigrated: number; imagesInline: number },
  onIssue?: CasIssueListener,
): Promise<V2Envelope> {
  const content = envelope.message.content;
  if (content === undefined) return envelope;
  const blocks = content as V2ContentBlock[]; // decoded fresh this line; owned here
  for (const [index, block] of blocks.entries()) {
    if (!isV2ImageBlock(block)) continue;
    counters.imageBlocks += 1;
    if (onImage === undefined) {
      // No hook: the block stays inline and is counted as such, keeping the
      // stats invariant intact instead of losing the block between counters.
      counters.imagesInline += 1;
      continue;
    }
    const blob = await onImage(block.data);
    if (blob === undefined || parseCasSpillRef(blob) === null) {
      // Declined, or a foreign descriptor a parser would choke on: keep the
      // block inline (counted) rather than write an unparsable reference.
      if (blob !== undefined) {
        onIssue?.({
          kind: 'invalid-blob-ref',
          message: 'image hook returned a non-canonical descriptor; keeping the block inline',
        });
      }
      counters.imagesInline += 1;
      continue;
    }
    counters.imagesMigrated += 1;
    blocks[index] = { type: 'image_ref', blob };
  }
  return envelope;
}
