/**
 * Bounded active-state snapshot of the seam.
 *
 * One snapshot entry rides inside EVERY seam commit (same batch, same
 * transaction), so the committed snapshot always agrees with the transition
 * it shipped with. Snapshots hold only ACTIVE objects — foreground and
 * backgrounded waits, pending prepared outcomes, active deliveries —
 * terminal records leave the snapshot as the design's bounded index demands
 * ("fence/index/replay limited to active objects").
 *
 * Recovery seeds its registry from the LATEST snapshot and replays only the
 * delta after it. Finding the latest snapshot costs O(log revisions) point
 * reads: snapshot ids are deterministic (`mcode:seam:snapshot:<revision>`),
 * so the chain is probed with exponential doubling + binary search through
 * the entry index — no history scan.
 *
 * @module
 */

import { SeamStorageError } from './errors.js';
import { snapshotEntryId } from './ids.js';
import type { BackgroundOutcome, JsonValue, WaitState } from './types.js';
import type { PortEntry } from './port.js';

/** Snapshot image of one wait (active only). */
export type SnapshotWaitRecord = {
	readonly waitId: string;
	readonly toolCallId: string;
	readonly conversationId: string;
	readonly delegationId: string | null;
	readonly childConversationId: string | null;
	readonly childRunId: string | null;
	readonly cancelOnParentAbort: boolean;
	readonly state: WaitState;
	readonly stateVersion: number;
	readonly openedCommitSeq: number;
	/** Prepared outcome while `backgrounded`; the wait is terminal without it. */
	readonly prepared: { readonly outcome: BackgroundOutcome; readonly outcomeHash: string } | null;
};

/** Snapshot image of one active delivery-index entry. */
export type SnapshotDeliveryRecord = {
	readonly conversationId: string;
	readonly requestId: string;
	readonly submissionId: string;
	readonly inputEntryId: string;
};

/** Payload shape of a `mcode.seam.snapshot` entry. */
export type SnapshotPayload = {
	readonly v: 1;
	readonly revision: number;
	readonly waits: readonly SnapshotWaitRecord[];
	readonly deliveries: readonly SnapshotDeliveryRecord[];
};

/** Build the snapshot entry payload for the given active state. */
export function encodeSnapshotPayload(payload: SnapshotPayload): JsonValue {
	return payload satisfies SnapshotPayload;
}

/** Parse and fully validate a stored snapshot payload. */
export function parseSnapshotPayload(value: unknown, entryId: string): SnapshotPayload {
	if (!isObject(value)) throw malformed(entryId);
	if (value['v'] !== 1 || !isSafeInteger(value['revision']) || value['revision'] < 1) throw malformed(entryId);
	if (!Array.isArray(value['waits']) || !Array.isArray(value['deliveries'])) throw malformed(entryId);
	const waits = (value['waits'] as unknown[]).map((item) => parseWaitRecord(item, entryId));
	const deliveries = (value['deliveries'] as unknown[]).map((item) => parseDeliveryRecord(item, entryId));
	return { v: 1, revision: value['revision'], waits, deliveries };
}

/**
 * Parse and validate a stored {@link BackgroundOutcome}. Shared by the
 * snapshot records and the `mcode.delegation.backgrounded` entries so the
 * authoritative prepared outcome a caller reproduces is never an
 * unvalidated cast.
 */
export function parseBackgroundOutcome(value: unknown, context: string): BackgroundOutcome {
	if (!isObject(value)) throw malformed(context);
	if (value['kind'] !== 'background') throw malformed(context);
	const reason = value['reason'];
	const initiator = value['initiator'];
	if (typeof reason !== 'string' || typeof initiator !== 'string') throw malformed(context);
	return {
		kind: 'background',
		waitId: asString(value['waitId'], context),
		toolCallId: asString(value['toolCallId'], context),
		conversationId: asString(value['conversationId'], context),
		delegationId: asStringOrNull(value['delegationId'], context),
		childConversationId: asStringOrNull(value['childConversationId'], context),
		childRunId: asStringOrNull(value['childRunId'], context),
		reason,
		initiator,
		backgroundHandle: (value['backgroundHandle'] ?? null) as BackgroundOutcome['backgroundHandle'],
		cancelOnParentAbort: value['cancelOnParentAbort'] === true,
		preparedAtMs: asSafeInteger(value['preparedAtMs'], context),
	};
}

