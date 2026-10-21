/**
 * The durable seam itself: transaction-scoped composition (T_accept /
 * T_release / T_complete) over the storage port.
 *
 * Composition rules (steering design §3, "Обязательный seam Ф1"):
 *
 * - `acceptOwnerInput` (T_accept) writes submission + receipt
 *   (`mcode.owner-input.received`) + delivery-index update in ONE
 *   `appendBatch` — one commit, one `commitSeq`. A pair of independent
 *   writes is never presented as T_accept. Dedup key is
 *   `(conversationId, requestId)` resolved through deterministic entry ids
 *   and the entry index: a repeat returns the original IDs and the original
 *   commit; a different payload raises `REQUEST_ID_CONFLICT`.
 * - `prepareRelease` (T_release) checks the wait's `stateVersion` CAS and
 *   commits the replayable prepared background outcome in one commit; the
 *   caller's waiter returns only after that commit resolved.
 * - `finalizeTool` (T_complete) commits the ONE tool-result of a
 *   `toolCallId`. Reproducing a prepared outcome after a crash between the
 *   two release phases works because the prepared outcome is durable and
 *   the finalize replays idempotently (same outcome → same entry, no second
 *   row; different outcome → `TOOL_RESULT_CONFLICT`).
 *
 * Every write also ships the bounded active-state snapshot in the same
 * batch, so a restarted seam recovers from one snapshot point read plus a
 * short forward delta — never a full-history scan.
 *
 * The seam is single-actor per generation (the storage contract's
 * single-writer epoch); public mutators are additionally serialized through
 * an in-process mutex so check-then-commit sequences cannot interleave.
 *
 * @module
 */

import { canonicalJson, hashJson } from './canonical.js';
import {
	InputTooLargeError,
	InvalidInputError,
	RequestIdConflictError,
	SeamError,
	SeamStorageError,
	ToolResultConflictError,
	UnknownWaitError,
	VersionConflictError,
	WaitIdConflictError,
	WaitTerminalError,
} from './errors.js';
import {
	receiptEntryId,
	settledEntryId,
	snapshotEntryId,
	submissionEntryId,
	toolResultEntryId,
	waitOpenedEntryId,
	waitPreparedEntryId,
} from './ids.js';
import type { DurableLogPort, PortEntry, PortEntryDraft } from './port.js';
import {
	encodeSnapshotPayload,
	parseBackgroundOutcome,
	parseSnapshotPayload,
	probeLatestSnapshot,
	type SnapshotDeliveryRecord,
	type SnapshotWaitRecord,
} from './snapshot.js';
import {
	DEFAULT_MAX_INPUT_BYTES,
	SEAM_ENTRY_KINDS,
	type AcceptOwnerInputResult,
	type BackgroundOutcome,
	type DeliveryView,
	type DurableSeamOptions,
	type FinalizeToolInput,
	type FinalizeToolResult,
	type ForegroundWaitDraft,
	type JsonValue,
	type OpenWaitResult,
	type OwnerInputDraft,
	type PrepareReleaseInput,
	type PreparedRelease,
	type RecoveryOptions,
	type RecoveryReport,
	type SeamWaitView,
	type SettleDeliveryInput,
	type SettleDeliveryResult,
	type WaitState,
	type WhenBusy,
} from './types.js';

const WHEN_BUSY_VALUES: readonly WhenBusy[] = ['steer', 'followUp'];

const DEFAULT_RECOVERY_WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * Byte reserve subtracted from the port's batch budget before deriving the
 * owner-input admission limit: covers the submission record, the receipt
 * envelope, and the active-state snapshot that share the accept commit.
 */
const SEAM_COMMIT_OVERHEAD_BYTES = 8 * 1024;

/** In-memory image of one wait; the entry log stays the only truth. */
type WaitRecord = {
	waitId: string;
	toolCallId: string;
	conversationId: string;
	delegationId: string | null;
	childConversationId: string | null;
	childRunId: string | null;
	cancelOnParentAbort: boolean;
	state: WaitState;
	stateVersion: number;
	openedCommitSeq: number;
	prepared: { readonly outcome: BackgroundOutcome; readonly outcomeHash: string } | null;
};

/** In-memory image of one active delivery-index entry. */
type DeliveryRecord = {
	conversationId: string;
	requestId: string;
	submissionId: string;
	inputEntryId: string;
};

/** Durable payload of the T_accept submission entry. */
type SubmissionPayload = {
	conversationId: string;
	requestId: string;
	submissionId: string;
	contentHash: string;
	/** Hash of the FULL call payload (content + whenBusy + actor + route). */
	payloadHash: string;
	whenBusy: WhenBusy;
	createdAtMs: number;
};

/** Durable payload of the T_accept receipt entry (no model/head/edits). */
type ReceiptPayload = {
	inputId: string;
	requestId: string;
	submissionId: string;
	targetConversationId: string;
	sourceConversationId: string | null;
	actor: string | null;
	route: string | null;
	whenBusy: WhenBusy;
	contentHash: string;
	/** Hash of the FULL call payload; the dedup/conflict comparison key. */
	payloadHash: string;
	content: JsonValue;
	receivedAtMs: number;
};

/** Durable payload of the wait-opened entry. */
type WaitOpenedPayload = Omit<WaitRecord, 'prepared'>;

/** Durable payload of the T_release prepared-outcome entry. */
type PreparedPayload = {
	waitId: string;
	toolCallId: string;
	stateVersion: number;
	outcome: BackgroundOutcome;
	outcomeHash: string;
};

