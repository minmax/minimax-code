/**
 * Public contract of the input-delivery status projection
 * (`mcode-input-delivery-status`, steering-design-sol.md §2/§3/§7).
 *
 * The projection renders ONE row per owner-input line from COMMITTED facts
 * only — never from client guesses. A row walks
 * `saving → saved/queued → admitted → answered`, or ends in `withdrawn`,
 * `unanswered` or `failed`. The receipt entry (`mcode.owner-input.received`)
 * and the placed entry (`mcode.owner-input.placed`) merge into that single
 * row, joined by `inputEntryId`; technical control entries
 * (`mcode.delegation.*`, the receipt itself) never become rows of their own.
 * Terminal rows leave the bounded active index — durable deduplication stays
 * in the native submissions, not here.
 *
 * The package is runtime-dependency-free: it consumes facts through
 * `register`/`transition` calls and holds no durable state of its own. The
 * document `mcode.input-delivery` of the steering contract is the durable
 * counterpart of the active index this projection maintains in memory.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Lifecycle states
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of ONE owner-input line (steering-design-sol.md §2):
 * "Одна пользовательская строка имеет состояния
 * `saving → saved/queued → admitted → answered`, либо `withdrawn`,
 * `unanswered`, `failed`. Это проекция committed-состояний, а не
 * последовательность догадок клиента."
 */
export type DeliveryState =
	/** Optimistic local row drawn by the client before any committed fact. */
	| 'saving'
	/** `acceptOwnerInput` committed: submission + receipt + delivery metadata exist. */
	| 'saved'
	/** Committed but parked (e.g. an explicit `followUp`); admission has not run yet. */
	| 'queued'
	/** The placed entry committed: the input entered the model context (exactly once). */
	| 'admitted'
	/** Terminal: the parent answered the input. */
	| 'answered'
	/** Terminal: the input was withdrawn while still pending; text stays in the receipt. */
	| 'withdrawn'
	/** Terminal: the run ended without answering an input that was accepted. */
	| 'unanswered'
	/** Terminal: saving failed; no accepted state exists and the text stays in the editor. */
	| 'failed';

/** Terminal states: a row in one of these has left the active index. */
export type DeliveryTerminalState = 'answered' | 'withdrawn' | 'unanswered' | 'failed';

/** Non-terminal states. */
export type DeliveryPendingState = 'saving' | 'saved' | 'queued' | 'admitted';

/** Busy policy the client attached to the input (`steer` is the interactive default). */
export type DeliveryWhenBusy = 'steer' | 'followUp';

// ---------------------------------------------------------------------------
// Registration metadata (the optimistic row)
// ---------------------------------------------------------------------------

/** Where the input is delivered. */
export interface DeliveryRouteTarget {
	/** Conversation the input is delivered to (the parent, or an explicitly chosen child). */
	readonly conversationId: string;
	/**
	 * Route kind. `parent` rows steer the parent loop; `child` rows wait at the
	 * child's native boundary (child-steering, steering-design-sol.md §4).
	 */
	readonly kind: 'parent' | 'child';
}

/**
 * What the client knows when it draws the optimistic row. Metadata never
 * asserts committed facts — linkage ids (submission, receipt, placement)
 * enter only through {@link DeliveryIndex.transition}.
 */
export interface DeliveryInputMeta {
	/**
	 * Owner-side request id. `(conversationId, requestId)` is the durable
	 * deduplication key of `T_accept`; a repeat returns the original result.
	 */
	readonly requestId: string;
	/** Conversation the input was composed in (the owner's client conversation). */
	readonly conversationId: string;
	/** Delivery target fixed before Enter; disconnecting never retargets it. */
	readonly target: DeliveryRouteTarget;
	/** Busy policy attached by the client; `followUp` never releases a foreground wait. */
	readonly whenBusy: DeliveryWhenBusy;
	/** Client wall-clock of the optimistic row; the projection never invents timestamps. */
	readonly registeredMs?: number;
}

// ---------------------------------------------------------------------------
// Transition details (committed facts)
// ---------------------------------------------------------------------------

/**
 * Committed facts of `saved` — the `acceptOwnerInput` commit produced the
 * native input submission and the receipt entry (`mcode.owner-input.received`).
 */
export interface DeliverySavedDetail {
	/** Native input submission id (the durable dedup and abort anchor). */
	readonly submissionId: string;
	/** Entry id of the immutable receipt entry; holds the payload for withdrawal restore. */
	readonly receiptEntryId: string;
	/** Sequence of the commit that produced the state; strictly increasing per row. */
	readonly commitSeq?: number;
	/** Delegation the input released/bound to, when the steer hit a foreground wait. */
	readonly delegationId?: string;
	/** Child conversation of that delegation, when known — target of the copy action. */
	readonly childConversationId?: string;
	/** Wall-clock of the committed event, as reported by the caller. */
	readonly atMs?: number;
}

/**
 * Committed facts of `queued` — the input is durably parked and waits for its
 * admission moment (explicit `followUp`, or native one-at-a-time order).
 */
