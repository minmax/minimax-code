// Coherence: fs.watch on the bound paths marks stale pages and replaces them
// with diff handles carrying the previous digest. Uses real temp files and a
// real wave-1 CAS; the only timing dependency is the fs.watch event delivery,
// polled with generous timeouts.

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buf, makeMmu, refOf, shaOf, sleep, until } from './helpers.js';
import type { PathWatcher } from '../../src/watch.js';

const DEBOUNCE_MS = 20;

async function makeFiles(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mcode-mmu-coh-'));
}

describe('watch coherence', () => {
  it('marks a changed page stale and replaces it with a diff handle', { timeout: 65_000 }, async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 1024, watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'picture.png');
      const before = buf(100, 0xaa);
      const after = buf(140, 0xbb);
      await writeFile(file, before);

      const handle = await mmu.pageFile(file, { mime: 'image/png' });
      expect(mmu.admit(handle)).toBe('resident');
      expect(mmu.stats()).toEqual({ resident: 1, bytes: 100 });

      const stop = mmu.watch([file]);
      try {
        await writeFile(file, after);
        await until(() => handle.stale, 'the page to be marked stale', 60_000);

        const replacement = handle.replacedBy;
        expect(replacement).toBeDefined();
        expect(replacement!.previousSha256).toBe(shaOf(before));
        expect(replacement!.sha256).toBe(shaOf(after));
        expect(replacement!.bytes).toBe(140);
        expect(replacement!.mime).toBe('image/png');
        expect(replacement!.stale).toBe(false);

        // The diff handle serves the new content and inherited the slot.
        expect(await mmu.fault(replacement!)).toEqual(after);
        expect(mmu.statusOf(replacement!)).toBe('resident');
        expect(mmu.stats()).toEqual({ resident: 1, bytes: 140 });

        // The stale handle is dead in every channel.
        expect(mmu.statusOf(handle)).toBe('stale');
        await expect(mmu.fault(handle)).rejects.toThrow(/stale/);
        await expect(mmu.pages.read(handle)).rejects.toThrow(/stale/);
        expect(() => mmu.digest(handle)).toThrow(/stale/);
        expect(() => mmu.admit(handle)).toThrow(/stale/);
      } finally {
        stop();
      }
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });

  it('ignores a write that does not change the content', async () => {
    const { mmu, dispose } = await makeMmu({ watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'same.png');
      const data = buf(80, 0x33);
      await writeFile(file, data);
      const handle = await mmu.pageFile(file);

      mmu.watch([file]);
      await writeFile(file, data); // Same bytes: digest unchanged.
      await sleep(200);
      expect(handle.stale).toBe(false);
      expect(handle.replacedBy).toBeUndefined();
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });

  it('stops tracking after the disposer fires and is idempotent', async () => {
    const { mmu, dispose } = await makeMmu({ watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'detached.png');
      await writeFile(file, buf(64, 1));
      const handle = await mmu.pageFile(file);

      const stop = mmu.watch([file]);
      stop();
      stop(); // Idempotent.

      await writeFile(file, buf(96, 2));
      await sleep(250);
      expect(handle.stale).toBe(false);
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });

  // fs.watch delivery on darwin can be delayed when several workers watch
  // files in parallel, so coherence tests poll longer than the default and
  // carry their own generous vitest timeout.
  it('marks pages stale without a replacement when the file is deleted', { timeout: 65_000 }, async () => {
    const { mmu, dispose } = await makeMmu({ watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'gone.png');
      await writeFile(file, buf(64, 7));
      const handle = await mmu.pageFile(file);

      const stop = mmu.watch([file]);
      try {
        await unlink(file);
        await until(() => handle.stale, 'the page to be marked stale', 60_000);
        expect(handle.replacedBy).toBeUndefined();
      } finally {
        stop();
      }
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });

  // fs.watch is best-effort: under load (FSEvents) or after an unlink the
  // event stream can stay silent for longer than any reasonable deadline —
  // this is exactly how the deletion test above once timed out at 15s. The
  // stat-poll backstop must deliver coherence on its own, so this test
  // mutes the event stream and drives the poll instead.
  it('stales pages via the stat-poll backstop when the event stream stays silent', { timeout: 20_000 }, async () => {
    const { mmu, dispose } = await makeMmu({
      watchDebounceMs: DEBOUNCE_MS,
      watchPollMs: 50,
    });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'silent.png');
      await writeFile(file, buf(48, 3));
      const handle = await mmu.pageFile(file);

      const stop = mmu.watch([file]);
      try {
        // Mute the fs.watch stream underneath: only the backstop remains.
        const watcher = (mmu as unknown as { watcher?: PathWatcher }).watcher;
        expect(watcher).toBeDefined();
        const subscription = (
          watcher as unknown as {
            subscriptions: Map<string, { watcher: { close(): void } }>;
          }
        ).subscriptions.get(file);
        expect(subscription).toBeDefined();
        subscription!.watcher.close();

        await unlink(file);
        await until(() => handle.stale, 'the backstop to mark the page stale', 5_000);
        expect(handle.replacedBy).toBeUndefined();
      } finally {
        stop();
      }
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });

  it('watches a directory and only stales pages of the changed file', { timeout: 65_000 }, async () => {
    const { mmu, dispose } = await makeMmu({ watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const dir = path.join(files, 'pages');
      await mkdir(dir);
      const fileA = path.join(dir, 'a.png');
      const fileB = path.join(dir, 'b.png');
      await writeFile(fileA, buf(64, 0x11));
      await writeFile(fileB, buf(64, 0x22));

      const handleA = await mmu.pageFile(fileA, { mime: 'image/png' });
      const handleB = await mmu.pageFile(fileB, { mime: 'image/png' });
      mmu.admit(handleA);
      mmu.admit(handleB);

      const stop = mmu.watch([dir]);
      try {
        await writeFile(fileB, buf(96, 0x33));
        await until(() => handleB.stale, 'page b to be marked stale', 60_000);
        expect(handleA.stale).toBe(false);
        expect(mmu.statusOf(handleA)).toBe('resident');

        expect(handleB.replacedBy).toBeDefined();
        expect(handleB.replacedBy!.sha256).toBe(shaOf(buf(96, 0x33)));
        expect(await mmu.fault(handleB.replacedBy!)).toEqual(buf(96, 0x33));
      } finally {
        stop();
      }
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });

  it('throws when asked to watch a missing path', async () => {
    const { mmu, dispose } = await makeMmu();
    const files = await makeFiles();
    try {
      expect(() => mmu.watch([path.join(files, 'missing.png')])).toThrow();
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });

  it('replaces independent handles bound to the same path together', { timeout: 65_000 }, async () => {
    const { mmu, dispose } = await makeMmu({ watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'shared.png');
      await writeFile(file, buf(64, 0x55));
      const first = await mmu.pageFile(file);
      const second = await mmu.pageFile(file); // Two handles, one binding.
      expect(first.sha256).toBe(second.sha256);

      const stop = mmu.watch([file]);
      try {
        await writeFile(file, buf(64, 0x66));
        await until(() => first.stale && second.stale, 'both pages to be marked stale', 60_000);
        expect(first.replacedBy).toBeDefined();
        expect(second.replacedBy).toBeDefined();
        expect(first.replacedBy!.sha256).toBe(shaOf(buf(64, 0x66)));
        expect(second.replacedBy!.sha256).toBe(shaOf(buf(64, 0x66)));
      } finally {
        stop();
      }
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });

  it('closes all watchers and state on close', async () => {
    const { mmu, dispose } = await makeMmu({ watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'closed.png');
      await writeFile(file, buf(64, 9));
      const handle = await mmu.pageFile(file);
      mmu.watch([file]);
      mmu.close();
      mmu.close(); // Idempotent.

      await writeFile(file, buf(128, 10));
      await sleep(200);
      expect(handle.stale).toBe(false);
      expect(() => mmu.page(refOf(buf(8, 1)))).toThrow(/closed/);
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });
});
