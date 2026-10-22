// LRU eviction under the resident byte budget, including batch eviction and
// the digest-mode floor for pages that can never fit.

import { expect, it, describe } from 'vitest';

import { makeMmu, buf, refOf, shaOf, makeLcg } from './helpers.js';

describe('LRU eviction under the byte budget', () => {
  it('evicts least-recently-used pages in a batch and keeps the budget', async () => {
    // Budget 300, default ratio 0.75 -> eviction drains to <= 225.
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const pages = [buf(100, 1), buf(100, 2), buf(100, 3), buf(100, 4)];
      const handles = pages.map((bytes) => mmu.page(refOf(bytes)));

      expect(mmu.admit(handles[0]!)).toBe('resident');
      expect(mmu.admit(handles[1]!)).toBe('resident');
      expect(mmu.admit(handles[2]!)).toBe('resident');
      expect(mmu.stats()).toEqual({ resident: 3, bytes: 300 });

      // The fourth admission goes over budget and evicts a batch: draining
      // to <= 225 needs two pages, so both LRU tails go at once.
      expect(mmu.admit(handles[3]!)).toBe('resident');
      expect(mmu.stats()).toEqual({ resident: 2, bytes: 200 });
      expect(mmu.statusOf(handles[0]!)).toBe('digest');
      expect(mmu.statusOf(handles[1]!)).toBe('digest');
      expect(mmu.statusOf(handles[2]!)).toBe('resident');
      expect(mmu.statusOf(handles[3]!)).toBe('resident');
    } finally {
      await dispose();
    }
  });

  it('keeps resident bytes at or under the budget through churn', async () => {
    const budget = 500;
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: budget });
    try {
      const rnd = makeLcg(42);
      const handles = Array.from({ length: 24 }, (_, i) =>
        mmu.page(refOf(buf(120, i + 1))),
      );
      for (const handle of handles) {
        expect(mmu.admit(handle)).toBe('resident');
        // Faults never change residency, so the budget must hold at every step.
        const victim = handles[Math.floor(rnd() * handles.length)]!;
        if (mmu.statusOf(victim) !== 'digest') {
          await mmu.fault(victim);
        }
        expect(mmu.stats().bytes).toBeLessThanOrEqual(budget);
      }
      expect(mmu.stats().bytes).toBeLessThanOrEqual(budget);
    } finally {
      await dispose();
    }
  });

  it('leaves pages larger than the whole budget in digest mode', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const big = mmu.page(refOf(buf(500, 9)));
      expect(mmu.admit(big)).toBe('digest');
      expect(mmu.stats()).toEqual({ resident: 0, bytes: 0 });
      expect(mmu.statusOf(big)).toBe('digest');
      // Digest-mode pages still fault in their original bytes.
      expect(await mmu.fault(big)).toEqual(buf(500, 9));
      expect(mmu.stats()).toEqual({ resident: 0, bytes: 0 });
    } finally {
      await dispose();
    }
  });

  it('re-admits an evicted page on demand', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const [a, b, c, d] = [1, 2, 3, 4].map((fill) => mmu.page(refOf(buf(100, fill))));
      for (const handle of [a, b, c, d]) {
        mmu.admit(handle!);
      }
      expect(mmu.statusOf(a!)).toBe('digest');

      // {c, d} resident = 200 bytes; re-admitting `a` fits the budget again.
      expect(mmu.admit(a!)).toBe('resident');
      expect(mmu.stats()).toEqual({ resident: 3, bytes: 300 });
      expect(mmu.statusOf(a!)).toBe('resident');
      expect(mmu.statusOf(c!)).toBe('resident');
    } finally {
      await dispose();
    }
  });

  it('verifies page refs and rejects unknown content', async () => {
    const { mmu, cas, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const data = buf(64, 7);
      expect(() =>
        mmu.page({ sha256: shaOf(buf(64, 8)), mime: 'image/png', bytes: data }),
      ).toThrow(/do not match sha256/);
      expect(() => mmu.page({ sha256: 'nothex', mime: 'image/png' })).toThrow(/invalid/i);
      expect(() => mmu.page({ sha256: shaOf(data), mime: '' })).toThrow(/non-empty mime/);
      // Bytes-less refs must point at published content.
      expect(() => mmu.page({ sha256: shaOf(data), mime: 'image/png' })).toThrow(
        /not in the CAS/,
      );
      const published = await cas.putBytes(data);
      const handle = mmu.page({ sha256: published.sha256, mime: 'image/png' });
      expect(mmu.statusOf(handle)).toBe('new');
      expect(await mmu.fault(handle)).toEqual(data);
    } finally {
      await dispose();
    }
  });
});
