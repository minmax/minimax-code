// Fail-closed state machine of the input-delivery projection.
//
// One owner-input line walks `saving → saved/queued → admitted → answered`,
// or ends in `withdrawn`, `unanswered` or `failed` (steering-design-sol.md
// §2). The matrix below is the single authority for which transitions carry a
// committed fact; anything else is a caller bug and throws instead of
// silently rewriting history.
//
// Two contract points are encoded here, not in the caller:
// - `admitted → withdrawn` does not exist: an already admitted input never
//   becomes "undelivered" (§5, abort row — its answer may still end
//   `unanswered`, and a copy-to-child stays available).
// - `withdrawn` is reachable only from committed pending states (`saved`,
//   `queued`): native `submission.abort()` can only retract what is still
//   waiting, and the optimistic `saving` row has nothing durable to abort.

import { DeliveryIndexError } from './types.js';
import type { DeliveryState, DeliveryTerminalState } from './types.js';

/** The state {@link register} creates — optimistic, not yet committed. */
export const INITIAL_DELIVERY_STATE: DeliveryState = 'saving';

/** Terminal states in canonical order; a row in one of these left the active index. */
export const TERMINAL_DELIVERY_STATES: readonly DeliveryTerminalState[] = [
	'answered',
	'withdrawn',
	'unanswered',
	'failed',
];

/**
 * Allowed transitions, `from → [to…]`. Terminal states map to `[]`: history
 * is never rewritten, and a late duplicate of an already-terminal fact must
 * be deduplicated by the caller's replay path, not by mutating the row.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
	saving: ['saved', 'queued', 'failed'],
	saved: ['queued', 'admitted', 'withdrawn', 'unanswered', 'failed'],
	queued: ['admitted', 'withdrawn', 'unanswered', 'failed'],
	admitted: ['answered', 'unanswered', 'failed'],
	answered: [],
	withdrawn: [],
	unanswered: [],
	failed: [],
};

/** Whether `state` is terminal (the row has left the active index). */
export function isTerminalDeliveryState(state: DeliveryState): boolean {
	return ALLOWED_TRANSITIONS[state].length === 0;
}

/**
 * Asserts `from → to` carries a committed fact. Same-state calls do NOT go
 * through here — they are handled as replays before the check. Unknown
 * transitions throw {@link DeliveryIndexError} with code `'invalid-transition'`.
 */
export function assertDeliveryTransition(from: DeliveryState, to: DeliveryState): void {
	if (!ALLOWED_TRANSITIONS[from].includes(to)) {
		throw new DeliveryIndexError(
			'invalid-transition',
			`transition ${from} → ${to} is not a committed state change of the input lifecycle ` +
				`(allowed from ${from}: ${ALLOWED_TRANSITIONS[from].join(', ') || 'nothing — terminal'})`,
		);
	}
}