/** Durable payload of the T_complete tool-result entry. */
type ToolResultPayload = {
	toolCallId: string;
	waitId: string | null;
	outcome: JsonValue;
	outcomeHash: string;
	waitTransition: 'completed' | null;
	waitStateVersionAfter: number | null;
	finalizedAtMs: number;
};

/** Durable payload of a delivery-index terminal update. */
type SettledPayload = {
	conversationId: string;
	requestId: string;
	inputEntryId: string;
};

/**
 * The durable seam over a {@link DurableLogPort}. Construct with
 * {@link DurableSeam.open}, which recovers the active registry before the
 * first transition.
 */
export class DurableSeam {
	private port: DurableLogPort;
	private waits: Map<string, WaitRecord>;
	private deliveries: Map<string, DeliveryRecord>;
	private snapshotRevision: number;
	/** Waits keyed by their tool call for `finalizeTool` linkage. */
	private waitsByToolCallId: Map<string, WaitRecord>;
	/** In-process mutex tail: mutators run strictly one at a time. */
	private tail: Promise<unknown>;
	/** Configured admission ceiling for one owner input (canonical bytes). */
	private maxInputBytes: number;

	private constructor(port: DurableLogPort, options: DurableSeamOptions = {}) {
		this.port = port;
		this.waits = new Map();
		this.deliveries = new Map();
		this.waitsByToolCallId = new Map();
		this.snapshotRevision = 0;
		this.tail = Promise.resolve();
		this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
	}

	/**
	 * Open a seam over `port` and recover the active registry: seed from the
	 * latest committed snapshot (O(log revisions) point reads), then replay
	 * the delta after it. A fresh log recovers trivially.
	 */
	static async open(port: DurableLogPort, options: DurableSeamOptions = {}): Promise<DurableSeam> {
		const seam = new DurableSeam(port, options);
		await seam.recover(options);
		return seam;
	}

	/**
	 * Rebuild the active registry from the log: probe the snapshot chain,
	 * seed, replay forward, and swap the registry in. Re-runnable; also the
	 * crash-recovery entry point a restarted process calls.
	 */
	async recover(options: RecoveryOptions = {}): Promise<RecoveryReport> {
		return this.runExclusive(async () => {
			const windowBytes = options.replayWindowBytes ?? DEFAULT_RECOVERY_WINDOW_BYTES;
			const waits = new Map<string, WaitRecord>();
			const deliveries = new Map<string, DeliveryRecord>();
			const byTool = new Map<string, WaitRecord>();

			let snapshotRevision = 0;
			let snapshotCommitSeq: number | null = null;
			let cursor = 0;

			const found = probeLatestSnapshot((id) => this.port.getEntry(id));
			if (found !== undefined) {
				const snapshot = parseSnapshotPayload(found.entry.payload, found.entry.id);
				snapshotRevision = snapshot.revision;
				snapshotCommitSeq = found.entry.seq;
				cursor = found.entry.seq;
				for (const record of snapshot.waits) {
					const wait: WaitRecord = {
						...record,
						prepared: record.prepared === null ? null : { ...record.prepared },
					};
					if (wait.openedCommitSeq === 0) {
						// The snapshot of the opening commit shipped before the entry's
						// own position existed; resolve it through the deterministic id.
						const opened = this.port.getEntry(waitOpenedEntryId(wait.waitId));
						if (opened !== undefined) wait.openedCommitSeq = opened.seq;
					}
					waits.set(wait.waitId, wait);
					byTool.set(wait.toolCallId, wait);
				}
				for (const record of snapshot.deliveries) {
					deliveries.set(deliveryKey(record.conversationId, record.requestId), { ...record });
				}
			}

			let replayedEntries = 0;
			let tornTail: RecoveryReport['tornTail'] = null;
			const head = this.port.head();
			while (cursor < head && tornTail === null) {
				const delta = this.port.readDeltaChecked(cursor, windowBytes);
				for (const entry of delta.entries) {
					applyReplayEntry(entry, waits, byTool, deliveries);
				}
				replayedEntries += delta.entries.length;
				if (delta.tornTail !== null) tornTail = delta.tornTail;
				if (delta.nextAfterSeq === null) break;
				cursor = delta.nextAfterSeq;
			}

			this.waits = waits;
			this.deliveries = deliveries;
			this.waitsByToolCallId = byTool;
			this.snapshotRevision = snapshotRevision;
			return {
				snapshotRevision,
				snapshotCommitSeq,
				replayFromCommitSeq: snapshotCommitSeq ?? 0,
				replayedEntries,
				recoveredWaits: waits.size,
				recoveredDeliveries: deliveries.size,
				tornTail,
			};
		});
	}

	// -------------------------------------------------------------------------
	// T_accept — acceptOwnerInput
	// -------------------------------------------------------------------------

