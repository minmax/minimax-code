/**
 * The daemon's durable sliver of state: the checkpoint that makes restarts
 * crash-only. Everything else the daemon holds (connections, the replay ring,
 * in-flight turns) is rebuildable or disposable; the one thing that must not
 * regress across restarts is the event-sequence watermark, or cursors already
 * delivered to clients would be reassigned to different events after a crash.
 *
 * The Ф4 product version folds the watermark into the real durable write path
 * (events become durable entries, cursor = durable sequence). The skeleton
 * persists a small JSON document under the durable root with atomic
 * tmp-rename semantics, coalesced by the hub so appends never block on disk.
 *
 * @module
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { MCODED_PROTOCOL_VERSION } from './protocol.js';

/** File name of the default checkpoint document inside the durable root. */
export const MCODED_CHECKPOINT_BASENAME = 'mcoded-checkpoint.json';

/** The durable state snapshot the daemon writes and reloads. */
export interface DaemonCheckpoint {
	/** Schema version of the checkpoint document itself. */
	readonly checkpointVersion: 1;
	/** Protocol version that wrote the checkpoint (see `MCODED_PROTOCOL_VERSION`). */
	readonly protocolVersion: typeof MCODED_PROTOCOL_VERSION;
	/**
	 * Newest event sequence number ever assigned by the writing process.
	 * `0` until the first event. A restart resumes at `lastSeq + 1`, so
	 * cursors never repeat — even when the previous process crashed before
	 * its final save, the worst case skips a range, never reuses one.
	 */
	readonly lastSeq: number;
	/** Wall-clock timestamp of the save (observability only). */
	readonly savedAtMs: number;
}

/** Persistence seam for {@link DaemonCheckpoint}. */
export interface CheckpointStore {
	load(): Promise<DaemonCheckpoint | null>;
	save(checkpoint: DaemonCheckpoint): Promise<void>;
}

/** Build a checkpoint document at a given watermark. */
export function makeCheckpoint(lastSeq: number, now: number = Date.now()): DaemonCheckpoint {
	return { checkpointVersion: 1, protocolVersion: 1, lastSeq, savedAtMs: now };
}

/** In-memory store: process-local default for embedders and tests. */
export class InMemoryCheckpointStore implements CheckpointStore {
	private checkpoint: DaemonCheckpoint | null = null;

	constructor(initial: DaemonCheckpoint | null = null) {
		this.checkpoint = initial;
	}

	async load(): Promise<DaemonCheckpoint | null> {
		return this.checkpoint;
	}

	async save(checkpoint: DaemonCheckpoint): Promise<void> {
		this.checkpoint = checkpoint;
	}
}

/**
 * Single-file JSON store with atomic publish (write temp sibling, rename).
 * A crash mid-save leaves the previous checkpoint intact; a missing file
 * reads as "no durable state yet".
 *
 * Saves are internally serialized: the hub's coalesced writer and a graceful
 * shutdown flush can overlap, and two concurrent tmp-rename cycles would race
 * for the same temp file.
 */
export class FileCheckpointStore implements CheckpointStore {
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly filePath: string,
		private readonly tempPath: string = `${filePath}.tmp`,
	) {}

	async load(): Promise<DaemonCheckpoint | null> {
		let raw: string;
		try {
			raw = await fs.readFile(this.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			(parsed as DaemonCheckpoint).checkpointVersion !== 1 ||
			typeof (parsed as DaemonCheckpoint).lastSeq !== 'number'
		) {
			throw new Error(`Unreadable mcoded checkpoint at ${this.filePath}`);
		}
		return parsed as DaemonCheckpoint;
	}

	async save(checkpoint: DaemonCheckpoint): Promise<void> {
		const run = this.writeQueue.then(() => this.writeOnce(checkpoint));
		this.writeQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async writeOnce(checkpoint: DaemonCheckpoint): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		await fs.writeFile(this.tempPath, `${JSON.stringify(checkpoint, null, '\t')}\n`, 'utf8');
		await fs.rename(this.tempPath, this.filePath);
	}
}
