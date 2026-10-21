// Pin/unpin semantics measured in turns: pins shield pages from eviction for
// exactly N turns, unpin keeps a one-turn hysteresis grace, and pinning an
// already unpinned page must not conjure protection.

import { describe, expect, it } from 'vitest';

import { buf, makeMmu, refOf } from './helpers.js';

describe('pin hysteresis across turns', () => {
  it('protects a pinned page from batch eviction for exactly N turns', async () => {
    // Budget 300, default ratio 0.75 -> eviction drains to <= 225.
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const [a, b, c, d, e, f] = [1, 2, 3, 4, 5, 6].map((fill) =>
        mmu.page(refOf(buf(100, fill))),
      );

      // Turn 0: pin `a` for 3 turns, then fill the resident set.
      mmu.pin(a!, 3);
      for (const handle of [a, b, c]) {
        expect(mmu.admit(handle!)).toBe('resident');
      }
      expect(mmu.stats()).toEqual({ resident: 3, bytes: 300 });

      // Turn 1: over-budget admission must skip the pinned LRU tail `a`.
      mmu.advanceTurn();
      expect(mmu.admit(d!)).toBe('resident');
      expect(mmu.statusOf(a!)).toBe('resident');
      expect(mmu.statusOf(b!)).toBe('digest');

      // Turn 2: still inside the pin window.
      mmu.advanceTurn();
      expect(mmu.admit(e!)).toBe('resident');
      expect(mmu.statusOf(a!)).toBe('resident');

      // Turn 3: the countdown expired, `a` is evicted like any other page.
      mmu.advanceTurn();
      expect(mmu.admit(f!)).toBe('resident');
      expect(mmu.statusOf(a!)).toBe('digest');
      expect(mmu.stats().bytes).toBeLessThanOrEqual(300);
    } finally {
      await dispose();
    }
  });

  it('keeps a one-turn grace after unpin before the page is evictable', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const [a, b, c, d, e, f] = [1, 2, 3, 4, 5, 6].map((fill) =>
        mmu.page(refOf(buf(100, fill))),
      );

      mmu.admit(a!);
      mmu.admit(b!);
      mmu.pin(a!, 10);
      mmu.advanceTurn(); // Turn 1.
      mmu.unpin(a!); // Grace: protected until turn 2 inclusive.

      // Same-turn admission pressure cannot evict the freshly unpinned page.
      mmu.admit(c!);
      mmu.admit(d!); // Over budget: evicts unpinned pages, skips `a`.
      expect(mmu.statusOf(a!)).toBe('resident');
      expect(mmu.statusOf(b!)).toBe('digest');

      // One turn later the grace is gone and `a` is evicted.
      mmu.advanceTurn(); // Turn 2.
      mmu.admit(e!);
      mmu.admit(f!);
      expect(mmu.statusOf(a!)).toBe('digest');
      expect(mmu.stats().bytes).toBeLessThanOrEqual(300);
    } finally {
      await dispose();
    }
  });

  it('treats unpin of an unpinned page as a no-op without conjured grace', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const [a, b, c, d] = [1, 2, 3, 4].map((fill) => mmu.page(refOf(buf(100, fill))));
      mmu.admit(a!);
      mmu.admit(b!);
      mmu.admit(c!);

      // `b` was never pinned: unpin must not add protection.
      mmu.unpin(b!);
      mmu.admit(d!); // Over budget: LRU order a, b, c -> a and b evicted.
      expect(mmu.statusOf(a!)).toBe('digest');
      expect(mmu.statusOf(b!)).toBe('digest');
      expect(mmu.stats()).toEqual({ resident: 2, bytes: 200 });
    } finally {
      await dispose();
    }
  });

  it('skips pinned pages even when they are the LRU-oldest residents', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 200 });
    try {
      const [a, b, c] = [1, 2, 3].map((fill) => mmu.page(refOf(buf(100, fill))));
      mmu.pin(a!, 5);
      mmu.admit(a!);
      mmu.admit(b!);
      // Admitting `c` goes over budget; the pinned LRU-oldest `a` is skipped
      // and the eviction drains through `b` down to the watermark (<= 150).
      mmu.admit(c!);
      expect(mmu.statusOf(a!)).toBe('resident');
      expect(mmu.statusOf(b!)).toBe('digest');
      expect(mmu.statusOf(c!)).toBe('resident');
      expect(mmu.stats()).toEqual({ resident: 2, bytes: 200 });
    } finally {
      await dispose();
    }
  });

  it('lets fully pinned resident sets oversubscribe the budget', async () => {
    // Pins are explicit caller contracts: when every resident page is pinned
    // there is nothing legal to evict, so the budget is exceeded by design.
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const [a, b, c, d] = [1, 2, 3, 4].map((fill) => mmu.page(refOf(buf(100, fill))));
      for (const handle of [a, b, c]) {
        mmu.pin(handle!, 5);
        mmu.admit(handle!);
      }
      expect(mmu.admit(d!)).toBe('resident');
      expect(mmu.stats()).toEqual({ resident: 4, bytes: 400 });
      expect(mmu.statusOf(d!)).toBe('resident');
      // Unpin everything and the very next over-budget admission restores it.
      for (const handle of [a, b, c]) {
        mmu.unpin(handle!);
      }
      mmu.advanceTurn();
      const e = mmu.page(refOf(buf(100, 5)));
      mmu.admit(e);
      expect(mmu.stats().bytes).toBeLessThanOrEqual(300);
    } finally {
      await dispose();
    }
  });
});
