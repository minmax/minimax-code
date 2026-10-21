/**
 * Replay ring limits (the ask's "ring limits" gate): the mcode SSE budget
 * (2000 frames / 8 MB) is pinned, and eviction behaves oldest-first with an
 * explicit, testable replay gap — never a silent skip.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_REPLAY_LIMITS, ReplayRing } from '../src/replay-ring.js';

describe('default limits (mcode SSE budget)', () => {
	it('pin 2000 frames / 8 MB as the Ф4 contract states', () => {
		expect(DEFAULT_REPLAY_LIMITS.maxFrames).toBe(2_000);
		expect(DEFAULT_REPLAY_LIMITS.maxBytes).toBe(8 * 1024 * 1024);
	});
});

describe('cursor assignment', () => {
	it('assigns monotonically increasing decimal cursors and tracks head', () => {
		const ring = new ReplayRing();
		expect(ring.head).toBeNull();
		const first = ring.append({ n: 1 });
		const second = ring.append({ n: 2 });
		expect(first.cursor).toBe('1');
		expect(second.cursor).toBe('2');
		expect(ring.head).toBe('2');
		expect(ring.size()).toEqual({ frames: 2, bytes: first.bytes + second.bytes });
	});

	it('continues an earlier sequence via resumeFrom (crash-only restart path)', () => {
		const ring = new ReplayRing();
		ring.resumeFrom(41);
		expect(ring.append('a').cursor).toBe('41');
		expect(ring.append('b').cursor).toBe('42');
	});

	it('refuses to rebase a non-empty ring (cursors would fork)', () => {
		const ring = new ReplayRing();
		ring.append('a');
		expect(() => ring.resumeFrom(10)).toThrow(/empty/);
	});

	it('rejects invalid limits and invalid rebases', () => {
		expect(() => new ReplayRing({ maxFrames: 0, maxBytes: 10 })).toThrow(RangeError);
		expect(() => new ReplayRing({ maxFrames: 5, maxBytes: 0 })).toThrow(RangeError);
		const ring = new ReplayRing();
		expect(() => ring.resumeFrom(0)).toThrow(RangeError);
		expect(() => ring.resumeFrom(1.5)).toThrow(RangeError);
	});
});

describe('frame-count eviction', () => {
	it('keeps at most maxFrames, evicting oldest first', () => {
		const ring = new ReplayRing({ maxFrames: 3, maxBytes: 1_000_000 });
		for (const n of [1, 2, 3, 4, 5]) ring.append({ n });
		expect(ring.size().frames).toBe(3);
		expect(ring.oldest).toBe('3');
		expect(ring.head).toBe('5');
		expect(ring.evicted).toBe(true);
	});

	it('answers evicted cursors with an explicit gap, retained ones with a slice', () => {
		const ring = new ReplayRing({ maxFrames: 3, maxBytes: 1_000_000 });
		for (const n of [1, 2, 3, 4, 5]) ring.append({ n });

		const evicted = ring.replayAfter('1');
		expect(evicted.ok).toBe(false);
		if (!evicted.ok) expect(evicted.head).toBe('5');

		const retained = ring.replayAfter('3');
		expect(retained.ok).toBe(true);
		if (retained.ok) {
			expect(retained.frames.map((frame) => frame.cursor)).toEqual(['4', '5']);
		}
	});
});

describe('byte-budget eviction', () => {
	it('never retains more than maxBytes total', () => {
		const ring = new ReplayRing({ maxFrames: 100, maxBytes: 120 });
		for (const n of [1, 2, 3, 4]) ring.append({ text: 'x'.repeat(50) });
		const { frames, bytes } = ring.size();
		expect(bytes).toBeLessThanOrEqual(120);
		expect(frames).toBeGreaterThanOrEqual(1);
		expect(ring.evicted).toBe(true);
	});

	it('does not retain a single payload larger than the whole budget', () => {
		const ring = new ReplayRing({ maxFrames: 10, maxBytes: 10 });
		const frame = ring.append({ text: 'x'.repeat(100) });
		// The frame still got a cursor (live delivery is the hub's job), but
		// nothing is retained and replay is impossible by construction.
		expect(frame.cursor).toBe('1');
		expect(ring.size()).toEqual({ frames: 0, bytes: 0 });
		expect(ring.replayAfter()).toEqual({ ok: true, frames: [] });
		expect(ring.head).toBeNull();
	});
});

describe('replay semantics', () => {
	it('replays the whole retained window when no anchor is given', () => {
		const ring = new ReplayRing();
		ring.append('a');
		ring.append('b');
		const slice = ring.replayAfter();
		expect(slice.ok).toBe(true);
		if (slice.ok) expect(slice.frames.map((frame) => frame.cursor)).toEqual(['1', '2']);
	});

	it('returns an empty slice for a client anchored at head', () => {
		const ring = new ReplayRing();
		ring.append('a');
		ring.append('b');
		const slice = ring.replayAfter('2');
		expect(slice.ok).toBe(true);
		if (slice.ok) expect(slice.frames).toEqual([]);
	});

	it('reports unknown future cursors as a gap with the current head', () => {
		const ring = new ReplayRing();
		ring.append('a');
		const slice = ring.replayAfter('999');
		expect(slice.ok).toBe(false);
		if (!slice.ok) expect(slice.head).toBe('1');
	});
});
