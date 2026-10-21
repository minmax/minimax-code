/**
 * Two clients against one hub, and the cursor/replay contract: independent
 * live streams, exactly-once delivery from an explicit anchor, and explicit
 * gaps for unretained cursors. (The ask's "two clients" and "cursor/replay"
 * gates; all over the in-memory transport.)
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
	isEventFrame,
	isReplayGap,
	attachClient,
	hello,
	setupHub,
	waitForResponse,
	waitForSuccess,
} from './helpers.js';

describe('two clients', () => {
	it('fans live events out to both clients, in order, with shared cursors', async () => {
		const { hub } = await setupHub();
		const a = attachClient(hub, 'a');
		const b = attachClient(hub, 'b');
		await hello(a);
		await hello(b);
		a.send({ type: 'events' });
		b.send({ type: 'events' });
		await waitForResponse(a, (frame) => frame.command === 'events');
		await waitForResponse(b, (frame) => frame.command === 'events');

		a.send({ type: 'prompt', id: 'p1', message: 'share me' });
		const aEvents = await a.events(4);
		const bEvents = await b.events(4);
		expect(aEvents.map((frame) => frame.cursor)).toEqual(['1', '2', '3', '4']);
		expect(bEvents.map((frame) => frame.cursor)).toEqual(['1', '2', '3', '4']);
		expect(bEvents.map((frame) => frame.event)).toEqual(aEvents.map((frame) => frame.event));
	});

	it('keeps one client closing from affecting the other', async () => {
		const { hub } = await setupHub();
		const a = attachClient(hub, 'a');
		const b = attachClient(hub, 'b');
		await hello(a);
		await hello(b);
		for (const client of [a, b]) {
			client.send({ type: 'events' });
			await waitForResponse(client, (frame) => frame.command === 'events');
		}

		b.close();
		a.send({ type: 'prompt', message: 'still there?' });
		const aEvents = await a.events(4);
		expect(aEvents[0]?.cursor).toBe('1');
		expect(hub.head).toBe('4');
	});
});

describe('cursor/replay', () => {
	it('replays the full retained window to a late client with no anchor', async () => {
		const { hub } = await setupHub();
		const a = attachClient(hub, 'a');
		await hello(a);
		a.send({ type: 'events' });
		await waitForResponse(a, (frame) => frame.command === 'events');
		a.send({ type: 'prompt', id: 'p1', message: 'history' });
		const live = await a.events(4);
		expect(live.map((frame) => frame.cursor)).toEqual(['1', '2', '3', '4']);

		const late = attachClient(hub, 'late');
		await hello(late);
		late.send({ type: 'events' });
		const attachResponse = await waitForSuccess(late, (frame) => frame.command === 'events');
		expect(attachResponse.data).toMatchObject({ replayed: 4, head: '4' });
		const replayed = await late.events(4);
		expect(replayed.map((frame) => frame.cursor)).toEqual(['1', '2', '3', '4']);
		expect(hub.head).toBe('4');
	});

	it('resumes exactly after an explicit cursor without duplicates', async () => {
		const { hub } = await setupHub();
		const a = attachClient(hub, 'a');
		await hello(a);
		a.send({ type: 'events' });
		await waitForResponse(a, (frame) => frame.command === 'events');
		a.send({ type: 'prompt', id: 'p1', message: 'first turn' });
		await a.events(4); // cursors 1..4

		// A second live burst happens BEFORE the reconnecting client attaches:
		// it must be covered by the replay, not by the live path.
		a.send({ type: 'steer', message: 'second turn' });
		await a.waitFor((frame) => isEventFrame(frame) && frame.cursor === '5');

		const reconnected = attachClient(hub, 'reconnected');
		await hello(reconnected);
		reconnected.send({ type: 'events', after: '2' });
		const attachResponse = await waitForSuccess(
			reconnected,
			(frame) => frame.command === 'events',
		);
		expect(attachResponse.data).toMatchObject({ replayed: 3, head: '5' });
		const resumed = await reconnected.events(3);
		expect(resumed.map((frame) => frame.cursor)).toEqual(['3', '4', '5']);
	});

	it('anchors at head deliver only live events (no replay)', async () => {
		const { hub } = await setupHub();
		const a = attachClient(hub, 'a');
		await hello(a);
		a.send({ type: 'events' });
		await waitForResponse(a, (frame) => frame.command === 'events');
		a.send({ type: 'prompt', message: 'seed' });
		await a.events(4);

		const fresh = attachClient(hub, 'fresh');
		await hello(fresh);
		fresh.send({ type: 'events', after: hub.head ?? '0' });
		const attachResponse = await waitForSuccess(fresh, (frame) => frame.command === 'events');
		expect(attachResponse.data).toMatchObject({ replayed: 0, head: '4' });

		a.send({ type: 'prompt', message: 'live only' });
		const live = await fresh.events(4);
		expect(live.map((frame) => frame.cursor)).toEqual(['5', '6', '7', '8']);
	});

	it('answers an evicted or unknown cursor with replay_gap, then accepts resync', async () => {
		const { hub } = await setupHub({ replayLimits: { maxFrames: 4 } });
		const a = attachClient(hub, 'a');
		await hello(a);
		a.send({ type: 'events' });
		await waitForResponse(a, (frame) => frame.command === 'events');

		// Two turns: the first turn's cursors (1..4) fall out of the 4-frame ring.
		a.send({ type: 'prompt', message: 'turn one' });
		await a.events(4);
		a.send({ type: 'prompt', message: 'turn two' });
		await a.events(4);

		const resync = attachClient(hub, 'resync');
		await hello(resync);
		resync.send({ type: 'events', after: '1' });
		const gap = await resync.waitFor(isReplayGap);
		expect(gap).toMatchObject({ type: 'replay_gap', after: '1', head: '8' });

		// The documented recovery: re-anchor at the reported head.
		resync.send({ type: 'events', after: '8' });
		const attachResponse = await waitForSuccess(resync, (frame) => frame.command === 'events');
		expect(attachResponse.data).toMatchObject({ replayed: 0, head: '8' });
		resync.close();
	});

	it('never delivers the same cursor twice to one client across replay and live', async () => {
		const { hub } = await setupHub();
		const a = attachClient(hub, 'a');
		const b = attachClient(hub, 'b');
		await hello(a);
		await hello(b);
		a.send({ type: 'events' });
		b.send({ type: 'events' });
		await waitForResponse(a, (frame) => frame.command === 'events');
		await waitForResponse(b, (frame) => frame.command === 'events');

		a.send({ type: 'prompt', message: 'exactly once' });
		const aEvents = await a.events(4);
		const bEvents = await b.events(4);
		const cursors = [...aEvents, ...bEvents].map((frame) => frame.cursor).sort();
		// Both streams complete; no cursor appears twice within either stream.
		expect(new Set(aEvents.map((frame) => frame.cursor)).size).toBe(4);
		expect(new Set(bEvents.map((frame) => frame.cursor)).size).toBe(4);
		expect(cursors.filter((cursor) => cursor === '1').length).toBe(2); // once per client
	});
});