	/**
	 * Atomically accept owner input: ONE commit holds the submission record,
	 * the `mcode.owner-input.received` receipt, and the delivery-index update.
	 *
	 * Dedup by `(conversationId, requestId)` against the entry index — a
	 * point read, so it stays correct across restarts without any in-memory
	 * state. Same payload → the ORIGINAL `{submissionId, inputEntryId,
	 * commitSeq}` with `status: 'replayed'`; different payload →
	 * `REQUEST_ID_CONFLICT`.
	 */
	async acceptOwnerInput(draft: OwnerInputDraft): Promise<AcceptOwnerInputResult> {
		assertNonEmpty(draft?.conversationId, 'conversationId');
		assertNonEmpty(draft?.requestId, 'requestId');
		assertWhenBusy(draft?.whenBusy);
		// Canonicalize eagerly so a cyclic/foreign payload fails BEFORE any
		// durable attempt, and measure it for the explicit admission budget
		// (backpressure instead of an opaque batch-cap failure at commit time).
		const contentHash = this.hashPayload(draft.content, 'content');
		this.assertInputBudget(canonicalByteLength(draft.content, 'content'));
		// The dedup identity is the FULL call payload: a repeat that changes
		// whenBusy/actor/route under an accepted key is a conflict, not a
		// replay, even when the content text is identical.
		const payloadHash = this.hashPayload(
			{
				content: draft.content,
				whenBusy: draft.whenBusy,
				actor: draft.actor ?? null,
				sourceConversationId: draft.sourceConversationId ?? null,
				route: draft.route ?? null,
			},
			'owner input',
		);

		return this.runExclusive(async () => {
			const existing = this.readAccepted(draft.conversationId, draft.requestId, payloadHash);
			if (existing !== null) return existing;

			const submissionId = submissionEntryId(draft.conversationId, draft.requestId);
			const inputEntryId = receiptEntryId(draft.conversationId, draft.requestId);
			const now = Date.now();
			const submission: SubmissionPayload = {
				conversationId: draft.conversationId,
				requestId: draft.requestId,
				submissionId,
				contentHash,
				payloadHash,
				whenBusy: draft.whenBusy,
				createdAtMs: now,
			};
			const receipt: ReceiptPayload = {
				inputId: inputEntryId,
				requestId: draft.requestId,
				submissionId,
				targetConversationId: draft.conversationId,
				sourceConversationId: draft.sourceConversationId ?? null,
				actor: draft.actor ?? null,
				route: draft.route ?? null,
				whenBusy: draft.whenBusy,
				contentHash,
				payloadHash,
				content: draft.content,
				receivedAtMs: now,
			};
			const delivery: DeliveryRecord = {
				conversationId: draft.conversationId,
				requestId: draft.requestId,
				submissionId,
				inputEntryId,
			};

			const commitSeq = await this.commitTransition(
				[
					{ id: submissionId, kind: SEAM_ENTRY_KINDS.submission, payload: submission },
					{ id: inputEntryId, kind: SEAM_ENTRY_KINDS.receipt, payload: receipt },
				],
				(_waits, _byTool, deliveries) => {
					deliveries.set(deliveryKey(delivery.conversationId, delivery.requestId), delivery);
				},
			);
			return { submissionId, inputEntryId, commitSeq, status: 'committed', whenBusy: draft.whenBusy };
		});
	}

	/**
	 * Mark a delivery terminal in the bounded active index (the hook the
	 * admission placement calls). Idempotent; unknown inputs are refused with
	 * `UNKNOWN_INPUT` — the index never fabricates history.
	 */
	async settleDelivery(input: SettleDeliveryInput): Promise<SettleDeliveryResult> {
		assertNonEmpty(input?.conversationId, 'conversationId');
		assertNonEmpty(input?.requestId, 'requestId');
		return this.runExclusive(async () => {
			const key = deliveryKey(input.conversationId, input.requestId);
			const inputEntryId = receiptEntryId(input.conversationId, input.requestId);
			const stored = this.port.getEntry(inputEntryId);
			if (stored === undefined) {
				throw new SeamError('UNKNOWN_INPUT', `no accepted input for ${JSON.stringify(input)}`);
			}
			if (!this.deliveries.has(key)) {
				// Already terminal (or the registry predates it): report the
				// terminal commit when it exists, the receipt's otherwise.
				const settledSeq =
					this.port.getEntry(settledEntryId(input.conversationId, input.requestId))?.seq ?? stored.seq;
				return { inputEntryId, commitSeq: settledSeq, status: 'replayed' };
			}
			const payload: SettledPayload = {
				conversationId: input.conversationId,
				requestId: input.requestId,
				inputEntryId,
			};
			const commitSeq = await this.commitTransition(
				[{ id: settledEntryId(input.conversationId, input.requestId), kind: SEAM_ENTRY_KINDS.deliverySettled, payload }],
				(_waits, _byTool, deliveries) => {
					deliveries.delete(key);
				},
			);
			return { inputEntryId, commitSeq, status: 'committed' };
		});
	}

	// -------------------------------------------------------------------------
	// Foreground wait anchors
	// -------------------------------------------------------------------------

