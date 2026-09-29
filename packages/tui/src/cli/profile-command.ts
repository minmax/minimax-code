import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertValidProfileName,
  DEFAULT_PROFILE_NAME,
  getProfile,
  listProfiles,

  resolveProfileDataDirPaths,
  type DiscoveredProfile,
} from '@mavis/config';

export type McodeProfileCliRequest =
  | { readonly action: 'list'; readonly json?: boolean }
  | { readonly action: 'current' }
  | { readonly action: 'remove'; readonly name: string; readonly confirmed: boolean };

/**
 * Every filesystem and profile-resolution dependency is injectable so the
 * command can be exercised against a temporary home directory instead of the
 * developer's real `~/.minimax*` tree.
 */
export interface RunMcodeProfileCommandOptions {
  readonly request: McodeProfileCliRequest;
  readonly homeDir?: string;
  /**
   * Kept for injection in tests. Profile selection itself goes through
   * `getProfile()`, which already reads this environment plus argv.
   */
  readonly environment?: NodeJS.ProcessEnv;
  readonly resolveProfile?: () => string | null;
  readonly discoverProfiles?: (homeDir: string) => readonly DiscoveredProfile[];
  readonly removePath?: (target: string) => void;
}

export async function runMcodeProfileCommand(
  options: RunMcodeProfileCommandOptions,
): Promise<string> {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const { request } = options;
  if (request.action === 'list') {
    const profiles = (options.discoverProfiles ?? listProfiles)(homeDir);
    if (request.json) return JSON.stringify(profiles, null, 2);
    return formatProfileList(profiles, resolveSelectedProfile(options));
  }
  if (request.action === 'current') {
    const profile = resolveSelectedProfile(options);
    const { dataDir } = resolveProfileDataDirPaths(profile, homeDir);
    return [
      `Current profile: ${profile ?? DEFAULT_PROFILE_NAME}`,
      `Data directory: ${dataDir}`,
    ].join('\n');
  }
  return removeProfile(request, homeDir, options);
}

function removeProfile(
  request: Extract<McodeProfileCliRequest, { action: 'remove' }>,
  homeDir: string,
  options: RunMcodeProfileCommandOptions,
): string {
  // Validate before touching the disk: the name becomes a home-directory
  // segment, so an unvalidated `../../etc` would target a directory the user
  // never named.
  const name = assertValidProfileName(request.name.trim());
  if (name === DEFAULT_PROFILE_NAME) {
    const { dataDir } = resolveProfileDataDirPaths(null, homeDir);
    throw new Error(
      `Refusing to remove the default profile. Delete ${dataDir} manually if that is what you want.`,
    );
  }
  if (!request.confirmed) {
    throw new Error(`Refusing to remove profile "${name}" without --yes.`);
  }

  const removePath = options.removePath ?? removeProfilePath;
  const { dataDir, legacyDataDir } = resolveProfileDataDirPaths(name, homeDir);
  // A profile upgraded from the `~/.mavis-<name>` layout may only have the
  // legacy directory left. Proceed if either exists, otherwise the user's only
  // remaining copy of that account's data would be unreachable.
  const hasCurrent = pathExists(dataDir);
  const hasLegacy = pathExists(legacyDataDir);
  if (!hasCurrent && !hasLegacy) {
    throw new Error(`Profile "${name}" has no data directory: ${dataDir}`);
  }
  const removed: string[] = [];
  if (hasCurrent) {
    removePath(dataDir);
    removed.push(dataDir);
  }
  if (hasLegacy) {
    removePath(legacyDataDir);
    removed.push(legacyDataDir);
  }
  return [`Profile removed: ${name}`, ...removed.map((target) => `  ${target}`)].join('\n');
}

/**
 * Delete one profile directory.
 *
 * A profile path is inspected with `lstat` first so a symlink is unlinked
 * instead of being walked: `~/.minimax-work` may legitimately be a link, and
 * following it would delete whatever it points at.
 */
function removeProfilePath(target: string): void {
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to remove a profile path that is not a directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: false });
}

function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function resolveSelectedProfile(options: RunMcodeProfileCommandOptions): string | null {
  if (options.resolveProfile) return options.resolveProfile();
  // Deliberately not short-circuiting on `MINIMAX_PROFILE` here. The process
  // already resolved its data directory through `getProfile()`, which reads the
  // flag first and the env second. Reading the env again would report a
  // different account than the one this process is actually running under.
  return getProfile();
}

function formatProfileList(
  profiles: readonly DiscoveredProfile[],
  selectedProfile: string | null,
): string {
  const selected = selectedProfile ?? DEFAULT_PROFILE_NAME;
  return profiles
    .map((profile) => {
      const label =
        profile.name === DEFAULT_PROFILE_NAME ? `${profile.name} (default)` : profile.name;
      return `${profile.name === selected ? '*' : ' '} ${label}\t${describeStatus(profile)}\t${profile.dataDir}`;
    })
    .join('\n');
}

function describeStatus(profile: DiscoveredProfile): string {
  if (profile.pendingAuthorization) return 'authorization pending';
  if (profile.authenticated) return 'signed in';
  return profile.exists ? 'signed out' : 'not created';
}
