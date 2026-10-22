/**
 * The wire compiler: payload assembly from cached Buffer segments.
 *
 * `compile()` walks the window manifest in order, serializes each referenced
 * entry independently (per-entry stage, cached LRU under
 * `(dialect.name, dialect.normalizerVersion, entryId)`), and assembles the
 * body with one `Buffer.concat` — never a `JSON.stringify` over the whole
 * message array. The byte budget guard is arithmetic over the per-entry
 * segment lengths, so an oversized body is rejected with an exact per-entry
 * breakdown before anything is sent.
 *
 * Each segment is one JSON line (trailing `\n`), so the concatenated body
 * stays newline-delimited JSON regardless of how many segments it joins.
 *
 * Failure atomicity: a compile pass that aborts (`WireBudgetExceeded`) rolls
 * back the segments it inserted into the cache — a failed pass leaves the
 * shared cache exactly as it found it, so later callers never inherit
 * hash-less hits from someone else's budget breach.
 */

import { createHash } from 'node:crypto';

import { MINIMAX_M3_DIALECT } from './dialect.js';
import { WireBudgetExceeded, WireCompilerError } from './errors.js';
import { defaultSegmentCache } from './lru.js';
import type { WireSegmentCache } from './lru.js';
import type {
  CompiledBody,
  CompileOptions,
  ContextManifest,
  Entry,
  JsonValue,
  SegmentStat,
  WireDialect,
} from './types.js';

/** Cache key of one per-entry stage: dialect, normalizer revision, entry. */
function segmentKey(dialect: WireDialect, entryId: string): string {
  // JSON encoding keeps the key unambiguous even if ids contain separators.
  // The entry CONTENT is deliberately not part of the key: correctness rests
  // on the frozen-entry guarantee (an entryId never maps to different
  // content — the durable log's writer contract, see `Entry`). Folding a
  // content hash in would force O(payload) hashing of the whole window on
  // every compile — the exact cost the segment cache exists to avoid — so a
  // reused entryId with mutated content is a writer-contract violation,
  // not something the warm path re-verifies.
  return JSON.stringify([dialect.name, dialect.normalizerVersion, entryId]);
}

/** Serializes one normalized entry into its Buffer segment (one JSON line). */
function compileSegment(entry: Entry, dialect: WireDialect): Buffer {
  const normalized: JsonValue = dialect.normalizeEntry(entry);
  if (normalized === undefined) {
    // A dialect that lies about its return type would otherwise serialize the
    // whole segment as the literal string "undefined".
    throw new WireCompilerError(
      `dialect ${JSON.stringify(dialect.name)} normalized entry ${JSON.stringify(entry.entryId)} to undefined`,
    );
  }
  return Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8');
}

/**
 * Compiles the manifest window into a wire body.
 *
 * Entries not referenced by the manifest are ignored; a manifest reference
 * without an entry, or duplicate entryIds inside `entries`, are caller bugs
 * and raise {@link WireCompilerError}.
 *
 * Cost model: on a cache hit the segment is reused AS-IS and no hashing runs
 * (the sha256 is needed only to PUBLISH a manifest; it is computed on every
 * miss, so a first compile always carries hashes). `requireHashes: true`
 * forces hashing on hits too — the degraded equivalence mode's
 * hash-verification path.
 */
export function compile(
  manifest: ContextManifest,
  entries: readonly Entry[],
  opts: CompileOptions,
): CompiledBody {
  if (!Number.isFinite(opts.maxBytes) || opts.maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative finite number, got ${opts.maxBytes}`);
  }

  const dialect = opts.dialect ?? MINIMAX_M3_DIALECT;
  const cache: WireSegmentCache = opts.cache ?? defaultSegmentCache();
  const requireHashes = opts.requireHashes === true;

  // Index entries by id; duplicates would make the manifest resolution
  // ambiguous, so they are rejected instead of silently picking a winner.
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    if (byId.has(entry.entryId)) {
      throw new WireCompilerError(`duplicate entryId in entries: ${JSON.stringify(entry.entryId)}`);
    }
    byId.set(entry.entryId, entry);
  }

  const parts: Buffer[] = [];
  const stats: SegmentStat[] = [];
  const insertedKeys: string[] = [];
  let totalBytes = 0;

  // A duplicated manifest reference would silently repeat a segment in the
  // body (e.g. after a botched compaction), doubling context without error —
  // rejected exactly like duplicate entries.
  const seenRefs = new Set<string>();
  for (const ref of manifest) {
    if (seenRefs.has(ref.entryId)) {
      throw new WireCompilerError(`duplicate entryId in manifest: ${JSON.stringify(ref.entryId)}`);
    }
    seenRefs.add(ref.entryId);

    const entry = byId.get(ref.entryId);
    if (entry === undefined) {
      throw new WireCompilerError(`manifest references unknown entryId: ${JSON.stringify(ref.entryId)}`);
    }
    const key = segmentKey(dialect, entry.entryId);
    const cached = cache.get(key);
    const cacheHit = cached !== undefined;
    // A cache hit skips the per-entry serialization entirely: the cached
    // segment bytes are reused as-is (segments are immutable once compiled),
    // and the O(payload) sha256 with them — the warm path stays O(window)
    // arithmetic, never re-hashing megabytes.
    const segment = cacheHit ? cached : compileSegment(entry, dialect);
    if (!cacheHit) {
      cache.set(key, segment);
      insertedKeys.push(key);
    }
    const sha256 =
      cacheHit && !requireHashes ? undefined : createHash('sha256').update(segment).digest('hex');

    parts.push(segment);
    stats.push({
      entryId: entry.entryId,
      kind: entry.kind,
      bytes: segment.length,
      sha256,
      cacheHit,
    });
    totalBytes += segment.length;
  }

  if (totalBytes > opts.maxBytes) {
    // Roll back the segments THIS pass inserted: a failed compile must not
    // warm the shared cache on behalf of other callers — otherwise a later
    // successful pass would hit entries it never serialized and could not
    // publish hashes for (cacheHit: true, sha256: undefined).
    for (const key of insertedKeys) cache.delete?.(key);
    throw new WireBudgetExceeded({
      totalBytes,
      maxBytes: opts.maxBytes,
      breakdown: stats.map((stat) => ({ entryId: stat.entryId, bytes: stat.bytes })),
    });
  }

  return { body: Buffer.concat(parts, totalBytes), totalBytes, segments: stats };
}
