import { describe, expect, it } from 'vitest';

import { compile, createLruSegmentCache } from '../../src/index.js';
import type { Entry, WireDialect } from '../../src/index.js';

/** Entry whose text the test dialects transform. */
function entry(text: string): Entry {
  return { entryId: `msg-${text}`, kind: 'text', content: text };
}

/** Dialect with an injectable normalizer version, so tests can bump just it. */
function makeDialect(version: string, transform: (text: string) => string): WireDialect {
  return {
    name: 'test-dialect',
    normalizerVersion: version,
    normalizeEntry: (e) => ({
      role: e.role ?? 'user',
      content: transform(typeof e.content === 'string' ? e.content : ''),
    }),
  };
}

describe('normalizer version invalidation', () => {
  it('recompiles a segment when the normalizer version changes', () => {
    const cache = createLruSegmentCache(64);
    const v1 = makeDialect('1', (text) => text.toLowerCase());
    const v2 = makeDialect('2', (text) => text.toUpperCase());

    const hello = entry('HelLo');
    const first = compile([{ entryId: hello.entryId }], [hello], {
      maxBytes: 1 << 20,
      dialect: v1,
      cache,
    });
    expect(first.segments[0]?.cacheHit).toBe(false);

    const second = compile([{ entryId: 'msg-HelLo' }], [entry('HelLo')], {
      maxBytes: 1 << 20,
      dialect: v2,
      cache,
    });
    // New normalizer version → cache miss and new bytes.
    expect(second.segments[0]?.cacheHit).toBe(false);
    expect(second.body.equals(first.body)).toBe(false);
    expect(second.body.toString('utf8')).toContain('HELLO');

    // Third pass on the new version hits the cache.
    const third = compile([{ entryId: 'msg-HelLo' }], [entry('HelLo')], {
      maxBytes: 1 << 20,
      dialect: v2,
      cache,
    });
    expect(third.segments[0]?.cacheHit).toBe(true);
    expect(third.body.equals(second.body)).toBe(true);
  });

  it('keeps other versions and other dialects cached across a version bump', () => {
    const cache = createLruSegmentCache(64);
    const v1 = makeDialect('1', (text) => text);
    const v2 = makeDialect('2', (text) => `${text}!`);
    const otherDialect: WireDialect = { ...v1, name: 'other-dialect' };

    // Warm three namespaces on the same entryId.
    for (const dialect of [v1, v2, otherDialect]) {
      compile([{ entryId: 'msg-x' }], [entry('x')], { maxBytes: 1 << 20, dialect, cache });
    }

    // Bumping v1 → v2(bumped) invalidates ONLY the v1 namespace.
    const v1bumped = makeDialect('3', (text) => `${text}?`);
    const after = compile([{ entryId: 'msg-x' }], [entry('x')], {
      maxBytes: 1 << 20,
      dialect: v1bumped,
      cache,
    });
    expect(after.segments[0]?.cacheHit).toBe(false);

    // The untouched namespaces still hit: v2 and other-dialect were not
    // invalidated by the v1→v3 bump (per-namespace keys, not a global flush).
    const v2Again = compile([{ entryId: 'msg-x' }], [entry('x')], {
      maxBytes: 1 << 20,
      dialect: v2,
      cache,
    });
    const otherAgain = compile([{ entryId: 'msg-x' }], [entry('x')], {
      maxBytes: 1 << 20,
      dialect: otherDialect,
      cache,
    });
    expect(v2Again.segments[0]?.cacheHit).toBe(true);
    expect(otherAgain.segments[0]?.cacheHit).toBe(true);
  });

  it('compiles deterministically across a version bump when rules are equal', () => {
    const cache = createLruSegmentCache(64);
    const a = makeDialect('1', (text) => text.trim());
    const b = makeDialect('2', (text) => text.trim());
    const padded: Entry = { entryId: 'msg-t', kind: 'text', content: '  t  ' };

    const first = compile([{ entryId: padded.entryId }], [padded], {
      maxBytes: 1 << 20,
      dialect: a,
      cache,
    });
    const second = compile([{ entryId: padded.entryId }], [padded], {
      maxBytes: 1 << 20,
      dialect: b,
      cache,
    });
    // Equal rules under different versions produce identical bytes; only the
    // cache namespace differs (second run is a miss because of the version).
    expect(second.segments[0]?.cacheHit).toBe(false);
    expect(second.body.equals(first.body)).toBe(true);
  });
});
