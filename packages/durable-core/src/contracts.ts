/**
 * Single shared declaration of the durable-core wave contract (IC-F2-001).
 *
 * This package is TYPE-ONLY: it ships no runtime code, so importing it never
 * creates a runtime dependency. Both sides of the worker/backend seam
 * re-export the canonical types declared here instead of declaring their own:
 *
 * - `@mavis/storage-worker` (`src/contracts.ts`) re-exports {@link Entry} and
 *   {@link Commit} under their canonical names — they are the worker's
 *   dictionary, pinned verbatim by the durable-core wave spec;
 * - `@mavis/durable-backend-sqlite-zstd` (`src/types.ts`) re-exports them
 *   under `DurableCoreEntry`/`DurableCoreCommit`, because the backend's
 *   published `Entry`/`Commit` names are its own (richer, branded) dictionary
 *   and are frozen until the DB-side unification lands.
 *
 * Until the backend adopts the canonical shapes, the runtime translation
 * between the two dictionaries stays in exactly one place:
 * `packages/storage-worker/src/sqlite-zstd-adapter.ts`. It is the only module
 * allowed to map between the dictionaries; do not add a second bridge.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Canonical dictionaries
// ---------------------------------------------------------------------------

/**
 * One record to persist; `bytes` drives the byte-bounded queue and batch
 * windows. This is the canonical INPUT entry of the whole durable-core wave
 * — the shape callers enqueue and both packages speak.
 */
export interface Entry {
	/** Stable application identity, unique across the whole database. */
	entryId: string;
	/** Log position of the predecessor entry, `null` for the first entry. */
	parentId: string | null;
	/** Application-defined discriminator (for example a `pi.*` entry kind). */
	kind: string;
	/** JSON-serializable payload stored inside the batch frame. */
	payload: unknown;
	/** Serialized size of the entry in bytes; the unit of queue/window budgets. */
	bytes: number;
}

/**
 * Result of one committed batch, as surfaced to the worker's callers. The
 * values are opaque strings by contract; the sqlite-zstd backend renders its
 * numeric ids as decimal strings at the adapter boundary.
 */
export interface Commit {
	/** Primary key of the stored batch. */
	batchId: string;
	/** Strictly increasing sequence of this commit. */
	seq: number;
	/** Log head after the commit. */
	head: string;
}

// ---------------------------------------------------------------------------
// Dictionary reconciliation (single place, IC-F2-001)
// ---------------------------------------------------------------------------

/**
 * The worker dictionary ({@link Entry}/{@link Commit} above) and the
 * sqlite-zstd backend dictionary (`EntryDraft`/`Entry`/`Commit` in
 * `packages/durable-backend-sqlite-zstd/src/types.ts`) disagree field by
 * field. The authoritative record of the disagreement:
 *
 * | canonical (worker)            | sqlite-zstd backend                          |
 * | ----------------------------- | -------------------------------------------- |
 * | `entryId: string`             | `id: string` (frame key stays `id` on disk)  |
 * | `parentId: string \| null` (required, `null` = first entry) | `parentId?: string \| null` (optional; preserved in the frame, not indexed — log order is authoritative) |
 * | `payload: unknown`            | `payload: JsonValue` (narrower; non-JSON payloads are rejected before a write) |
 * | `bytes: number` (required budget unit) | no such field; the backend measures the serialized batch itself |
 * | `Commit.batchId: string`      | `Commit.batchId: BatchId` (branded number, invariant `batch_id === seq`) |
 * | `Commit.seq: number`          | `Commit.seq: Seq` (branded number)           |
 * | `Commit.head: string` (log head) | `Commit.head: Seq` (branded number; equals `seq` in this backend) |
 * | — (not representable)         | `Commit.entryCount`, `Commit.codec`, `Commit.compressedBytes`, `Commit.uncompressedBytes` (lost at the seam today) |
 * | `Entry` = input entry         | `Entry` = STORED (read) entry: draft + `seq: Seq` + `ordinal` (name collision — IC-F2-002; scheduled to become `StoredEntry`) |
 *
 * Semantic notes both sides must honor:
 * - `parentId` is part of the worker's log-position logic, but merely a
 *   preserved copy inside the backend frame — the log order itself is
 *   authoritative for the backend.
 * - `bytes` is the worker's budget unit and must be measured the same way the
 *   backend measures a stored draft (UTF-8 bytes of the frame JSON), which is
 *   what the adapter's `entryDraftSizeBytes` computes.
 *
 * Runtime translation rules (the adapter, the only bridge):
 * - `toEntryDraft`: `entryId` → `id`, drop `bytes`, keep `parentId`/`kind`/`payload`.
 * - `commitFromSqliteZstd`: `String(batchId)`, `seq` as-is, `String(head)`.
 */

