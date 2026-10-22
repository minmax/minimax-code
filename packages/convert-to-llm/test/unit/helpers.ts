/** Shared builders for convert-to-llm unit tests. */

import type { DurableEntry, JsonValue } from '../../src/types.js';

let nextSeq = 1;

/** Reset the shared seq counter (tests call this in `beforeEach` if they care). */
export function resetEntrySeq(): void {
  nextSeq = 1;
}

/** Build a durable entry mirroring the sqlite-zstd `Entry` shape. */
export function makeEntry(
  id: string,
  kind: string,
  payload: JsonValue,
  overrides: Partial<Omit<DurableEntry, 'id' | 'kind' | 'payload'>> = {},
): DurableEntry {
  return {
    id,
    kind,
    payload,
    seq: overrides.seq ?? nextSeq++,
    ordinal: overrides.ordinal ?? 0,
    parentId: overrides.parentId ?? null,
  };
}

/** A `pi.user` entry with `{model:[message]}` payload (pi-durable convention). */
export function userEntry(
  id: string,
  text: string,
  extra: Record<string, JsonValue> = {},
): DurableEntry {
  return makeEntry(id, 'pi.user', {
    model: [{ role: 'user', content: text, timestamp: 1, ...extra }],
  });
}

/** A `pi.assistant` entry with text/thinking/toolCall blocks. */
export function assistantEntry(
  id: string,
  content: Array<Record<string, JsonValue>>,
): DurableEntry {
  return makeEntry(id, 'pi.assistant', {
    model: [
      {
        role: 'assistant',
        content,
        api: 'openai-completions',
        provider: 'minimax_api',
        model: 'MiniMax-M3',
        usage: {},
        stopReason: 'stop',
        timestamp: 2,
      },
    ],
  });
}

/** A `pi.tool-result` entry. */
export function toolResultEntry(
  id: string,
  toolCallId: string,
  text: string,
  isError = false,
): DurableEntry {
  return makeEntry(id, 'pi.tool-result', {
    model: [
      {
        role: 'toolResult',
        toolCallId,
        toolName: 'read',
        content: [{ type: 'text', text }],
        isError,
        timestamp: 3,
      },
    ],
  });
}
