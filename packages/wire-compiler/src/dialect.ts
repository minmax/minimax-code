/**
 * Wire dialects: per-entry normalize rules behind a stable interface.
 *
 * A dialect owns the mapping "frozen log entry → wire JSON value" for one
 * provider family. Because the segment cache key carries
 * `(dialect.name, dialect.normalizerVersion)`, changing the normalize rules
 * only recompiles the segments of the bumped dialect/version — every other
 * dialect's cached segments stay valid. `normalizeEntry` must be pure and
 * deterministic: the same entry always yields byte-identical JSON.
 */

import { createHash } from 'node:crypto';

import { WireCompilerError } from './errors.js';
import type { ContentBlock, Entry, JsonValue, ToolDefinition, WireDialect } from './types.js';

export type { WireDialect } from './types.js';

/** `normalizerVersion` of the bundled minimax-m3 dialect. */
export const MINIMAX_M3_NORMALIZER_VERSION = '1';

/**
 * Placeholder link substituted for image content: the wire body never carries
 * image bytes (base64 or otherwise), only a deterministic reference the model
 * can name. Inline base64 blocks are hashed over their decoded bytes, matching
 * the `cas://sha256/<digest>#<size>` reference shape the importer publishes.
 */
export function imagePlaceholderLink(blob: string): string {
  return `[image: ${blob}]`;
}

/** Builds the deterministic `cas://` placeholder for an inline base64 image. */
function inlineImageLink(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return `cas://sha256/${sha256}#${bytes.length}`;
}

/**
 * The default dialect for MiniMax-M3: OpenAI-style message objects with
 * thinking blocks stripped and images reduced to placeholder links.
 *
 * Normalized shapes (version `MINIMAX_M3_NORMALIZER_VERSION`):
 * - `system`      → `{"role":"system","content":<string|blocks>}`
 * - `text`        → `{"role":<role|"user">,"content":<string|blocks>}`
 * - `tool-deltas` → `{"role":"tool-deltas","tools":[<definition>...]}`
 * - `toolResult`  → `{"role":"toolResult","toolCallId","toolName","content":<string|blocks>,"isError"}`
 */
export const MINIMAX_M3_DIALECT: WireDialect = {
  name: 'minimax-m3',
  normalizerVersion: MINIMAX_M3_NORMALIZER_VERSION,

  normalizeEntry(entry: Entry): JsonValue {
    switch (entry.kind) {
      case 'system':
        return { role: entry.role ?? 'system', content: normalizeContent(entry.content) };
      case 'text':
        return { role: entry.role ?? 'user', content: normalizeContent(entry.content) };
      case 'tool-deltas':
        return { role: entry.role ?? 'tool-deltas', tools: (entry.tools ?? []).map(normalizeTool) };
      case 'toolResult':
        return {
          role: entry.role ?? 'toolResult',
          toolCallId: entry.toolCallId ?? '',
          toolName: entry.toolName ?? '',
          content: normalizeContent(entry.content),
          isError: entry.isError === true,
        };
    }
    // Runtime guard: entries arrive as runtime JSON from the durable log, so
    // a kind unknown to this normalizer version must fail loudly instead of
    // silently serializing into a literal "undefined" segment. The switch
    // above keeps static exhaustiveness: a new EntryKind member fails the
    // return-type check here until handled.
    throw new WireCompilerError(`unknown entry kind: ${JSON.stringify(entry.kind)}`);
  },
};

/** Normalizes a message payload: strings pass through, blocks are filtered. */
function normalizeContent(content: string | readonly ContentBlock[] | undefined): JsonValue {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  // Thinking blocks normalize to `undefined` and are dropped here, preserving
  // the order of the surviving blocks.
  return content.map(normalizeBlock).filter((block): block is JsonValue => block !== undefined);
}

/**
 * Normalizes one content block:
 * - `thinking` blocks are removed (returns `undefined`);
 * - inline base64 `image` blocks become deterministic `cas://` placeholder
 *   links rendered as text;
 * - `image_ref` blocks become their stored link rendered as placeholder text;
 * - every other block passes through unchanged.
 */
function normalizeBlock(block: ContentBlock): JsonValue | undefined {
  switch (block.type) {
    case 'thinking':
      return undefined;
    case 'image': {
      const data = block['data'];
      return { type: 'text', text: imagePlaceholderLink(inlineImageLink(typeof data === 'string' ? data : '')) };
    }
    case 'image_ref': {
      const blob = block['blob'];
      return { type: 'text', text: imagePlaceholderLink(typeof blob === 'string' ? blob : 'unknown') };
    }
    default:
      return block;
  }
}

/** Normalizes one tool definition with a fixed key order. */
function normalizeTool(tool: ToolDefinition): JsonValue {
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
  };
}
