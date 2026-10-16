export const MINIMAX_CODE_PERMISSION_MODES = ['default', 'auto', 'bypassPermissions'] as const;

export type TuiPermissionMode = (typeof MINIMAX_CODE_PERMISSION_MODES)[number] | 'off';

const PERMISSION_MODE_LABELS: Record<TuiPermissionMode, string> = {
  default: 'Ask',
  auto: 'Auto',
  bypassPermissions: 'Full access',
  off: 'Off',
};

const PERMISSION_MODE_COMPACT_LABELS: Record<TuiPermissionMode, string> = {
  default: 'ASK',
  auto: 'AUTO',
  bypassPermissions: 'FULL',
  off: 'OFF',
};

export function normalizeTuiPermissionMode(value: unknown): TuiPermissionMode | undefined {
  return MINIMAX_CODE_PERMISSION_MODES.find((mode) => mode === value);
}

export function formatTuiPermissionMode(mode: TuiPermissionMode): string {
  return PERMISSION_MODE_LABELS[mode];
}

export function formatTuiPermissionModeCompact(mode: TuiPermissionMode): string {
  return PERMISSION_MODE_COMPACT_LABELS[mode];
}

export function isDangerousTuiPermissionMode(mode: TuiPermissionMode): boolean {
  return mode === 'bypassPermissions';
}

/**
 * Coerce a runtime guard read into a boolean, or `undefined` when the host
 * does not own the setting.
 *
 * `undefined` is deliberately distinct from `true`: it lets the UI say "this
 * host does not manage the delete guard" instead of claiming a protection that
 * may not exist. Anything that is not an explicit boolean is treated as absent.
 */
export function normalizeDangerousCommandGateEnabled(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function formatTuiDeleteGuardLabel(enabled: boolean | undefined): string {
  if (enabled === undefined) return 'Managed by host';
  return enabled ? 'Recoverable' : 'Permanent';
}

export function nextTuiPermissionMode(current: TuiPermissionMode): TuiPermissionMode {
  if (current === 'off') return 'default';
  const currentIndex = MINIMAX_CODE_PERMISSION_MODES.indexOf(current);
  return MINIMAX_CODE_PERMISSION_MODES[
    (currentIndex + 1) % MINIMAX_CODE_PERMISSION_MODES.length
  ] as TuiPermissionMode;
}
