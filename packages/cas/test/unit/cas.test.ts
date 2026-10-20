import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCas } from '../../src/cas.js';

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mcode-cas-'));
}

/** Snapshot used to assert that a stored blob was not rewritten by a dedup hit. */
async function blobIdentity(root: string, sha256: string) {
  const shard = path.join(root, 'cas', sha256.slice(0, 2));
  const info = await stat(path.join(shard, sha256.slice(2)));
  return { ino: info.ino, mtimeMs: info.mtimeMs };
}

describe('cas roundtrip', () => {
  it('stores and reads back bytes with the correct digest, size and layout', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const data = Buffer.from('hello cas');
      const expectedSha = createHash('sha256').update(data).digest('hex');

      const put = await cas.putBytes(data);
      expect(put).toEqual({ sha256: expectedSha, size: data.length });

      expect(cas.has(expectedSha)).toBe(true);
      expect(await cas.get(expectedSha)).toEqual(data);

      // Layout: <root>/cas/<first 2 hex>/<remaining 62 hex>.
      const expectedPath = path.join(root, 'cas', expectedSha.slice(0, 2), expectedSha.slice(2));
      expect(cas.pathFor(expectedSha)).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('roundtrips an empty buffer and full-range binary content', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);

      const empty = await cas.putBytes(Buffer.alloc(0));
      expect(empty.size).toBe(0);
      expect(await cas.get(empty.sha256)).toEqual(Buffer.alloc(0));

      const binary = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));
      const put = await cas.putBytes(binary);
      expect(put.size).toBe(256);
      expect(createHash('sha256').update(binary).digest('hex')).toBe(put.sha256);
      expect(await cas.get(put.sha256)).toEqual(binary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stores files and images verbatim without re-encoding', async () => {
    const root = await makeRoot();
    const sourceDir = await mkdtemp(path.join(tmpdir(), 'mcode-cas-src-'));
    try {
      const cas = await openCas(root);
      // A tiny valid PNG header: stored byte-for-byte, never decoded.
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(randomUUID()),
      ]);
      const imagePath = path.join(sourceDir, 'pixel.png');
      await writeFile(imagePath, png);

      const viaFile = await cas.putFile(imagePath);
      expect(viaFile).toEqual({ sha256: createHash('sha256').update(png).digest('hex'), size: png.length });
      expect(await cas.get(viaFile.sha256)).toEqual(png);

      const viaImage = await cas.putImage(imagePath);
      // Same bytes as putFile: the digest matches and nothing is re-encoded.
      expect(viaImage).toEqual(viaFile);
      expect(await readFile(cas.pathFor(viaImage.sha256))).toEqual(png);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});

describe('cas dedup', () => {
  it('does not rewrite an existing blob on a repeated putBytes', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const data = Buffer.from('dedup me');
      const first = await cas.putBytes(data);
      const before = await blobIdentity(root, first.sha256);

      const second = await cas.putBytes(data);
      expect(second).toEqual(first);
      const after = await blobIdentity(root, first.sha256);
      expect(after).toEqual(before);

      // A dedup hit never touches the tmp staging directory either.
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not rewrite the stored blob on a putFile dedup hit', async () => {
    const root = await makeRoot();
    const sourceDir = await mkdtemp(path.join(tmpdir(), 'mcode-cas-src-'));
    try {
      const cas = await openCas(root);
      const sourcePath = path.join(sourceDir, 'blob.bin');
      const data = Buffer.from('same content');
      await writeFile(sourcePath, data);

      const first = await cas.putFile(sourcePath);
      const before = await blobIdentity(root, first.sha256);

      const second = await cas.putFile(sourcePath);
      expect(second).toEqual(first);
      expect(await blobIdentity(root, first.sha256)).toEqual(before);
      expect(await cas.get(first.sha256)).toEqual(data);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});

describe('cas atomicity', () => {
  it('never exposes an orphaned tmp file left by an interrupted write', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const garbage = Buffer.from('half-written garbage');

      // Simulate a publication that died before its rename: a partial tmp
      // file is left in <root>/tmp and the blob never becomes visible.
      await mkdir(path.join(root, 'tmp'), { recursive: true });
      await writeFile(path.join(root, 'tmp', 'interrupted-tmp'), garbage);

      const garbageSha = createHash('sha256').update(garbage).digest('hex');
      expect(cas.has(garbageSha)).toBe(false);
      await expect(cas.get(garbageSha)).rejects.toThrow(/not found/);

      // The store stays usable and the orphan stays out of the way.
      const put = await cas.putBytes(Buffer.from('after crash'));
      expect(await cas.get(put.sha256)).toEqual(Buffer.from('after crash'));
      expect(cas.has(garbageSha)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes nothing when the rename fails and cleans up the tmp file', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // chmod does not stop root, so the failure cannot be simulated.
      return;
    }
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const data = Buffer.from('unpublishable');
      const sha = createHash('sha256').update(data).digest('hex');
      const shard = path.join(root, 'cas', sha.slice(0, 2));
      await mkdir(shard, { recursive: true });
      await chmod(shard, 0o500);
      try {
        await expect(cas.putBytes(data)).rejects.toThrow();
        // The interrupted publication is not visible and left no tmp file.
        expect(cas.has(sha)).toBe(false);
        await expect(cas.get(sha)).rejects.toThrow(/not found/);
      } finally {
        await chmod(shard, 0o700);
      }
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);

      // After the blocker is gone, publication succeeds.
      await cas.putBytes(data);
      expect(await cas.get(sha)).toEqual(data);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the store readable while concurrent puts of the same content race', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const data = Buffer.from('raced');
      const results = await Promise.all(
        Array.from({ length: 8 }, () => cas.putBytes(data)),
      );
      const shas = new Set(results.map((put) => put.sha256));
      expect(shas.size).toBe(1);
      expect(await cas.get(results[0]!.sha256)).toEqual(data);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('cas validation', () => {
  it('rejects digests that are not 64 lowercase-compatible hex chars', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      expect(() => cas.pathFor('../escape')).toThrow(/invalid SHA-256 digest/);
      expect(() => cas.pathFor(`${'a'.repeat(63)}g`)).toThrow(/invalid SHA-256 digest/);
      expect(() => cas.has('../escape')).toThrow(/invalid SHA-256 digest/);
      await expect(cas.get('../escape')).rejects.toThrow(/invalid SHA-256 digest/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts uppercase digests by normalizing them', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const put = await cas.putBytes(Buffer.from('normalize'));
      const upper = put.sha256.toUpperCase();
      expect(cas.pathFor(upper)).toBe(cas.pathFor(put.sha256));
      expect(cas.has(upper)).toBe(true);
      expect(await cas.get(upper)).toEqual(Buffer.from('normalize'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
