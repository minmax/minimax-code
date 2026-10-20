/**
 * Shared test helpers: entry/commit factories, deferred promises, and a
 * condition-polling helper so timing assertions never rely on fixed sleeps.
 */

import type { Commit, Entry } from '../src/contracts.js';

let entryCounter = 0;

export function makeEntry(bytes = 16, overrides: Partial<Entry> = {}): Entry {
  entryCounter += 1;
  return {
    entryId: `entry-${entryCounter}`,
    parentId: null,
    kind: 'test',
    payload: { n: entryCounter },
    bytes,
    ...overrides,
  };
}

export function makeCommit(seq: number): Commit {
  return { batchId: `batch-${seq}`, seq, head: `head-${seq}` };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `condition` until it holds or the timeout elapses. */
export async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await delay(5);
  }
}
