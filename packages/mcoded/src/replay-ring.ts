/**
 * The daemon's event replay ring: a bounded, cursor-addressed window of recent
 * runtime events that late or reconnecting clients can replay.
 *
 * Limits follow the shape of the mcode SSE turn stream (`local-runtime`
 * `turn-stream.ts`): a frame cap and a UTF-8 byte cap, evicting oldest-first
 * in one pruning pass. The Ф4 contract pins this ring to 2000 frames / 8 MB
 * (the upstream turn stream currently runs 5000 frames / 8 MB — same byte
 * budget, larger window). Eviction is
 * the only way frames leave the ring before shutdown; once a cursor has been
 * evicted it is gone forever, and a replay anchored before it must fail
 * loudly (`replay_gap`) instead of silently skipping events.
 *
 * @module
 */

import type { Cursor } from './protocol.js';

/** Replay window limits: frame count and total retained payload bytes. */
export interface ReplayLimits {
	/** Maximum number of retained frames; the oldest is evicted beyond it. */
	readonly maxFrames: number;
	/** Maximum total UTF-8 bytes of retained payloads; oldest-first eviction. */
	readonly maxBytes: number;
}

/**
 * Default limits, pinned by the Ф4 contract (2000 frames / 8 MB; the mcode
 * SSE turn stream shares the byte budget with a larger frame window).
 */
export const DEFAULT_REPLAY_LIMITS: ReplayLimits = {
	maxFrames: 2_000,
	maxBytes: 8 * 1024 * 1024,
};

/** One retained event: the opaque payload, its cursor and its measured size. */
export interface ReplayFrame {
	readonly cursor: Cursor;
	/** The runtime event payload, relayed verbatim on the wire. */
	readonly event: unknown;
	/** UTF-8 byte size of the serialized payload; the unit of `maxBytes`. */
	readonly bytes: number;
}

/** Result of a replay request anchored at a client cursor. */
export type ReplaySlice =
	| { ok: true; frames: ReplayFrame[] }
	| { ok: false; head: Cursor | null };

/** Bounded FIFO of event frames with cursor-addressed replay. */
export class ReplayRing {
	private readonly frames: ReplayFrame[] = [];
	private nextSeq = 1;
	private retainedBytes = 0;
	private evictedAny = false;
	private readonly encoder = new TextEncoder();

	constructor(private readonly limits: ReplayLimits = DEFAULT_REPLAY_LIMITS) {
		if (!Number.isInteger(limits.maxFrames) || limits.maxFrames < 1) {
			throw new RangeError(`Invalid replay limit maxFrames ${limits.maxFrames}.`);
		}
		if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 1) {
			throw new RangeError(`Invalid replay limit maxBytes ${limits.maxBytes}.`);
		}
	}

	/**
	 * Rebase the cursor counter — the crash-only restart path. The hub calls
	 * this with the checkpoint watermark + 1 so cursors continue the
	 * daemon-wide sequence instead of restarting it. Valid only while the ring
	 * holds no frames (exactly the state a freshly started daemon is in).
	 */
	resumeFrom(startSeq: number): void {
		if (this.frames.length > 0) {
			throw new Error('ReplayRing.resumeFrom is only valid on an empty ring');
		}
		if (!Number.isInteger(startSeq) || startSeq < 1) {
			throw new RangeError(`Invalid replay ring startSeq ${startSeq}.`);
		}
		this.nextSeq = startSeq;
	}

	/**
	 * Append one event, assign its cursor, prune the window and return the
	 * retained frame. Oversized payloads are assigned a cursor and accepted
	 * (live delivery is the caller's job) but never retained: pruning removes
	 * them immediately, so replaying them is impossible by construction.
	 */
	append(event: unknown): ReplayFrame {
		const frame: ReplayFrame = {
			cursor: String(this.nextSeq++),
			event,
			bytes: this.encoder.encode(JSON.stringify(event)).byteLength,
		};
		this.frames.push(frame);
		this.retainedBytes += frame.bytes;
		this.prune();
		return frame;
	}

	/** Newest retained cursor, or `null` while nothing has been appended. */
	get head(): Cursor | null {
		const last = this.frames[this.frames.length - 1];
		return last?.cursor ?? null;
	}

	/** Oldest retained cursor, or `null` while nothing is retained. */
	get oldest(): Cursor | null {
		return this.frames[0]?.cursor ?? null;
	}

	/** Whether pruning has dropped at least one frame so far. */
	get evicted(): boolean {
		return this.evictedAny;
	}

	/** Current occupancy against the limits. */
	size(): { frames: number; bytes: number } {
		return { frames: this.frames.length, bytes: this.retainedBytes };
	}

	/**
	 * Collect the retained frames strictly after `after`.
	 *
	 * - `after` omitted → the whole retained window (initial attach);
	 * - `after` === head → empty slice (client is current);
	 * - `after` unknown, evicted, or ahead of head → `{ ok: false }`: the
	 *   caller must surface a replay gap instead of guessing.
	 */
	replayAfter(after?: Cursor): ReplaySlice {
		if (after === undefined) {
			return { ok: true, frames: [...this.frames] };
		}
		const index = this.frames.findIndex((frame) => frame.cursor === after);
		if (index < 0) {
			return { ok: false, head: this.head };
		}
		return { ok: true, frames: this.frames.slice(index + 1) };
	}

	/** Evict oldest-first until both limits hold again. */
	private prune(): void {
		while (
			this.frames.length > this.limits.maxFrames ||
			this.retainedBytes > this.limits.maxBytes
		) {
			const dropped = this.frames.shift();
			if (!dropped) return;
			this.retainedBytes -= dropped.bytes;
			this.evictedAny = true;
		}
	}
}
