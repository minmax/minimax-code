#!/usr/bin/env node
// Measures the storage-worker commit path against the REAL sqlite-zstd
// backend, in BOTH execution modes:
//
//   bridge    — `createStorageWorker`: the backend handle stays on the caller
//               (main) thread; serialization + compression + fsync run there.
//   offthread — `createOffThreadStorageWorker`: the backend handle lives on
//               the worker thread; the caller only pays for enqueue + IPC.
//
// The Ф1 acceptance "commit <= 5 ms p95 in the WORKER, not on the main
// thread" is gated on the `offthread.*` metrics; the bridge variant is kept
// measured with an explicit event-loop stall budget (`bridge.stallP99Ms`),
// because it is the fallback path when a runtime cannot host worker threads.
//
// Standalone in the same sense as the other benches — node builtins only —
// with one twist: it imports the TypeScript package sources through Node's
// type stripping plus an in-process resolve hook mapping `.js` -> `.ts`.
//
// Usage: node scripts/bench/bench-worker-commit.mjs   (env BATCHES=200, ENTRY_KB=64)
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (message) => {
  console.error(`bench-worker: ${message}`);
  process.exit(2);
};

// Type stripping loads `.ts` files but does not map the packages' `.js`
// specifiers onto them; register the mapping for this process only. (The
// off-thread worker gets its own copy via --import.)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const packagesRoot = fileURLToPath(new URL('../../packages', import.meta.url));
const storageWorkerUrl = pathToFileURL(join(packagesRoot, 'storage-worker/src/index.ts')).href;
const backendUrl = pathToFileURL(join(packagesRoot, 'durable-backend-sqlite-zstd/src/index.ts')).href;

const batches = Number(process.env.BATCHES ?? 200);
const entryKb = Number(process.env.ENTRY_KB ?? 64);
if (!Number.isInteger(batches) || batches <= 0) fail(`BATCHES must be a positive integer, got "${process.env.BATCHES}"`);
if (!Number.isInteger(entryKb) || entryKb <= 0) fail(`ENTRY_KB must be a positive integer, got "${process.env.ENTRY_KB}"`);

const { createStorageWorker, createOffThreadStorageWorker, sqliteZstdStorageBackend } = await import(storageWorkerUrl);
const { openSqliteZstdBackend } = await import(backendUrl);

const MIB = 1048576;
const text = 'w'.repeat(entryKb * 1024 - 128);
const percentile = (values, quantile) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
};
const mean = (values) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

/** Caller-side event-loop stall sampler (the "freezes the stream" metric). */
function startStallSampler() {
  const deltas = [];
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    deltas.push(now - previous);
    previous = now;
  }, 1);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
    p99() {
      return percentile(deltas.map((delta) => Math.max(0, delta - 1)), 0.99);
    },
    max() {
      return deltas.length === 0 ? 0 : Math.max(...deltas.map((delta) => Math.max(0, delta - 1)));
    },
  };
}

async function runMode(mode, makeWorker) {
  const dataDir = mkdtempSync(join(tmpdir(), `bench-worker-${mode}-`));
  const enqueueMs = [];
  const commitMs = [];
  try {
    const worker = await makeWorker(dataDir);
    const stall = startStallSampler();
    for (let index = 0; index < batches; index += 1) {
      // One batch = 4 entries x entryKb (just under the 256 KiB window cut).
      for (let part = 0; part < 4; part += 1) {
        const started = performance.now();
        await worker.enqueue({
          entryId: `${mode}-${index}-${part}`,
          parentId: null,
          kind: 'pi.bench',
          payload: { text, index, part },
          bytes: entryKb * 1024,
        });
        enqueueMs.push(performance.now() - started);
      }
      const started = performance.now();
      await worker.flush();
      commitMs.push(performance.now() - started);
    }
    stall.stop();
    await worker.checkpoint();
    await worker.dispose();
    console.log(`${mode}.batches=${batches}`);
    console.log(`${mode}.entryKb=${entryKb}`);
    console.log(`${mode}.entries=${batches * 4}`);
    console.log(`${mode}.enqueueP50Ms=${percentile(enqueueMs, 0.5).toFixed(3)}`);
    console.log(`${mode}.enqueueP99Ms=${percentile(enqueueMs, 0.99).toFixed(3)}`);
    console.log(`${mode}.enqueueMaxMs=${Math.max(...enqueueMs).toFixed(3)}`);
    console.log(`${mode}.commitP50Ms=${percentile(commitMs, 0.5).toFixed(2)}`);
    console.log(`${mode}.commitP95Ms=${percentile(commitMs, 0.95).toFixed(2)}`);
    console.log(`${mode}.commitMaxMs=${Math.max(...commitMs).toFixed(2)}`);
    console.log(`${mode}.commitMeanMs=${mean(commitMs).toFixed(2)}`);
    console.log(`${mode}.stallP99Ms=${stall.p99().toFixed(2)}`);
    console.log(`${mode}.stallMaxMs=${stall.max().toFixed(2)}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// Bridge variant: the backend handle is created HERE.
await runMode('bridge', async (dataDir) => {
  const backend = openSqliteZstdBackend(dataDir);
  return createStorageWorker(sqliteZstdStorageBackend(backend), {
    windowMs: 60_000,
    windowBytes: 256 * 1024,
    maxBatchUncompressedBytes: backend.maxBatchUncompressedBytes,
  });
});

// Off-thread variant: the backend handle is created ON the worker thread,
// through a plain-JS factory shim it can load (the shim applies the same
// `.js -> .ts` resolve mapping for the backend sources).
const offThreadDir = mkdtempSync(join(tmpdir(), 'bench-worker-offthread-'));
const shimPath = join(offThreadDir, 'backend-factory.mjs');
const backendIndexUrl = pathToFileURL(join(packagesRoot, 'durable-backend-sqlite-zstd/src/index.ts')).href;
writeFileSync(
  shimPath,
  `
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try { return nextResolve(specifier, context); }
      catch { return nextResolve(specifier.replace(/\\.js$/, '.ts'), context); }
    }
    return nextResolve(specifier, context);
  },
});
export async function openSqliteZstdBackendFactory(directory) {
  const mod = await import(${JSON.stringify(backendIndexUrl)});
  return mod.openSqliteZstdBackend(directory);
}
`,
);
try {
  await runMode('offthread', (dataDir) =>
    createOffThreadStorageWorker(
      {
        module: pathToFileURL(shimPath).href,
        exportName: 'openSqliteZstdBackendFactory',
        args: [dataDir],
      },
      {
        windowMs: 60_000,
        windowBytes: 256 * 1024,
        workerExecArgv: ['--import', pathToFileURL(shimPath).href],
      },
    ),
  );
} finally {
  rmSync(offThreadDir, { recursive: true, force: true });
}