	/**
	 * Register the foreground wait of a delegation tool-round. Idempotent: a
	 * repeat (crash retry, duplicate RPC) returns the stored state with
	 * `status: 'replayed'` — it never opens a second wait for the id.
	 */
	async openForegroundWait(draft: ForegroundWaitDraft): Promise<OpenWaitResult> {
		assertNonEmpty(draft?.waitId, 'waitId');
		assertNonEmpty(draft?.toolCallId, 'toolCallId');
		assertNonEmpty(draft?.conversationId, 'conversationId');
		return this.runExclusive(async () => {
			// Registry first; a terminal wait that already left the bounded
			// projection is reconstructed from its deterministic entries, so a
			// duplicate open is judged against the durable identity either way.
			const existing = this.waits.get(draft.waitId) ?? this.readWaitRecordFromEntries(draft.waitId);
			if (existing !== undefined) {
				assertSameWaitIdentity(draft, existing);
				return {
					waitId: existing.waitId,
					state: existing.state,
					stateVersion: existing.stateVersion,
					commitSeq: existing.openedCommitSeq,
					status: 'replayed',
				};
			}
			const record: WaitRecord = {
				waitId: draft.waitId,
				toolCallId: draft.toolCallId,
				conversationId: draft.conversationId,
				delegationId: draft.delegationId ?? null,
				childConversationId: draft.childConversationId ?? null,
				childRunId: draft.childRunId ?? null,
				cancelOnParentAbort: draft.cancelOnParentAbort === true,
				state: 'foreground',
				stateVersion: 1,
				openedCommitSeq: 0,
				prepared: null,
			};
			const payload: WaitOpenedPayload = { ...record };
			const entryId = waitOpenedEntryId(draft.waitId);
			const commitSeq = await this.commitTransition(
				[{ id: entryId, kind: SEAM_ENTRY_KINDS.waitOpened, payload }],
				(waits, byTool) => {
					waits.set(record.waitId, record);
					byTool.set(record.toolCallId, record);
				},
			);
			// The record is shared with the registry the commit swapped in, so
			// assigning the real position here also fixes the projection. The
			// snapshot of THIS commit carried 0 for it; recovery resolves that
			// through the deterministic entry id.
			record.openedCommitSeq = commitSeq;
			return { waitId: record.waitId, state: record.state, stateVersion: record.stateVersion, commitSeq, status: 'committed' };
		});
	}

	/** Durable view of one wait, or `undefined` when unknown. */
	getWait(waitId: string): SeamWaitView | undefined {
		const wait = this.waits.get(waitId);
		return wait === undefined ? undefined : waitView(wait);
	}

	/** The wait blocking a tool call, when the tool call belongs to one. */
	waitByToolCallId(toolCallId: string): SeamWaitView | undefined {
		const wait = this.waitsByToolCallId.get(toolCallId);
		return wait === undefined ? undefined : waitView(wait);
	}

	/** All waits of the recovered registry (active-state projection only). */
	listWaits(): readonly SeamWaitView[] {
		return [...this.waits.values()].map(waitView);
	}

	// -------------------------------------------------------------------------
	// T_release — prepareRelease
	// -------------------------------------------------------------------------

	/**
	 * Prepare the background outcome of a foreground wait (T_release phase
	 * 1). CAS on `expectedVersion`; one commit holds the
	 * `mcode.delegation.backgrounded` control entry plus the replayable
	 * prepared outcome and the updated snapshot. The caller may return its
	 * waiter only after this resolves.
	 *
	 * Crash-retry semantics: repeating the call with the CURRENT version
	 * after the commit returns the stored outcome with `status: 'replayed'`;
	 * a stale version is a `VERSION_CONFLICT`.
	 */
	async prepareRelease(input: PrepareReleaseInput): Promise<PreparedRelease> {
		assertNonEmpty(input?.waitId, 'waitId');
		assertVersion(input?.expectedVersion);
		const preparedEntryId = waitPreparedEntryId(input.waitId);
		return this.runExclusive(async () => {
			// The registry holds ACTIVE waits only; a crash-retry against a
			// wait that already left the projection is still answered from its
			// deterministic entries (replay of the stored prepared outcome, or
			// a precise terminal refusal).
			const wait = this.waits.get(input.waitId) ?? this.readWaitRecordFromEntries(input.waitId);
			if (wait === undefined) throw new UnknownWaitError(input.waitId);
			if (input.expectedVersion !== wait.stateVersion) {
				throw new VersionConflictError(input.waitId, input.expectedVersion, wait.stateVersion);
			}
			if (wait.state === 'backgrounded' && wait.prepared !== null) {
				return {
					waitId: wait.waitId,
					toolCallId: wait.toolCallId,
					stateVersion: wait.stateVersion,
					commitSeq: this.preparedCommitSeq(wait),
					preparedEntryId,
					outcome: wait.prepared.outcome,
					status: 'replayed',
				};
			}
			if (wait.state !== 'foreground') {
				throw new WaitTerminalError(wait.waitId, wait.state, 'T_release');
			}
			const outcome: BackgroundOutcome = {
				kind: 'background',
				waitId: wait.waitId,
				toolCallId: wait.toolCallId,
				conversationId: wait.conversationId,
				delegationId: wait.delegationId,
				childConversationId: wait.childConversationId,
				childRunId: wait.childRunId,
				reason: input.reason ?? 'owner_input',
				initiator: input.initiator ?? 'owner-input',
				backgroundHandle: input.backgroundHandle ?? null,
				cancelOnParentAbort: wait.cancelOnParentAbort,
				preparedAtMs: Date.now(),
			};
			const outcomeHash = this.hashPayload(outcome, 'backgroundHandle');
			const payload: PreparedPayload = {
				waitId: wait.waitId,
				toolCallId: wait.toolCallId,
				stateVersion: wait.stateVersion + 1,
				outcome,
				outcomeHash,
			};
			await this.commitTransition(
				[{ id: preparedEntryId, kind: SEAM_ENTRY_KINDS.backgrounded, payload }],
				(waits, byTool) => {
					// Clone-on-write: the pre-commit snapshot must see the
					// transition while a rejected commit leaves the original
					// record untouched.
					const next: WaitRecord = {
						...wait,
						state: 'backgrounded',
						stateVersion: payload.stateVersion,
						prepared: { outcome, outcomeHash },
					};
					waits.set(next.waitId, next);
					byTool.set(next.toolCallId, next);
				},
			);
			const updated = this.waits.get(input.waitId) ?? wait;
			return {
				waitId: updated.waitId,
				toolCallId: updated.toolCallId,
				stateVersion: updated.stateVersion,
				commitSeq: this.preparedCommitSeq(updated),
				preparedEntryId,
				outcome,
				status: 'committed',
			};
		});
	}

