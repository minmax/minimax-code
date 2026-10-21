import type { Dialect } from './types.js';

/**
 * The built-in `minimax-m3` dialect.
 *
 * Provider format: OpenAI-compatible chat records (`system` / `user` /
 * `assistant` / `tool`) with function-style `tool_calls` on assistant
 * messages. This encodes the MiniMax normalizations that the superseded
 * `mcode-outbound-projection` performed as a whole-history pass; here they
 * are per-entry rules:
 *
 * - prior-turn thinking blocks are cut (never forwarded to the provider);
 * - several text blocks of one message join with a blank line;
 * - image blocks become deterministic text placeholders — binary image data
 *   never enters the per-entry JSON record (CAS pages own image transport);
 * - `toolResult` messages become `tool` records correlated by `tool_call_id`.
 *
 * Any rule change MUST bump `normalizerVersion`: cache keys are
 * `(entryId, name, normalizerVersion)`, so a bump invalidates only the rule
 * change and never mixes bytes from two rule sets.
 */
export const MINIMAX_M3_DIALECT: Dialect = {
  name: 'minimax-m3',
  normalizerVersion: 1,
  thinking: 'cut',
  textJoin: '\n\n',
  batchJoin: '\n\n',
  imagePlaceholder(mimeType) {
    return `[image: ${mimeType}]`;
  },
};

/** Build the deterministic per-entry compile cache key. */
export function compileKey(entryId: string, dialect: Dialect): string {
  return `${entryId}@${dialect.name}#v${dialect.normalizerVersion}`;
}

/** Cache key for a batch-merged record; every added member changes the key. */
export function compileBatchKey(sourceEntryIds: readonly string[], dialect: Dialect): string {
  return `batch(${sourceEntryIds.join('+')})@${dialect.name}#v${dialect.normalizerVersion}`;
}
