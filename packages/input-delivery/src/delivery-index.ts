// The delivery index: an in-memory projection of committed input facts.
//
// Responsibilities (steering-design-sol.md §2/§3, node `mcode-input-delivery-status`):
// - ONE row per owner-input line; the receipt (`mcode.owner-input.received`)
//   and the placed entry (`mcode.owner-input.placed`) merge into that row,
//   joined by `inputEntryId`. Technical control entries never become rows —
//   their facts (delegation binding, blockers) are absorbed into the row.
// - Fail-closed transitions: the state machine in `machine.ts` rejects any
//   fact that contradicts the lifecycle, so a stale or replayed caller can
//   never rewrite committed history.
// - Bounded active index: terminal rows leave the index in the same
//   transition that commits them. A small LRU of tombstones keeps recent
//   terminal rows addressable for late `get`s; durable deduplication never
//   lived here — it stays in the native submissions keyed by
//   `(conversationId, requestId)` (the `mcode.input-delivery` document is the
//   durable counterpart of the ACTIVE map only).
//
// The index holds no payload text and no callbacks: content lives in the
// receipt, actions are data, and every fact enters through `register` /
// `transition`.

import { deriveDeliveryActions } from './actions.js';
import {
	INITIAL_DELIVERY_STATE,
	assertDeliveryTransition,
	isTerminalDeliveryState,
} from './machine.js';
import { DeliveryIndexError } from './types.js';
import type {
	DeliveryAction,
	DeliveryAdmittedDetail,
	DeliveryIndex as DeliveryIndexContract,
	DeliveryIndexOptions,
	DeliveryInputMeta,
	DeliveryPlacementFacts,
	DeliveryQueuedDetail,
	DeliveryReceiptFacts,
	DeliverySavedDetail,
	DeliveryState,
	DeliveryTerminalDetail,
	DeliveryTransitionDetail,
	DeliveryTransitionRecord,
	Projection,
} from './types.js';

/** Default tombstone capacity (`DeliveryIndexOptions.maxTerminalRetained`). */
const DEFAULT_MAX_TERMINAL_RETAINED = 64;

/** Mutable row state; the public {@link Projection} is a frozen snapshot of it. */
interface RowState {
	readonly inputId: string;
	readonly requestId: string;
	readonly conversationId: string;
	readonly target: DeliveryInputMeta['target'];
	readonly whenBusy: DeliveryInputMeta['whenBusy'];
	state: DeliveryState;
	/** False until the first committed transition folds in. */
	committed: boolean;
	/** The `inputEntryId` join key; set by admission. */
	inputEntryId: string | null;
	receipt: DeliveryReceiptFacts | null;
	placement: DeliveryPlacementFacts | null;
	blocker: string | null;
	delegationId: string | null;
	childConversationId: string | null;
	/** Highest `commitSeq` folded so far; `null` when no fact carried one. */
	lastCommitSeq: number | null;
	/** Full transition timeline, starting with the optimistic `saving` entry. */
	history: DeliveryTransitionRecord[];
}

/** Validates the tombstone capacity option once, at construction time. */
function resolveTerminalCap(maxTerminalRetained: number | undefined): number {
	const cap = maxTerminalRetained ?? DEFAULT_MAX_TERMINAL_RETAINED;
	if (!Number.isInteger(cap) || cap < 0) {
		throw new TypeError(`maxTerminalRetained must be a non-negative integer, got ${maxTerminalRetained}`);
	}
	return cap;
}

/** Narrows a transition detail to {@link DeliverySavedDetail}; fails closed on missing ids. */
function asSavedDetail(detail: DeliveryTransitionDetail | undefined): DeliverySavedDetail {
	const candidate = detail as DeliverySavedDetail | undefined;
	if (typeof candidate?.submissionId !== 'string' || typeof candidate.receiptEntryId !== 'string') {
		throw new TypeError('a saved transition requires submissionId and receiptEntryId (the committed receipt)');
	}
	return candidate;
}

