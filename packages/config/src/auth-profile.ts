/**
 * Named auth profiles.
 *
 * A profile selects an isolated data directory: the default profile uses the
 * unsuffixed `~/.minimax`, and `--profile work` uses `~/.minimax-work`. Every
 * credential, session, and setting stored under that directory is therefore
 * scoped to the profile, which is what keeps two accounts (for example a
 * personal token plan and a work token plan) from sharing state.
 *
 * Two entry points select a profile, in priority order:
 *
 *   1. `--profile <name>` on the command line.
 *   2. the `MINIMAX_PROFILE` environment variable.
 *
 * The legacy `__MAVIS_RUNTIME_PROFILE` remains a last-resort fallback for
 * internal service processes, but it is only honoured when
 * `__MAVIS_ALLOW_LEGACY_RUNTIME_ENV=1`.
 *
 * Profile names become a path segment (`~/.minimax-<name>`), so they are
 * validated against a strict allowlist. This is a security boundary, not a
 * formatting preference: an unvalidated name such as `../../etc` would resolve
 * outside the home directory and redirect the credential store.
 *
 * @module
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LEGACY_DATA_DIR_BASENAME, NEW_DATA_DIR_BASENAME } from './data-dir.js';

/** Display name of the implicit profile used when no profile is selected. */
export const DEFAULT_PROFILE_NAME = 'default';

/** Public environment variable that selects a profile for the whole process tree. */
export const PROFILE_ENV_VAR = 'MINIMAX_PROFILE';

/** Legacy internal environment variable. Honoured only behind the runtime-env gate. */
export const LEGACY_PROFILE_ENV_VAR = '__MAVIS_RUNTIME_PROFILE';

const MAX_PROFILE_NAME_LENGTH = 64;

/**
 * Allowlist for profile names.
 *
 * Deliberately narrower than a generic "no path separators" check: a name must
 * start and end alphanumeric, so `.`, `..`, and dotfiles are impossible, and it
 * may not contain a separator, whitespace, or a leading dash. The trailing
 * restriction also keeps generated flags such as `--profile <name>` unambiguous.
 */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

/** Thrown when a profile name cannot be used safely as a directory segment. */
export class InvalidProfileNameError extends Error {
  readonly code = 'INVALID_PROFILE_NAME';
  readonly profileName: string;

  constructor(profileName: string) {
    super(
      `Invalid profile name "${profileName}". Use 1-${MAX_PROFILE_NAME_LENGTH} letters, numbers, dots, ` +
        'underscores, or hyphens, starting and ending with a letter or number.',
    );
    this.name = 'InvalidProfileNameError';
    this.profileName = profileName;
  }
}

/**
 * Report whether a profile name is safe to use.
 *
 * Prefer {@link assertValidProfileName} at trust boundaries: a boolean is easy
 * to ignore, and silently falling back to the default profile would point a user
 * at the wrong account's credentials.
 */
export function isValidProfileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PROFILE_NAME_LENGTH &&
    PROFILE_NAME_PATTERN.test(value)
  );
}

/**
 * Validate a profile name, throwing {@link InvalidProfileNameError} if unusable.
 *
 * @throws {InvalidProfileNameError}
 */
export function assertValidProfileName(value: string): string {
  if (!isValidProfileName(value)) throw new InvalidProfileNameError(value);
  return value;
}

/**
 * Coerce a user-supplied profile selector into the internal representation.
 *
 * An absent or blank selector means "no profile selected", represented as
 * `null` so that existing callers keep resolving the unsuffixed default data
 * directory. A non-blank selector is validated rather than sanitised: guessing
 * at the user's intent is worse than refusing a name that looks wrong.
 *
 * `default` is reserved. It is the display name of the implicit profile, and
 * treating it as an ordinary name would make `--profile default` resolve to
 * `~/.minimax-default` — a second, invisible account holding its own token,
 * which is exactly the wrong-account failure this feature exists to prevent.
 * `--profile default` therefore means the same thing as omitting the flag.
 *
 * @throws {InvalidProfileNameError} when a non-blank value is not a valid name.
 */
export function normalizeProfileSelector(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toLowerCase() === DEFAULT_PROFILE_NAME) return null;
  return assertValidProfileName(trimmed);
}

/**
 * Read the public profile environment variable.
 *
 * An invalid value is reported rather than dropped: `MINIMAX_PROFILE=../evil`
 * must not quietly fall back to the default profile and send the user to their
 * personal account.
 */
export function readProfileEnv(environment: NodeJS.ProcessEnv = process.env): string | null {
  const raw = environment[PROFILE_ENV_VAR];
  if (raw === undefined) return null;
  return normalizeProfileSelector(raw);
}

export interface DataDirProfilePaths {
  /** Absolute data directory for this profile, without running migration. */
  readonly dataDir: string;
  /** Legacy compat directory for this profile, if one is relevant. */
  readonly legacyDataDir: string;
}

function basenameForProfile(base: string, profile: string | null | undefined): string {
  return profile ? `${base}-${profile}` : base;
}

