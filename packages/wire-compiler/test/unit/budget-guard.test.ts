import { describe, expect, it } from 'vitest';

import { compile, createLruSegmentCache, WireBudgetExceeded, WireCompilerError } from '../../src/index.js';
import type { Entry } from '../../src/index.js';

/** Three text entries with distinct, known wire sizes. */
function sizedEntries(): Entry[] {
  return [
    { entryId: 'short', kind: 'text', content: 'x'.repeat(10) },
    { entryId: 'medium', kind: 'text', content: 'y'.repeat(100) },
    { entryId: 'long', kind: 'text', content: 'z'.repeat(1000) },
  ];
}

const MANIFEST = sizedEntries().map((entry) => ({ entryId: entry.entryId }));

describe('wire budget guard', () => {
  it('rejects an oversized body with an exact per-entryId breakdown', () => {
    const cache = createLruSegmentCache(64);
    // Reference total: compile without a budget to learn the exact size.
    const reference = compile(MANIFEST, sizedEntries(), { maxBytes: Number.MAX_SAFE_INTEGER, cache });

    let raised: WireBudgetExceeded | undefined;
    try {
      compile(MANIFEST, sizedEntries(), { maxBytes: reference.totalBytes - 1, cache });
    } catch (error) {
      raised = error as WireBudgetExceeded;
    }

    expect(raised).toBeInstanceOf(WireBudgetExceeded);
    expect(raised).toBeInstanceOf(WireCompilerError);
    expect(raised?.name).toBe('WireBudgetExceeded');
    expect(raised?.totalBytes).toBe(reference.totalBytes);
    expect(raised?.maxBytes).toBe(reference.totalBytes - 1);
    // Breakdown is per entryId, in manifest order, and sums exactly to totalBytes.
    expect(raised?.breakdown.map((part) => part.entryId)).toEqual(['short', 'medium', 'long']);
    expect(raised?.breakdown.reduce((sum, part) => sum + part.bytes, 0)).toBe(reference.totalBytes);
    expect(raised?.breakdown).toEqual(reference.segments.map((stat) => ({ entryId: stat.entryId, bytes: stat.bytes })));
    // Message names the largest offender.
    expect(raised?.message).toContain('long');
  });

  // Regression (wave-2 review): a budget-failed compile used to leave the
  // segments it had just serialized in the (shared) cache — without ever
  // publishing their sha256. A later successful pass of another caller then
  // reported `cacheHit: true` with `sha256: undefined` for entries it had
  // never serialized itself. The failed pass now rolls its inserts back.
  it('a budget breach leaves the cache exactly as it found it', () => {
    const cache = createLruSegmentCache(64);
    expect(() => compile(MANIFEST, sizedEntries(), { maxBytes: 8, cache })).toThrow(
      WireBudgetExceeded,
    );
    expect(cache.size).toBe(0);

    // The next successful pass is a COLD pass: it serializes everything
    // itself and can publish hashes for every segment.
    const after = compile(MANIFEST, sizedEntries(), {
      maxBytes: Number.MAX_SAFE_INTEGER,
      cache,
    });
    expect(after.segments.every((segment) => segment.cacheHit === false)).toBe(true);
    expect(after.segments.every((segment) => typeof segment.sha256 === 'string')).toBe(true);
  });

  it('rollback only removes what the failed pass itself inserted', () => {
    const cache = createLruSegmentCache(64);
    // Warm one entry first: it predates the failing pass.
    compile([{ entryId: 'short' }], [sizedEntries()[0]!], {
      maxBytes: Number.MAX_SAFE_INTEGER,
      cache,
    });

    let raised: unknown;
    try {
      compile(MANIFEST, sizedEntries(), { maxBytes: 8, cache });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(WireBudgetExceeded);

    // The pre-existing entry survives; the failed pass's own inserts are gone.
    expect(cache.size).toBe(1);
    const warmed = compile([{ entryId: 'short' }], [sizedEntries()[0]!], {
      maxBytes: Number.MAX_SAFE_INTEGER,
      cache,
    });
    expect(warmed.segments[0]!.cacheHit).toBe(true);
  });

  it('admits a body exactly at the budget (the guard is a strict >)', () => {
    const reference = compile(MANIFEST, sizedEntries(), { maxBytes: Number.MAX_SAFE_INTEGER, cache: createLruSegmentCache(64) });
    const exact = compile(MANIFEST, sizedEntries(), {
      maxBytes: reference.totalBytes,
      cache: createLruSegmentCache(64),
    });
    expect(exact.totalBytes).toBe(reference.totalBytes);
    expect(exact.body.equals(reference.body)).toBe(true);
  });

  it('enforces the budget even when every segment is already cached', () => {
    const cache = createLruSegmentCache(64);
    compile(MANIFEST, sizedEntries(), { maxBytes: Number.MAX_SAFE_INTEGER, cache });

    let raised: unknown;
    try {
      // Cached segments only: the guard must still run on the byte lengths.
      compile(MANIFEST, sizedEntries(), { maxBytes: 8, cache });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(WireBudgetExceeded);
  });

  it('allows an empty manifest under a zero budget', () => {
    const result = compile([], [], { maxBytes: 0, cache: createLruSegmentCache(8) });
    expect(result.totalBytes).toBe(0);
    expect(result.body.length).toBe(0);
    expect(result.segments).toEqual([]);
  });

  it('rejects non-sensical budgets', () => {
    expect(() => compile([], [], { maxBytes: -1 })).toThrow(RangeError);
    expect(() => compile([], [], { maxBytes: Number.NaN })).toThrow(RangeError);
  });
});