	/** Waits that are backgrounded with their tool result still missing. */
	listPendingPrepared(): readonly PreparedRelease[] {
		const pending: PreparedRelease[] = [];
		for (const wait of this.waits.values()) {
			if (wait.state === 'backgrounded' && wait.prepared !== null && !this.isToolFinalized(wait.toolCallId)) {
				pending.push({
					waitId: wait.waitId,
					toolCallId: wait.toolCallId,
					stateVersion: wait.stateVersion,
					commitSeq: this.preparedCommitSeq(wait),
					preparedEntryId: waitPreparedEntryId(wait.waitId),
					outcome: wait.prepared.outcome,
					status: 'replayed',
				});
			}
		}
		return pending;
	}

	// -------------------------------------------------------------------------
	// T_complete — finalizeTool
	// -------------------------------------------------------------------------

	/**
	 * Commit the single tool-result of one tool call (T_complete). The result
	 * identity is the deterministic `mcode:tool-result:<toolCallId>` entry:
	 * the FIRST finalize commits it and, when the call belongs to a
	 * foreground wait, completes that wait in the same commit. A repeat with
	 * the same outcome replays the original commit; a different outcome (or
	 * one contradicting a prepared outcome) raises `TOOL_RESULT_CONFLICT` —
	 * a crashed finalization is reproduced verbatim, never re-decided.
	 */
	async finalizeTool(input: FinalizeToolInput): Promise<FinalizeToolResult> {
		assertNonEmpty(input?.toolCallId, 'toolCallId');
		const outcomeHash = this.hashPayload(input?.outcome, 'outcome');
		const entryId = toolResultEntryId(input.toolCallId);
		return this.runExclusive(async () => {
			const existing = this.port.getEntry(entryId);
			if (existing !== undefined) {
				return this.replayToolResult(existing, outcomeHash);
			}
			const wait = this.waitsByToolCallId.get(input.toolCallId) ?? null;
			if (wait !== null && wait.state === 'backgrounded' && wait.prepared !== null && wait.prepared.outcomeHash !== outcomeHash) {
				throw new ToolResultConflictError(
					input.toolCallId,
					`the prepared outcome of wait ${JSON.stringify(wait.waitId)} is authoritative and must be reproduced`,
				);
			}
			const now = Date.now();
			let transition: FinalizeToolResult['wait'] = null;
			const payload: ToolResultPayload = {
				toolCallId: input.toolCallId,
				waitId: wait?.waitId ?? null,
				outcome: input.outcome,
				outcomeHash,
				waitTransition: null,
				waitStateVersionAfter: null,
				finalizedAtMs: now,
			};
			const nextVersion = wait === null ? 0 : wait.stateVersion + 1;
			if (wait !== null && wait.state === 'foreground') {
				payload.waitTransition = 'completed';
				payload.waitStateVersionAfter = nextVersion;
				transition = { waitId: wait.waitId, state: 'completed', stateVersion: nextVersion };
			}
			const commitSeq = await this.commitTransition(
				[{ id: entryId, kind: SEAM_ENTRY_KINDS.toolResult, payload }],
				(waits, byTool) => {
					if (wait === null) return;
					// Terminal waits leave the bounded projection: completed, or
					// backgrounded-with-finalized-tool — the durable state now
					// lives in the tool-result entry, not in the active snapshot.
					// Deleting from the clone keeps a rejected commit harmless.
					waits.delete(wait.waitId);
					byTool.delete(wait.toolCallId);
				},
			);
			return {
				toolCallId: input.toolCallId,
				toolResultEntryId: entryId,
				commitSeq,
				status: 'committed',
				wait:
					transition ??
					(wait === null ? null : { waitId: wait.waitId, state: wait.state, stateVersion: wait.stateVersion }),
			};
		});
	}

	// -------------------------------------------------------------------------
	// Delivery index projection
	// -------------------------------------------------------------------------

