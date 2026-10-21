/**
 * Public types of the durable seam: transaction-scoped composition
 * (T_accept / T_release / T_complete) over the wave-1 durable storage
 * contract (`packages/durable-backend-sqlite-zstd`, the `sessions.gN.db`
 * append-only entry log with atomic batch commits and owner-epoch fencing).
 *
 * The seam is the "Обязательный seam Ф1" of the steering design: it composes
 * the native storage operations into ONE commit where the design demands one
 * commit, and it never implements its own inbox, never writes SQL directly,
 * and never replaces the agent loop. All app records below are stored through
 * the storage contract as plain entries; the entry log remains the single
 * source of truth.
 *
 * @module
 */

/** JSON value accepted anywhere in the seam (entries, outcomes, handles). */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/**
 * What the caller wants to happen when the conversation is busy. `steer` is
 * the interactive default of the steering design; `followUp` keeps the
 * native follow-up semantics. The value is stored verbatim in the submission
 * and the receipt; the seam itself does not interpret it.
 */
export type WhenBusy = 'steer' | 'followUp';

/**
 * Entry kinds this seam writes. Everything lives under the `mcode.` app
 * namespace; the receipt kind is the canonical `mcode.owner-input.received`
 * of the steering design (§3, canonical records).
 */
export const SEAM_ENTRY_KINDS = {
	/** Native input submission record (dedup + replay anchor). */
	submission: 'mcode.owner-input.submission',
	/** Immutable owner-input receipt. No `model`, no `head`, no `edits`. */
	receipt: 'mcode.owner-input.received',
	/** Foreground wait anchor created for a delegation tool-round. */
	waitOpened: 'mcode.delegation.wait-opened',
	/** T_release decision: control entry carrying the prepared outcome. */
	backgrounded: 'mcode.delegation.backgrounded',
	/** T_complete: the single tool-result of one `toolCallId`. */
	toolResult: 'mcode.delegation.tool-result',
	/** Delivery-index terminal removal (bounded active index hygiene). */
	deliverySettled: 'mcode.input-delivery.settled',
	/** Bounded active-state snapshot carried inside every seam commit. */
	snapshot: 'mcode.seam.snapshot',
} as const;

// ---------------------------------------------------------------------------
// T_accept — acceptOwnerInput
// ---------------------------------------------------------------------------

/** Input of {@link DurableSeam.acceptOwnerInput}. */
export type OwnerInputDraft = {
	/** Target conversation the input is addressed to. */
	readonly conversationId: string;
	/**
	 * Caller-fixed dedup identity. The dedup key is
	 * `(conversationId, requestId)`; a repeat with the same payload returns
	 * the original IDs, a different payload under the same key raises
	 * `REQUEST_ID_CONFLICT`.
	 */
	readonly requestId: string;
	/** Owner content. Hashed canonically; stored in the receipt. */
	readonly content: JsonValue;
	/** Routing wish recorded on the submission and the receipt. */
	readonly whenBusy: WhenBusy;
	/** Optional actor identity (recorded, not interpreted). */
	readonly actor?: string;
	/** Optional source conversation of the input. */
	readonly sourceConversationId?: string;
	/** Optional route label (recorded, not interpreted). */
	readonly route?: string;
};

/** Result of {@link DurableSeam.acceptOwnerInput}. */
export type AcceptOwnerInputResult = {
	/** Stable submission identity (deterministic from the dedup key). */
	readonly submissionId: string;
	/** Entry id of the receipt (`mcode.owner-input.received`). */
	readonly inputEntryId: string;
	/**
	 * Sequence of the ONE commit that atomically holds submission + receipt +
	 * delivery-index update. On a replay this is the ORIGINAL commit's
	 * sequence — a dedup hit never writes a second commit.
	 */
	readonly commitSeq: number;
	/** `committed` on the first accept, `replayed` on a dedup hit. */
	readonly status: 'committed' | 'replayed';
	/** The accepted routing wish (echoed for the caller's projection). */
	readonly whenBusy: WhenBusy;
};

// ---------------------------------------------------------------------------
// Foreground waits — anchors for T_release / T_complete
// ---------------------------------------------------------------------------

/** State machine of one foreground wait (steering design §3):
 *
 * ```
 * wait:  foreground --T_release--> backgrounded   (irreversible for this waitId)
 *             \----T_complete----> completed
 * ```
 */
