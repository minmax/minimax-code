/**
 * Adapter from the wave-1 `sqlite-zstd` durable backend to the seam's
 * storage port. This is the ONLY module of the package that knows the
 * backend; the seam core stays port-shaped and testable against any log.
 *
 * The backend is imported TYPE-only: the adapter receives the backend
 * instance structurally and never loads it at runtime, so the seam can be
 * composed over whatever object upholds the storage contract
 * (`SqliteZstdBackend` today). Backend errors are recognized structurally
 * (by class name) and mapped into the seam hierarchy:
 *
 * - backend `OwnerLostError` → seam `OWNER_LOST` (single-writer fencing;
 *   the epoch is re-checked inside every backend commit transaction);
 * - `SealedGenerationError` → `GENERATION_SEALED`;
 * - `DuplicateEntryError` (deterministic-entry-id collision) →
 *   `ENTRY_ID_COLLISION`;
 * - anything else → `STORAGE_FAILURE` with the original as `cause`.
 *
 * @module
 */

import { SeamError, SeamOwnerLostError, SeamStorageError } from './errors.js';
import type { DurableLogPort, PortCommit, PortDelta, PortEntry, PortEntryDraft } from './port.js';

/**
 * Minimal structural shape of the wave-1 backend this adapter reads.
 * `SqliteZstdBackend` satisfies it as-is; a test double may too.
 */
export interface SqliteZstdBackendLike {
	appendBatch(
		entries: readonly { readonly id: string; readonly kind: string; readonly payload: unknown }[],
	): Promise<{ readonly seq: number; readonly head: number; readonly entryCount: number }>;
	getEntry(entryId: string): { readonly id: string; readonly kind: string; readonly payload: unknown; readonly seq: number; readonly ordinal: number } | undefined;
	readDeltaChecked(
		afterSeq: number,
		limitBytes: number,
	): {
		readonly entries: readonly { readonly id: string; readonly kind: string; readonly payload: unknown; readonly seq: number; readonly ordinal: number }[];
		readonly nextAfterSeq: number | null;
		readonly tornTail: { readonly batchId: number; readonly reason: string } | null;
	};
	readonly head: number;
	readonly maxBatchUncompressedBytes: number;
}

/** Wrap a `SqliteZstdBackend` (or structural equivalent) as a seam port. */
export function sqliteZstdDurableLogPort(backend: SqliteZstdBackendLike): DurableLogPort {
	return {
		async appendBatch(entries: readonly PortEntryDraft[]): Promise<PortCommit> {
			try {
				const commit = await backend.appendBatch(entries);
				return { seq: commit.seq, head: commit.head, entryCount: commit.entryCount };
			} catch (error) {
				throw mapBackendError(error);
			}
		},
		getEntry(entryId: string): PortEntry | undefined {
			try {
				const entry = backend.getEntry(entryId);
				return entry === undefined ? undefined : toPortEntry(entry);
			} catch (error) {
				throw mapBackendError(error);
			}
		},
		readDeltaChecked(afterSeq: number, limitBytes: number): PortDelta {
			try {
				const delta = backend.readDeltaChecked(afterSeq, limitBytes);
				return {
					entries: delta.entries.map(toPortEntry),
					nextAfterSeq: delta.nextAfterSeq,
					tornTail: delta.tornTail,
				};
			} catch (error) {
				throw mapBackendError(error);
			}
		},
		head(): number {
			try {
				return backend.head;
			} catch (error) {
				throw mapBackendError(error);
			}
		},
		maxBatchBytes(): number | null {
			try {
				return backend.maxBatchUncompressedBytes;
			} catch (error) {
				throw mapBackendError(error);
			}
		},
	};
}

type AnyBackendEntry = {
	readonly id: string;
	readonly kind: string;
	readonly payload: unknown;
	readonly seq: number;
	readonly ordinal: number;
};

function toPortEntry(entry: AnyBackendEntry): PortEntry {
	return { id: entry.id, kind: entry.kind, payload: entry.payload as PortEntry['payload'], seq: entry.seq, ordinal: entry.ordinal };
}

/**
 * Map a storage-contract error into the seam hierarchy. Recognition is
 * structural (the backend class is deliberately not loaded at runtime).
 */
function mapBackendError(error: unknown): unknown {
	if (error instanceof SeamError) return error;
	const name = error instanceof Error ? error.name : '';
	if (name === 'OwnerLostError') {
		return new SeamOwnerLostError(error instanceof Error ? error.message : 'the storage owner epoch moved', {
			cause: error,
		});
	}
	if (name === 'SealedGenerationError') {
		return new SeamStorageError('GENERATION_SEALED', error instanceof Error ? error.message : 'the generation is sealed', {
			cause: error,
		});
	}
	if (name === 'DuplicateEntryError') {
		return new SeamStorageError(
			'ENTRY_ID_COLLISION',
			error instanceof Error ? error.message : 'a deterministic seam entry id already exists',
			{ cause: error },
		);
	}
	return new SeamStorageError('STORAGE_FAILURE', error instanceof Error ? error.message : String(error), { cause: error });
}
