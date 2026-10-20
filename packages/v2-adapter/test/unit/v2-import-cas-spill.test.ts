import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openCas, type CasStore } from '@mavis/cas';
import { SqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';
import { createStorageWorker, sqliteZstdStorageBackend } from '@mavis/storage-worker';

import { openV2Session, type V2Envelope, type V2ImportTarget } from '../../src/index.js';
import { envelopeLine, writeTempSession } from './tmp-session.js';

// Gate: images never live in the history. The v2 import externalizes inline
// base64 image blocks into the CAS by default, and the durable payload that
// reaches the sqlite-zstd log carries only `image_ref` descriptors — no
// base64 blob above the gate threshold, at any stage.

const directories: string[] = [];

function freshDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

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
      const payload = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
      await worker.enqueue({
        entryId,
        parentId: previousId,
        kind: 'pi.v2-import',
        payload,
        // Declared size = the post-externalization envelope, the unit the
        // worker's budgets count in. A large entry would be admitted only
        // within the batch cap — externalization is what keeps it small.
        bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      });
      previousId = entryId;
      entries.push(envelope);
    },
  };
}

describe('v2 import with default CAS externalization', () => {
  it('keeps base64 blobs out of the imported history (gate: no run above 64 KiB)', async () => {
    const casRoot = freshDirectory('v2-cas-root-');
    const cas = await openCas(casRoot);
    const base64 = 'A'.repeat(300 * 1024);
    const session = await writeTempSession([envelopeLine(imageEnvelope('msg-img-1', base64))]);

    const entries: V2Envelope[] = [];
    const target = { entries, putEntry: async (envelope: V2Envelope) => { entries.push(envelope); } };
    const stats = await openV2Session(session.dir).importTo(target, { cas });

    expect(stats.imageBlocks).toBe(1);
    expect(stats.imagesMigrated).toBe(1);
    expect(stats.imagesInline).toBe(0);
    expect(target.entries).toHaveLength(1);

    const serialized = JSON.stringify(target.entries[0]);
    expect(serialized).not.toMatch(BASE64_BLOB_PATTERN);
    const block = target.entries[0]?.message.content?.[1] as { type: string; blob: string };
    expect(block.type).toBe('image_ref');
    const digest = /cas:\/\/sha256\/([0-9a-f]{64})#/.exec(block.blob)?.[1];
    expect(digest).toBeDefined();
    expect(cas.has(digest!)).toBe(true);
    expect((await cas.get(digest!)).length).toBe(Buffer.from(base64, 'base64').length);

    await session.dispose();
  });

  it('keeps images inline when `cas: null` (documented off switch)', async () => {
    const session = await writeTempSession([
      envelopeLine(imageEnvelope('msg-img-2', 'B'.repeat(80 * 1024))),
    ]);
    const entries: V2Envelope[] = [];
    const target = { entries, putEntry: async (envelope: V2Envelope) => { entries.push(envelope); } };
    const stats = await openV2Session(session.dir).importTo(target, { cas: null });
    // With no hook at all, inline blocks are only counted, not migrated.
    expect(stats.imagesMigrated).toBe(0);
    expect(JSON.stringify(target.entries[0])).toMatch(BASE64_BLOB_PATTERN);
    await session.dispose();
  });
});

describe('default image CAS lands in the durable root, never the legacy tree', () => {
  it('fs trace: default import writes ~/.mcode-durable/cas and creates no ~/.minimax', async () => {
    // The default profile home is os.homedir(); the fs trace runs against a
    // throwaway HOME so the assertion is absolute, not comparative.
    const fakeHome = freshDirectory('v2-default-home-');
    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const session = await writeTempSession([
        envelopeLine(imageEnvelope('msg-img-5', 'E'.repeat(80 * 1024))),
      ]);
      const entries: V2Envelope[] = [];
      const target = { entries, putEntry: async (envelope: V2Envelope) => { entries.push(envelope); } };
      // NO options at all: the default-on hook must externalize into the
      // durable root under the CURRENT home.
      const stats = await openV2Session(session.dir).importTo(target);
      expect(stats.imagesMigrated).toBe(1);

      // fs trace: nothing in the legacy family was created...
      expect(existsSync(join(fakeHome, '.minimax'))).toBe(false);
      // ...and the blob lives under the durable root.
      const durableCas = join(fakeHome, '.mcode-durable', 'cas');
      expect(existsSync(durableCas)).toBe(true);
      const block = entries[0]?.message.content?.[1] as { type: string; blob: string };
      expect(block.type).toBe('image_ref');
      const digest = /cas:\/\/sha256\/([0-9a-f]{64})#/.exec(block.blob)?.[1];
      expect(digest).toBeDefined();
      const cas = await openCas(durableCas);
      expect(cas.has(digest!)).toBe(true);

      // The guard itself agrees: the legacy path is refused, the durable one passes.
      const config = await import('@mavis/config');
      expect(() => config.assertNoLegacyWrite(join(fakeHome, '.minimax', 'cas'), join(fakeHome, '.minimax'))).toThrow(
        config.LegacyWriteError,
      );
      expect(config.assertNoLegacyWrite(durableCas, join(fakeHome, '.minimax'))).toBe(durableCas);

      await session.dispose();
    } finally {
      process.env.HOME = previousHome;
    }
  }, 30_000);
});

describe('end to end: v2 import -> storage worker -> sqlite-zstd + CAS', () => {
  it('commits the imported history with image refs only, readable back from the log', async () => {
    const casRoot = freshDirectory('v2-e2e-cas-');
    const dataDir = freshDirectory('v2-e2e-data-');
    const cas = await openCas(casRoot);
    const backend = SqliteZstdBackend.open(dataDir);
    const worker = createStorageWorker(sqliteZstdStorageBackend(backend), {
      windowMs: 60_000,
      maxBatchUncompressedBytes: backend.maxBatchUncompressedBytes,
    });

    const session = await writeTempSession([
      envelopeLine(imageEnvelope('msg-img-3', 'C'.repeat(300 * 1024))),
      envelopeLine(imageEnvelope('msg-img-4', 'D'.repeat(70 * 1024))),
    ]);

    const target = storageTarget(worker);
    const stats = await openV2Session(session.dir).importTo(target, { cas });
    expect(stats.imagesMigrated).toBe(2);

    const commit = await worker.flush();
    expect(commit).not.toBeNull();
    await worker.checkpoint();
    await worker.dispose();

    // Read the durable log back: image_refs, no blobs, chain intact.
    const delta = backend.readDelta(0, 1024 * 1024);
    expect(delta.map((entry) => entry.id)).toEqual(['imported-1', 'imported-2']);
    expect(delta.map((entry) => entry.parentId)).toEqual([null, 'imported-1']);
    for (const entry of delta) {
      const serialized = JSON.stringify(entry.payload);
      expect(serialized).not.toMatch(BASE64_BLOB_PATTERN);
    }
    const first = delta[0]?.payload as { message: { content: Array<{ type: string; blob?: string }> } };
    expect(first.message.content[1]?.type).toBe('image_ref');
    const digest = /cas:\/\/sha256\/([0-9a-f]{64})#/.exec(first.message.content[1]!.blob!)?.[1];
    expect(digest).toBeDefined();
    expect(cas.has(digest!)).toBe(true);

    await backend.close();
    await session.dispose();
  }, 30_000);
});