/** Narrows a transition detail to {@link DeliveryAdmittedDetail}; fails closed on the join key. */
function asAdmittedDetail(detail: DeliveryTransitionDetail | undefined): DeliveryAdmittedDetail {
	const candidate = detail as DeliveryAdmittedDetail | undefined;
	if (typeof candidate?.inputEntryId !== 'string' || candidate.inputEntryId.length === 0) {
		throw new TypeError('an admitted transition requires inputEntryId (the receipt/placement join key)');
	}
	return candidate;
}

/** Merges a scalar binding fact: first committed value wins, a different later one conflicts. */
function mergeBinding(
	current: string | null,
	incoming: string | undefined,
	what: string,
	inputId: string,
): string | null {
	if (incoming === undefined) return current;
	if (current !== null && current !== incoming) {
		throw new DeliveryIndexError(
			'linkage-conflict',
			`input ${JSON.stringify(inputId)} is already bound to ${what} ${JSON.stringify(current)}, ` +
				`cannot rebind to ${JSON.stringify(incoming)}`,
		);
	}
	return current ?? incoming;
}

/**
 * Replay-path twin of {@link mergeBinding}: a redelivered fact may REPEAT the
 * stored binding but never introduce or change one — a same-state fact with a
 * binding the stored row does not carry is not a replay, and the state
 * machine has no path for it. Validation only; the row stays untouched.
 */
function assertReplayBinding(row: RowState, incoming: string | undefined, what: string): void {
	if (incoming === undefined) return;
	const stored = what === 'delegation' ? row.delegationId : row.childConversationId;
	if (incoming === stored) return;
	throw new DeliveryIndexError(
		'linkage-conflict',
		`input ${JSON.stringify(row.inputId)}: replayed ${row.state} fact carries ${what} ` +
			`${JSON.stringify(incoming)}, stored ${JSON.stringify(stored)}`,
	);
}

/**
 * Creates the delivery index. Bare `createDeliveryIndex()` is the documented
 * API; the options argument only tunes the tombstone bound.
 */
