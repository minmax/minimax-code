/**
 * Test helpers: an in-memory `DurableLogPort` with fault injection, and
 * factory glue for the real sqlite-zstd backend.
 *
 * The in-memory log upholds the same contract the seam relies on: batch
 * appends are all-or-nothing, entry ids are unique, and a "stolen" owner
 * epoch fails appends until restored. Faults are injected BEFORE any effect,
 * which is exactly the crash-before-commit point the atomic-rollback tests
 * exercise.
 *
 * @module
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteZstdBackend, loadSqlite3Constructor } from '../../durable-backend-sqlite-zstd/src/index.js';
import { SeamOwnerLostError, SeamStorageError, sqliteZstdDurableLogPort } from '../src/index.js';
import type { DurableLogPort, PortCommit, PortDelta, PortEntry, PortEntryDraft } from '../src/index.js';
import type { SqliteZstdBackendOptions } from '../../durable-backend-sqlite-zstd/src/types.js';

export class InMemoryDurableLog implements DurableLogPort {
	readonly entries = new Map<string, PortEntry>();
	readonly batches: PortEntry[][] = [];
	private headSeq = 0;
	private ownerLost = false;
	private failNext: Error | null = null;
	private readonly appendGates: Promise<void>[] = [];

	/** Inject a one-shot crash BEFORE the next append commits anything. */
	failNextAppend(error: Error): void {
		this.failNext = error;
	}

	/** Simulate another writer taking the generation: appends fail. */
	stealOwnership(): void {
		this.ownerLost = true;
	}

	/** Undo {@link stealOwnership} (the crashed writer was detected). */
	restoreOwnership(): void {
		this.ownerLost = false;
	}

	/**
	 * Hold the NEXT append before it commits; the returned function releases
	 * it. Used to interleave concurrent seam calls deterministically.
	 */
	holdNextAppend(): () => void {
		let release!: () => void;
		this.appendGates.push(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		return release;
	}

	/** Remove matching entries from the log entirely (simulates older logs). */
	dropEntries(keep: (entry: PortEntry) => boolean): void {
		for (const [id, entry] of this.entries) {
			if (!keep(entry)) this.entries.delete(id);
		}
		for (let i = this.batches.length - 1; i >= 0; i -= 1) {
			const batch = this.batches[i]!;
			const filtered = batch.filter(keep);
			if (filtered.length === 0) this.batches.splice(i, 1);
			else this.batches[i] = filtered;
		}
	}

	/** Build a log from stored entries, grouped into their original batches. */
	static fromEntries(entries: readonly PortEntry[]): InMemoryDurableLog {
		const log = new InMemoryDurableLog();
		const bySeq = new Map<number, PortEntry[]>();
		for (const entry of entries) {
			const batch = bySeq.get(entry.seq);
			if (batch === undefined) bySeq.set(entry.seq, [entry]);
			else batch.push(entry);
		}
		for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) {
			const batch = bySeq.get(seq)!.sort((a, b) => a.ordinal - b.ordinal);
			for (const entry of batch) log.entries.set(entry.id, entry);
			log.batches.push(batch);
			log.headSeq = seq;
		}
		return log;
	}

	async appendBatch(drafts: readonly PortEntryDraft[]): Promise<PortCommit> {
		if (this.failNext !== null) {
			const error = this.failNext;
			this.failNext = null;
			throw error;
		}
		if (this.ownerLost) {
			throw new SeamOwnerLostError('in-memory owner epoch moved; another writer took over');
		}
		if (this.appendGates.length > 0) {
			await this.appendGates.shift();
		}
		const seen = new Set<string>();
		for (const draft of drafts) {
			if (this.entries.has(draft.id) || seen.has(draft.id)) {
				// Same domain outcome the sqlite adapter maps the backend's
				// DuplicateEntryError to — ports agree on the error hierarchy.
				throw new SeamStorageError('ENTRY_ID_COLLISION', `entry id already committed: ${draft.id}`);
			}
			seen.add(draft.id);
		}
		const seq = this.headSeq + 1;
		const batch = drafts.map((draft, ordinal) => ({ ...draft, seq, ordinal }));
		for (const entry of batch) this.entries.set(entry.id, entry);
		this.batches.push(batch);
		this.headSeq = seq;
		return { seq, head: seq, entryCount: batch.length };
	}

	getEntry(entryId: string): PortEntry | undefined {
		return this.entries.get(entryId);
	}

	readDeltaChecked(afterSeq: number, _limitBytes: number): PortDelta {
		const entries: PortEntry[] = [];
		let last: number | null = null;
		for (const batch of this.batches) {
			const first = batch[0];
			if (first === undefined || first.seq <= afterSeq) continue;
			for (const entry of batch) entries.push(entry);
			last = first.seq;
		}
		return { entries, nextAfterSeq: last, tornTail: null };
	}

	head(): number {
		return this.headSeq;
	}

	/** Unbounded: the budget checks then rely on the configured ceiling only. */
	maxBatchBytes(): number | null {
		return null;
	}
}

/** Open a real sqlite-zstd backend + port in a temp directory. */
export function openSqliteBackend(
	directory = mkdtempSync(join(tmpdir(), 'durable-seam-')),
	options: SqliteZstdBackendOptions = {},
): {
	readonly directory: string;
	readonly backend: SqliteZstdBackend;
	readonly port: DurableLogPort;
} {
	const backend = SqliteZstdBackend.open(directory, options);
	return { directory, backend, port: sqliteZstdDurableLogPort(backend) };
}

export { loadSqlite3Constructor, mkdtempSync, join, tmpdir };
export type { SqliteZstdBackend } from '../../durable-backend-sqlite-zstd/src/index.js';
