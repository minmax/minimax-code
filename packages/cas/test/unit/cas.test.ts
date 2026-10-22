import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { openCas } from '../../src/cas.js';

// Test doubles for the two races this suite simulates:
// - `simulatedMissing` makes one existence probe lie about a blob being absent,
//   so the exclusive link commit loses the publication race with EEXIST;
// - `statOverrides` feeds putFile a stale size, so its copy pass disagrees and
//   the second-pass-on-mismatch path has to reconcile;
// - `readStreamOpens` counts source reads, proving putFile is single-pass.
const simulatedMissing = vi.hoisted(() => new Set<string>());
const statOverrides = vi.hoisted(() => new Map<string, () => Stats>());
const readStreamOpens = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async stat(pathLike: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) {
      const override = statOverrides.get(String(pathLike));
      if (override !== undefined) {
        statOverrides.delete(String(pathLike));
        return override();
      }
      if (simulatedMissing.delete(String(pathLike))) {
        const simulated = new Error(
          `simulated ENOENT (publication race): ${String(pathLike)}`,
        ) as NodeJS.ErrnoException;
        simulated.code = 'ENOENT';
        throw simulated;
      }
      return actual.stat(pathLike, options);
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream(pathLike: Parameters<typeof actual.createReadStream>[0], options?: Parameters<typeof actual.createReadStream>[1]) {
      readStreamOpens.push(String(pathLike));
      return actual.createReadStream(pathLike, options);
    },
  };
});

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mcode-cas-'));
}

/** Snapshot used to assert that a stored blob was not rewritten by a dedup hit. */
async function blobIdentity(root: string, sha256: string) {
  const shard = path.join(root, 'cas', sha256.slice(0, 2));
  const info = await stat(path.join(shard, sha256.slice(2)));
  return { ino: info.ino, mtimeMs: info.mtimeMs };
}

