/**
 * The per-entry conversion stage (node `pi-convert-to-llm`, adapt decision).
 *
 * `convertEntry(entry, dialect)` turns one durable entry into its provider
 * record deterministically: the same entry bytes and dialect version always
 * produce byte-identical output. The wire compiler memoizes this stage by
 * `(entryId, dialect, normalizerVersion)` — see {@link compileKey}.
 *
 * Role/content rules per the `minimax-m3` dialect:
 * - `pi.system` → `system`; `pi.user` → `user`;
 * - `pi.assistant` → `assistant` with text blocks and tool-call deltas;
 *   thinking blocks are cut;
 * - `pi.tool-result` → `tool` correlated by `toolCallId`;
 * - `mcode.owner-input.placed` → the executed user input (dedup upstream);
 * - `mcode.system-reminder` → a user record flagged `tail: true`;
 * - audit/control kinds (other `mcode.*`) convert to `null` — they are
 *   excluded from the provider payload by the steering D+C contract.
 *
 * Embedded `<system-reminder>` blocks inside user text are split into tail
 * records by {@link convertEntryTails}; the user record keeps its residual
 * bytes and old user messages are never mutated further.
 */

import { isAuditControlKind, isPlacedEntryKind, isReminderEntryKind } from './audit.js';
import { compileBatchKey, compileKey } from './dialect.js';
import { decodeEntryPayload, type DecodedMessage, type DecodedPart } from './decode.js';
import {
  buildCompiledEntry,
  buildReminderTail,
  splitUserReminders,
} from './reminders.js';
import type { CompiledEntry, Dialect, DurableEntry } from './types.js';
import { MINIMAX_M3_DIALECT } from './dialect.js';

/** Render decoded parts to provider text; images become deterministic placeholders. */
function renderParts(parts: readonly DecodedPart[], dialect: Dialect): string {
  const rendered: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      rendered.push(part.text);
    } else {
      rendered.push(dialect.imagePlaceholder(part.mimeType));
    }
  }
  return rendered.join(dialect.textJoin);
}

/** Convert one decoded message to its provider record fields. */
function convertMessage(
  message: DecodedMessage,
  dialect: Dialect,
): Pick<
  CompiledEntry,
  'role' | 'content' | 'toolCalls' | 'toolCallId' | 'toolName' | 'isError'
> {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: renderParts(message.parts, dialect) };
    case 'user':
      return { role: 'user', content: renderParts(message.parts, dialect) };
    case 'assistant': {
      return {
        role: 'assistant',
        content: renderParts(message.parts, dialect),
        toolCalls: message.toolCalls?.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    case 'toolResult':
      return {
        role: 'tool',
        content: renderParts(message.parts, dialect),
        toolCallId: message.toolCallId ?? '',
        toolName: message.toolName ?? '',
        isError: message.isError === true,
      };
  }
}

/**
 * Convert one durable entry into its primary provider record.
 *
 * Returns `null` when the entry carries no provider content: audit/control
 * kinds, `pi.reset` boundaries, undecodable payloads, system entries with
 * empty content, and user entries whose text is fully consumed by reminder
 * extraction (the text lives on in the tail records instead).
 *
 * Deterministic: identical `(entry, dialect)` inputs produce identical
 * records, byte for byte.
 */
