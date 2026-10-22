/**
 * Projection of the raw session log into the model-visible context window.
 *
 * The log is append-only and never rewritten: compaction checkpoints and
 * context-edit omissions are plain entries that the projection interprets.
 * The projection applies, in order:
 *
 * 1. omissions — entries targeted by a `mcode.context_edit` omission disappear;
 * 2. the LAST `mcode.compaction` checkpoint — everything before its
 *    `firstKeptEntryId` collapses into the checkpoint's summary (a single
 *    user message), and its frozen `systemMessage` replaces the current one.
 *
 * The original entries stay in the log; projecting is pure derivation.
 *
 * @module
 */

import {
  COMPACTION_ENTRY_KIND,
  CONTEXT_EDIT_ENTRY_KIND,
  MESSAGE_ENTRY_KIND,
  SYSTEM_ENTRY_KIND,
  type CompactionEntryPayload,
  type CompactionMessage,
  type ContextEditOmissionPayload,
  type LogEntry,
  type ProjectedContext,
  type ProjectedEntry,
} from './types.js';
import { isCompactionMessagePayload } from './entries.js';

/** Thrown when a compaction checkpoint references an unknown first-kept entry. */
export class UnknownFirstKeptEntryError extends Error {
  override readonly name = 'UnknownFirstKeptEntryError';

  constructor(readonly entryId: string, readonly firstKeptEntryId: string) {
    super(`compaction entry ${entryId} references unknown firstKeptEntryId ${firstKeptEntryId}`);
  }
}

interface CompactionMarker {
  readonly index: number;
  readonly payload: CompactionEntryPayload;
}

function isPayloadObject(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === 'object' && payload !== null;
}

function parseCompactionPayload(entry: LogEntry): CompactionEntryPayload | undefined {
  if (entry.kind !== COMPACTION_ENTRY_KIND || !isPayloadObject(entry.payload)) return undefined;
  const payload = entry.payload;
  if (typeof payload.summary !== 'string' || typeof payload.firstKeptEntryId !== 'string') return undefined;
  // `systemMessage: string | null` is part of the declared payload contract.
  // A non-string value — a missing field included — would otherwise reach the
  // winner rule below (`undefined !== null`), project `undefined` as the
  // system prompt, and desynchronize every consumer: the usage tracker froze
  // it and its `usage()` threw on every later call while this oracle
  // (`windowManifestBytes` / `estimateProjectedContextTokens`) tolerated the
  // shape. The record is MALFORMED — plain audit noise, exactly like a
  // payload without a summary.
  if (typeof payload.systemMessage !== 'string' && payload.systemMessage !== null) return undefined;
  return payload as unknown as CompactionEntryPayload;
}

function parseOmissionPayload(entry: LogEntry): ContextEditOmissionPayload | undefined {
  if (entry.kind !== CONTEXT_EDIT_ENTRY_KIND || !isPayloadObject(entry.payload)) return undefined;
  const payload = entry.payload;
  if (payload.action !== 'omission' || !Array.isArray(payload.targetIds)) return undefined;
  return payload as unknown as ContextEditOmissionPayload;
}

function messageOf(entry: LogEntry): CompactionMessage | undefined {
  if (entry.kind !== MESSAGE_ENTRY_KIND) return undefined;
  // A malformed payload (no role, wrong content shape) projects NOTHING —
  // dead weight, exactly like the usage tracker treats it. Letting it through
  // would make the estimator return `undefined` and poison window totals.
  return isCompactionMessagePayload(entry.payload) ? entry.payload : undefined;
}

/**
 * Project the raw log into the visible context window. Entries align 1:1 with
 * the input (same order, same ids); every raw entry contributes its current
 * `contextMessages`, which the cut-point machinery consumes.
 *
 * Projection order of the flat `messages` differs from log order in one
 * place: the winning checkpoint's summary leads its retained tail, because
 * the checkpoint entry is APPENDED AFTER the entries it keeps (the log is
 * append-only) — `messages` is [summary, ...retained tail..., ...newer...].
 */
