// Quick actions as data (steering-design-sol.md §2).
//
// The TUI renders the action bar from this derivation; the projection never
// registers callbacks or performs the actions. Every action carries an
// explicit target — the bound delegation, the child conversation, or the
// input itself — so the control path never guesses an addressee from "the
// last worker".
//
// Availability rules:
// - `saving`: nothing is committed, so there is nothing to control durably
//   (a local editor discard is a client concern, not a delivery action).
// - terminal rows: the control surface is closed; the logs stay reachable
//   through the delegation card, not through a cleaned-up row.
// - `withdraw` exists only BEFORE admission: a native `submission.abort()`
//   can retract a pending submission, while an admitted input is part of the
//   context and can never become "undelivered" (§5).
// - `copy-to-child` survives admission on purpose (§4): it creates a NEW
//   linked child submission and never re-addresses the accepted input.
// - delegation-bound actions require a known `delegationId` — without a
//   committed linkage there is no wait to release and no delegate to stop.

import type {
	DeliveryAction,
	DeliveryActionId,
	DeliveryState,
} from './types.js';

/** Localized product labels of the steering contract, preserved verbatim. */
export const DELIVERY_ACTION_LABELS: Readonly<Record<DeliveryActionId, string>> = {
	background: 'В фон',
	'stop-delegate': 'Остановить делегата',
	// Declared for the contract's complete action vocabulary; the per-input
	// derivation below never emits it (a subtree stop belongs to the
	// delegation supervisor's stop-cascade surface, not to one input row).
	'stop-tree': 'Остановить дерево',
	withdraw: 'Отозвать',
	'copy-to-child': 'Копия ребёнку',
	'task-query': 'task_query',
	'task-output': 'task_output',
};

/**
 * States of an ACTIVE row where delegation-bound actions are offered: the
 * wait may still be foreground (`saved`/`queued`) or the delegate keeps
 * running in the background (`admitted`).
 */
const DELEGATION_ACTION_STATES: ReadonlySet<DeliveryState> = new Set(['saved', 'queued', 'admitted']);

/** States where the input is still pending and can be withdrawn. */
const WITHDRAWABLE_STATES: ReadonlySet<DeliveryState> = new Set(['saved', 'queued']);

/** States where a copy-to-child is offered (kept after admission, per §4). */
const COPYABLE_STATES: ReadonlySet<DeliveryState> = new Set(['saved', 'queued', 'admitted']);

/** The row facts action availability derives from. */
export interface DeliveryActionSource {
	readonly inputId: string;
	readonly state: DeliveryState;
	readonly delegationId: string | null;
	readonly childConversationId: string | null;
}

/**
 * Derives the quick actions of a row in canonical order
 * (background, stop-delegate, withdraw, copy-to-child, task-query, task-output).
 * Pure and total: unknown states simply contribute no actions.
 */
export function deriveDeliveryActions(row: DeliveryActionSource): readonly DeliveryAction[] {
	if (row.state === 'saving' || DELEGATION_ACTION_STATES.has(row.state) === false) {
		// Optimistic row or terminal row (the set above covers exactly the
		// three committed pending states; everything else is saving/terminal).
		return [];
	}

	const actions: DeliveryAction[] = [];
	const delegationBound = row.delegationId !== null;

	// «В фон» only while the wait may still be foreground. After admission it is
	// stale: the steer's whole point was that the release already happened
	// before the input entered the context.
	if (delegationBound && WITHDRAWABLE_STATES.has(row.state)) {
		actions.push({
			id: 'background',
			label: DELIVERY_ACTION_LABELS.background,
			target: { kind: 'delegation', delegationId: row.delegationId },
		});
	}

	if (delegationBound) {
		actions.push({
			id: 'stop-delegate',
			label: DELIVERY_ACTION_LABELS['stop-delegate'],
			target: { kind: 'delegation', delegationId: row.delegationId },
		});
	}

	if (WITHDRAWABLE_STATES.has(row.state)) {
		actions.push({
			id: 'withdraw',
			label: DELIVERY_ACTION_LABELS.withdraw,
			target: { kind: 'input', inputId: row.inputId },
		});
	}

	if (row.childConversationId !== null && COPYABLE_STATES.has(row.state)) {
		actions.push({
			id: 'copy-to-child',
			label: DELIVERY_ACTION_LABELS['copy-to-child'],
			target: { kind: 'conversation', conversationId: row.childConversationId },
		});
	}

	if (delegationBound) {
		actions.push(
			{
				id: 'task-query',
				label: DELIVERY_ACTION_LABELS['task-query'],
				target: { kind: 'delegation', delegationId: row.delegationId },
			},
			{
				id: 'task-output',
				label: DELIVERY_ACTION_LABELS['task-output'],
				target: { kind: 'delegation', delegationId: row.delegationId },
			},
		);
	}

	return actions;
}
