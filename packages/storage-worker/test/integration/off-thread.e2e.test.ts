import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteZstdBackend } from '@mavis/durable-backend-sqlite-zstd';

import { createOffThreadStorageWorker } from '../../src/off-thread.js';
import type { Entry } from '../../src/contracts.js';

// The off-thread host runs the WHOLE durable write path (serialization,
// compression, SQLite fsync) on a worker thread. These tests drive the real
// host end to end: a hermetic recording backend proves the mechanics and the
// thread isolation, and the REAL sqlite-zstd backend proves the data lands in
// sessions.g1.db through the in-thread adapter.

const directories: string[] = [];

function freshDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'off-thread-e2e-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function entry(entryId: string, bytes: number, payload: unknown = { n: 1 }): Entry {
  return { entryId, parentId: null, kind: 'pi.session', payload, bytes };
}

/** Writes a plain-JS backend factory the worker thread can load without any bundler. */
function writeRecordingFactory(dir: string, stateFile: string): string {
  const factoryPath = join(dir, 'recording-backend.mjs');
  writeFileSync(
    factoryPath,
    `
export async function openRecordingBackend(stateFile) {
  const { appendFileSync } = await import('node:fs');
  let seq = 0;
  const record = (line) => appendFileSync(stateFile, JSON.stringify({ ...line, threadId: process.threadId }) + '\\n');
  return {
    maxBatchUncompressedBytes: 256 * 1024,
    async appendBatch(drafts) {
      seq += 1;
      record({ kind: 'append', ids: drafts.map((draft) => draft.id), seq });
      return { batchId: seq, seq, head: seq };
    },
    async checkpoint() {
      record({ kind: 'checkpoint' });
      return undefined;
    },
    async close() {
      record({ kind: 'close' });
    },
  };
}
`,
  );
  return pathToFileURL(factoryPath).href;
}

function readEvents(stateFile: string): Array<{ kind: string; ids?: string[]; threadId: number }> {
  return readFileSync(stateFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { kind: string; ids?: string[]; threadId: number });
}

