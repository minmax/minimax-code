/**
 * Shared test helpers: a temp sqlite-zstd backend per test, supervisor
 * factory, spawn-key/spec builders, and small async assertions so timing
 * checks never rely on fixed sleeps alone.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

import { SqliteZstdBackend } from '../../durable-backend-sqlite-zstd/src/index.js';
import { DurableSeam, sqliteZstdDurableLogPort } from '../../durable-seam/src/index.js';
import { sqliteZstdDelegationLog } from '../src/log.js';
import type { StoredSupervisorEntry } from '../src/log.js';
import { DelegationSupervisor } from '../src/supervisor.js';
import type { ChildSpec, JsonValue, SpawnKey } from '../src/types.js';
import { isSupervisorKind } from '../src/document.js';

const tempDirs: string[] = [];

/** A fresh single-writer backend over a temp directory (removed after the test). */
export function makeBackend(): SqliteZstdBackend {
  const directory = mkdtempSync(join(tmpdir(), 'delegation-supervisor-'));
  tempDirs.push(directory);
  return SqliteZstdBackend.open(directory);
}

/**
 * A supervisor over the given backend (convention: one per test). The
 * wait-outcome authority is a REAL `DurableSeam` over the same backend — the
 * supervisor routes every release through it and projects the committed
 * decision (steering-design-sol.md §3: one backgrounded entry per waitId).
 */
export async function makeSupervisor(
  backend: SqliteZstdBackend,
  options: { recoveryScanBytes?: number; anchorReadBytes?: number; maxTerminalRecords?: number } = {},
  effectFence?: { disengage(request: unknown): Promise<unknown> },
): Promise<DelegationSupervisor> {
  const seam = await DurableSeam.open(sqliteZstdDurableLogPort(backend));
  return DelegationSupervisor.open({
    log: sqliteZstdDelegationLog(backend),
    waitSeam: seam,
    effectFence: effectFence as never,
    ...options,
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory === undefined) continue;
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The default spawn key; override single fields per test. */
export function spawnKey(overrides: Partial<SpawnKey> = {}): SpawnKey {
  return { parentConversationId: 'conv-parent', parentRunId: 'run-1', toolCallId: 'tool-1', ...overrides };
}

/** The default child spec; override per test. */
export function childSpec(overrides: ChildSpec = {}): ChildSpec {
  return { prompt: 'explore the repo', ...overrides };
}

export const doneOutcome = { status: 'completed' as const, summary: 'done' };

/** Every supervisor entry currently in the log, oldest first. */
export function supervisorEntries(backend: SqliteZstdBackend): StoredSupervisorEntry[] {
  return backend.readDeltaChecked(0, 64 * 1024 * 1024).entries.filter((entry) => isSupervisorKind(entry.kind));
}

/** Entry payloads of one kind, oldest first. */
export function payloadsOfKind<T = Record<string, unknown>>(backend: SqliteZstdBackend, kind: string): T[] {
  return supervisorEntries(backend)
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.payload as T);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Asserts the promise has not settled within a short poll window. */
export async function expectPending(promise: Promise<unknown>, label = 'promise'): Promise<void> {
  const outcome = await Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    delay(15).then(() => 'pending' as const),
  ]);
  if (outcome === 'settled') throw new Error(`expected ${label} to stay pending`);
}

/** Collects resolution events of a wait promise without consuming it. */
export function trackResolutions(promise: Promise<unknown>): { readonly count: () => number } {
  let resolutions = 0;
  promise.then(
    () => {
      resolutions += 1;
    },
    () => {
      resolutions += 1;
    },
  );
  return { count: () => resolutions };
}

/** JSON clone helper for building raw payloads in recovery fixtures. */
export function asJson<T extends object>(value: T): T & JsonValue {
  return JSON.parse(JSON.stringify(value)) as T & JsonValue;
}
