/**
 * Deterministic entry ids of the seam.
 *
 * Every durable seam record gets its entry id DERIVED from the record's key,
 * which makes the entry log itself the dedup and lookup index: a point read
 * (`getEntry`) answers "was this accepted / prepared / finalized" without any
 * scan, and the storage contract's `entries.entry_id` primary key makes a
 * second write under the same key impossible. Durable deduplication therefore
 * lives in the entry index — not in a seam-private table (steering design §3:
 * "durable deduplication remains in native submissions / the entry index").
 *
 * Composite keys (conversationId + requestId) are hashed to avoid
 * delimiter-injection collisions; single-string keys are embedded verbatim.
 *
 * @module
 */

import { hashString } from './canonical.js';

/** Hash of a composite `(conversationId, requestId)` dedup key. */
export function requestKeyHash(conversationId: string, requestId: string): string {
	// NUL separator: ids never contain it, so the composition is injective in
	// practice; the hash keeps entry ids bounded and delimiter-free.
	return hashString(`${conversationId}\u0000${requestId}`).slice(0, 32);
}

/** Entry id of the receipt (`mcode.owner-input.received`) for a dedup key. */
export function receiptEntryId(conversationId: string, requestId: string): string {
	return `mcode:receipt:${requestKeyHash(conversationId, requestId)}`;
}

/** Entry id of the native submission record for a dedup key. */
export function submissionEntryId(conversationId: string, requestId: string): string {
	return `mcode:submission:${requestKeyHash(conversationId, requestId)}`;
}

/** Entry id of the terminal delivery-index update for a dedup key. */
export function settledEntryId(conversationId: string, requestId: string): string {
	return `mcode:delivery-settled:${requestKeyHash(conversationId, requestId)}`;
}

/** Entry id of the wait-opened record of one wait. */
export function waitOpenedEntryId(waitId: string): string {
	return `mcode:wait:${waitId}:opened`;
}

/** Entry id of the prepared background outcome (T_release) of one wait. */
export function waitPreparedEntryId(waitId: string): string {
	return `mcode:wait:${waitId}:prepared`;
}

/** Entry id of the single tool-result of one tool call (T_complete). */
export function toolResultEntryId(toolCallId: string): string {
	return `mcode:tool-result:${toolCallId}`;
}

/** Entry id of the active-state snapshot of a given revision (1-based). */
export function snapshotEntryId(revision: number): string {
	return `mcode:seam:snapshot:${revision}`;
}