export type WaitState = 'foreground' | 'backgrounded' | 'completed';

/** Input of {@link DurableSeam.openForegroundWait}. */
export type ForegroundWaitDraft = {
	/**
	 * Stable wait identity chosen by the caller (the design keys foreground
	 * waits on `(parentConversationId, parentRunId, toolCallId)`; the seam
	 * treats it as an opaque non-empty string).
	 */
	readonly waitId: string;
	/** The `task` tool-call this wait blocks on; finalized exactly once. */
	readonly toolCallId: string;
	/** Parent conversation owning the wait. */
	readonly conversationId: string;
	/** Optional delegation identity (recorded on the control entries). */
	readonly delegationId?: string;
	/** Optional child conversation under supervision. */
	readonly childConversationId?: string;
	/** Optional child run id (part of the completion identity). */
	readonly childRunId?: string;
	/**
	 * Supervision flag recorded verbatim: a stop of the parent must cascade to
	 * the child when true. The seam stores it; enforcement lives in the
	 * supervision layer.
	 */
	readonly cancelOnParentAbort?: boolean;
};

/** Durable view of one foreground wait. */
export type SeamWaitView = {
	readonly waitId: string;
	readonly toolCallId: string;
	readonly conversationId: string;
	readonly delegationId: string | null;
	readonly childConversationId: string | null;
	readonly childRunId: string | null;
	readonly cancelOnParentAbort: boolean;
	readonly state: WaitState;
	/**
	 * Optimistic-concurrency version of the wait. Starts at 1 on open and
	 * advances by exactly 1 per durable transition. Every transition takes the
	 * caller's `expectedVersion` as a CAS.
	 */
	readonly stateVersion: number;
	/** Commit that opened the wait. */
	readonly openedCommitSeq: number;
	/** The prepared background outcome when state is `backgrounded`. */
	readonly preparedOutcome: BackgroundOutcome | null;
};

// ---------------------------------------------------------------------------
// T_release — prepareRelease
// ---------------------------------------------------------------------------

/** Input of {@link DurableSeam.prepareRelease}. */
export type PrepareReleaseInput = {
	/** The foreground wait to release. */
	readonly waitId: string;
	/**
	 * CAS expectation: the caller's view of `stateVersion`. The release is
	 * prepared only when it still matches the durable version.
	 */
	readonly expectedVersion: number;
	/** Why the wait moved to background (default `owner_input`). */
	readonly reason?: string;
	/** Who decided (default `owner-input`). */
	readonly initiator?: string;
	/**
	 * Background handle the supervisor will anchor the child to (recorded
	 * verbatim inside the prepared outcome).
	 */
	readonly backgroundHandle?: JsonValue;
};

/**
 * The prepared background outcome of T_release: durably committed BEFORE the
 * waiter returns, replayable after a crash between the prepare and the
 * finalization commits.
 */
export type BackgroundOutcome = {
	readonly kind: 'background';
	readonly waitId: string;
	readonly toolCallId: string;
	readonly conversationId: string;
	readonly delegationId: string | null;
	readonly childConversationId: string | null;
	readonly childRunId: string | null;
	readonly reason: string;
	readonly initiator: string;
	readonly backgroundHandle: JsonValue;
	readonly cancelOnParentAbort: boolean;
	readonly preparedAtMs: number;
};

/** Result of {@link DurableSeam.prepareRelease}. */
export type PreparedRelease = {
	readonly waitId: string;
	readonly toolCallId: string;
	/** The wait's version AFTER this transition. */
	readonly stateVersion: number;
	/** Commit holding the prepared outcome (the ORIGINAL one on a replay). */
	readonly commitSeq: number;
	/** Entry id of the committed prepared outcome. */
	readonly preparedEntryId: string;
	/** The prepared background outcome to hand to {@link DurableSeam.finalizeTool}. */
	readonly outcome: BackgroundOutcome;
	/** `committed` on the first prepare, `replayed` on a crash-retry. */
	readonly status: 'committed' | 'replayed';
};

// ---------------------------------------------------------------------------
// T_complete — finalizeTool
// ---------------------------------------------------------------------------

/** Input of {@link DurableSeam.finalizeTool}. */
export type FinalizeToolInput = {
	/** The tool call being finalized; gets exactly one tool-result, ever. */
	readonly toolCallId: string;
	/** The outcome to record. Reproducing a prepared outcome must match it. */
	readonly outcome: JsonValue;
};