/** Drains a stream to a buffer; rejects when the stream errors. */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
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

      expect(await cas.hasAsync(expectedSha)).toBe(true);
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

  it('accepts Uint8Array views over larger buffers, not just Buffers', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
      const view = backing.subarray(1, 5);

      const put = await cas.putBytes(view);
      expect(put.size).toBe(4);
      expect(put.sha256).toBe(createHash('sha256').update(view).digest('hex'));
      expect(await cas.get(put.sha256)).toEqual(Buffer.from([2, 3, 4, 5]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stores file bytes verbatim without re-encoding', async () => {
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
      expect(viaFile).toEqual({
        sha256: createHash('sha256').update(png).digest('hex'),
        size: png.length,
      });
      expect(await cas.get(viaFile.sha256)).toEqual(png);
      expect(await readFile(cas.pathFor(viaFile.sha256))).toEqual(png);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});

describe('cas existence probes', () => {
  it('hasAsync probes existence and rejects invalid digests', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const put = await cas.putBytes(Buffer.from('probe'));

      expect(await cas.hasAsync(put.sha256)).toBe(true);
      expect(await cas.hasAsync('b'.repeat(64))).toBe(false);
      await expect(cas.hasAsync('nope')).rejects.toThrow(/invalid SHA-256 digest/);
      await expect(cas.hasAsync('../escape')).rejects.toThrow(/invalid SHA-256 digest/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the legacy sync has() boolean for compat callers', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const put = await cas.putBytes(Buffer.from('legacy probe'));

      // No await: the legacy probe must keep returning a plain boolean.
      expect(cas.has(put.sha256)).toBe(true);
      expect(cas.has('c'.repeat(64))).toBe(false);
      // It still validates its input synchronously.
      expect(() => cas.has('../escape')).toThrow(/invalid SHA-256 digest/);
    } finally {
      await rm(root, { recursive: true, force: true });
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
      expect(await cas.hasAsync(garbageSha)).toBe(false);
      await expect(cas.get(garbageSha)).rejects.toThrow(/not found/);

      // The store stays usable and the orphan stays out of the way.
      const put = await cas.putBytes(Buffer.from('after crash'));
      expect(await cas.get(put.sha256)).toEqual(Buffer.from('after crash'));
      expect(await cas.hasAsync(garbageSha)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sweeps orphaned tmp files on open but keeps live ones', async () => {
    const root = await makeRoot();
    try {
      await mkdir(path.join(root, 'tmp'), { recursive: true });
      // A tmp file stranded by kill -9 between the write and the commit.
      const stalePath = path.join(root, 'tmp', 'orphaned-by-crash.tmp');
      await writeFile(stalePath, Buffer.from('killed mid-write'));
      const backdated = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(stalePath, backdated, backdated);
      // A live publisher's tmp file is minutes old at most.
      const freshPath = path.join(root, 'tmp', 'in-flight.tmp');
      await writeFile(freshPath, Buffer.from('live publisher'));

      await openCas(root);

      expect(existsSync(stalePath)).toBe(false);
      expect(existsSync(freshPath)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans up the tmp file when a concurrent publisher wins the race', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const data = Buffer.from('contended bytes');
      const sha256 = createHash('sha256').update(data).digest('hex');
      const target = cas.pathFor(sha256);
      // The rival publisher lands between this publisher's probe and its
      // exclusive commit: the probe lies "missing", the link gets EEXIST.
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
      const rival = await blobIdentity(root, sha256);
      simulatedMissing.add(target);

      const put = await cas.putBytes(data);
      expect(put).toEqual({ sha256, size: data.length });

      // The loser left no tmp behind and the winner's inode survived untouched.
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
      expect(await blobIdentity(root, sha256)).toEqual(rival);
      expect(await cas.hasAsync(sha256)).toBe(true);
      expect(await cas.get(sha256)).toEqual(data);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes nothing when the commit fails and cleans up the tmp file', async () => {
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
        expect(await cas.hasAsync(sha)).toBe(false);
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
      // The seven EEXIST losers cleaned up after themselves.
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('cas read integrity', () => {
  it('rejects a get whose stored blob no longer matches its digest', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const put = await cas.putBytes(Buffer.from('pristine'));
      await writeFile(cas.pathFor(put.sha256), Buffer.from('tampered!'));

      await expect(cas.get(put.sha256)).rejects.toThrow(/integrity check failed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails the stream when the stored blob was substituted', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const data = Buffer.from('stream me whole');
      const put = await cas.putBytes(data);
      await writeFile(cas.pathFor(put.sha256), Buffer.concat([data, Buffer.from('extra')]));
      // The substitution has the right prefix but extra bytes: still caught.
      await expect(streamToBuffer(cas.getStream(put.sha256))).rejects.toThrow(
        /integrity check failed/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('streams a healthy blob in chunks without full materialization', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const data = randomBytes(3 * 1024 * 1024 + 7);
      const put = await cas.putBytes(data);
      // Deep-equality on multi-megabyte buffers is pathologically slow in the
      // test matcher, so the big blob is verified by digest and length.
      const streamed = await streamToBuffer(cas.getStream(put.sha256));
      expect(streamed.length).toBe(data.length);
      expect(createHash('sha256').update(streamed).digest('hex')).toBe(put.sha256);
      const whole = await cas.get(put.sha256);
      expect(whole.length).toBe(data.length);
      expect(createHash('sha256').update(whole).digest('hex')).toBe(put.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('checks the optional expected size on top of the digest', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const put = await cas.putBytes(Buffer.from('12345'));

      await expect(cas.get(put.sha256, { expectedSize: 4 })).rejects.toThrow(/size mismatch/);
      await expect(
        streamToBuffer(cas.getStream(put.sha256, { expectedSize: 6 })),
      ).rejects.toThrow(/size mismatch/);
      expect((await cas.get(put.sha256, { expectedSize: 5 })).toString()).toBe('12345');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing blobs as not found for get and getStream', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const missing = 'd'.repeat(64);
      await expect(cas.get(missing)).rejects.toThrow(/not found/);
      await expect(streamToBuffer(cas.getStream(missing))).rejects.toThrow(/not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('cas putBase64', () => {
  it('stores base64 payloads with the digest of the decoded bytes', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const bytes = Buffer.concat([
        Buffer.from([0x00, 0xff, 0x10]),
        randomBytes(97),
        Buffer.from('tail'),
      ]);
      const base64 = bytes.toString('base64');

      const put = await cas.putBase64(base64);
      expect(put).toEqual({
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      });
      expect(await cas.get(put.sha256)).toEqual(bytes);
      // Same content as putBytes: identical digest, so dedup applies.
      const viaBytes = await cas.putBytes(bytes);
      expect(viaBytes.sha256).toBe(put.sha256);
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles payloads spanning several decode chunks without carry leaks', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      // Larger than one base64 chunk (64 KiB of chars) so the 4-char carry
      // crosses chunk boundaries at least twice.
      const bytes = randomBytes(60 * 1024);
      const base64 = bytes.toString('base64');
      expect(base64.length).toBeGreaterThan(64 * 1024);

      const put = await cas.putBase64(base64);
      expect(put.size).toBe(bytes.length);
      expect(await cas.get(put.sha256)).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts empty and unpadded payloads leniently', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);

      const empty = await cas.putBase64('');
      expect(empty.size).toBe(0);
      expect(await cas.get(empty.sha256)).toEqual(Buffer.alloc(0));

      const bytes = Buffer.from('unpadded');
      const unpadded = bytes.toString('base64').replace(/=+$/u, '');
      const put = await cas.putBase64(unpadded);
      expect(await cas.get(put.sha256)).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('cas durability option', () => {
  it('roundtrips with the fsync pair disabled per store and per call', async () => {
    const root = await makeRoot();
    const sourceDir = await mkdtemp(path.join(tmpdir(), 'mcode-cas-src-'));
    try {
      const relaxed = await openCas(root, { durability: false });
      const viaStore = await relaxed.putBytes(Buffer.from('store-wide off'));
      expect(await relaxed.get(viaStore.sha256)).toEqual(Buffer.from('store-wide off'));

      const strict = await openCas(root);
      const viaCall = await strict.putBytes(Buffer.from('per-call off'), { durability: false });
      expect(await strict.get(viaCall.sha256)).toEqual(Buffer.from('per-call off'));

      const payload = Buffer.from('file without fsyncs');
      const sourcePath = path.join(sourceDir, 'fast.bin');
      await writeFile(sourcePath, payload);
      const viaFile = await strict.putFile(sourcePath, { durability: false });
      expect(await strict.get(viaFile.sha256)).toEqual(payload);

      const viaBase64 = await strict.putBase64(Buffer.from('b64 fast').toString('base64'), {
        durability: false,
      });
      expect(await strict.get(viaBase64.sha256)).toEqual(Buffer.from('b64 fast'));

      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});

describe('cas putFile io', () => {
  it('copies the source in a single pass, dedup hits included', async () => {
    const root = await makeRoot();
    const sourceDir = await mkdtemp(path.join(tmpdir(), 'mcode-cas-src-'));
    try {
      const cas = await openCas(root);
      const payload = Buffer.from('single pass payload');
      const sourcePath = path.join(sourceDir, 'once.bin');
      await writeFile(sourcePath, payload);

      const put = await cas.putFile(sourcePath);
      // Exactly one read of the source: copy and hash happen together.
      expect(readStreamOpens.filter((opened) => opened === sourcePath)).toHaveLength(1);
      expect(await cas.get(put.sha256)).toEqual(payload);
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);

      // A dedup hit still costs exactly one pass and rewrites nothing.
      const before = await blobIdentity(root, put.sha256);
      await cas.putFile(sourcePath);
      expect(readStreamOpens.filter((opened) => opened === sourcePath)).toHaveLength(2);
      expect(await blobIdentity(root, put.sha256)).toEqual(before);
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('takes the second pass only when the first pass was torn', async () => {
    const root = await makeRoot();
    const sourceDir = await mkdtemp(path.join(tmpdir(), 'mcode-cas-src-'));
    try {
      const cas = await openCas(root);
      const payload = Buffer.from('torn pass retry');
      const sourcePath = path.join(sourceDir, 'torn.bin');
      await writeFile(sourcePath, payload);
      // The pre-copy stat disagrees with the pass (simulating a source that
      // was rewritten mid-read): putFile must reconcile with a second pass.
      statOverrides.set(sourcePath, () =>
        ({ size: payload.length + 1, isFile: () => true }) as Stats,
      );

      const put = await cas.putFile(sourcePath);
      expect(readStreamOpens.filter((opened) => opened === sourcePath)).toHaveLength(2);
      expect(put).toEqual({
        sha256: createHash('sha256').update(payload).digest('hex'),
        size: payload.length,
      });
      expect(await cas.get(put.sha256)).toEqual(payload);
      // The torn first pass left no tmp behind.
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
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
      await expect(cas.hasAsync('../escape')).rejects.toThrow(/invalid SHA-256 digest/);
      await expect(cas.get('../escape')).rejects.toThrow(/invalid SHA-256 digest/);
      await expect(streamToBuffer(cas.getStream('../escape'))).rejects.toThrow(
        /invalid SHA-256 digest/,
      );
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
      expect(await cas.hasAsync(upper)).toBe(true);
      expect(await cas.get(upper)).toEqual(Buffer.from('normalize'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
