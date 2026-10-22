// fault returns the original bytes in every residency mode, and the digest
// placeholder is a deterministic pure function of the page identity. Also
// covers the ctx.pages contract and the handle lifecycle errors.

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { formatPageDigest } from '../../src/digest.js';
import { createMMU } from '../../src/mmu.js';
import { buf, makeMmu, refOf, shaOf } from './helpers.js';

// Pinned by the spec: `[image sha256:ab12… WxH mime — recall(handle) чтобы увидеть]`.
const PLACEHOLDER_PATTERN =
  /^\[image sha256:[0-9a-f]{4}… (\?x\?|\d+x\d+) image\/png — recall\(handle\) чтобы увидеть\]$/u;

describe('fault returns the original content', () => {
  it('faults a page that was never admitted', async () => {
    const { mmu, cas, dispose } = await makeMmu();
    try {
      const data = buf(2048, 0x5a);
      const handle = mmu.page(refOf(data));
      expect(await mmu.fault(handle)).toEqual(data);
      // The in-hand bytes became durable on the first fault.
      expect(cas.has(shaOf(data))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('faults a resident page and keeps returning the same bytes', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 4096 });
    try {
      const data = buf(1024, 0xa7);
      const handle = mmu.page(refOf(data));
      mmu.admit(handle);
      expect(await mmu.fault(handle)).toEqual(data);
      expect(await mmu.fault(handle)).toEqual(data);
    } finally {
      await dispose();
    }
  });

  it('faults a digest-mode page without making it resident', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 256 });
    try {
      const data = buf(1024, 0x11);
      const handle = mmu.page(refOf(data));
      expect(mmu.admit(handle)).toBe('digest');
      expect(await mmu.fault(handle)).toEqual(data);
      expect(mmu.stats()).toEqual({ resident: 0, bytes: 0 });
    } finally {
      await dispose();
    }
  });

  it('pages in a file through pageFile and stores it verbatim', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 4096 });
    const files = await mkdtemp(path.join(tmpdir(), 'mcode-mmu-files-'));
    try {
      const source = path.join(files, 'picture.png');
      const data = buf(512, 0x42);
      await writeFile(source, data);
      const handle = await mmu.pageFile(source, { mime: 'image/png' });
      expect(handle.sourcePath).toBe(source);
      expect(handle.bytes).toBe(data.length);
      expect(mmu.admit(handle)).toBe('resident');
      expect(await mmu.fault(handle)).toEqual(data);
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });

  it('publishes pending bytes once, so another MMU over the same CAS can fault them', async () => {
    const { mmu, cas, dispose } = await makeMmu();
    try {
      const data = buf(128, 0x99);
      const handle = mmu.page(refOf(data));
      expect(await mmu.fault(handle)).toEqual(data);
      expect(cas.has(shaOf(data))).toBe(true);
      mmu.close();

      // A fresh MMU over the SAME CAS, bytes-less ref: content is durable.
      const second = createMMU(cas);
      const handle2 = second.page({ sha256: shaOf(data), mime: 'image/png' });
      expect(await second.fault(handle2)).toEqual(data);
      second.close();
    } finally {
      await dispose();
    }
  });
});

describe('digest placeholder determinism', () => {
  it('renders the pinned placeholder format with dimensions', async () => {
    const { mmu, dispose } = await makeMmu();
    try {
      const data = buf(64, 3);
      const handle = mmu.page(refOf(data, { width: 10, height: 20 }));
      const digest = mmu.digest(handle);
      expect(digest).toBe(
        `[image sha256:${shaOf(data).slice(0, 4)}… 10x20 image/png — recall(handle) чтобы увидеть]`,
      );
      expect(digest).toMatch(PLACEHOLDER_PATTERN);
    } finally {
      await dispose();
    }
  });

  it('collapses unknown dimensions to ?x?', async () => {
    const { mmu, dispose } = await makeMmu();
    try {
      const handle = mmu.page(refOf(buf(64, 4)));
      expect(mmu.digest(handle)).toMatch(
        /^\[image sha256:[0-9a-f]{4}… \?x\? image\/png — recall\(handle\) чтобы увидеть\]$/u,
      );
    } finally {
      await dispose();
    }
  });

  it('is stable across handles, admission state and MMU instances', async () => {
    const first = await makeMmu();
    const second = await makeMmu();
    try {
      const data = buf(96, 5);
      const h1 = first.mmu.page(refOf(data, { width: 640, height: 480 }));
      const before = first.mmu.digest(h1);
      first.mmu.admit(h1);
      expect(first.mmu.digest(h1)).toBe(before);
      first.mmu.advanceTurn();
      expect(first.mmu.digest(h1)).toBe(before);

      // Same identity fields in a different instance must render identically.
      const h2 = second.mmu.page(refOf(data, { width: 640, height: 480 }));
      expect(second.mmu.digest(h2)).toBe(before);

      // The pure renderer agrees with the MMU method.
      expect(formatPageDigest({ sha256: shaOf(data), mime: 'image/png', width: 640, height: 480 })).toBe(before);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('differs for different content and mime', async () => {
    const { mmu, dispose } = await makeMmu();
    try {
      const one = mmu.digest(mmu.page(refOf(buf(64, 1))));
      const two = mmu.digest(mmu.page(refOf(buf(64, 2))));
      const three = mmu.digest(mmu.page(refOf(buf(64, 1), { width: 1, height: 1 })));
      expect(one).not.toBe(two); // Content identity is distinct...
      expect(one).not.toBe(three); // ...and so are the dimensions.
      // Precondition of the test: the truncated quartets really differ here.
      expect(one.slice(14, 18)).not.toBe(two.slice(14, 18));
    } finally {
      await dispose();
    }
  });
});

describe('ctx.pages contract', () => {
  it('exposes read and digest as the only observation channels', async () => {
    const { mmu, dispose } = await makeMmu();
    try {
      const data = buf(256, 0x77);
      const handle = mmu.page(refOf(data, { width: 8, height: 8 }));
      mmu.admit(handle);
      expect(await mmu.pages.read(handle)).toEqual(data);
      expect(mmu.pages.digest(handle)).toBe(mmu.digest(handle));
    } finally {
      await dispose();
    }
  });
});

describe('handle lifecycle errors', () => {
  it('rejects every use of a released handle and is idempotent to release', async () => {
    const { mmu, dispose } = await makeMmu();
    try {
      const handle = mmu.page(refOf(buf(64, 6)));
      mmu.admit(handle);
      mmu.release(handle);
      expect(mmu.release(handle)).toBeUndefined(); // Idempotent.
      expect(mmu.stats()).toEqual({ resident: 0, bytes: 0 });
      expect(mmu.statusOf(handle)).toBe('released');
      await expect(mmu.fault(handle)).rejects.toThrow(/released/);
      await expect(mmu.pages.read(handle)).rejects.toThrow(/released/);
      expect(() => mmu.digest(handle)).toThrow(/released/);
      expect(() => mmu.admit(handle)).toThrow(/released/);
      expect(() => mmu.pin(handle)).toThrow(/released/);
    } finally {
      await dispose();
    }
  });

  it('rejects unknown handles from foreign instances', async () => {
    const { mmu, dispose } = await makeMmu();
    const other = await makeMmu();
    try {
      const foreign = other.mmu.page(refOf(buf(64, 8)));
      expect(() => mmu.admit(foreign)).toThrow(/unknown page handle/);
      expect(() => mmu.statusOf(foreign)).toThrow(/unknown page handle/);
      await expect(mmu.fault(foreign)).rejects.toThrow(/unknown page handle/);
    } finally {
      await other.dispose();
      await dispose();
    }
  });
});
