/** Pure value model for sandbox settings, shared by config parsing and the renderer without Node.js dependencies. */
export type SandboxFilesystemModeName =
  | 'read_only'
  | 'workspace_write'
  | 'delete_guard'
  | 'full_access';

/**
 * Every filesystem level the config accepts, ordered from most restricted to
 * unrestricted. Exported so the config validator and the surfaces that offer a
 * choice cannot drift into accepting or advertising a mode the parser rejects.
 */
export const SANDBOX_FILESYSTEM_MODE_NAMES = [
  'read_only',
  'workspace_write',
  'delete_guard',
  'full_access',
] as const satisfies readonly SandboxFilesystemModeName[];

export interface SandboxSettingsSnapshot {
  enabled: boolean;
  filesystemMode: SandboxFilesystemModeName;
}

/** Default to full access with deletion protection off on every platform; retain the platform parameter for shared callers. */
export function getDefaultSandboxSettings(_platform: string): SandboxSettingsSnapshot {
  return { enabled: false, filesystemMode: 'full_access' };
}

/** Normalize the legacy disabled master switch and full access to no sandbox; retain other enabled levels. */
export function normalizeSandboxSettings(
  settings: SandboxSettingsSnapshot,
): SandboxSettingsSnapshot {
  return !settings.enabled || settings.filesystemMode === 'full_access'
    ? { enabled: false, filesystemMode: 'full_access' }
    : { ...settings };
}