// ---------------------------------------------------------------------------
// entryId uniqueness and replay (referenced by SW-04 / DB-05)
// ---------------------------------------------------------------------------

/**
 * Acknowledgment status of one append under the uniqueness/replay contract:
 * - `committed` — the entry became durable in this append;
 * - `replayed` — the `entryId` was already durable; the redelivery was
 *   acknowledged idempotently and no second row was created.
 */
export type EntryAppendStatus = 'committed' | 'replayed';

/**
 * Uniqueness and replay contract for `Entry.entryId` (implemented by SW-04 on
 * the worker side and DB-05 on the backend side; both must reference this
 * declaration instead of restating the semantics):
 *
 * 1. `entryId` is the stable application identity of an entry and is unique
 *    across the whole database (the sqlite-zstd backend enforces it as the
 *    `entries.entry_id` primary key).
 * 2. Redelivering an `entryId` that is already committed is a REPLAY, not a
 *    conflict. It is acknowledged idempotently: no second stored row, the
 *    original batch stays authoritative, and the outcome reports
 *    {@link EntryAppendStatus} `'replayed'`.
 * 3. A replay must never fail the batch it travels in, and never quarantine
 *    unrelated co-batched entries: "already committed" is separated from
 *    every other refusal BEFORE whole-batch accounting happens.
 * 4. "Already committed" must be recognizable as a domain outcome, not a raw
 *    driver error, so an at-least-once caller replaying its journal after a
 *    crash can distinguish replay (`'replayed'`) from a real failure.
 */

// ---------------------------------------------------------------------------
// Dead letters (quarantine) and their acknowledgement (referenced by SW-03)
// ---------------------------------------------------------------------------

/** Why entries left the write path into quarantine. */
export type DeadLetterReason =
	/** A single entry above the batch cap at admission time. */
	| 'entry-exceeds-batch-cap'
	/** A single entry that cannot fit a batch even alone (post-split poison). */
	| 'entry-too-large'
	/** A batch that failed too many consecutive times with the same composition. */
	| 'batch-stuck';

/**
 * Durability contract of quarantine (dead letters). SW-03 implements it; the
 * worker/backend packages must not restate it locally:
 *
 * 1. Quarantine is fail-closed for durability, never a silent drop. Between
 *    the quarantine decision and the caller's {@link DeadLetterAck} the dead
 *    letters must survive process death: they are persisted durably (the same
 *    backend, a dedicated entry kind) BEFORE being removed from the write
 *    path.
 * 2. The caller is always told about new dead letters — the report is part of
 *    the contract, not an optional callback.
 * 3. Ack is explicit: only an acked dead letter may leave the durable
 *    dead-letter store. Unacked letters are re-reported after recovery; the
 *    in-memory `quarantined` view is a projection, never the only record.
 * 4. Failure classification for the retry path is by stability —
 *    {@link FlushFailureStability} — not merely by attempt count.
 * 5. A quarantined entry breaks the parent chain by contract: successors keep
 *    their `parentId` pointing at it, and readers must treat a missing parent
 *    as a quarantined prefix, not as corruption.
 */
export interface DeadLetter {
	/** The entry as it was accepted for persistence. */
	readonly entry: Entry;
	/** Why it left the write path. */
	readonly reason: DeadLetterReason;
	/** Wall-clock timestamp of the quarantine decision. */
	readonly quarantinedMs: number;
}

/** Caller's explicit acknowledgement that dead letters were taken over. */
export interface DeadLetterAck {
	/** Entry ids the caller took over, exactly as reported. */
	readonly entryIds: readonly string[];
	/** Wall-clock timestamp of the acknowledgement. */
	readonly ackedMs: number;
}

/**
 * Stability of a flush failure — the unit of the retry/dead-letter decision
 * (SW-03): `transient` failures keep the batch on the retry path; `terminal`
 * ones dead-letter it immediately.
 */
export type FlushFailureStability = 'transient' | 'terminal';
