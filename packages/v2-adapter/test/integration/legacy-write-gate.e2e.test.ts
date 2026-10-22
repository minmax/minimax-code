import fs, { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertNoLegacyWrite, LegacyWriteError, resolveDurableRoot } from '@mavis/config';
import { openCas } from '@mavis/cas';
import { SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';
import { createStorageWorker, sqliteZstdStorageBackend } from '@mavis/storage-worker';

import { openV2Session, type V2Envelope, type V2ImportTarget } from '../../src/index.js';
import { envelopeLine, writeTempSession } from '../unit/tmp-session.js';

// Acceptance gate Ф1 (final-architecture.md:26 and :383): "~/.minimax/** is
// never opened for writing, this is checked by a gate" — over the FULL write
// stack (v2 import -> CAS -> storage worker -> sqlite-zstd), not only the
// default-import unit trace. The barrier refuses (not merely observes) any
// intercepted filesystem write whose target falls into the legacy family, so
// a regression fails the operation loudly instead of writing through.
//
// What the barrier can and cannot see, stated honestly:
// - it intercepts every node:fs / node:fs/promises write call made on the
//   main thread (the import, the CAS store, the backend's directory and
//   seal/unseal maintenance);
// - the storage worker commits batches on its own thread and better-sqlite3
//   writes through native code — those bypass the JS fs surface. The
//   empty-family assertion below is the layer that covers them: the legacy
//   roots are pre-created EMPTY, so any file or directory a native or
//   off-thread component creates inside the family fails the gate.

const directories: string[] = [];

function freshDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

/** Any base64-looking run above 64 KiB inside a serialized payload. */
const BASE64_BLOB_PATTERN = /[A-Za-z0-9+/]{65536,}/u;

function imageEnvelope(messageId: string, base64: string): Record<string, unknown> {
  return {
    message_id: messageId,
    turn_id: '3f7d9c2e-1a4b-4c8d-9e2f-5a6b7c8d9e01',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', data: base64 },
      ],
      timestamp: 1760755230000,
    },
  };
}

/** Import sink that feeds every envelope into the durable storage worker. */
function storageTarget(worker: ReturnType<typeof createStorageWorker>): V2ImportTarget & { entries: V2Envelope[] } {
  const entries: V2Envelope[] = [];
  let seq = 0;
  let previousId: string | null = null;
  return {
    entries,
    async putEntry(envelope: V2Envelope) {
      seq += 1;
      const entryId = `imported-${seq}`;
      const serialized = JSON.stringify(envelope);
      const payload = JSON.parse(serialized) as Record<string, unknown>;
      await worker.enqueue({
        entryId,
        parentId: previousId,
        kind: 'pi.v2-import',
        payload,
        bytes: Buffer.byteLength(serialized, 'utf8'),
      });
      previousId = entryId;
      entries.push(envelope);
    },
  };
}

type AnyRecord = Record<string, unknown>;

/**
 * Prime Node's lazy internal rimraf BEFORE any barrier is installed.
 *
 * `node:internal/fs/rimraf` destructures `rmdirSync`/`unlinkSync` (and the
 * promise variants) from `node:fs` when the rimraf module is FIRST loaded,
 * and `node:fs` loads it lazily on the first `rm`/`rmSync` call. If that
 * first call ever happened while a barrier was installed, rimraf would cache
 * the barrier's wrapper and the test's own temporary-directory cleanup would
 * trip the barrier forever, independent of any real stack violation. A
 * no-op recursive `rm` of a nonexistent path forces the initialization while
 * the filesystem surface is pristine.
 */
function primeInternalRimraf(): void {
  const phantom = join(tmpdir(), 'legacy-gate-barrier-priming-nonexistent');
  fs.rmSync(phantom, { recursive: true, force: true });
  void fsp.rm(phantom, { recursive: true, force: true });
}

/**
 * Refuse barrier over the main-thread filesystem write surface. Every
 * intercepted call first runs the shared legacy guard
 * (`assertNoLegacyWrite` with the EXPLICIT legacy root — the captured
 * `LEGACY_ROOT` default cannot be trusted under an overridden HOME), so a
 * legacy-family write throws `LegacyWriteError` instead of going through.
 */
class LegacyWriteBarrier {
  private readonly originals = new Map<string, unknown>();
  /** Interception counter and the last targets, for the self-probe below. */
  intercepted = 0;
  lastTargets: string[] = [];

  constructor(private readonly legacyRoot: string) {}

  install(): void {
    const surfaces: AnyRecord[] = [fs as unknown as AnyRecord, fsp as unknown as AnyRecord];
    for (const surface of surfaces) {
      for (const name of WRITE_API_NAMES) {
        const original = surface[name];
        if (typeof original !== 'function') continue;
        this.originals.set(`${(surface === fs ? 'fs' : 'fsp')}:${name}`, original);
        surface[name] = (...args: unknown[]): unknown => {
          const target = args[0];
          if (typeof target === 'string' || Buffer.isBuffer(target)) {
            const targetPath = Buffer.isBuffer(target) ? target.toString('utf8') : target;
            this.intercepted += 1;
            this.lastTargets.push(targetPath);
            // Throws LegacyWriteError for anything inside the legacy family;
            // reads elsewhere pass untouched. Read-only `open` flags are
            // reads, not writes, and pass unguarded.
            if (name === 'open' || name === 'openSync') {
              if (isOpenReadOnly(args[1])) return (original as (...a: unknown[]) => unknown)(...args);
            }
            assertNoLegacyWrite(path.resolve(targetPath), this.legacyRoot);
          }
          return (original as (...a: unknown[]) => unknown)(...args);
        };
      }
    }
  }

