/**
 * LRU cache of compiled wire segments.
 *
 * Segments are stored as `Buffer`s (off the UTF-16 string heap) keyed by
 * `(dialect.name, dialect.normalizerVersion, entryId)`. The cache is derived
 * state — evicting everything is always safe, a miss just re-serializes the
 * frozen entry deterministically. Correctness rests on the frozen-entry
 * guarantee: an entryId never maps to different content.
 */

import type { WireSegmentCache } from './types.js';

export type { WireSegmentCache } from './types.js';

/** Bounded LRU view of {@link WireSegmentCache} with introspection for tests. */
export interface LruSegmentCache extends WireSegmentCache {
  /** Maximum number of segments the cache retains. */
  readonly capacity: number;
  /** Current number of cached segments. */
  readonly size: number;
}

/** Capacity of the module-level shared cache used when `opts.cache` is omitted. */
export const DEFAULT_SEGMENT_CACHE_CAPACITY = 512;

class LruCache implements LruSegmentCache {
  private readonly entries = new Map<string, Buffer>();
  readonly capacity: number;

  constructor(capacity: number) {
    // Capacity must be a positive integer: an unbounded or zero-capacity cache
    // would silently turn the guard on serialization cost into a memory leak
    // or a no-op respectively.
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`cache capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): Buffer | undefined {
    const segment = this.entries.get(key);
    if (segment === undefined) return undefined;
    // Re-insert to mark the key as most recently used (Map iteration order is
    // insertion order, so the oldest key is always the first one).
    this.entries.delete(key);
    this.entries.set(key, segment);
    return segment;
  }

  set(key: string, segment: Buffer): void {
    this.entries.delete(key);
    this.entries.set(key, segment);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/** Creates an isolated LRU segment cache with the given capacity. */
export function createLruSegmentCache(capacity: number): LruSegmentCache {
  return new LruCache(capacity);
}

/**
 * Module-level shared cache backing `compile()` when no explicit cache is
 * passed. Sharing is safe because keys are globally unique
 * `(dialect, normalizerVersion, entryId)` triples and entries are frozen.
 */
const sharedCache: LruSegmentCache = createLruSegmentCache(DEFAULT_SEGMENT_CACHE_CAPACITY);

/** Returns the default shared segment cache. */
export function defaultSegmentCache(): LruSegmentCache {
  return sharedCache;
}
