#!/usr/bin/env node
// Measures the STEERING hot path of steering-design-sol.md §6.1/§6.2 on REAL
// clocks and the REAL sqlite-zstd backend — the storage-truth counterpart of
// packages/steering-control/test/release-latency.test.ts, which deliberately
// runs on the TEST CLOCK with a fake seam:
//
//   enter (T_accept)          — `acceptOwnerInput`: submission + receipt +
//                               delivery index in ONE committed batch
//                               (WAL `synchronous = FULL`). Gate §6.1:
//                               Enter → durable saved-ack p95 ≤ 100 ms,
//                               p99 ≤ 250 ms.
//   release (T_release)       — `openForegroundWait` + `prepareRelease`:
//                               the CAS'd backgrounded decision, saved-ack →
//                               committed release. Gate §6.2: p99 ≤ 250 ms.
//   finalize (T_complete)     — `finalizeTool`: the single tool-result of the
//                               released wait (part of the release pass in
//                               the composed control).
//   enter→release end-to-end  — the composed §6.2 span (accept → release →
//                               finalize), the in-process lower bound of
//                               "Enter → старт следующего parent provider
//                               request p95 ≤ 500 мс" (the provider hop is
//                               NOT measured here — no network in this bench;
//                               the in-process e2e lives in the steering
//                               integration test of local-runtime-v2).
//
// The composed stack is the wave-3 source itself (durable-seam over the real
// backend), imported through Node type stripping like the other benches.
//
// Usage: node scripts/bench/bench-steering.mjs   (env ITERS=300 [KEEP=0])
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const fail = (message) => {
  console.error(`bench-steering: ${message}`);
  process.exit(2);
};

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
const backendUrl = pathToFileURL(join(packagesRoot, 'durable-backend-sqlite-zstd/src/index.ts')).href;
const seamUrl = pathToFileURL(join(packagesRoot, 'durable-seam/src/index.ts')).href;

const iterations = Number(process.env.ITERS ?? 300);
if (!Number.isInteger(iterations) || iterations < 10) fail(`ITERS must be an integer >= 10, got "${process.env.ITERS}"`);
const keep = process.env.KEEP === '1';

const { openSqliteZstdBackend } = await import(backendUrl);
const { DurableSeam, sqliteZstdDurableLogPort } = await import(seamUrl);
const { metric } = await import('./lib/scan-fixture.mjs');

const percentile = (values, quantile) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
};

const directory = mkdtempSync(join(tmpdir(), 'bench-steering-'));
const backend = openSqliteZstdBackend(directory);
const seam = await DurableSeam.open(sqliteZstdDurableLogPort(backend));

try {
  const enterMs = [];
  const releaseMs = [];
  const finalizeMs = [];
  const composedMs = [];

  for (let index = 0; index < iterations; index += 1) {
    const conversationId = `bench-conv-${index}`;
    const waitId = `bench-wait-${index}`;
    const toolCallId = `bench-tool-${index}`;

    // §6.1 — Enter → durable saved-ack (one WAL FULL commit).
    const enterStarted = performance.now();
    const accepted = await seam.acceptOwnerInput({
      conversationId,
      requestId: `req-${index}`,
      content: { text: 'hold on, switch to background', whenBusy: 'steer' },
      whenBusy: 'steer',
      actor: 'bench',
      sourceConversationId: 'bench-source',
      route: 'bench',
    });
    const enterDone = performance.now();
    if (accepted.status !== 'committed') fail(`unexpected accept status ${accepted.status}`);
    enterMs.push(enterDone - enterStarted);

    // §6.2 — saved-ack → committed release (CAS'd backgrounded decision).
    await seam.openForegroundWait({
      waitId,
      toolCallId,
      conversationId,
      delegationId: `bench-del-${index}`,
      childConversationId: `bench-child-${index}`,
      cancelOnParentAbort: true,
    });
    await seam.prepareRelease({ waitId, expectedVersion: 1, reason: 'owner_input', initiator: 'bench' });
    const releaseDone = performance.now();
    releaseMs.push(releaseDone - enterDone);

    // The single tool-result of the released wait (composed release pass).
    const prepared = seam.getWait(waitId);
    const outcome = prepared?.preparedOutcome ?? null;
    if (outcome === null) fail(`no prepared outcome for ${waitId}`);
    await seam.finalizeTool({ toolCallId, outcome });
    const finalizeDone = performance.now();
    finalizeMs.push(finalizeDone - releaseDone);

    // Composed §6.2 span: saved-ack → committed release → finalized tool.
    composedMs.push(finalizeDone - enterDone);
  }

  // One warm restart over the same store: recovery is bounded active-state.
  const restartStarted = performance.now();
  await DurableSeam.open(sqliteZstdDurableLogPort(backend));
  metric('steering.reopenMs', performance.now() - restartStarted);

  metric('steering.corpus', 'synthetic-admission');
  metric('steering.iters', iterations);
  metric('steering.enterSavedAckP50Ms', percentile(enterMs, 0.5));
  metric('steering.enterSavedAckP95Ms', percentile(enterMs, 0.95));
  metric('steering.enterSavedAckP99Ms', percentile(enterMs, 0.99));
  metric('steering.releaseP50Ms', percentile(releaseMs, 0.5));
  metric('steering.releaseP95Ms', percentile(releaseMs, 0.95));
  metric('steering.releaseP99Ms', percentile(releaseMs, 0.99));
  metric('steering.finalizeP99Ms', percentile(finalizeMs, 0.99));
  metric('steering.enterToReleaseP95Ms', percentile(composedMs, 0.95));
  metric('steering.enterToReleaseP99Ms', percentile(composedMs, 0.99));
} finally {
  await backend.close();
  if (!keep) rmSync(directory, { recursive: true, force: true });
}
