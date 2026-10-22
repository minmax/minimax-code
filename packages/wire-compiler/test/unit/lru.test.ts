import { describe, expect, it } from 'vitest';

import {
  compile,
  createLruSegmentCache,
  DEFAULT_SEGMENT_CACHE_CAPACITY,
  defaultSegmentCache,
  WireCompilerError,
} from '../../src/index.js';
import type { Entry, WireDialect } from '../../src/index.js';

function textEntry(id: string, text: string): Entry {
  return { entryId: id, kind: 'text', content: text };
}

describe('LRU segment cache', () => {
  it('evicts the least recently used key and refreshes recency on get', () => {
    const cache = createLruSegmentCache(2);
    cache.set('a', Buffer.from('A'));
    cache.set('b', Buffer.from('B'));

    // Touch `a` so `b` becomes the least recently used entry.
    expect(cache.get('a')?.toString()).toBe('A');
    cache.set('c', Buffer.from('C'));

    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.toString()).toBe('A');
    expect(cache.get('c')?.toString()).toBe('C');
    expect(cache.capacity).toBe(2);
  });

  it('rejects non-positive and non-integer capacities', () => {
    expect(() => createLruSegmentCache(0)).toThrow(RangeError);
    expect(() => createLruSegmentCache(-3)).toThrow(RangeError);
    expect(() => createLruSegmentCache(1.5)).toThrow(RangeError);
  });

  it('recompiles everything once capacity is smaller than the window', () => {
    const entries = [textEntry('e1', 'one'), textEntry('e2', 'two'), textEntry('e3', 'three')];
    const manifest = entries.map((entry) => ({ entryId: entry.entryId }));
    const cache = createLruSegmentCache(2);

    const first = compile(manifest, entries, { maxBytes: 1 << 20, cache });
    expect(first.segments.map((stat) => stat.cacheHit)).toEqual([false, false, false]);

    // Capacity 2 < window 3: every pass evicts a segment before the window
    // reaches it again, so a second pass misses on every segment — and still
    // produces byte-identical output.
    const second = compile(manifest, entries, { maxBytes: 1 << 20, cache });
    expect(second.segments.map((stat) => stat.cacheHit)).toEqual([false, false, false]);
    expect(second.body.equals(first.body)).toBe(true);
  });

  it('hits the cache for every segment once capacity covers the window', () => {
    const entries = [textEntry('e1', 'one'), textEntry('e2', 'two')];
    const manifest = entries.map((entry) => ({ entryId: entry.entryId }));
    const cache = createLruSegmentCache(2);

    compile(manifest, entries, { maxBytes: 1 << 20, cache });
    const again = compile(manifest, entries, { maxBytes: 1 << 20, cache });
    expect(again.segments.map((stat) => stat.cacheHit)).toEqual([true, true]);
  });

  it('uses the shared default cache when opts.cache is omitted', () => {
    // Unique entryIds keep this test independent of other tests sharing the
    // module-level cache.
    const id = `shared-${DEFAULT_SEGMENT_CACHE_CAPACITY}-${Math.random().toString(36).slice(2)}`;
    const entry = textEntry(id, 'shared');

    expect(defaultSegmentCache().capacity).toBe(DEFAULT_SEGMENT_CACHE_CAPACITY);
    const first = compile([{ entryId: id }], [entry], { maxBytes: 1 << 20 });
    const second = compile([{ entryId: id }], [entry], { maxBytes: 1 << 20 });
    expect(first.segments[0]?.cacheHit).toBe(false);
    expect(second.segments[0]?.cacheHit).toBe(true);
    expect(second.body.equals(first.body)).toBe(true);
  });

  it('rejects manifest references without entries and duplicate entry ids', () => {
    expect(() => compile([{ entryId: 'ghost' }], [], { maxBytes: 1 << 20 })).toThrow(WireCompilerError);
    expect(() =>
      compile([{ entryId: 'dup' }], [textEntry('dup', 'a'), textEntry('dup', 'b')], { maxBytes: 1 << 20 }),
    ).toThrow(/duplicate entryId in entries/);
    // A duplicated manifest reference would silently repeat the segment in
    // the body (doubling context), so it is rejected as well.
    expect(() =>
      compile([{ entryId: 'a' }, { entryId: 'a' }], [textEntry('a', 'x')], { maxBytes: 1 << 20 }),
    ).toThrow(/duplicate entryId in manifest/);
  });

  it('rejects an entry kind the dialect does not know', () => {
    const alien = { entryId: 'alien', kind: 'hologram', content: 'x' } as unknown as Entry;
    expect(() => compile([{ entryId: 'alien' }], [alien], { maxBytes: 1 << 20 })).toThrow(
      /unknown entry kind: "hologram"/,
    );
  });

  it('rejects a dialect normalizing an entry to undefined', () => {
    const lyingDialect = {
      name: 'lying',
      normalizerVersion: '1',
      // Deliberately returns undefined despite the declared return type.
      normalizeEntry: () => undefined as unknown as ReturnType<WireDialect['normalizeEntry']>,
    };
    expect(() =>
      compile([{ entryId: 'e1' }], [textEntry('e1', 'x')], { maxBytes: 1 << 20, dialect: lyingDialect }),
    ).toThrow(/normalized entry "e1" to undefined/);
  });
});