export interface DeliveryQueuedDetail {
	/** Named remaining blocker for the status line (e.g. a sibling tool still running). */
	readonly blocker?: string;
	/** Sequence of the commit that produced the state; strictly increasing per row. */
	readonly commitSeq?: number;
	/** Delegation the row is bound to, when known — target of the delegation actions. */
	readonly delegationId?: string;
	/** Child conversation of that delegation, when known — target of the copy action. */
	readonly childConversationId?: string;
	/** Wall-clock of the committed event, as reported by the caller. */
	readonly atMs?: number;
}

/**
 * Committed facts of `admitted` — native admission placed the input into the
 * model context exactly once. `admitted` does NOT promise that the model has
 * answered; it only asserts the placed entry exists.
 */
export interface DeliveryAdmittedDetail {
	/**
	 * The linkage id carried by the placed entry (`mcode.owner-input.placed`
	 * payload). Receipt and placement join on it into ONE row.
	 */
	readonly inputEntryId: string;
	/** Entry id of the durable placed entry itself, when the caller has it. */
	readonly placedEntryId?: string;
	/** Sequence of the commit that produced the state; strictly increasing per row. */
	readonly commitSeq?: number;
	/** Wall-clock of the committed event, as reported by the caller. */
	readonly atMs?: number;
}

/** Committed facts of a terminal transition (`answered`/`withdrawn`/`unanswered`/`failed`). */
export interface DeliveryTerminalDetail {
	/** Terminal cause as reported by the committed control path (e.g. `owner-stop`). */
	readonly reason?: string;
	/** Sequence of the commit that produced the state; strictly increasing per row. */
	readonly commitSeq?: number;
	/** Wall-clock of the committed event, as reported by the caller. */
	readonly atMs?: number;
}

/** Every transition detail variant, keyed by the transition target state. */
export type DeliveryTransitionDetail =
	| DeliverySavedDetail
	| DeliveryQueuedDetail
	| DeliveryAdmittedDetail
	| DeliveryTerminalDetail;

// ---------------------------------------------------------------------------
// Quick actions as data
// ---------------------------------------------------------------------------

/**
 * Quick actions of the steering contract (steering-design-sol.md §2):
 * «В фон», «Остановить делегата», «Остановить дерево», «Отозвать»,
 * «Копия ребёнку», and the log navigation `task_query`/`task_output`.
 * `stop-tree` is DECLARED here so the action vocabulary of the contract is
 * complete, but the per-input derivation (`deriveDeliveryActions`) does not
 * emit it: a subtree stop targets the delegation tree, not one input line —
 * the emission belongs to the delegation supervisor's stop-cascade surface.
 */
export type DeliveryActionId =
	/** Release the foreground wait (T_release); the child keeps working. */
	| 'background'
	/** Stop the bound child delegation. */
	| 'stop-delegate'
	/** Stop the whole delegation subtree (emitted by the delegation supervisor). */
	| 'stop-tree'
	/** Abort the still-pending native submission (never offered after admission). */
	| 'withdraw'
	/** Create a separate linked child submission; allowed even after admission. */
	| 'copy-to-child'
	/** Open the delegation state log (`task_query`). */
	| 'task-query'
	/** Open the delegation output log (`task_output`). */
	| 'task-output';

/** Whom an action addresses — every action has an explicit target. */
export type DeliveryActionTarget =
	| { readonly kind: 'delegation'; readonly delegationId: string }
	| { readonly kind: 'conversation'; readonly conversationId: string }
	| { readonly kind: 'input'; readonly inputId: string };

/** One quick action as data: id, localized product label, explicit target. No callbacks. */
export interface DeliveryAction {
	readonly id: DeliveryActionId;
	/** Localized product label of the steering contract; preserved verbatim. */
	readonly label: string;
	readonly target: DeliveryActionTarget;
}

// ---------------------------------------------------------------------------
// Projection (the rendered row)
// ---------------------------------------------------------------------------

/** One committed transition of a row, as kept in {@link Projection.history}. */
export interface DeliveryTransitionRecord {
	/** State the row entered. */
	readonly state: DeliveryState;
	/** Caller-reported wall-clock, or `null` when the caller sent none. */
	readonly atMs: number | null;
	/** Commit sequence of the fact, or `null` when the caller sent none. */
	readonly commitSeq: number | null;
}

/** Receipt facts (`mcode.owner-input.received`) merged into the row. */
export interface DeliveryReceiptFacts {
	/** Entry id of the immutable receipt entry. */
	readonly entryId: string;
	/** Native submission id. */
	readonly submissionId: string;
}

/** Placement facts (`mcode.owner-input.placed`) merged into the row. */
export interface DeliveryPlacementFacts {
	/** Linkage id carried by the placed entry; joins receipt and placement. */
	readonly inputEntryId: string;
	/** Entry id of the durable placed entry, when the caller supplied it. */
	readonly entryId: string | null;
}

/**
 * The rendered row: ONE projection per owner-input line. The receipt and the
 * placed entry are phases of the same command, never two replies; technical
 * control entries are absorbed into the row as linkage/delegation facts and
 * never surface as rows of their own.
 */