  restore(): void {
    const fsSurface = fs as unknown as AnyRecord;
    const fspSurface = fsp as unknown as AnyRecord;
    for (const [key, original] of this.originals) {
      const [surfaceName, name] = key.split(':');
      const surface = surfaceName === 'fs' ? fsSurface : fspSurface;
      if (surfaceName !== undefined && name !== undefined) surface[name] = original;
    }
    this.originals.clear();
  }
}

const WRITE_API_NAMES = [
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'open',
  'openSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'chmod',
  'chmodSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
] as const;

/** Read-only opens (flag 'r' / O_RDONLY) are reads, not writes: pass them. */
function isOpenReadOnly(flag: unknown): boolean {
  if (flag === undefined) return true; // default flag is 'r'
  if (typeof flag === 'string') return flag === 'r' || flag === 'rs';
  if (typeof flag === 'number') return (flag & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND)) === 0;
  return false;
}

describe('gate: the full write stack never touches the legacy ~/.minimax family', () => {
  let fakeHome: string;
  let previousHome: string | undefined;
  let barrier: LegacyWriteBarrier;
  let legacyRoot: string;
  let durableRoot: string;

  beforeEach(() => {
    primeInternalRimraf();
    fakeHome = freshDirectory('legacy-gate-home-');
    previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    // The family roots pre-exist and stay EMPTY: the post-run emptiness check
    // is the layer that catches native/off-thread writers the JS barrier
    // cannot intercept (better-sqlite3, the storage worker's thread).
    legacyRoot = join(fakeHome, '.minimax');
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.mkdirSync(join(fakeHome, '.minimax-work'), { recursive: true });
    durableRoot = resolveDurableRoot();
    barrier = new LegacyWriteBarrier(legacyRoot);
    barrier.install();
  });

  afterEach(() => {
    barrier.restore();
    if (previousHome !== undefined) process.env.HOME = previousHome;
    while (directories.length > 0) {
      const dir = directories.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fs trace + refuse barrier: import -> CAS -> storage worker -> sqlite-zstd writes only the durable root', async () => {
    // Self-probe: an allowed durable-root write must be SEEN by the barrier.
    // If interception ever stops working (module surface change), this fails
    // loudly instead of letting the gate pass vacuously.
    await fsp.mkdir(durableRoot, { recursive: true });
    await fsp.writeFile(join(durableRoot, 'barrier-probe.txt'), 'probe', 'utf8');
    expect(barrier.intercepted).toBeGreaterThan(0);
    expect(barrier.lastTargets.some((target) => target.startsWith(durableRoot))).toBe(true);

    // The guard itself refuses the legacy family and passes the durable root.
    expect(() => assertNoLegacyWrite(join(legacyRoot, 'cas'), legacyRoot)).toThrow(LegacyWriteError);
    expect(assertNoLegacyWrite(durableRoot, legacyRoot)).toBe(durableRoot);

    // Full stack, default resolution: the import externalizes images into the
    // durable-root CAS (no explicit store passed), and the storage worker
    // commits the batches into sqlite-zstd under the durable root.
    const backend = SqliteZstdBackend.open(durableRoot);
    const worker = createStorageWorker(sqliteZstdStorageBackend(backend), {
      windowMs: 60_000,
      maxBatchUncompressedBytes: backend.maxBatchUncompressedBytes,
    });

    const session = await writeTempSession([
      envelopeLine(imageEnvelope('msg-legacy-gate', 'F'.repeat(300 * 1024))),
    ]);
    const target = storageTarget(worker);
    const stats = await openV2Session(session.dir).importTo(target);
    expect(stats.imagesMigrated).toBe(1);

    const commit = await worker.flush();
    expect(commit).not.toBeNull();
    await worker.checkpoint();
    await worker.dispose();

    // The durable log holds image refs only, readable back.
    const delta = backend.readDelta(0, 1024 * 1024);
    expect(delta.map((entry) => entry.id)).toEqual(['imported-1']);
    const serialized = JSON.stringify(delta[0]?.payload);
    expect(serialized).not.toMatch(BASE64_BLOB_PATTERN);
    await backend.close();
    await session.dispose();

    // Layer 1: the pre-created legacy family is still EMPTY — nothing (main
    // thread, worker thread, or native) created a single entry inside it.
    expect(readdirSync(legacyRoot)).toEqual([]);
    expect(readdirSync(join(fakeHome, '.minimax-work'))).toEqual([]);

    // Layer 2: the durable layout is exactly where the policy says.
    expect(fs.existsSync(join(durableRoot, 'sessions.g1.db'))).toBe(true);
    expect(fs.existsSync(join(durableRoot, 'cas'))).toBe(true);
    const cas = await openCas(durableRoot);
    const block = target.entries[0]?.message.content?.[1] as { type: string; blob: string };
    expect(block.type).toBe('image_ref');
    const digest = /cas:\/\/sha256\/([0-9a-f]{64})#/.exec(block.blob)?.[1];
    expect(digest).toBeDefined();
    expect(cas.has(digest!)).toBe(true);
  }, 60_000);
});