export function createDeliveryIndex(options?: DeliveryIndexOptions): DeliveryIndexContract {
	const terminalCap = resolveTerminalCap(options?.maxTerminalRetained);

	/** Active rows in registration order (Map preserves insertion order). */
	const active = new Map<string, RowState>();
	/** Retained terminal rows (tombstones), least-recently-used first. */
	const terminal = new Map<string, Projection>();

	/**
	 * Builds the public projection as a DEEP-FROZEN snapshot: the caller gets
	 * an immutable view (mutation attempts are ignored in sloppy mode and
	 * throw in strict mode, which Vitest/ESM are) and can never reach into the
	 * internal row state through nested objects or arrays.
	 */
	function snapshot(row: RowState): Projection {
		const terminalRow = isTerminalDeliveryState(row.state);
		return Object.freeze({
			inputId: row.inputId,
			state: row.state,
			committed: row.committed,
			terminal: terminalRow,
			active: !terminalRow,
			requestId: row.requestId,
			conversationId: row.conversationId,
			target: Object.freeze({ ...row.target }),
			whenBusy: row.whenBusy,
			inputEntryId: row.inputEntryId,
			receipt: row.receipt === null ? null : Object.freeze({ ...row.receipt }),
			placement: row.placement === null ? null : Object.freeze({ ...row.placement }),
			linked: row.receipt !== null && row.placement !== null && row.placement.inputEntryId === row.inputEntryId,
			blocker: row.blocker,
			delegationId: row.delegationId,
			childConversationId: row.childConversationId,
			actions: Object.freeze(deriveDeliveryActions(row).map((action) => Object.freeze({ ...action }))),
			history: Object.freeze(row.history.map((record) => Object.freeze({ ...record }))),
		});
	}

	/** Stores a terminal tombstone under the LRU cap, evicting the oldest entry. */
	function retainTerminal(projection: Projection): void {
		terminal.delete(projection.inputId);
		terminal.set(projection.inputId, projection);
		while (terminal.size > terminalCap) {
			const oldest = terminal.keys().next();
			if (oldest.done) break;
			terminal.delete(oldest.value);
		}
	}

	/** Resolves a row for a mutation; unknown ids fail closed. */
	function activeRow(inputId: string): RowState {
		const row = active.get(inputId);
		if (row === undefined) {
			throw new DeliveryIndexError(
				'unknown-input',
				terminal.has(inputId)
					? `input ${JSON.stringify(inputId)} is terminal and no longer active (retained tombstone only)`
					: `unknown input ${JSON.stringify(inputId)}`,
			);
		}
		return row;
	}

	/**
	 * Same-state transition: the caller redelivered a committed fact. The row
	 * never mutates its lifecycle, linkage ids or history; every carried id
	 * must match the stored one (or be absent), a different `commitSeq` is a
	 * caller bug. The queued blocker is the one exception: it names the
	 * CURRENT remaining blocker from committed control entries, so a replay
	 * may refresh it.
	 */
	function foldReplay(row: RowState, detail: DeliveryTransitionDetail | undefined): void {
		const seq = detail?.commitSeq;
		if (typeof seq === 'number' && row.lastCommitSeq !== null && seq !== row.lastCommitSeq) {
			throw new DeliveryIndexError(
				'stale-commit',
				`input ${JSON.stringify(row.inputId)}: replay of ${row.state} carries commitSeq ${seq}, ` +
					`stored ${row.lastCommitSeq}`,
			);
		}
		const saved = row.state === 'saved' ? asSavedDetail(detail) : undefined;
		if (saved !== undefined) {
			if (row.receipt !== null && (row.receipt.submissionId !== saved.submissionId || row.receipt.entryId !== saved.receiptEntryId)) {
				throw new DeliveryIndexError(
					'linkage-conflict',
					`input ${JSON.stringify(row.inputId)}: replayed saved fact differs from the stored receipt`,
				);
			}
			assertReplayBinding(row, saved.delegationId, 'delegation');
			assertReplayBinding(row, saved.childConversationId, 'child conversation');
		}
		const admitted = row.state === 'admitted' ? asAdmittedDetail(detail) : undefined;
		if (admitted !== undefined && row.placement !== null && row.placement.inputEntryId !== admitted.inputEntryId) {
			throw new DeliveryIndexError(
				'linkage-conflict',
				`input ${JSON.stringify(row.inputId)}: replayed admitted fact carries inputEntryId ` +
					`${JSON.stringify(admitted.inputEntryId)}, stored ${JSON.stringify(row.placement.inputEntryId)} — ` +
					'the placed entry appears exactly once per input',
			);
		}
		const queued = detail as DeliveryQueuedDetail | undefined;
		if (row.state === 'queued') {
			assertReplayBinding(row, queued?.delegationId, 'delegation');
			assertReplayBinding(row, queued?.childConversationId, 'child conversation');
			if (typeof queued?.blocker === 'string') row.blocker = queued.blocker;
		}
	}

	return {
		register(inputId: string, meta: DeliveryInputMeta): void {
			if (active.has(inputId) || terminal.has(inputId)) {
				// A redelivered input is a replay of the original row: the durable
				// dedup of (conversationId, requestId) lives in the native
				// submissions, and this index never resurrects a second row.
				throw new DeliveryIndexError(
					'duplicate-input',
					`input ${JSON.stringify(inputId)} is already registered`,
				);
			}
			const row: RowState = {
				inputId,
				requestId: meta.requestId,
				conversationId: meta.conversationId,
				target: { ...meta.target },
				whenBusy: meta.whenBusy,
				state: INITIAL_DELIVERY_STATE,
				committed: false,
				inputEntryId: null,
				receipt: null,
				placement: null,
				blocker: null,
				delegationId: null,
				childConversationId: null,
				lastCommitSeq: null,
				history: [
					{ state: INITIAL_DELIVERY_STATE, atMs: meta.registeredMs ?? null, commitSeq: null },
				],
			};
			active.set(inputId, row);
		},

		transition(inputId: string, state: DeliveryState, detail?: DeliveryTransitionDetail): void {
			const row = activeRow(inputId);

			// Committed replay: same state again — never mutates the lifecycle.
			if (state === row.state) {
				foldReplay(row, detail);
				return;
			}

			assertDeliveryTransition(row.state, state);

			// ATOMIC ON FAILURE: nothing below may write to `row` before every
			// check has passed. A rejected fact (stale sequence, rebound
			// delegation, conflicting join key) must leave the row — its stored
			// commitSeq watermark, blocker and bindings included — exactly as it
			// was, so the corrected retry of the same committed fact is accepted
			// instead of being dismissed as stale forever.
			const seq = detail?.commitSeq;
			if (typeof seq === 'number' && row.lastCommitSeq !== null && seq <= row.lastCommitSeq) {
				throw new DeliveryIndexError(
					'stale-commit',
					`input ${JSON.stringify(inputId)}: transition to ${state} carries commitSeq ${seq}, ` +
						`not newer than the stored ${row.lastCommitSeq}`,
				);
			}

			// Compute every mutation into locals first; `mergeBinding` throws on
			// conflicts while `row` is still untouched.
			let receipt = row.receipt;
			let placement = row.placement;
			let inputEntryId = row.inputEntryId;
			let blocker = row.blocker;
			let delegationId = row.delegationId;
			let childConversationId = row.childConversationId;

			switch (state) {
				case 'saved': {
					const saved = asSavedDetail(detail);
					receipt = { entryId: saved.receiptEntryId, submissionId: saved.submissionId };
					delegationId = mergeBinding(row.delegationId, saved.delegationId, 'delegation', inputId);
					childConversationId = mergeBinding(
						row.childConversationId,
						saved.childConversationId,
						'child conversation',
						inputId,
					);
					break;
				}
				case 'queued': {
					const queued = (detail ?? {}) as DeliveryQueuedDetail;
					if (typeof queued.blocker === 'string') blocker = queued.blocker;
					delegationId = mergeBinding(row.delegationId, queued.delegationId, 'delegation', inputId);
					childConversationId = mergeBinding(
						row.childConversationId,
						queued.childConversationId,
						'child conversation',
						inputId,
					);
					break;
				}
				case 'admitted': {
					const admitted = asAdmittedDetail(detail);
					if (row.placement !== null) {
						// Unreachable through the state machine (admitted admits no
						// re-entry); kept as a belt-and-braces guard for the
						// exactly-once placed entry.
						throw new DeliveryIndexError(
							'linkage-conflict',
							`input ${JSON.stringify(inputId)} is already admitted — the placed entry appears exactly once`,
						);
					}
					placement = { inputEntryId: admitted.inputEntryId, entryId: admitted.placedEntryId ?? null };
					inputEntryId = admitted.inputEntryId;
					// The blocker named why admission was waiting; the placed entry
					// is in the context, so the named blocker no longer exists.
					blocker = null;
					break;
				}
				case 'answered':
				case 'withdrawn':
				case 'unanswered':
				case 'failed': {
					// Terminal: no extra facts beyond reason/commitSeq; the reason is
					// part of the history record, not of the row body.
					break;
				}
			}

			// All checks passed — apply the computed mutation set.
			if (typeof seq === 'number') row.lastCommitSeq = seq;
			row.receipt = receipt;
			row.placement = placement;
			row.inputEntryId = inputEntryId;
			row.blocker = blocker;
			row.delegationId = delegationId;
			row.childConversationId = childConversationId;
			row.state = state;
			row.committed = true;
			row.history.push({
				state,
				atMs: detail?.atMs ?? null,
				commitSeq: typeof seq === 'number' ? seq : null,
			});

			// Bounded cleanup: the terminal row leaves the active index in the
			// same step; the tombstone keeps ids (receipt/submission/placement)
			// addressable for late UI refreshes without holding any payload.
			if (isTerminalDeliveryState(state)) {
				active.delete(inputId);
				retainTerminal(snapshot(row));
			}
		},

		get(inputId: string): Projection {
			const row = active.get(inputId);
			if (row !== undefined) return snapshot(row);
			const tombstone = terminal.get(inputId);
			if (tombstone !== undefined) {
				// LRU refresh: a late read keeps the tombstone addressable.
				terminal.delete(inputId);
				terminal.set(inputId, tombstone);
				return tombstone;
			}
			throw new DeliveryIndexError('unknown-input', `unknown input ${JSON.stringify(inputId)}`);
		},

		has(inputId: string): boolean {
			return active.has(inputId);
		},

		active(): readonly Projection[] {
			return [...active.values()].map((row) => snapshot(row));
		},
	};
}
