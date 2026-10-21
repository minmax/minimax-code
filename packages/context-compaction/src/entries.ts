/**
 * Durable draft builders for the entry kinds this package owns.
 *
 * All payloads are plain JSON, structurally compatible with `EntryDraft` of
 * `@mavis/durable-backend-sqlite-zstd`. Building a draft never writes: the
 * caller appends it through its own persistence seam (backend, storage
 * worker, or an in-memory log in tests).
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import {
  COMPACTION_ENTRY_KIND,
  CONTEXT_EDIT_ENTRY_KIND,
  MESSAGE_ENTRY_KIND,
  SYSTEM_ENTRY_KIND,
  type CompactionEntryPayload,
  type CompactionMessage,
  type ContextEditOmissionPayload,
  type DurableEntryDraft,
} from './types.js';

/**
 * Generate a reasonably unique entry id; callers may pass their own instead.
 * `randomUUID` keeps ids unique across process restarts — a Date.now +
 * counter scheme collides after a restart within the same clock tick, which
 * would violate the draft id's "unique across the whole log" contract.
 */
export function generateLogEntryId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Draft of one conversation-message entry (`mcode.message`). */
export function createMessageEntryDraft(
  id: string,
  message: CompactionMessage,
  parentId: string | null = null,
): DurableEntryDraft {
  return { id, parentId, kind: MESSAGE_ENTRY_KIND, payload: message };
}

/** Draft of one frozen-system-prompt entry (`mcode.system`). */
export function createSystemEntryDraft(id: string, text: string, parentId: string | null = null): DurableEntryDraft {
  return { id, parentId, kind: SYSTEM_ENTRY_KIND, payload: { text } };
}

/** Draft of one compaction checkpoint entry (`mcode.compaction`). */
export function createCompactionEntryDraft(
  id: string,
  payload: CompactionEntryPayload,
  parentId: string | null = null,
): DurableEntryDraft {
  return { id, parentId, kind: COMPACTION_ENTRY_KIND, payload };
}

/**
 * Draft of one context-edit omission entry (`mcode.context_edit`): hides the
 * target entries from projection without touching them in the log.
 */
export function createOmissionEntryDraft(
  id: string,
  targetIds: readonly string[],
  reason: string,
  now: () => number = Date.now,
  parentId: string | null = null,
): DurableEntryDraft {
  const payload: ContextEditOmissionPayload = {
    action: 'omission',
    targetIds: [...targetIds],
    reason,
    createdAtMs: now(),
  };
  return { id, parentId, kind: CONTEXT_EDIT_ENTRY_KIND, payload };
}

/**
 * Read back and validate a compaction payload. `undefined` when the entry is
 * not a well-formed compaction checkpoint (the projection skips foreign or
 * malformed entries rather than crashing on them).
 */
export function parseCompactionEntry(entry: DurableEntryDraft): CompactionEntryPayload | undefined {
  if (entry.kind !== COMPACTION_ENTRY_KIND) return undefined;
  const payload = entry.payload as Partial<CompactionEntryPayload> | null;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.summary !== 'string' ||
    typeof payload.firstKeptEntryId !== 'string'
  ) {
    return undefined;
  }
  return payload as CompactionEntryPayload;
}
