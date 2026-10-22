/**
 * The RPC wire over the in-memory transport: handshake and version pinning,
 * request-id correlation, error discipline, and the echo-stub event flow.
 * Socket-level behavior is daemon-lifecycle.test.ts's job.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { PushableIterable } from '../src/runtime-adapter.js';
import {
	isEventFrame,
	isReplayGap,
	isResponse,
	attachClient,
	hello,
	setupHub,
	waitForFailure,
	waitForResponse,
	waitForSuccess,
} from './helpers.js';

describe('handshake (version)', () => {
	it('welcomes a matching version with the current head cursor', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		const response = await hello(client);
		expect(response.success).toBe(true);
		expect(response.data).toEqual({ version: 1, head: null });
	});

	it('refuses a mismatched version and closes the connection', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		client.send({ type: 'hello', version: 99 });
		const response = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(response.error).toContain('99');
		await client.closed(); // daemon hung up after the failed handshake
	});

	it('answers a non-hello first frame without dropping the connection', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		client.send({ type: 'prompt', message: 'early' });
		const response = await waitForFailure(client);
		expect(response.error).toContain('handshake');
		// The client can still recover by sending the handshake now.
		const welcome = await hello(client);
		expect(welcome.success).toBe(true);
	});

	it('answers an unparsable line with a failed response, not a crash', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		client.sendRaw('this is not json');
		const response = await waitForFailure(client);
		expect(response.error).toContain('not valid JSON');
		// The stream survives: a well-formed hello still works.
		expect((await hello(client)).success).toBe(true);
	});

	it('echoes the declared command on shape violations', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		expect((await hello(client)).success).toBe(true);
		client.sendRaw(JSON.stringify({ type: 'prompt' })); // no message
		const response = await waitForFailure(client);
		expect(response.command).toBe('prompt');
	});

	it('rejects a second hello on an open connection', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		expect((await hello(client)).success).toBe(true);
		client.send({ type: 'hello', version: 1 });
		const response = await waitForFailure(client, (frame) => frame.command === 'hello');
		expect(response.error).toContain('already handshaken');
	});
});

describe('mutations (request-id correlation)', () => {
	it('echoes the client request-id on prompt/steer/follow_up responses', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		await hello(client);

		client.send({ type: 'prompt', id: 'req-1', message: 'hello world' });
		const promptResponse = await waitForSuccess(client, (frame) => frame.command === 'prompt');
		expect(promptResponse).toMatchObject({
			type: 'response',
			command: 'prompt',
			id: 'req-1',
			success: true,
		});

		client.send({ type: 'steer', id: 'req-2', message: 'focus' });
		const steerResponse = await waitForSuccess(client, (frame) => frame.command === 'steer');
		expect(steerResponse).toMatchObject({ command: 'steer', id: 'req-2', success: true });

		client.send({ type: 'follow_up', id: 'req-3', message: 'then what' });
		const followUpResponse = await waitForSuccess(
			client,
			(frame) => frame.command === 'follow_up',
		);
		expect(followUpResponse).toMatchObject({ command: 'follow_up', id: 'req-3', success: true });
	});

	it('mints unique request-ids when the client omits them', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		await hello(client);
		client.send({ type: 'prompt', message: 'one' });
		client.send({ type: 'prompt', message: 'two' });
		const first = await waitForResponse(client, (frame) => frame.success);
		const second = await waitForResponse(client, (frame) => frame.success);
		expect(first.id).toBeDefined();
		expect(second.id).toBeDefined();
		expect(first.id).not.toBe(second.id);
	});

	it('surfaces adapter failures as failed responses carrying the request-id', async () => {
		const events = new PushableIterable<unknown>();
		const { hub } = await setupHub({
			adapter: {
				submit: () => Promise.reject(new Error('runtime exploded')),
				abort: () => Promise.resolve(),
				events,
				stop: () => events.end(),
			},
		});
		const client = attachClient(hub, 'a');
		await hello(client);
		client.send({ type: 'prompt', id: 'req-9', message: 'boom' });
		const response = await waitForFailure(client, (frame) => frame.command === 'prompt');
		expect(response).toMatchObject({ command: 'prompt', id: 'req-9', success: false });
		expect(response.error).toContain('runtime exploded');
	});

	it('aborts through the adapter and answers the abort response', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		await hello(client);
		client.send({ type: 'events' });
		await waitForResponse(client, (frame) => frame.command === 'events');
		client.send({ type: 'abort', id: 'req-abort' });
		const response = await waitForSuccess(client, (frame) => frame.command === 'abort');
		expect(response).toMatchObject({ command: 'abort', id: 'req-abort', success: true });
		const event = await client.waitFor(isEventFrame);
		expect(event.event).toMatchObject({ type: 'turn_aborted' });
	});
});

describe('event stream (stubs over the wire)', () => {
	it('streams stub events with increasing cursors after attach', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		await hello(client);
		client.send({ type: 'events' });
		const attachResponse = await waitForResponse(client, (frame) => frame.command === 'events');
		expect(attachResponse.success).toBe(true);

		client.send({ type: 'prompt', id: 'p1', message: 'abc' });
		const events = await client.events(4); // started + 2 deltas + completed
		expect(events.map((frame) => frame.cursor)).toEqual(['1', '2', '3', '4']);
		expect(events[0]?.event).toMatchObject({ type: 'message_started', requestId: 'p1' });
		expect(events.map((frame) => (frame.event as { type: string }).type)).toEqual([
			'message_started',
			'message_delta',
			'message_delta',
			'message_completed',
		]);
		expect(hub.head).toBe('4');
	});

	it('does not deliver events to clients that never attached', async () => {
		const { hub } = await setupHub();
		const listener = attachClient(hub, 'listener');
		const silent = attachClient(hub, 'silent');
		await hello(listener);
		await hello(silent);
		listener.send({ type: 'events' });
		await listener.waitFor((frame) => isResponse(frame) && frame.command === 'events');

		listener.send({ type: 'prompt', message: 'only for listener' });
		const events = await listener.events(4); // started + 2 deltas + completed
		expect(events.length).toBe(4);
		// The silent client sees no event frames at all.
		expect(silent.received.some(isEventFrame)).toBe(false);
		silent.close();
	});
});

describe('shutdown command', () => {
	it('acks and hands the request to the daemon callback', async () => {
		const { hub } = await setupHub();
		let requested = 0;
		hub.onShutdownRequested = () => {
			requested += 1;
		};
		const client = attachClient(hub, 'a');
		await hello(client);
		client.send({ type: 'shutdown', id: 'bye-1' });
		const response = await client.waitFor(
			(frame) => isResponse(frame) && frame.command === 'shutdown',
		);
		expect(response).toMatchObject({ command: 'shutdown', id: 'bye-1', success: true });
		expect(requested).toBe(1);
	});
});

describe('replay_gap shape', () => {
	it('names the requested cursor and the head', async () => {
		const { hub } = await setupHub();
		const client = attachClient(hub, 'a');
		await hello(client);
		client.send({ type: 'events' });
		await waitForResponse(client, (frame) => frame.command === 'events');
		client.send({ type: 'prompt', message: 'seed' });
		await client.events(4);
		client.send({ type: 'events', after: '404' });
		const gap = await client.waitFor(isReplayGap);
		expect(gap).toMatchObject({ type: 'replay_gap', after: '404', head: '4' });
	});
});