export interface Projection {
	/** Row key: the stable identity of the user line. */
	readonly inputId: string;
	readonly state: DeliveryState;
	/** True only while the row still awaits its first committed fact (`saving`). */
	readonly committed: boolean;
	/** True when `state` is terminal; such rows have left the active index. */
	readonly terminal: boolean;
	/** False once terminal cleanup moved the row out of the active index. */
	readonly active: boolean;
	readonly requestId: string;
	readonly conversationId: string;
	readonly target: DeliveryRouteTarget;
	readonly whenBusy: DeliveryWhenBusy;
	/** The join key (`inputEntryId`); `null` until the placed entry commits. */
	readonly inputEntryId: string | null;
	/** Receipt facts, or `null` before `saved`. */
	readonly receipt: DeliveryReceiptFacts | null;
	/** Placement facts, or `null` before `admitted`. */
	readonly placement: DeliveryPlacementFacts | null;
	/** True when receipt and placement are present and joined by the same `inputEntryId`. */
	readonly linked: boolean;
	/** Named remaining blocker of a queued row; `null` otherwise. */
	readonly blocker: string | null;
	/** Delegation the row is bound to; target of the delegation actions. */
	readonly delegationId: string | null;
	/** Child conversation of the bound delegation; target of the copy action. */
	readonly childConversationId: string | null;
	/** Quick actions available NOW, as data with explicit targets. */
	readonly actions: readonly DeliveryAction[];
	/** Committed transitions in order, starting with the optimistic `saving` row. */
	readonly history: readonly DeliveryTransitionRecord[];
}

// ---------------------------------------------------------------------------
// Index API
// ---------------------------------------------------------------------------

/** Options of {@link createDeliveryIndex}. */
export interface DeliveryIndexOptions {
	/**
	 * How many terminal tombstones stay addressable through {@link DeliveryIndex.get}
	 * after cleanup (LRU, oldest evicted). Default 64. The cap bounds the index;
	 * durable deduplication never depended on it — it lives in the native
	 * submissions keyed by `(conversationId, requestId)`.
	 */
	readonly maxTerminalRetained?: number;
}

/**
 * The delivery index: registers optimistic rows, folds committed transitions
 * and hands out projections. Row states move forward only (fail-closed state
 * machine); terminal rows leave the bounded active index immediately.
 */
export interface DeliveryIndex {
	/**
	 * Creates the optimistic `saving` row. Duplicate ids (active or terminal)
	 * throw — a redelivered input is a replay of the original row, and the
	 * durable dedup of `(conversationId, requestId)` stays in the submissions.
	 */
	register(inputId: string, meta: DeliveryInputMeta): void;

	/** Folds the committed `saved` fact (submission + receipt exist). */
	transition(inputId: string, state: 'saved', detail: DeliverySavedDetail): void;
	/** Folds the committed `queued` fact (durably parked, admission pending). */
	transition(inputId: string, state: 'queued', detail?: DeliveryQueuedDetail): void;
	/** Folds the committed `admitted` fact (placed entry, exactly once per input). */
	transition(inputId: string, state: 'admitted', detail: DeliveryAdmittedDetail): void;
	/** Folds the terminal `answered` fact. */
	transition(inputId: string, state: 'answered', detail?: DeliveryTerminalDetail): void;
	/** Folds the terminal `withdrawn` fact (pending inputs only; see the state machine). */
	transition(inputId: string, state: 'withdrawn', detail?: DeliveryTerminalDetail): void;
	/** Folds the terminal `unanswered` fact. */
	transition(inputId: string, state: 'unanswered', detail?: DeliveryTerminalDetail): void;
	/** Folds the terminal `failed` fact (saving failed; the text stays in the editor). */
	transition(inputId: string, state: 'failed', detail?: DeliveryTerminalDetail): void;

	/**
	 * Projection of one row. Active rows come from the index; recent terminal
	 * rows come from the bounded tombstone store (`active: false`); unknown or
	 * evicted ids throw {@link DeliveryIndexError} with code `'unknown-input'`.
	 */
	get(inputId: string): Projection;

	/** Whether the id is in the ACTIVE index (optimistic and committed rows alike). */
	has(inputId: string): boolean;

	/**
	 * Active rows in registration order — exactly one row per input line.
	 * Receipt, placed and control entries never appear as rows of their own.
	 */
	active(): readonly Projection[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable cause of a {@link DeliveryIndexError}. */
export type DeliveryIndexErrorCode =
	/** No active row and no retained tombstone under the id. */
	| 'unknown-input'
	/** The id is already registered (active or retained terminal row). */
	| 'duplicate-input'
	/** The transition contradicts the state machine (e.g. withdraw after admit). */
	| 'invalid-transition'
	/** A committed fact carries a linkage id that differs from the stored one. */
	| 'linkage-conflict'
	/** The fact carries a `commitSeq` not strictly newer than the stored one. */
	| 'stale-commit';

/** Error raised when a caller violates the projection contract. */
export class DeliveryIndexError extends Error {
	/** Machine-readable cause. */
	readonly code: DeliveryIndexErrorCode;

	constructor(code: DeliveryIndexErrorCode, message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = 'DeliveryIndexError';
		this.code = code;
	}
}