/**
 * Find the highest-existing snapshot revision through point reads alone:
 * exponential doubling until a revision is missing, then binary search
 * between the last hit and the first miss. `undefined` when the log holds no
 * snapshot at all.
 */
export function probeLatestSnapshot(
	getEntry: (entryId: string) => PortEntry | undefined,
): { readonly revision: number; readonly entry: PortEntry } | undefined {
	if (getEntry(snapshotEntryId(1)) === undefined) return undefined;
	let lo = 1;
	let hi = 2;
	while (getEntry(snapshotEntryId(hi)) !== undefined) {
		lo = hi;
		hi *= 2;
	}
	while (hi - lo > 1) {
		const mid = lo + Math.floor((hi - lo) / 2);
		if (getEntry(snapshotEntryId(mid)) !== undefined) lo = mid;
		else hi = mid;
	}
	const entry = getEntry(snapshotEntryId(lo));
	if (entry === undefined) throw malformed(snapshotEntryId(lo));
	return { revision: lo, entry };
}

function parseWaitRecord(item: unknown, entryId: string): SnapshotWaitRecord {
	if (!isObject(item)) throw malformed(entryId);
	const preparedValue = item['prepared'];
	let prepared: SnapshotWaitRecord['prepared'] = null;
	if (preparedValue !== null) {
		if (!isObject(preparedValue) || typeof preparedValue['outcomeHash'] !== 'string') throw malformed(entryId);
		prepared = { outcome: parseBackgroundOutcome(preparedValue['outcome'], entryId), outcomeHash: preparedValue['outcomeHash'] };
	}
	const state = item['state'];
	if (state !== 'foreground' && state !== 'backgrounded' && state !== 'completed') throw malformed(entryId);
	return {
		waitId: asString(item['waitId'], entryId),
		toolCallId: asString(item['toolCallId'], entryId),
		conversationId: asString(item['conversationId'], entryId),
		delegationId: asStringOrNull(item['delegationId'], entryId),
		childConversationId: asStringOrNull(item['childConversationId'], entryId),
		childRunId: asStringOrNull(item['childRunId'], entryId),
		cancelOnParentAbort: item['cancelOnParentAbort'] === true,
		state,
		stateVersion: asSafeInteger(item['stateVersion'], entryId),
		openedCommitSeq: asSafeInteger(item['openedCommitSeq'], entryId),
		prepared,
	};
}

function parseDeliveryRecord(item: unknown, entryId: string): SnapshotDeliveryRecord {
	if (!isObject(item)) throw malformed(entryId);
	return {
		conversationId: asString(item['conversationId'], entryId),
		requestId: asString(item['requestId'], entryId),
		submissionId: asString(item['submissionId'], entryId),
		inputEntryId: asString(item['inputEntryId'], entryId),
	};
}

function malformed(entryId: string): SeamStorageError {
	return new SeamStorageError('STORAGE_FAILURE', `snapshot entry ${JSON.stringify(entryId)} is malformed`);
}

function asString(value: unknown, entryId: string): string {
	if (typeof value !== 'string' || value.length === 0) throw malformed(entryId);
	return value;
}

function asStringOrNull(value: unknown, entryId: string): string | null {
	if (value === null) return null;
	return asString(value, entryId);
}

function asSafeInteger(value: unknown, entryId: string): number {
	if (!isSafeInteger(value)) throw malformed(entryId);
	return value;
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
