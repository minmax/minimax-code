/**
 * Shared builders for the context-compaction test suite.
 *
 * @module
 */

import type {
  CompactionMessage,
  DurableEntryDraft,
  LogEntry,
} from '../../src/index.js';
import { createMessageEntryDraft } from '../../src/index.js';

/** Fixed-width filler text of exactly `chars` characters (4 chars -> 1 token). */
export function filler(chars: number): string {
  if (chars <= 0) return '';
  const word = 'abcdefgh';
  return word.repeat(Math.ceil(chars / word.length)).slice(0, chars);
}

export function userMessage(text: string): CompactionMessage {
  return { role: 'user', content: text };
}

export function assistantMessage(text: string, usage?: { totalTokens: number }): CompactionMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...(usage === undefined ? {} : { usage, stopReason: 'stop' }),
  };
}

export function toolResultMessage(text: string, toolCallId = 'call-1'): CompactionMessage {
  return { role: 'toolResult', content: [{ type: 'text', text }], toolCallId };
}

export function customMessage(customType: string, text: string): CompactionMessage {
  return { role: 'custom', customType, text };
}

let entryCounter = 0;

/** Build one `mcode.message` log entry with a unique id. */
export function messageEntry(message: CompactionMessage, id?: string): LogEntry {
  entryCounter += 1;
  return stamp(createMessageEntryDraft(id ?? `e${entryCounter}`, message));
}

/** Attach the backend-stamped position fields to a draft. */
export function stamp(draft: DurableEntryDraft, seq = 1, ordinal = 0): LogEntry {
  return { ...draft, seq: seq as LogEntry['seq'], ordinal };
}

export function toLogEntries(drafts: DurableEntryDraft[]): LogEntry[] {
  return drafts.map((draft, ordinal) => stamp(draft, ordinal + 1, ordinal));
}

/** In-memory append-only log double: appends never rewrite existing entries. */
export class MemoryLog {
  readonly entries: LogEntry[] = [];

  async append(drafts: readonly DurableEntryDraft[]): Promise<void> {
    for (const draft of drafts) {
      this.entries.push({ ...draft, seq: this.entries.length + 1, ordinal: 0 });
    }
  }

  /** Entries appended AFTER the given snapshot was taken (identity by array). */
  entriesSince(snapshot: readonly LogEntry[]): LogEntry[] {
    return this.entries.slice(snapshot.length);
  }
}

/** Deterministic Summarizer double recording every prompt it receives. */
export class RecordingSummarizer {
  readonly prompts: string[] = [];
  /** Responses served in order; the last one repeats when exhausted. */
  readonly responses: string[];
  /** When set, the call at this zero-based index rejects instead. */
  failAt?: number;

  constructor(...responses: string[]) {
    this.responses = responses.length > 0 ? responses : ['SUMMARY'];
  }

  readonly call = async (prompt: string): Promise<string> => {
    const index = this.prompts.length;
    this.prompts.push(prompt);
    if (this.failAt === index) throw new Error(`summarizer failed at ${index}`);
    return this.responses[Math.min(index, this.responses.length - 1)]!;
  };

  get callCount(): number {
    return this.prompts.length;
  }
}