	/** Active (non-terminal) deliveries of the recovered index. */
	listActiveDeliveries(): readonly DeliveryView[] {
		return [...this.deliveries.values()].map((record) => ({ ...record }));
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	/**
	 * Dedup check against the durable entry index. Returns the replay
	 * result when the same FULL payload (content + whenBusy + actor + route)
	 * was already accepted, throws `REQUEST_ID_CONFLICT` on any difference,
	 * returns null when the key is fresh. Pure — no in-memory state involved.
	 */
	private readAccepted(
		conversationId: string,
		requestId: string,
		payloadHash: string,
	): AcceptOwnerInputResult | null {
		const inputEntryId = receiptEntryId(conversationId, requestId);
		const stored = this.port.getEntry(inputEntryId);
		if (stored === undefined) return null;
		if (stored.kind !== SEAM_ENTRY_KINDS.receipt) {
			throw new SeamStorageError(
				'ENTRY_ID_COLLISION',
				`entry ${JSON.stringify(inputEntryId)} exists with kind ${JSON.stringify(stored.kind)}`,
			);
		}
		const receipt = parseReceiptPayload(stored.payload, inputEntryId);
		if (receipt.payloadHash !== payloadHash) {
			throw new RequestIdConflictError({ conversationId, requestId });
		}
		return {
			submissionId: receipt.submissionId,
			inputEntryId,
			commitSeq: stored.seq,
			status: 'replayed',
			whenBusy: receipt.whenBusy,
		};
	}

	private replayToolResult(stored: PortEntry, outcomeHash: string): FinalizeToolResult {
		if (stored.kind !== SEAM_ENTRY_KINDS.toolResult) {
			throw new SeamStorageError(
				'ENTRY_ID_COLLISION',
				`entry ${JSON.stringify(stored.id)} exists with kind ${JSON.stringify(stored.kind)}`,
			);
		}
		const payload = parseToolResultPayload(stored.payload, stored.id);
		if (payload.outcomeHash !== outcomeHash) {
			throw new ToolResultConflictError(
				payload.toolCallId,
				`the committed tool result carries a different outcome (hash ${payload.outcomeHash.slice(0, 16)}…)`,
			);
		}
		const wait = payload.waitId === null ? undefined : this.waits.get(payload.waitId);
		return {
			toolCallId: payload.toolCallId,
			toolResultEntryId: stored.id,
			commitSeq: stored.seq,
			status: 'replayed',
			wait:
				wait === undefined
					? null
					: { waitId: wait.waitId, state: wait.state, stateVersion: wait.stateVersion },
		};
	}

	private isToolFinalized(toolCallId: string): boolean {
		return this.port.getEntry(toolResultEntryId(toolCallId)) !== undefined;
	}

	/**
	 * Reconstruct a wait's durable state from its deterministic entries —
	 * used when the wait already left the bounded active projection (terminal
	 * waits are removed on finalization) but a retry must still be judged
	 * against the durable identity and outcome. Three point reads at most,
	 * bounded by the single wait being resolved. `undefined` when never opened.
	 */
	private readWaitRecordFromEntries(waitId: string): WaitRecord | undefined {
		const opened = this.port.getEntry(waitOpenedEntryId(waitId));
		if (opened === undefined || opened.kind !== SEAM_ENTRY_KINDS.waitOpened) return undefined;
		const record: WaitRecord = {
			...parseWaitOpenedPayload(opened.payload, opened.id),
			openedCommitSeq: opened.seq,
			prepared: null,
		};
		const prepared = this.port.getEntry(waitPreparedEntryId(waitId));
		if (prepared !== undefined && prepared.kind === SEAM_ENTRY_KINDS.backgrounded) {
			const payload = parsePreparedPayload(prepared.payload, prepared.id);
			record.state = 'backgrounded';
			record.stateVersion = payload.stateVersion;
			record.prepared = { outcome: payload.outcome, outcomeHash: payload.outcomeHash };
		}
		const tool = this.port.getEntry(toolResultEntryId(record.toolCallId));
		if (tool !== undefined && tool.kind === SEAM_ENTRY_KINDS.toolResult) {
			const payload = parseToolResultPayload(tool.payload, tool.id);
			if (payload.waitTransition === 'completed' && payload.waitStateVersionAfter !== null) {
				record.state = 'completed';
				record.stateVersion = payload.waitStateVersionAfter;
			}
			// A finalized background outcome leaves the wait backgrounded —
			// irreversible for this waitId either way.
		}
		return record;
	}

	/** Commit seq of a prepared outcome: the live value or the stored entry's. */
	private preparedCommitSeq(wait: WaitRecord): number {
		const stored = this.port.getEntry(waitPreparedEntryId(wait.waitId));
		return stored?.seq ?? 0;
	}

	/**
	 * Commit the given entries PLUS the snapshot that includes `mutate`'s
	 * effect — one `appendBatch`, one durable transition. The in-memory
	 * registry is cloned for the snapshot and mutated ONLY after the commit
	 * resolved: a rejected commit leaves both the log and the projection
	 * untouched (atomic rollback).
	 */
	private async commitTransition(
		entries: readonly PortEntryDraft[],
		mutate: (waits: Map<string, WaitRecord>, byTool: Map<string, WaitRecord>, deliveries: Map<string, DeliveryRecord>) => void,
	): Promise<number> {
		const waits = new Map(this.waits);
		const byTool = new Map(this.waitsByToolCallId);
		const deliveries = new Map(this.deliveries);
		mutate(waits, byTool, deliveries);
		const snapshotDraft: PortEntryDraft = {
			id: snapshotEntryId(this.snapshotRevision + 1),
			kind: SEAM_ENTRY_KINDS.snapshot,
			payload: encodeSnapshotPayload({
				v: 1,
				revision: this.snapshotRevision + 1,
				waits: [...waits.values()].map(encodeWaitRecord),
				deliveries: [...deliveries.values()].map((record) => ({ ...record })),
			}),
		};
		// Port adapters map storage-contract errors to the seam hierarchy; a
		// rejection leaves the log AND the registry untouched (atomic
		// rollback — nothing was mutated, only cloned, so far).
		const commit = await this.port.appendBatch([...entries, snapshotDraft]);
		this.waits = waits;
		this.waitsByToolCallId = byTool;
		this.deliveries = deliveries;
		this.snapshotRevision += 1;
		return commit.seq;
	}

	private hashPayload(value: unknown, label: string): string {
		try {
			return hashJson(value);
		} catch (error) {
			throw new InvalidInputError(`${label} must be a JSON value: ${(error as Error).message}`, { cause: error });
		}
	}

	/**
	 * Explicit admission backpressure: refuse an input that cannot fit the
	 * effective budget BEFORE any durable attempt. The effective budget is
	 * the configured ceiling capped by the port's batch budget minus the
	 * seam's commit overhead (submission + receipt envelope + snapshot share
	 * the accept commit), so a "big paste" fails with `INPUT_TOO_LARGE` here
	 * instead of an opaque batch-cap `STORAGE_FAILURE` at commit time.
	 */
	private assertInputBudget(contentBytes: number): void {
		let limit = this.maxInputBytes;
		const batchCap = this.port.maxBatchBytes?.() ?? null;
		if (batchCap !== null && batchCap > SEAM_COMMIT_OVERHEAD_BYTES) {
			limit = Math.min(limit, batchCap - SEAM_COMMIT_OVERHEAD_BYTES);
		}
		if (contentBytes > limit) {
			throw new InputTooLargeError(contentBytes, limit);
		}
	}

	/** Serialize mutators: a check-then-commit sequence never interleaves. */
	private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.tail.then(fn, fn);
		this.tail = next.catch(() => undefined);
		return next;
	}
}

