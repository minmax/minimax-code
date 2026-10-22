/**
 * The per-entry stage contract between the wire compiler and convert-to-llm.
 *
 * The wave-2 review found two incompatible parallel contracts for the SAME
 * pipeline stage: this package's structural `Entry`/`WireDialect` (kinds
 * `system`|`tool-deltas`|`text`|`toolResult`, NDJSON segments) versus
 * convert-to-llm's `DurableEntry`/`CompiledEntry` (pi.* kinds, provider
 * records with a fixed key order). The architecture pins ONE owner of the
 * per-entry stage (final-architecture.md:74 — convert-to-llm is "the
 * memoized per-entry stage INSIDE the wire compiler"), so this module —
 * same precedent as `packages/storage-worker/src/contracts.ts` — declares:
 *
 * 1. convert-to-llm owns the stage: {@link convertEntry} produces the
 *    `CompiledEntry`, and `serializeCompiledEntry` is the per-entry wire
 *    serialization the compiler memoizes;
 * 2. {@link compiledEntryToWireEntry} maps a record onto this package's
 *    frozen-entry shape, losslessly;
 * 3. {@link compiledRecordDialect} is the dialect over mapped records whose
 *    segments are BYTE-IDENTICAL to `serializeCompiledEntry` (+ trailing
 *    `\n`) — the bridge test (`test/unit/bridge.test.ts`) pins the equality
 *    for every record shape;
 * 4. {@link compiledEntrySegment} returns that pinned segment Buffer
 *    directly (runtime import of `serializeCompiledEntry` — this package
 *    consumes convert-to-llm, not a parallel copy of its rules).
 *
 * Cache keys carry the same information in two notations: the compiler's
 * segment key is `(dialect.name, normalizerVersion, entryId)`; the record's
 * `cacheKey` is `` `${entryId}@${dialect.name}#v${version}` ``. A record must
 * only be compiled under the dialect derived from its own conversion dialect.
 *
 * @module
 */

import { MINIMAX_M3_DIALECT, serializeCompiledEntry } from '../../convert-to-llm/src/index.js';
import type { CompiledEntry, DurableEntry, ProviderRole } from '../../convert-to-llm/src/index.js';

import { WireCompilerError } from './errors.js';
import type { ContentBlock, Entry, JsonValue, WireDialect } from './types.js';

export type { CompiledEntry, DurableEntry, ProviderRole };

/** `normalizerVersion` of {@link compiledRecordDialect} — bound to convert-to-llm's rules. */
export const COMPILED_RECORD_NORMALIZER_VERSION = String(MINIMAX_M3_DIALECT.normalizerVersion);

/** The structural kind for a provider role, in the compiler's vocabulary. */
function kindOfRole(role: ProviderRole): Entry['kind'] {
  switch (role) {
    case 'system':
      return 'system';
    case 'tool':
      return 'toolResult';
    default:
      return 'text';
  }
}

/**
 * Maps one converted record onto the compiler's frozen-entry shape — the
 * input `compiledRecordDialect` expects. Lossless: the dialect reconstructs
 * byte-identical record bodies from the mapped fields.
 *
 * Assistant tool-call deltas travel as `toolCall` content blocks appended
 * after the text block; the dialect re-projects them to `tool_calls` with the
 * arguments string passed through VERBATIM. No `JSON.parse`/`JSON.stringify`
 * round trip: `decode.ts`'s `encodeArguments` already hands the record the
 * stored string as-is (any textual form — non-canonical spacing, even non-JSON
 * text — is a legal frozen payload), and `serializeCompiledEntry` embeds that
 * same string unchanged, so re-encoding here would fork one frozen entry into
 * two different wire byte streams depending on the compilation path.
 */
export function compiledEntryToWireEntry(record: CompiledEntry): Entry {
  const blocks: ContentBlock[] = [];
  if (record.content.length > 0 || (record.toolCalls ?? []).length === 0) {
    blocks.push({ type: 'text', text: record.content });
  }
  for (const call of record.toolCalls ?? []) {
    blocks.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  return {
    entryId: record.entryId,
    kind: kindOfRole(record.role),
    role: record.role,
    content: blocks,
    ...(record.toolCallId !== undefined ? { toolCallId: record.toolCallId } : {}),
    ...(record.toolName !== undefined ? { toolName: record.toolName } : {}),
    ...(record.isError !== undefined ? { isError: record.isError } : {}),
  };
}

/**
 * The pinned per-entry dialect over converted records. Segments are one JSON
 * line each, with the EXACT field order of `serializeCompiledEntry`:
 * `{role, content, tool_calls?, tool_call_id?, name?, is_error?}`.
 */
export function compiledRecordDialect(): WireDialect {
  return {
    name: 'minimax-m3-compiled',
    normalizerVersion: COMPILED_RECORD_NORMALIZER_VERSION,

    normalizeEntry(entry: Entry): JsonValue {
      if (Array.isArray(entry.content) && entry.content.some((block) => block.type === 'toolCall')) {
        if (entry.role !== 'assistant') {
          throw new WireCompilerError(
            `compiled-record dialect: toolCall blocks are only valid on assistant records, got role ${JSON.stringify(entry.role)}`,
          );
        }
      }
      const body: Record<string, JsonValue> = {
        role: entry.role ?? defaultRole(entry.kind),
        content: normalizeRecordContent(entry.content),
      };
      const toolCalls = Array.isArray(entry.content)
        ? entry.content.filter((block) => block.type === 'toolCall')
        : [];
      if (toolCalls.length > 0) {
        body.tool_calls = toolCalls.map((block) => {
          // Verbatim pass-through of the stored arguments string — the pinned
          // byte-identity with `serializeCompiledEntry` holds for ANY string
          // content only if it is embedded unchanged. A non-string block is a
          // hand-built shape outside the mapped-record contract, where the
          // guarantee has no pinned reference: rejected instead of guessed.
          if (typeof block.arguments !== 'string') {
            throw new WireCompilerError(
              `compiled-record dialect: toolCall block of entry ${JSON.stringify(entry.entryId)} carries non-string arguments (mapped records always carry the stored string)`,
            );
          }
          return {
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: block.arguments },
          };
        });
      }
      if (entry.toolCallId !== undefined) body.tool_call_id = entry.toolCallId;
      if (entry.toolName !== undefined) body.name = entry.toolName;
      if (entry.isError !== undefined) body.is_error = entry.isError;
      return body;
    },
  };
}

function defaultRole(kind: Entry['kind']): string {
  switch (kind) {
    case 'system':
      return 'system';
    case 'toolResult':
      return 'toolResult';
    case 'tool-deltas':
      return 'tool-deltas';
    default:
      return 'user';
  }
}

/**
 * Record content normalization: converted records carry at most one text
 * block plus assistant toolCall blocks, so the content is exactly the text
 * blocks joined — a single block collapses back to the record's plain
 * string. Blocks pass through unchanged otherwise (converted records never
 * carry thinking/image blocks — conversion already resolved them).
 */
function normalizeRecordContent(content: string | readonly ContentBlock[] | undefined): JsonValue {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

/**
 * The pinned wire segment of one converted record:
 * `serializeCompiledEntry(record)` plus the NDJSON trailing newline. The
 * compiler produces exactly these bytes under {@link compiledRecordDialect}
 * — the bridge test pins the equality.
 */
export function compiledEntrySegment(record: CompiledEntry): Buffer {
  return Buffer.from(`${serializeCompiledEntry(record)}\n`, 'utf8');
}
