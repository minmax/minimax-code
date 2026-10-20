import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSqlite3Constructor, openSqliteZstdBackend, SqliteZstdBackend } from '../../src/index.js';
import { openCas } from '@mavis/cas';

// kill -9 crash matrix (Ф1 acceptance): the writer PROCESS is killed with
// SIGKILL at arbitrary moments — mid-commit for the sqlite-zstd backend,
// mid-publish for the CAS blob store. After each kill the store must reopen
// clean: every commit observed before the kill is durable and readable, no
// half-written blob is ever served, and the file trees hold no torn garbage.

const Database = loadSqlite3Constructor();

const directories: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

function freshDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already dead.
    }
  }
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface ChildProbe {
  child: ReturnType<typeof spawn>;
  /** Resolves when the child exits (any signal). */
  exited: Promise<void>;
}

/** Spawns the writer child; its kill -9 matrix role is crash-prone appender/publisher. */
function spawnWriter(scriptPath: string, targetDir: string, progressFile: string): ChildProbe {
  const child = spawn(process.execPath, [scriptPath, targetDir, progressFile], {
    // Stdout stays silenced (the progress file is the channel); a crashed
    // child still surfaces its stderr in the test log.
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });
  children.push(child);
  return { child, exited };
}

/** Waits until the progress file records at least `count` events. */
async function waitForProgress(progressFile: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const lines = existsSafe(progressFile)
      ? readFileSync(progressFile, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
      : [];
    if (lines.length >= count) return lines;
    if (Date.now() > deadline) throw new Error(`progress stalled at ${lines.length}/${count}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function existsSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

describe('kill -9: sqlite-zstd commit path', () => {
  it('keeps every observed commit durable and never serves a torn tail', async () => {
    const dir = freshDirectory('kill9-backend-');
    const progressFile = join(dir, 'progress.jsonl');
    const scriptPath = join(dir, 'writer.mjs');
    writeBackendWriterScript(scriptPath);

    const writer = spawnWriter(scriptPath, dir, progressFile);
    // Observe >= 3 durable commits from OUTSIDE the writer process, then -9 it.
    await waitForProgress(progressFile, 3);
    const raw = new Database(join(dir, 'sessions.g1.db'), { readonly: true, fileMustExist: true });
    const durableHead = Number(raw.prepare("SELECT value FROM meta WHERE key = 'head'").get()?.value);
    raw.close();
    writer.child.kill('SIGKILL');
    await writer.exited;
    expect(durableHead).toBeGreaterThanOrEqual(3);

    // Reopen: the head is at least the observed one, monotonically consistent
    // with the writer's own progress, and every committed entry is readable.
    const reopened = openSqliteZstdBackend(dir);
    // The kill landed mid-flight: the head is at least the externally
    // observed durable head, and the log is a gap-free prefix of commits
    // (this backend never skips or rewrites a sequence).
    expect(reopened.head).toBeGreaterThanOrEqual(durableHead);
    const delta = reopened.readDelta(0, 1024 * 1024 * 1024);
    expect(delta).toHaveLength(Number(reopened.head) * 2); // two entries per batch
    // Every index row agrees with the frames — no torn tail served — and the
    // served sequences are exactly 1..head, twice each.
    const seqs = delta.flatMap((entry) => [Number(entry.seq)]);
    expect(seqs).toEqual(
      Array.from({ length: Number(reopened.head) }, (_, index) => [index + 1, index + 1]).flat(),
    );
    const headBeforeCrash = Number(reopened.head);
    reopened.close();

    // The stale owner pid (dead writer) is detected as such: a fresh writer
    // can take over without any manual cleanup.
    const takeover = SqliteZstdBackend.open(dir);
    await takeover.appendBatch([
      { id: 'after-crash', kind: 'pi.test', payload: { ok: true } },
    ]);
    expect(takeover.head).toBe(headBeforeCrash + 1);
    await takeover.close();
  }, 60_000);
});

describe('kill -9: CAS blob publish path', () => {
  it('leaves no half-written blob and keeps every published digest readable', async () => {
    const dir = freshDirectory('kill9-cas-');
    const progressFile = join(dir, 'progress.jsonl');
    const scriptPath = join(dir, 'publisher.mjs');
    writeCasPublisherScript(scriptPath);

    const writer = spawnWriter(scriptPath, dir, progressFile);
    const lines = await waitForProgress(progressFile, 5);
    const published = lines.map((line) => JSON.parse(line) as { sha256: string; size: number });
    writer.child.kill('SIGKILL');
    await writer.exited;

    const cas = await openCas(dir);
    // Every digest the writer saw confirmed (post-rename) must be readable.
    for (const item of published) {
      expect(cas.has(item.sha256)).toBe(true);
      expect((await cas.get(item.sha256)).length).toBe(item.size);
    }
    // Store integrity walk: every published file must hash to its own name —
    // a tmp file caught mid-write never lives under the published tree.
    const casDir = join(dir, 'cas');
    const shards = readdirSync(casDir);
    let walked = 0;
    for (const shard of shards) {
      for (const name of readdirSync(join(casDir, shard))) {
        const digest = shard + name;
        const bytes = readFileSync(join(casDir, shard, name));
        const hash = createHash('sha256').update(bytes).digest('hex');
        expect(hash).toBe(digest);
        walked += 1;
      }
    }
    expect(walked).toBeGreaterThanOrEqual(published.length);
  }, 60_000);
});

/** Writer child: appends two-entry batches as fast as the backend allows. */
function writeBackendWriterScript(scriptPath: string): void {
  const backendIndex = pathToFileURL(
    join(fileURLToDirname(import.meta.url), '../../src/index.ts'),
  ).href;
  writeFileSync(
    scriptPath,
    `
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try { return nextResolve(specifier, context); }
      catch { return nextResolve(specifier.replace(/\\.js$/, '.ts'), context); }
    }
    return nextResolve(specifier, context);
  },
});
const { openSqliteZstdBackend } = await import(${JSON.stringify(backendIndex)});
const [directory, progressFile] = process.argv.slice(2);
const backend = openSqliteZstdBackend(directory);
for (let index = 1; ; index += 1) {
  await backend.appendBatch([
    { id: 'crash-' + index + '-a', kind: 'pi.test', payload: { index } },
    { id: 'crash-' + index + '-b', kind: 'pi.test', payload: { index } },
  ]);
  appendFileSync(progressFile, JSON.stringify({ index, head: Number(backend.head) }) + '\\n');
}
`,
  );
}

/** Publisher child: publishes random blobs and records each confirmed digest. */
function writeCasPublisherScript(scriptPath: string): void {
  const casIndex = pathToFileURL(
    join(fileURLToDirname(import.meta.url), '../../../cas/src/index.ts'),
  ).href;
  writeFileSync(
    scriptPath,
    `
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try { return nextResolve(specifier, context); }
      catch { return nextResolve(specifier.replace(/\\.js$/, '.ts'), context); }
    }
    return nextResolve(specifier, context);
  },
});
const { openCas } = await import(${JSON.stringify(casIndex)});
const [directory, progressFile] = process.argv.slice(2);
const cas = await openCas(directory);
for (let index = 1; ; index += 1) {
  const bytes = randomBytes(32 * 1024 + index);
  const { sha256, size } = await cas.putBytes(bytes);
  appendFileSync(progressFile, JSON.stringify({ sha256, size }) + '\\n');
}
`,
  );
}

function fileURLToDirname(url: string): string {
  return fileURLToPath(new URL('.', url));
}
