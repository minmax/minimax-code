/**
 * The durable data root and its on-disk layout.
 *
 * The durable runtime owns a data root separate from the legacy mcode data
 * directory: the default profile uses `~/.mcode-durable`, and `--profile work`
 * uses `~/.mcode-durable-work`, following the same profile rule as
 * `auth-profile.ts`. Everything the runtime persists lives under that root —
 * the canonical session databases (`sessions.g<N>.db`, one file per format
 * generation), the content-addressed blob store (`cas/`), the service tables
 * (`runtime.db`), and the daemon socket (`mcoded.sock`).
 *
 * The legacy `~/.minimax` tree is a read-only source during migration: nothing
 * in the durable runtime may open a path inside it for writing. The rule is
 * stated once here ({@link assertNoLegacyWrite}) so filesystem gates can share
 * a single definition of "legacy" instead of restating it per call site.
 *
 * @module
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeProfileSelector } from './auth-profile.js';
import { NEW_DATA_DIR_BASENAME } from './data-dir.js';

/** Directory name of the durable root under the home directory. */
export const DURABLE_ROOT_BASENAME = '.mcode-durable';

/** Content-addressed blob store directory inside the durable root. */
export const DURABLE_CAS_DIR_BASENAME = 'cas';

/** Service-table SQLite database inside the durable root (agents, cron, queues, memory). */
export const DURABLE_RUNTIME_DB_BASENAME = 'runtime.db';

/** Unix socket the mcoded daemon listens on, inside the durable root. */
export const DURABLE_SOCKET_BASENAME = 'mcoded.sock';

/** Base name of the canonical session database; the generation is inserted before `.db`. */
export const DURABLE_SESSIONS_DB_BASENAME = 'sessions';

/** Generation of the session database the runtime starts from. */
export const DEFAULT_SESSIONS_GENERATION = 1;

/**
 * Absolute path of the legacy data root the durable runtime must never write.
 *
 * `~/.minimax` is `NEW_DATA_DIR_BASENAME` in `data-dir.ts` — "new" only
 * relative to the pre-MiniMax `.mavis` layout; the durable runtime supersedes
 * both and treats this root as read-only.
 *
 * The path is captured when this module is first imported. A process that
 * overrides `HOME`/`os.homedir()` afterwards (a test harness, for example)
 * must pass the matching root explicitly rather than rely on this default.
 */
export const LEGACY_ROOT = path.join(os.homedir(), NEW_DATA_DIR_BASENAME);

/** Thrown when an operation attempts to write inside the legacy data root. */
export class LegacyWriteError extends Error {
  readonly code = 'LEGACY_WRITE_FORBIDDEN';
  readonly targetPath: string;
  readonly legacyRoot: string;

  constructor(targetPath: string, legacyRoot: string) {
    super(
      `Refusing to write "${targetPath}": the path falls inside the legacy data root ` +
        `"${legacyRoot}", which the durable runtime only reads.`,
    );
    this.name = 'LegacyWriteError';
    this.targetPath = targetPath;
    this.legacyRoot = legacyRoot;
  }
}

/**
 * Resolve the durable data root a profile points at, without touching the disk.
 *
 * Profile selection follows {@link normalizeProfileSelector}: an absent, blank,
 * or `default` selector resolves the unsuffixed root, and any other value must
 * pass the profile-name allowlist so the generated directory segment cannot
 * escape the home directory.
 *
 * @throws {InvalidProfileNameError} when a non-blank profile is not a valid name.
 */
export function resolveDurableRoot(
  profile?: string | null,
  homeDir: string = os.homedir(),
): string {
  const selected = normalizeProfileSelector(profile);
  const home = path.resolve(homeDir);
  return path.join(home, selected ? `${DURABLE_ROOT_BASENAME}-${selected}` : DURABLE_ROOT_BASENAME);
}

/**
 * Resolve the canonical session database of one format generation.
 *
 * Generation `N` lives in `sessions.g<N>.db` next to the previous generation,
 * which must stay byte-identical while a verified migration fills the new one.
 *
 * @throws {RangeError} when the generation is not an integer >= 1.
 */
export function resolveSessionsDbPath(
  root: string,
  generation: number = DEFAULT_SESSIONS_GENERATION,
): string {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new RangeError(`Invalid session database generation ${generation}. Use an integer >= 1.`);
  }
  return path.join(root, `${DURABLE_SESSIONS_DB_BASENAME}.g${generation}.db`);
}

/** Resolve the content-addressed blob store directory under a durable root. */
export function resolveCasDirPath(root: string): string {
  return path.join(root, DURABLE_CAS_DIR_BASENAME);
}

/** Resolve the service-table database under a durable root. */
export function resolveRuntimeDbPath(root: string): string {
  return path.join(root, DURABLE_RUNTIME_DB_BASENAME);
}

/** Resolve the daemon socket under a durable root. */
export function resolveMcodedSocketPath(root: string): string {
  return path.join(root, DURABLE_SOCKET_BASENAME);
}

// Same normalization `data-dir.ts` uses to compare paths: resolve, and fold
// case only on Windows, where the file system is case-insensitive.
function normalizePathForCompare(targetPath: string): string {
  let normalized = path.resolve(targetPath);
  if (process.platform === 'win32') {
    normalized = normalized.replace(/^\\\\\?\\/, '');
    return normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Report whether `target` falls inside the write-protected legacy family.
 *
 * The family is the legacy root itself plus its profile-suffixed siblings
 * (`~/.minimax`, `~/.minimax-work`), matched at the home-directory level the
 * same way the profile resolver names them. Paths elsewhere under the home
 * directory, and absolute paths outside it entirely, are not legacy.
 */
function isLegacyFamilyPath(target: string, legacyRoot: string): boolean {
  const resolvedRoot = normalizePathForCompare(legacyRoot);
  const legacyHome = path.dirname(resolvedRoot);

  const relative = path.relative(legacyHome, normalizePathForCompare(target));
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  const [first] = relative.split(path.sep);
  const legacyBasename = path.basename(resolvedRoot);
  return first !== undefined && (first === legacyBasename || first.startsWith(`${legacyBasename}-`));
}

/**
 * Assert that a path may be written under the durable architecture.
 *
 * The legacy tree is read-only: the durable runtime streams data out of it but
 * never opens anything inside it for writing. Call this before any filesystem
 * mutation whose target is derived from configuration or a profile;
 * {@link ensureDurableLayout} applies the same guard to its own writes.
 *
 * Filesystem gates that cannot trust the process environment (see
 * {@link LEGACY_ROOT}) should pass `legacyRoot` explicitly instead of relying
 * on the default.
 *
 * @returns The validated path, unchanged.
 * @throws {LegacyWriteError} when `target` is inside the legacy family.
 */
export function assertNoLegacyWrite(target: string, legacyRoot: string = LEGACY_ROOT): string {
  if (isLegacyFamilyPath(target, legacyRoot)) throw new LegacyWriteError(target, legacyRoot);
  return target;
}

/**
 * Create the durable directory layout under `root`.
 *
 * Only directories are created: the SQLite databases and the daemon socket are
 * opened by their owners on demand. Existing directories are left untouched,
 * so the call is idempotent and safe at every startup.
 *
 * @throws {LegacyWriteError} when `root` is inside the legacy family.
 */
export function ensureDurableLayout(root: string): void {
  assertNoLegacyWrite(root);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(resolveCasDirPath(root), { recursive: true });
}