export function convertEntry(
  entry: DurableEntry,
  dialect: Dialect = MINIMAX_M3_DIALECT,
): CompiledEntry | null {
  if (isAuditControlKind(entry.kind)) return null;

  if (isReminderEntryKind(entry.kind)) {
    const decoded = decodeEntryPayload(entry.kind, entry.payload);
    if (decoded.reminderText === undefined) return null;
    return buildReminderTail(entry.id, entry.kind, decoded.reminderText, dialect);
  }

  const decoded = decodeEntryPayload(entry.kind, entry.payload);
  const message = decoded.messages[0];
  // pi-durable writes exactly one model message per entry; extra elements are
  // ignored on purpose — a multi-message payload would make the per-entry
  // cache key ambiguous. The writer contract, not the reader, owns this.
  if (message === undefined) return null;

  const fields = convertMessage(message, dialect);

  if (fields.role === 'user') {
    const text = fields.content;
    const split = splitUserReminders(entry.id, entry.kind, text, dialect);
    const residual = split.residualText;
    // Either reminders consumed the whole text (it lives on in the tails) or
    // the entry carried no provider-visible content at all; an empty user
    // record would only confuse the provider.
    if (residual.trim().length === 0) return null;
    return buildCompiledEntry({
      cacheKey: compileKey(entry.id, dialect),
      entryId: entry.id,
      sourceEntryIds: [entry.id],
      kind: entry.kind,
      role: 'user',
      content: residual,
      tail: false,
      ...(isPlacedEntryKind(entry.kind) && decoded.inputEntryId !== undefined
        ? { inputEntryId: decoded.inputEntryId }
        : {}),
    });
  }

  // An empty system record (positional prompt / tool change) is prefix noise.
  if (fields.role === 'system' && fields.content.trim().length === 0) return null;

  return buildCompiledEntry({
    cacheKey: compileKey(entry.id, dialect),
    entryId: entry.id,
    sourceEntryIds: [entry.id],
    kind: entry.kind,
    role: fields.role,
    content: fields.content,
    tail: false,
    ...(fields.toolCalls !== undefined ? { toolCalls: fields.toolCalls } : {}),
    ...(fields.toolCallId !== undefined ? { toolCallId: fields.toolCallId } : {}),
    ...(fields.toolName !== undefined ? { toolName: fields.toolName } : {}),
    ...(fields.isError !== undefined ? { isError: fields.isError } : {}),
  });
}

/**
 * Extract the reminder tail records of one entry: user entries yield the
 * `<system-reminder>` blocks split out of the stored text. Order is source
 * order; ids of split-out records are `entryId#reminder:N`.
 *
 * Dedicated `mcode.system-reminder` entries return `[]` here on purpose —
 * their tail record is the entry's own conversion result (see
 * {@link convertEntry}), so callers never see it twice.
 */
export function convertEntryTails(
  entry: DurableEntry,
  dialect: Dialect = MINIMAX_M3_DIALECT,
): readonly CompiledEntry[] {
  if (isReminderEntryKind(entry.kind)) return [];
  if (isAuditControlKind(entry.kind)) return [];

  const decoded = decodeEntryPayload(entry.kind, entry.payload);
  const message = decoded.messages[0];
  if (message === undefined || message.role !== 'user') return [];

  const text = renderParts(message.parts, dialect);
  return splitUserReminders(entry.id, entry.kind, text, dialect).tails;
}

/**
 * Convert an immediate-send batch group into one merged user record (the
 * `outbound-message-normalizer` semantics: members join with a blank line,
 * later members merge into the first member's position). The cache key is
 * derived from every member id, so appending a member changes the key instead
 * of reusing stale bytes.
 */
export function convertBatch(
  entries: readonly DurableEntry[],
  dialect: Dialect = MINIMAX_M3_DIALECT,
): CompiledEntry | null {
  const first = entries[0];
  if (first === undefined) return null;
  const contents: string[] = [];
  for (const entry of entries) {
    const record = convertEntry(entry, dialect);
    if (record !== null && record.role === 'user') contents.push(record.content);
    // Tails of batch members still surface through convertEntryTails.
  }
  if (contents.length === 0) return null;
  const ids = entries.map((entry) => entry.id);
  return buildCompiledEntry({
    cacheKey: compileBatchKey(ids, dialect),
    entryId: first.id,
    sourceEntryIds: ids,
    kind: first.kind,
    role: 'user',
    content: contents.join(dialect.batchJoin),
    tail: false,
  });
}
