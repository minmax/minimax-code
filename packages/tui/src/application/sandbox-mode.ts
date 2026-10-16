/**
 * Sandbox filesystem levels the TUI offers, ordered from most restricted to
 * unrestricted. The list mirrors what the config parser accepts; a value that
 * is not in it is treated as absent rather than coerced, so a host that grows
 * a new level cannot have this surface guess at it.
 */
export const TUI_SANDBOX_FILESYSTEM_MODES = [
  'read_only',
  'workspace_write',
  'delete_guard',
  'full_access',
] as const;

export type TuiSandboxFilesystemMode = (typeof TUI_SANDBOX_FILESYSTEM_MODES)[number];

const SANDBOX_MODE_LABELS: Record<TuiSandboxFilesystemMode, string> = {
  read_only: 'Read only',
  workspace_write: 'Workspace',
  delete_guard: 'Delete guard',
  full_access: 'Full access',
};

const SANDBOX_MODE_COMPACT_LABELS: Record<TuiSandboxFilesystemMode, string> = {
  read_only: 'READ',
  workspace_write: 'WORK',
  delete_guard: 'GUARD',
  full_access: 'FULL',
};

const SANDBOX_MODE_DESCRIPTIONS: Record<TuiSandboxFilesystemMode, string> = {
  read_only: 'The agent can read files but cannot write or delete them',
  workspace_write: 'Writes and deletes stay on the workspace surface',
  delete_guard: 'Writes anywhere, deletes stay on the workspace surface',
  full_access: 'No filesystem restriction, including deletes outside the workspace',
};

export function normalizeTuiSandboxFilesystemMode(value: unknown): TuiSandboxFilesystemMode | undefined {
  return TUI_SANDBOX_FILESYSTEM_MODES.find((mode) => mode === value);
}

/**
 * Parse a `/sandbox <mode>` argument. Unknown input resolves to `undefined` so
 * the command can print usage and write nothing, rather than falling back to a
 * default level.
 */
export function parseTuiSandboxFilesystemModeArgument(
  value: string,
): TuiSandboxFilesystemMode | undefined {
  return normalizeTuiSandboxFilesystemMode(value.trim().toLocaleLowerCase());
}

export function formatTuiSandboxModeLabel(mode: TuiSandboxFilesystemMode | undefined): string {
  if (mode === undefined) return 'Managed by host';
  return SANDBOX_MODE_LABELS[mode];
}

export function formatTuiSandboxModeCompactLabel(mode: TuiSandboxFilesystemMode): string {
  return SANDBOX_MODE_COMPACT_LABELS[mode];
}

export function describeTuiSandboxMode(mode: TuiSandboxFilesystemMode): string {
  return SANDBOX_MODE_DESCRIPTIONS[mode];
}

/**
 * Levels that need a warning marker in the picker.
 *
 * `full_access` removes every filesystem restriction, and `read_only` is the
 * other end of the same trade-off: it looks like the cautious choice but it
 * stops the agent from doing its work, so it must not read as "safe" either.
 */
export function isCautionaryTuiSandboxMode(mode: TuiSandboxFilesystemMode): boolean {
  return mode === 'full_access' || mode === 'read_only';
}