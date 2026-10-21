/**
 * Tolerant, deterministic decoding of durable entry payloads into logical
 * messages.
 *
 * Entries are JSON at rest. The canonical writer convention (pi-durable) is
 * `payload.model = [message]` with exactly one message per entry; the decoder
 * also accepts a bare message object and a `payload.messages` array so that
 * import paths and app-level writers stay convertible. Anything it cannot
 * decode yields an empty message list — the caller counts that as
 * `undecodable` and the wire equivalence gate would flag a wrongly dropped
 * entry.
 *
 * Images decode to reference parts (`{type:'image', mimeType}`), never to
 * binary data: the dialect renders a deterministic text placeholder and CAS
 * pages own the actual image transport.
 */

import type { JsonValue } from './types.js';

/** One projected content part: text bytes or an image reference. */
export type DecodedPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string };

/** Projected tool call before dialect rendering. */
export interface DecodedToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON-encoded arguments; byte-stable for identical stored payloads. */
  readonly arguments: string;
}

/** Logical message roles the converter understands. */
export type DecodedRole = 'system' | 'user' | 'assistant' | 'toolResult';

/** A logical message decoded from an entry payload. */
export interface DecodedMessage {
  readonly role: DecodedRole;
  readonly parts: readonly DecodedPart[];
  /** Assistant-only: tool-call deltas carried by the message. */
  readonly toolCalls?: readonly DecodedToolCall[];
  /** Tool-result-only correlation. */
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  /** Immediate-send batch marker (`hostMetadata.immediateSendBatchId`). */
  readonly batchId?: string;
}

/** Everything the converter needs from one entry payload. */
export interface DecodedEntryPayload {
  /** Logical messages; empty when the payload decodes to nothing. */
  readonly messages: readonly DecodedMessage[];
  /** Steering placed-entry linkage (`mcode.owner-input.placed`). */
  readonly inputEntryId?: string;
  /** Raw reminder text of a dedicated `mcode.system-reminder` entry. */
  readonly reminderText?: string;
}

type PlainObject = { readonly [key: string]: JsonValue };

function isRecord(value: JsonValue | undefined): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** Encode tool-call arguments deterministically: JSON strings pass through, values stringify. */
function encodeArguments(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
}

/** Decode a content block list (text/image) into projected parts. */
function decodeBlockParts(blocks: readonly JsonValue[]): DecodedPart[] {
  const parts: DecodedPart[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const type = asString(block.type);
    if (type === 'text') {
      const text = asString(block.text);
      if (text !== undefined) parts.push({ type: 'text', text });
    } else if (type === 'image') {
      const mimeType = asString(block.mimeType) ?? 'application/octet-stream';
      parts.push({ type: 'image', mimeType });
    }
  }
  return parts;
}

/** Decode message content of any supported shape into projected parts. */
function decodeContentParts(content: JsonValue | undefined): DecodedPart[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  return decodeBlockParts(asArray(content));
}

/** Read the immediate-send batch marker the same way mcode's normalizer does. */
function decodeBatchId(message: PlainObject): string | undefined {
  const metadata = message.hostMetadata;
  if (!isRecord(metadata)) return undefined;
  const id = asString(metadata.immediateSendBatchId);
  return id !== undefined && id.length > 0 ? id : undefined;
}

/** Decode one pi-ai-shaped message object. Returns `undefined` for non-messages. */
function decodeMessage(raw: JsonValue): DecodedMessage | undefined {
  if (!isRecord(raw)) return undefined;
  const role = asString(raw.role);
  switch (role) {
    case 'system':
    case 'user': {
      const message: DecodedMessage = {
        role,
        parts: decodeContentParts(raw.content),
      };
      const batchId = decodeBatchId(raw);
      return batchId === undefined ? message : { ...message, batchId };
    }
    case 'assistant': {
      const parts = decodeContentParts(raw.content);
      const toolCalls: DecodedToolCall[] = [];
      for (const block of asArray(raw.content)) {
        if (!isRecord(block)) continue;
        if (asString(block.type) !== 'toolCall') continue;
        const id = asString(block.id);
        const name = asString(block.name);
        if (id === undefined || name === undefined) continue;
        toolCalls.push({ id, name, arguments: encodeArguments(block.arguments) });
      }
      return { role: 'assistant', parts, toolCalls };
    }
    case 'toolResult': {
      const toolCallId = asString(raw.toolCallId);
      if (toolCallId === undefined) return undefined;
      return {
        role: 'toolResult',
        parts: decodeContentParts(raw.content),
        toolCallId,
        toolName: asString(raw.toolName) ?? '',
        isError: raw.isError === true,
      };
    }
    default:
      return undefined;
  }
}

/** Decode the `model` field convention: `[message]`, single message, or `messages` array. */
function decodeModel(payload: PlainObject): readonly DecodedMessage[] {
  const model = payload.model;
  if (Array.isArray(model)) {
    return model
      .map(decodeMessage)
      .filter((message): message is DecodedMessage => message !== undefined);
  }
  const single = decodeMessage(model ?? ({} as JsonValue));
  if (single) return [single];
  const list = asArray(payload.messages);
  return list
    .map(decodeMessage)
    .filter((message): message is DecodedMessage => message !== undefined);
}

/** Decode a bare payload: the payload object itself is the message. */
function decodeBareMessage(payload: PlainObject): readonly DecodedMessage[] {
  const single = decodeMessage(payload as JsonValue);
  return single ? [single] : [];
}

/** Reminder text of a dedicated reminder entry: `text`/`content`/`blocks`/model message. */
function decodeReminderText(payload: PlainObject): string | undefined {
  const direct = asString(payload.text) ?? asString(payload.content);
  if (direct !== undefined) return direct;
  const blocks = asArray(payload.blocks)
    .map((block) => (isRecord(block) ? asString(block.text) : asString(block)))
    .filter((text): text is string => text !== undefined);
  if (blocks.length > 0) return blocks.join('\n\n');
  const fromModel = decodeModel(payload);
  const firstUser = fromModel.find((message) => message.role === 'user');
  if (!firstUser) return undefined;
  return firstUser.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

/**
 * Decode one entry payload. Never throws: malformed payloads decode to an
 * empty message list and let the caller decide (count and skip).
 */
export function decodeEntryPayload(kind: string, payload: JsonValue): DecodedEntryPayload {
  if (!isRecord(payload)) return { messages: [] };

  if (kind === 'mcode.system-reminder') {
    const reminderText = decodeReminderText(payload);
    return reminderText === undefined ? { messages: [] } : { messages: [], reminderText };
  }

  if (kind === 'mcode.owner-input.placed') {
    const inputEntryId = asString(payload.inputEntryId);
    const decoded = decodeModel(payload);
    const messages = decoded.length > 0 ? decoded : decodePlacedContent(payload);
    return inputEntryId === undefined ? { messages } : { messages, inputEntryId };
  }

  if (Object.hasOwn(payload, 'model') || Object.hasOwn(payload, 'messages')) {
    return { messages: decodeModel(payload) };
  }
  return { messages: decodeBareMessage(payload) };
}

/** Placed-entry fallback: model user content stored directly under `content`. */
function decodePlacedContent(payload: PlainObject): readonly DecodedMessage[] {
  const content = payload.content;
  if (typeof content !== 'string' || content.length === 0) return [];
  return [{ role: 'user', parts: [{ type: 'text', text: content }] }];
}