// ---------------------------------------------------------------------------
// Replay of individual entries (forward delta on top of the seed snapshot)
// ---------------------------------------------------------------------------

function applyReplayEntry(
	entry: PortEntry,
	waits: Map<string, WaitRecord>,
	byTool: Map<string, WaitRecord>,
	deliveries: Map<string, DeliveryRecord>,
): void {
	switch (entry.kind) {
		case SEAM_ENTRY_KINDS.waitOpened: {
			const payload = parseWaitOpenedPayload(entry.payload, entry.id);
			if (!waits.has(payload.waitId)) {
				const wait: WaitRecord = { ...payload, openedCommitSeq: entry.seq, prepared: null };
				waits.set(wait.waitId, wait);
				byTool.set(wait.toolCallId, wait);
			}
			return;
		}
		case SEAM_ENTRY_KINDS.backgrounded: {
			const payload = parsePreparedPayload(entry.payload, entry.id);
			const wait = waits.get(payload.waitId);
			if (wait !== undefined && payload.stateVersion > wait.stateVersion) {
				wait.state = 'backgrounded';
				wait.stateVersion = payload.stateVersion;
				wait.prepared = { outcome: payload.outcome, outcomeHash: payload.outcomeHash };
			}
			return;
		}
		case SEAM_ENTRY_KINDS.toolResult: {
			const payload = parseToolResultPayload(entry.payload, entry.id);
			const wait = payload.waitId === null ? undefined : waits.get(payload.waitId);
			if (wait !== undefined) {
				// Terminal waits leave the projection (see finalizeTool): a
				// finalized tool means the wait is terminal either way, and its
				// durable state lives in the entries.
				waits.delete(wait.waitId);
				byTool.delete(wait.toolCallId);
			}
			return;
		}
		case SEAM_ENTRY_KINDS.receipt: {
			const payload = parseReceiptPayload(entry.payload, entry.id);
			const key = deliveryKey(payload.targetConversationId, payload.requestId);
			if (!deliveries.has(key)) {
				deliveries.set(key, {
					conversationId: payload.targetConversationId,
					requestId: payload.requestId,
					submissionId: payload.submissionId,
					inputEntryId: payload.inputId,
				});
			}
			return;
		}
		case SEAM_ENTRY_KINDS.deliverySettled: {
			const payload = parseSettledPayload(entry.payload, entry.id);
			deliveries.delete(deliveryKey(payload.conversationId, payload.requestId));
			return;
		}
		default:
			// Foreign kinds (including snapshots and submissions) carry no
			// registry state beyond what their deterministic point reads give.
			return;
	}
}

// ---------------------------------------------------------------------------
// Payload parse/validate helpers
// ---------------------------------------------------------------------------

function parseReceiptPayload(value: unknown, entryId: string): ReceiptPayload {
	if (!isObject(value)) throw malformedPayload(entryId);
	return {
		inputId: requireString(value['inputId'], entryId),
		requestId: requireString(value['requestId'], entryId),
		submissionId: requireString(value['submissionId'], entryId),
		targetConversationId: requireString(value['targetConversationId'], entryId),
		sourceConversationId: optionalString(value['sourceConversationId']),
		actor: optionalString(value['actor']),
		route: optionalString(value['route']),
		whenBusy: parseWhenBusy(value['whenBusy'], entryId),
		contentHash: requireString(value['contentHash'], entryId),
		payloadHash: requireString(value['payloadHash'], entryId),
		content: (value['content'] ?? null) as JsonValue,
		receivedAtMs: requireSafeInteger(value['receivedAtMs'], entryId),
	};
}

function parseWaitOpenedPayload(value: unknown, entryId: string): WaitOpenedPayload {
	if (!isObject(value)) throw malformedPayload(entryId);
	const state = value['state'];
	if (state !== 'foreground') throw malformedPayload(entryId);
	return {
		waitId: requireString(value['waitId'], entryId),
		toolCallId: requireString(value['toolCallId'], entryId),
		conversationId: requireString(value['conversationId'], entryId),
		delegationId: optionalString(value['delegationId']),
		childConversationId: optionalString(value['childConversationId']),
		childRunId: optionalString(value['childRunId']),
		cancelOnParentAbort: value['cancelOnParentAbort'] === true,
		state: 'foreground',
		stateVersion: requireSafeInteger(value['stateVersion'], entryId),
		openedCommitSeq: requireSafeInteger(value['openedCommitSeq'], entryId),
	};
}

function parsePreparedPayload(value: unknown, entryId: string): PreparedPayload {
	if (!isObject(value)) throw malformedPayload(entryId);
	return {
		waitId: requireString(value['waitId'], entryId),
		toolCallId: requireString(value['toolCallId'], entryId),
		stateVersion: requireSafeInteger(value['stateVersion'], entryId),
		outcome: parseBackgroundOutcome(value['outcome'], entryId),
		outcomeHash: requireString(value['outcomeHash'], entryId),
	};
}

