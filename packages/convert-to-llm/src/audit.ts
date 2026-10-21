/**
 * Audit/control entry policy of the steering D+C contract.
 *
 * The projection node `pi-session-projection` (steering-design-sol.md §7)
 * states: audit/control entries never reach the LLM context themselves; the
 * placed entry lands exactly once. This module encodes the kind-level half of
 * that contract:
 *
 * - every kind prefixed `mcode.` is audit/control by default and is excluded
 *   from the provider payload (`mcode.owner-input.received`,
 *   `mcode.delegation.*`, future app kinds — excluded fail-closed);
 * - exactly two `mcode.` kinds are model-visible and pass through:
 *   `mcode.owner-input.placed` (the executed user input, deduplicated by
 *   `inputEntryId`) and `mcode.system-reminder` (reminder tail entries).
 */

/** Model-visible exceptions to the `mcode.*` audit/control exclusion. */
const MODEL_VISIBLE_MCODE_KINDS: ReadonlySet<string> = new Set([
  'mcode.owner-input.placed',
  'mcode.system-reminder',
]);

/** True when the entry kind is audit/control and must never reach the provider. */
export function isAuditControlKind(kind: string): boolean {
  return kind.startsWith('mcode.') && !MODEL_VISIBLE_MCODE_KINDS.has(kind);
}

/** True when the kind is one of the whitelisted model-visible `mcode.` kinds. */
export function isVisibleControlKind(kind: string): boolean {
  return MODEL_VISIBLE_MCODE_KINDS.has(kind);
}

/** True when the entry is the steering placed entry. */
export function isPlacedEntryKind(kind: string): boolean {
  return kind === 'mcode.owner-input.placed';
}

/** True when the entry is a dedicated system-reminder tail entry. */
export function isReminderEntryKind(kind: string): boolean {
  return kind === 'mcode.system-reminder';
}