describe('off-thread storage worker (backend owned by the worker thread)', () => {
  it('executes appendBatch and checkpoint on the worker thread and closes the backend on dispose', async () => {
    const dir = freshDirectory();
    const stateFile = join(dir, 'state.jsonl');
    const module = writeRecordingFactory(dir, stateFile);
    const worker = await createOffThreadStorageWorker(
      { module, exportName: 'openRecordingBackend', args: [stateFile] },
      { windowMs: 60_000 },
    );

    await worker.enqueue(entry('a', 10));
    await worker.enqueue(entry('b', 10));
    const commit = await worker.flush();
    expect(commit).toEqual({ batchId: '1', seq: 1, head: '1' });
    await worker.checkpoint();
    await worker.dispose();

    const events = readEvents(stateFile);
    const appends = events.filter((event) => event.kind === 'append');
    expect(appends).toHaveLength(1);
    expect(appends[0]?.ids).toEqual(['a', 'b']);
    expect(events.some((event) => event.kind === 'checkpoint')).toBe(true);
    expect(events.some((event) => event.kind === 'close')).toBe(true);
    // The append path ran on a DIFFERENT thread than the test's main thread.
    for (const event of events) expect(event.threadId).not.toBe(1);
  }, 30_000);

  it('quarantines an oversize entry through the thread boundary', async () => {
    const dir = freshDirectory();
    const stateFile = join(dir, 'state.jsonl');
    const module = writeRecordingFactory(dir, stateFile);
    const worker = await createOffThreadStorageWorker(
      { module, exportName: 'openRecordingBackend', args: [stateFile] },
      { windowMs: 60_000 },
    );

    // Declares 16 bytes, serializes far above the 256 KiB cap.
    await worker.enqueue(entry('liar', 16, { blob: 'y'.repeat(300 * 1024) }));
    await expect(worker.flush()).rejects.toThrow(/above the backend batch cap/);
    expect(worker.quarantined.map((item) => item.entryId)).toEqual(['liar']);

    await worker.enqueue(entry('after', 10));
    expect(await worker.flush()).toEqual({ batchId: '1', seq: 1, head: '1' });
    await worker.dispose();

    const appends = readEvents(stateFile).filter((event) => event.kind === 'append');
    expect(appends).toHaveLength(1);
    expect(appends[0]?.ids).toEqual(['after']);
  }, 30_000);

  it('keeps admitting past the 8 MiB queue ceiling: committed bytes are released (deadlock regression)', async () => {
    const dir = freshDirectory();
    const stateFile = join(dir, 'state.jsonl');
    const module = writeRecordingFactory(dir, stateFile);
    const worker = await createOffThreadStorageWorker(
      { module, exportName: 'openRecordingBackend', args: [stateFile] },
      { windowMs: 60_000, windowBytes: 256 * 1024 },
    );

    // 40 x 256 KiB = 10 MiB of uncommitted bytes — above the default 8 MiB
    // admission ceiling. Before the committed-bytes release existed, enqueue
    // parked forever at ~8 MiB (32 batches) and this test hung.
    for (let index = 0; index < 40; index += 1) {
      await worker.enqueue(entry(`bulk-${index}`, 256 * 1024));
    }
    for (let round = 0; round < 10; round += 1) {
      const commit = await worker.flush();
      expect(commit).not.toBeNull();
    }
    expect(worker.quarantined).toHaveLength(0);
    await worker.dispose();

    // Each entry fills the 256 KiB window exactly: one single-entry batch each.
    const appends = readEvents(stateFile).filter((event) => event.kind === 'append');
    expect(appends).toHaveLength(40);
    expect(appends.flatMap((event) => event.ids)).toEqual(
      Array.from({ length: 40 }, (_, index) => `bulk-${index}`),
    );
  }, 30_000);

  it('persists the real sqlite-zstd backend from inside the thread', async () => {
    const dir = freshDirectory();
    // The backend sources are TypeScript whose internal imports use `.js`
    // specifiers — raw Node type stripping resolves neither. A tiny shim
    // loaded via `--import` teaches the worker's resolver the `.js -> .ts`
    // mapping, then exposes the real backend factory.
    const shimPath = join(dir, 'ts-resolve-shim.mjs');
    const backendIndex = pathToFileURL(
      join(fileURLToPath(import.meta.url), '../../../../durable-backend-sqlite-zstd/src/index.ts'),
    ).href;
    writeFileSync(
      shimPath,
      `
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.replace(/\\.js$/, '.ts'), context);
      }
    }
    return nextResolve(specifier, context);
  },
});
export async function openSqliteZstdBackendFactory(directory) {
  const mod = await import(${JSON.stringify(backendIndex)});
  return mod.openSqliteZstdBackend(directory);
}
`,
    );
    const worker = await createOffThreadStorageWorker(
      {
        module: pathToFileURL(shimPath).href,
        exportName: 'openSqliteZstdBackendFactory',
        args: [dir],
      },
      {
        windowMs: 60_000,
        workerExecArgv: ['--import', pathToFileURL(shimPath).href],
      },
    );

    await worker.enqueue(entry('durable-1', 10));
    await worker.enqueue(entry('durable-2', 10, { n: 2 }));
    expect(await worker.flush()).toEqual({ batchId: '1', seq: 1, head: '1' });
    await worker.checkpoint();
    await worker.dispose(); // graceful: releases the single-writer lock

    // The commits are durable in sessions.g1.db; the lock was released, so a
    // plain reopen sees the whole history.
    const reopened = openSqliteZstdBackend(dir);
    expect(reopened.head).toBe(1);
    expect(reopened.readDelta(0, 1024 * 1024).map((item) => item.id)).toEqual(['durable-1', 'durable-2']);
    expect(reopened.readResume()).toMatchObject({ seq: 1, head: 1 });
    reopened.close();
  }, 60_000);
});
