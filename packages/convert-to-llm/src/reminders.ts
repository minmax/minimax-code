/**
 * System-reminder tail policy (node `mcode-system-reminder`, adapt decision).
 *
 * mcode used to append reminder blocks into the next user message at request
 * time, mutating already-persisted user content and breaking the byte
 * prefix the wire compiler and the provider prompt cache rely on. The hybrid
 * contract: reminders are separate records positioned AFTER the cache
 * prefix; stored user messages are never rewritten.
 *
 * This module deterministically extracts embedded
 * `<system-reminder>…</system-reminder>` blocks out of user text so that
 * entries written by the legacy producer convert to the same shape:
 * the user record keeps its non-reminder bytes, every block becomes its own
 * tail record.
 */

import type { CompiledEntry, Dialect } from './types.js';
import { compileKey } from './dialect.js';

const REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// Non-global companion: `test` on a global regex advances `lastIndex`, which
// would make the predicate stateful; the predicate must stay pure.
const REMINDER_PRESENCE = /<system-reminder>[\s\S]*?<\/system-reminder>/;

/** Extract every embedded `<system-reminder>` block (full tagged text, in order). */
export function extractReminderBlocks(text: string): string[] {
  return text.match(REMINDER_BLOCK) ?? [];
}

/** True when the text already is / contains a reminder block. */
export function containsReminderBlock(text: string): boolean {
  return REMINDER_PRESENCE.test(text);
}

/**
 * Split user text into the residual user content and one tail record per
 * embedded block. Deterministic: identical input text yields byte-identical
 * outputs. The residual content is the exact concatenation of the
 * non-block segments (no re-trimming), so reminder placement never changes
 * any other byte of the record.
 */
export function splitUserReminders(
  entryId: string,
  kind: string,
  text: string,
  dialect: Dialect,
): { residualText: string; blocks: string[]; tails: CompiledEntry[] } {
  const blocks: string[] = [];
  const segments: string[] = [];
  let cursor = 0;
  REMINDER_BLOCK.lastIndex = 0;
  for (let match = REMINDER_BLOCK.exec(text); match !== null; match = REMINDER_BLOCK.exec(text)) {
    segments.push(text.slice(cursor, match.index));
    blocks.push(match[0]);
    cursor = match.index + match[0].length;
  }
  segments.push(text.slice(cursor));

  const tails = blocks.map((block, index) =>
    buildReminderTail(`${entryId}#reminder:${index}`, kind, block, dialect),
  );
  return { residualText: segments.join(''), blocks, tails };
}

/**
 * Build one reminder tail record. Raw reminder text is wrapped in
 * `<system-reminder>` tags unless it already carries them, so dedicated
 * reminder entries and split-out blocks render identically.
 */
export function buildReminderTail(
  entryId: string,
  kind: string,
  reminderText: string,
  dialect: Dialect,
): CompiledEntry {
  const content = containsReminderBlock(reminderText)
    ? reminderText
    : `<system-reminder>\n${reminderText}\n</system-reminder>`;
  return buildCompiledEntry({
    cacheKey: compileKey(entryId, dialect),
    entryId,
    sourceEntryIds: [entryId],
    kind,
    role: 'user',
    content,
    tail: true,
  });
}

/** Shared deterministic record builder: fixed key order, fixed serialization. */
export function buildCompiledEntry(fields: {
  cacheKey: string;
  entryId: string;
  sourceEntryIds: readonly string[];
  kind: string;
  role: CompiledEntry['role'];
  content: string;
  tail: boolean;
  toolCalls?: CompiledEntry['toolCalls'];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  inputEntryId?: string;
}): CompiledEntry {
  const record: CompiledEntry = {
    cacheKey: fields.cacheKey,
    entryId: fields.entryId,
    sourceEntryIds: [...fields.sourceEntryIds],
    kind: fields.kind,
    role: fields.role,
    content: fields.content,
    tail: fields.tail,
    byteLen: 0,
  };
  const extended: CompiledEntry = {
    ...record,
    ...(fields.toolCalls !== undefined && fields.toolCalls.length > 0
      ? { toolCalls: fields.toolCalls }
      : {}),
    ...(fields.toolCallId !== undefined ? { toolCallId: fields.toolCallId } : {}),
    ...(fields.toolName !== undefined ? { toolName: fields.toolName } : {}),
    ...(fields.isError !== undefined ? { isError: fields.isError } : {}),
    ...(fields.inputEntryId !== undefined ? { inputEntryId: fields.inputEntryId } : {}),
  };
  return {
    ...extended,
    byteLen: Buffer.byteLength(serializeCompiledEntry(extended), 'utf8'),
  };
}

/**
 * Serialize one compiled record to its provider JSON body. Key order is
 * fixed by construction, so identical records serialize to identical bytes —
 * this is the byte-stability the wire compiler's prefix guarantee leans on.
 */
export function serializeCompiledEntry(record: CompiledEntry): string {
  const body: Record<string, unknown> = {
    role: record.role,
    content: record.content,
  };
  if (record.toolCalls !== undefined && record.toolCalls.length > 0) {
    body.tool_calls = record.toolCalls.map((call) => ({
      id: call.id,
      type: call.type,
      function: { name: call.function.name, arguments: call.function.arguments },
    }));
  }
  if (record.toolCallId !== undefined) body.tool_call_id = record.toolCallId;
  if (record.toolName !== undefined) body.name = record.toolName;
  if (record.isError !== undefined) body.is_error = record.isError;
  return JSON.stringify(body);
}