/** Result of {@link DurableSeam.finalizeTool}. */
export type FinalizeToolResult = {
	readonly toolCallId: string;
	/** Entry id of the single tool-result. */
	readonly toolResultEntryId: string;
	/** Commit holding the tool-result (the ORIGINAL one on a replay). */
	readonly commitSeq: number;
	/** `committed` on the first finalize, `replayed` on a crash-retry. */
	readonly status: 'committed' | 'replayed';
	/** The affected wait, when the tool call belongs to one. */
	readonly wait: { readonly waitId: string; readonly state: WaitState; readonly stateVersion: number } | null;
};

// ---------------------------------------------------------------------------
// Wait open + delivery index
// ---------------------------------------------------------------------------

/** Result of {@link DurableSeam.openForegroundWait}. */
export type OpenWaitResult = {
	readonly waitId: string;
	readonly state: WaitState;
	readonly stateVersion: number;
	/** Commit that opened the wait (the ORIGINAL one on a replay). */
	readonly commitSeq: number;
	/** `committed` on the first open, `replayed` when the wait already exists. */
	readonly status: 'committed' | 'replayed';
};

/** Input of {@link DurableSeam.settleDelivery}. */
export type SettleDeliveryInput = {
	readonly conversationId: string;
	readonly requestId: string;
};

/** Result of {@link DurableSeam.settleDelivery}. */
export type SettleDeliveryResult = {
	readonly inputEntryId: string;
	/** Commit of the terminal index update (the receipt's on a replay). */
	readonly commitSeq: number;
	/** `committed` on the first settle, `replayed` when already terminal. */
	readonly status: 'committed' | 'replayed';
};

/** Active entry of the bounded input-delivery index. */
export type DeliveryView = {
	readonly conversationId: string;
	readonly requestId: string;
	readonly submissionId: string;
	readonly inputEntryId: string;
};

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/** Options of {@link DurableSeam.recover}. */
export type RecoveryOptions = {
	/**
	 * Uncompressed byte budget of ONE replay window (forward delta scan from
	 * the seed snapshot). Default 8 MiB; the scan loops until the log ends.
	 */
	readonly replayWindowBytes?: number;
};

/** Verdict-carrying report of {@link DurableSeam.recover}. */
export type RecoveryReport = {
	/** Revision of the seed snapshot (0 when the log had none). */
	readonly snapshotRevision: number;
	/** Commit of the seed snapshot entry (null when the log had none). */
	readonly snapshotCommitSeq: number | null;
	/** Where the forward replay started (the seed snapshot's commit, or 0). */
	readonly replayFromCommitSeq: number;
	/** Entries replayed on top of the seed snapshot. */
	readonly replayedEntries: number;
	/** Waits in the recovered active registry. */
	readonly recoveredWaits: number;
	/** Active deliveries in the recovered index. */
	readonly recoveredDeliveries: number;
	/** Set when the replay stopped on a corrupt batch (prefix was applied). */
	readonly tornTail: { readonly batchId: number; readonly reason: string } | null;
}

// ---------------------------------------------------------------------------
// Open options
// ---------------------------------------------------------------------------

/**
 * Default admission budget for one owner input, in canonical JSON bytes.
 * Aligned with the steering design's payload bound (§6: `payload ≤ 32 MiB`);
 * the EFFECTIVE budget is `min(this, the storage batch budget minus seam
 * overhead)` — see {@link DurableSeamOptions.maxInputBytes}.
 */
export const DEFAULT_MAX_INPUT_BYTES = 32 * 1024 * 1024;

/** Options for opening a seam ({@link DurableSeam.open}). */
export type DurableSeamOptions = RecoveryOptions & {
	/**
	 * Admission budget for one owner input, in canonical JSON bytes. The
	 * effective budget is `min(maxInputBytes, portBatchBudget − overhead)`
	 * when the port reports one, so an oversized input is refused with an
	 * explicit `INPUT_TOO_LARGE` BEFORE any durable attempt (the "big paste"
	 * backpressure edge case) instead of failing opaquely on the batch cap.
	 * Default {@link DEFAULT_MAX_INPUT_BYTES}.
	 */
	readonly maxInputBytes?: number;
};