export function projectContext(entries: readonly LogEntry[]): ProjectedContext {
  // Pass 1: omission. A context_edit omission hides its targets from every
  // later observation, regardless of where in the log the omission itself sits.
  const omitted = new Set<string>();
  for (const entry of entries) {
    const omission = parseOmissionPayload(entry);
    if (!omission) continue;
    for (const targetId of omission.targetIds) omitted.add(targetId);
  }

  // Pass 2: the last compaction checkpoint wins; older ones stay in the log
  // but their projected effect is replaced by the newer checkpoint. An
  // OMITTED checkpoint is retracted (the overflow-recovery retraction story):
  // the winner search skips it, so projection falls back to the previous
  // checkpoint — or to the full raw history when every checkpoint is omitted.
  let lastCompaction: CompactionMarker | undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (omitted.has(entries[i]!.id)) continue;
    const payload = parseCompactionPayload(entries[i]!);
    if (payload !== undefined) {
      lastCompaction = { index: i, payload };
      break;
    }
  }

  // firstKeptEntryId points at an entry already in the log when the
  // checkpoint was appended — normally BEFORE the checkpoint entry itself.
  let keptFrom = 0;
  const summaryMessage: CompactionMessage | null =
    lastCompaction === undefined ? null : { role: 'user', content: lastCompaction.payload.summary };
  if (lastCompaction !== undefined) {
    keptFrom = entries.findIndex((entry) => entry.id === lastCompaction!.payload.firstKeptEntryId);
    if (keptFrom === -1) {
      throw new UnknownFirstKeptEntryError(entries[lastCompaction.index]!.id, lastCompaction.payload.firstKeptEntryId);
    }
  }

  // System prompt: the frozen value of the winning checkpoint, otherwise the
  // newest visible mcode.system entry.
  let systemMessage: string | null = null;
  if (lastCompaction !== undefined && lastCompaction.payload.systemMessage !== null) {
    systemMessage = lastCompaction.payload.systemMessage;
  } else {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]!;
      if (omitted.has(entry.id)) continue;
      if (entry.kind === SYSTEM_ENTRY_KIND && isPayloadObject(entry.payload) && typeof entry.payload.text === 'string') {
        systemMessage = entry.payload.text;
        break;
      }
    }
  }

  const projectedEntries: ProjectedEntry[] = [];
  const messages: CompactionMessage[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    let contextMessages: CompactionMessage[];

    if (index === lastCompaction?.index) {
      // The winning checkpoint projects its summary as a single user message.
      contextMessages = [summaryMessage!];
    } else if (omitted.has(entry.id) || index < keptFrom) {
      contextMessages = [];
    } else {
      const message = messageOf(entry);
      contextMessages = message === undefined ? [] : [message];
    }

    projectedEntries.push({
      id: entry.id,
      // ANY mcode.compaction entry is a cut boundary (even a malformed one):
      // the cut-point metadata extension must not crawl over it, so the
      // firstKeptEntryId never references a corrupt checkpoint id.
      isCompaction: entry.kind === COMPACTION_ENTRY_KIND,
      contextMessages,
    });

    // Flat messages follow projection order: the summary leads at keptFrom,
    // the checkpoint entry itself contributes nothing extra.
    if (index < keptFrom) continue;
    if (index === keptFrom && summaryMessage !== null) messages.push(summaryMessage);
    if (index !== lastCompaction?.index) messages.push(...contextMessages);
  }

  return { systemMessage, messages, entries: projectedEntries };
}

/**
 * Messages of a projected entry that belong into a summarizer conversation:
 * compaction summaries are already condensed and are excluded, so a chain of
 * compactions does not nest old summaries into new ones.
 */
export function summarizableMessages(entry: ProjectedEntry): readonly CompactionMessage[] {
  return entry.isCompaction ? [] : entry.contextMessages;
}

/**
 * Byte size of the PROJECTED WINDOW: Σ UTF-8 bytes of the serialized payload
 * of every entry that currently contributes LLM-visible content (kept message
 * entries, the winning checkpoint, the active system prompt), plus the
 * serialized system-prompt payload. This is the byte truth of the compaction
 * trigger's byte axis — the window the projection materializes, NOT the raw
 * append-only log (audit/control bookkeeping contributes nothing, and a
 * checkpoint RESETS the axis to its kept tail). O(log): the slow reference
 * the incremental {@link WindowUsageTracker} is property-tested against;
 * the scheduler itself consumes the tracker, never this function.
 */
export function windowManifestBytes(entries: readonly LogEntry[]): number {
  const projected = projectContext(entries);
  let bytes = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (projected.entries[i]!.contextMessages.length > 0) {
      bytes += Buffer.byteLength(JSON.stringify(entries[i]!.payload), 'utf8');
    }
  }
  if (projected.systemMessage !== null) {
    bytes += Buffer.byteLength(JSON.stringify({ text: projected.systemMessage }), 'utf8');
  }
  return bytes;
}