function parseToolResultPayload(value: unknown, entryId: string): ToolResultPayload {
	if (!isObject(value)) throw malformedPayload(entryId);
	const transition = value['waitTransition'];
	if (transition !== null && transition !== 'completed') throw malformedPayload(entryId);
	return {
		toolCallId: requireString(value['toolCallId'], entryId),
		waitId: optionalString(value['waitId']),
		outcome: (value['outcome'] ?? null) as JsonValue,
		outcomeHash: requireString(value['outcomeHash'], entryId),
		waitTransition: transition,
		waitStateVersionAfter: optionalSafeInteger(value['waitStateVersionAfter'], entryId),
		finalizedAtMs: requireSafeInteger(value['finalizedAtMs'], entryId),
	};
}

function parseSettledPayload(value: unknown, entryId: string): SettledPayload {
	if (!isObject(value)) throw malformedPayload(entryId);
	return {
		conversationId: requireString(value['conversationId'], entryId),
		requestId: requireString(value['requestId'], entryId),
		inputEntryId: requireString(value['inputEntryId'], entryId),
	};
}

function encodeWaitRecord(record: WaitRecord): SnapshotWaitRecord {
	return {
		waitId: record.waitId,
		toolCallId: record.toolCallId,
		conversationId: record.conversationId,
		delegationId: record.delegationId,
		childConversationId: record.childConversationId,
		childRunId: record.childRunId,
		cancelOnParentAbort: record.cancelOnParentAbort,
		state: record.state,
		stateVersion: record.stateVersion,
		openedCommitSeq: record.openedCommitSeq,
		prepared: record.prepared === null ? null : { ...record.prepared },
	};
}

function waitView(record: WaitRecord): SeamWaitView {
	return {
		waitId: record.waitId,
		toolCallId: record.toolCallId,
		conversationId: record.conversationId,
		delegationId: record.delegationId,
		childConversationId: record.childConversationId,
		childRunId: record.childRunId,
		cancelOnParentAbort: record.cancelOnParentAbort,
		state: record.state,
		stateVersion: record.stateVersion,
		openedCommitSeq: record.openedCommitSeq,
		preparedOutcome: record.prepared === null ? null : { ...record.prepared.outcome },
	};
}

function deliveryKey(conversationId: string, requestId: string): string {
	return `${conversationId}\u0000${requestId}`;
}

/**
 * The durable identity of a wait anchor: the fields a duplicate
 * `openForegroundWait` must repeat EXACTLY. A different tool call or
 * conversation under an opened waitId is a `WAIT_ID_CONFLICT`.
 */
function waitIdentity(fields: {
	toolCallId: string;
	conversationId: string;
	delegationId: string | null;
	childConversationId: string | null;
	childRunId: string | null;
	cancelOnParentAbort: boolean;
}): string {
	return hashJson({
		toolCallId: fields.toolCallId,
		conversationId: fields.conversationId,
		delegationId: fields.delegationId,
		childConversationId: fields.childConversationId,
		childRunId: fields.childRunId,
		cancelOnParentAbort: fields.cancelOnParentAbort,
	});
}

function assertSameWaitIdentity(draft: ForegroundWaitDraft, record: WaitRecord): void {
	const draftIdentity = waitIdentity({
		toolCallId: draft.toolCallId,
		conversationId: draft.conversationId,
		delegationId: draft.delegationId ?? null,
		childConversationId: draft.childConversationId ?? null,
		childRunId: draft.childRunId ?? null,
		cancelOnParentAbort: draft.cancelOnParentAbort === true,
	});
	const recordIdentity = waitIdentity(record);
	if (draftIdentity !== recordIdentity) {
		throw new WaitIdConflictError(
			draft.waitId,
			`opened as toolCallId ${JSON.stringify(record.toolCallId)} in conversation ${JSON.stringify(record.conversationId)}`,
		);
	}
}

/** Canonical JSON byte length of a value (for the admission budget). */
function canonicalByteLength(value: unknown, label: string): number {
	try {
		return Buffer.byteLength(canonicalJson(value), 'utf8');
	} catch (error) {
		throw new InvalidInputError(`${label} must be a JSON value: ${(error as Error).message}`, { cause: error });
	}
}

function malformedPayload(entryId: string): SeamStorageError {
	return new SeamStorageError('STORAGE_FAILURE', `seam entry ${JSON.stringify(entryId)} has a malformed payload`);
}

function parseWhenBusy(value: unknown, entryId: string): WhenBusy {
	if (value === 'steer' || value === 'followUp') return value;
	throw malformedPayload(entryId);
}

function assertWhenBusy(value: unknown): asserts value is WhenBusy {
	if (!WHEN_BUSY_VALUES.includes(value as WhenBusy)) {
		throw new InvalidInputError(`whenBusy must be one of ${WHEN_BUSY_VALUES.map((v) => JSON.stringify(v)).join(' | ')}`);
	}
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new InvalidInputError(`${label} must be a non-empty string`);
	}
}

function assertVersion(value: unknown): asserts value is number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new InvalidInputError(`expectedVersion must be a positive safe integer, got ${String(value)}`);
	}
}

function requireString(value: unknown, entryId: string): string {
	if (typeof value !== 'string' || value.length === 0) throw malformedPayload(entryId);
	return value;
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireSafeInteger(value: unknown, entryId: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw malformedPayload(entryId);
	return value;
}

function optionalSafeInteger(value: unknown, entryId: string): number | null {
	if (value === null || value === undefined) return null;
	return requireSafeInteger(value, entryId);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
