// Shared fixtures for the context-mmu unit tests: a real wave-1 CAS in a
// temp directory (validating the injected contract against the actual
// implementation) plus small helpers for deterministic pages.

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';

import { openCas } from '../../../cas/src/index.js';
import { createMMU } from '../../src/mmu.js';
import type { CasStore, ContextMmu, MmuOptions, PageRef } from '../../src/types.js';

export function shaOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A page-shaped buffer with distinct content per `fill`. */
export function buf(size: number, fill: number): Buffer {
  return Buffer.alloc(size, fill);
}

export function refOf(data: Buffer, extra: Partial<PageRef> = {}): PageRef {
  return { sha256: shaOf(data), mime: 'image/png', bytes: data, ...extra };
}

export interface MmuFixture {
  mmu: ContextMmu;
  cas: CasStore;
  root: string;
  dispose(): Promise<void>;
}

/** Opens a real CAS in a temp dir and an MMU over it. */
export async function makeMmu(opts: MmuOptions = {}): Promise<MmuFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'mcode-mmu-cas-'));
  const cas = await openCas(root);
  const mmu = createMMU(cas, opts);
  return {
    mmu,
    cas,
    root,
    dispose: async () => {
      mmu.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `get` is true, failing with `what` after `timeoutMs`. */
export async function until(get: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!get()) {
    if (Date.now() > deadline) {
      expect.fail(`timed out waiting for ${what}`);
    }
    await sleep(20);
  }
}

/** Deterministic pseudo-random generator so churn tests never flake. */
export function makeLcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}