/**
 * Resolve the data directory a profile points at, without touching the disk.
 *
 * `packages/config/src/data-dir.ts` performs the same path arithmetic before
 * migration; this helper exists so callers that only need a path (the profile
 * listing command, for example) do not have to trigger directory creation.
 */
export function resolveProfileDataDirPaths(
  profile: string | null,
  homeDir: string = os.homedir(),
): DataDirProfilePaths {
  const home = path.resolve(homeDir);
  return {
    dataDir: path.join(home, basenameForProfile(NEW_DATA_DIR_BASENAME, profile)),
    legacyDataDir: path.join(home, basenameForProfile(LEGACY_DATA_DIR_BASENAME, profile)),
  };
}

export interface DiscoveredProfile {
  /** Profile name, or {@link DEFAULT_PROFILE_NAME} for the unsuffixed directory. */
  readonly name: string;
  /** Absolute data directory backing this profile. */
  readonly dataDir: string;
  /** True when the directory currently exists on disk. */
  readonly exists: boolean;
  /** True when a stored OAuth credential record is present for this profile. */
  readonly authenticated: boolean;
  /** True when `auth-state.json` reports an in-progress authorization. */
  readonly pendingAuthorization: boolean;
}

function readAuthState(
  dataDir: string,
): { authenticated: boolean; pendingAuthorization: boolean } {
  const authHome = path.join(dataDir, 'auth');
  let authenticated = false;
  let pendingAuthorization = false;

  // The namespace layout is `auth/<buildEnv>/<region>/<clientId>/`, and the
  // client id is a build-time constant that may change. Walk to a bounded depth
  // and key off the file names rather than a fixed number of path segments, so
  // a layout change cannot silently report every profile as signed out.
  const walk = (directory: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath, depth + 1);
        continue;
      }
      if (entry.name === 'auth.json') authenticated = true;
      if (entry.name !== 'auth-state.json') continue;
      let status: unknown;
      try {
        status = (JSON.parse(fs.readFileSync(entryPath, 'utf8')) as { status?: unknown }).status;
      } catch {
        continue;
      }
      if (status === 'authorizing' || status === 'refreshing') pendingAuthorization = true;
    }
  };

  walk(authHome, 0);
  return { authenticated, pendingAuthorization };
}

function directoryExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List the profiles present in `homeDir`.
 *
 * Profiles are discovered by matching the data-directory basenames rather than
 * by keeping a registry file, so a profile that still holds credentials can
 * never become invisible to the user. {@link DEFAULT_PROFILE_NAME} is always
 * reported first and always exists as the fallback even when absent from disk.
 *
 * Names are deduplicated case-insensitively. A profile name is preserved
 * verbatim in the directory it selects, and on macOS and Windows those
 * directories are case-insensitive, so `Work` and `work` are the same account;
 * listing both would imply two accounts where there is one.
 */
export function listProfiles(homeDir: string = os.homedir()): DiscoveredProfile[] {
  const home = path.resolve(homeDir);
  const names = new Map<string, string>([[DEFAULT_PROFILE_NAME, DEFAULT_PROFILE_NAME]]);

  const prefixes = [
    { prefix: `${NEW_DATA_DIR_BASENAME}-`, strip: (value: string) => value.slice(NEW_DATA_DIR_BASENAME.length + 1) },
    { prefix: `${LEGACY_DATA_DIR_BASENAME}-`, strip: (value: string) => value.slice(LEGACY_DATA_DIR_BASENAME.length + 1) },
  ];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    for (const { prefix, strip } of prefixes) {
      if (!entry.name.startsWith(prefix)) continue;
      const candidate = strip(entry.name);
      // `~/.mavis-work` is a compat symlink to `~/.minimax-work`, so both map
      // to the same profile. Only names that are still valid are surfaced.
      if (isValidProfileName(candidate) && !names.has(candidate.toLowerCase())) {
        names.set(candidate.toLowerCase(), candidate);
      }
    }
  }

  return [...names.values()].sort((left, right) => {
    if (left === DEFAULT_PROFILE_NAME) return -1;
    if (right === DEFAULT_PROFILE_NAME) return 1;
    return left.localeCompare(right);
  }).map((name) => {
    const { dataDir, legacyDataDir } = resolveProfileDataDirPaths(
      name === DEFAULT_PROFILE_NAME ? null : name,
      home,
    );
    // A profile can still live only in the legacy `~/.mavis-<name>` layout
    // after an upgrade. Reporting it as absent would hide stored credentials
    // and make `mcode profile remove` refuse to clean it up.
    const currentExists = directoryExists(dataDir);
    const legacyExists = name !== DEFAULT_PROFILE_NAME && directoryExists(legacyDataDir);
    const exists = currentExists || legacyExists;
    const { authenticated, pendingAuthorization } = exists
      ? readAuthState(currentExists ? dataDir : legacyDataDir)
      : { authenticated: false, pendingAuthorization: false };
    return { name, dataDir, exists, authenticated, pendingAuthorization };
  });
}
