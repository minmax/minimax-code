/**
 * The daemon over a real unix socket: durable-path binding with 0600, start /
 * graceful restart / crash-only restart, stale-socket recovery, the one-daemon-
 * per-root refusal, socket-activation fd adoption and the argv surface.
 *
 * Socket-specific suites are skipped on Windows (no unix sockets); the rest of
 * the package still runs there.
 *
 * @module
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveMcodedSocketPath } from '@mavis/config';

import { McodedDaemon, McodedDaemonError, readInheritedListenFd } from '../src/daemon.js';
import { mcodedMain, parseMcodedArgs } from '../src/main.js';
import { makeCheckpoint } from '../src/checkpoint.js';
import { hello, waitForResponse, connectClient } from './helpers.js';

const unixSockets = process.platform !== 'win32';
const describeSocket = unixSockets ? describe : describe.skip;

const tempRoots: string[] = [];

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcoded-lifecycle-'));
	tempRoots.push(root);
});

afterAll(() => {
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function freshRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcoded-root-'));
	tempRoots.push(root);
	return root;
}

describeSocket('start (durable-path socket)', () => {
	it('binds resolveMcodedSocketPath(root) with 0600 permissions', async () => {
		const root = freshRoot();
		const daemon = new McodedDaemon({ root, listenFd: null });
		await daemon.start();

		const socketPath = resolveMcodedSocketPath(root);
		expect(daemon.socketPath).toBe(socketPath);
		expect(daemon.isListening).toBe(true);
		expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);

		await daemon.shutdown();
	});

	it('serves the full wire flow over the socket', async () => {
		const root = freshRoot();
		const daemon = new McodedDaemon({ root, listenFd: null });
		await daemon.start();

		const client = await connectClient(daemon.socketPath, 'socket-client');
		const welcome = await hello(client);
		expect(welcome.data).toMatchObject({ version: 1, head: null });

		client.send({ type: 'events' });
		await waitForResponse(client, (frame) => frame.command === 'events');
		client.send({ type: 'prompt', id: 'sock-1', message: 'over the socket' });

		const events = await client.events(4);
		expect(events.map((frame) => frame.cursor)).toEqual(['1', '2', '3', '4']);
		expect(events[0]?.event).toMatchObject({ type: 'message_started', requestId: 'sock-1' });

		client.close();
		await daemon.shutdown();
	});
});

describeSocket('restart', () => {
	it('graceful restart: unlinks the socket and resumes the cursor sequence', async () => {
		const root = freshRoot();
		const first = new McodedDaemon({ root, listenFd: null });
		await first.start();
		const client = await connectClient(first.socketPath);
		await hello(client);
		client.send({ type: 'events' });
		client.send({ type: 'prompt', message: 'before restart' });
		const events = await client.events(4);
		expect(events[3]?.cursor).toBe('4');
		await first.shutdown();

		// The socket file is gone after a graceful self-bound shutdown.
		expect(fs.existsSync(resolveMcodedSocketPath(root))).toBe(false);

		// Restart resumes the sequence after the checkpoint watermark (4).
		const second = new McodedDaemon({ root, listenFd: null });
		await second.start();
		const client2 = await connectClient(second.socketPath);
		const welcome = await hello(client2);
		// The in-memory ring restarts empty (head is null), but the durable
		// watermark survived: the hub resumes counting after 4.
		expect(welcome.data).toMatchObject({ head: null });
		expect(second.hub.sequenceWatermark).toBe(4);
		client2.send({ type: 'events' });
		client2.send({ type: 'prompt', message: 'after restart' });
		const resumed = await client2.events(4);
		expect(resumed.map((frame) => frame.cursor)).toEqual(['5', '6', '7', '8']);

		// Cursors of the previous life are not retained by the fresh ring, so
		// a reconnect behind the head is an explicit replay_gap — the client
		// re-syncs; nothing is ever silently skipped.
		client2.send({ type: 'events', after: '2' });
		const gap = await client2.waitFor((frame) => frame.type === 'replay_gap');
		expect(gap).toMatchObject({ type: 'replay_gap', after: '2', head: '8' });

		client.close();
		client2.close();
		await second.shutdown();
	});

	it('refuses a second daemon while one is live on the same root', async () => {
		const root = freshRoot();
		const first = new McodedDaemon({ root, listenFd: null });
		await first.start();
		const second = new McodedDaemon({ root, listenFd: null });
		await expect(second.start()).rejects.toMatchObject({
			name: 'McodedDaemonError',
			code: 'daemon-alive',
		});
		await expect(second.start()).rejects.toBeInstanceOf(McodedDaemonError);
		await first.shutdown();
	});

	it('recovers from a stale socket file left by a crashed process', async () => {
		const root = freshRoot();
		const socketPath = resolveMcodedSocketPath(root);
		// Debris of a kill -9: a socket file nobody answers on. A regular file
		// behaves identically for the recovery path.
		fs.writeFileSync(socketPath, 'stale debris');

		const daemon = new McodedDaemon({ root, listenFd: null });
		await daemon.start();
		expect(daemon.isListening).toBe(true);

		const client = await connectClient(socketPath);
		expect((await hello(client)).success).toBe(true);
		client.close();
		await daemon.shutdown();
	});
});

describeSocket('crash-only restart', () => {
	it('a crash leaves the socket behind; the next start recovers and keeps cursors unique', async () => {
		const root = freshRoot();
		const daemon = new McodedDaemon({ root, listenFd: null });
		await daemon.start();
		const client = await connectClient(daemon.socketPath);
		await hello(client);
		client.send({ type: 'events' });
		await waitForResponse(client, (frame) => frame.command === 'events');
		client.send({ type: 'prompt', message: 'about to crash' });
		await client.events(4);
		// Let the coalesced checkpoint writer settle, then crash uncleanly:
		// no drain, no final save, socket file left on disk — kill -9 debris.
		await daemon.hub.flushCheckpoint();
		await daemon.crash();
		expect(daemon.isListening).toBe(false);
		// Whether the socket file survives a crash is platform behavior:
		// Linux leaves the inode behind, current darwin unlinks it on close.
		// Either way the next start must recover — the synthetic-debris test
		// above pins the recovery path for the Linux-shaped leftover.

		const restarted = new McodedDaemon({ root, listenFd: null });
		await restarted.start();
		const client2 = await connectClient(restarted.socketPath);
		const welcome = await hello(client2);
		// Crash-only invariant: the in-memory ring restarts empty, but the
		// sequence continues after the last durable watermark — cursors are
		// skipped forward, never reused.
		expect(welcome.data).toMatchObject({ head: null });
		expect(restarted.hub.sequenceWatermark).toBe(4);
		client2.send({ type: 'events' });
		client2.send({ type: 'prompt', message: 'post-crash' });
		const resumed = await client2.events(4);
		expect(resumed[0]?.cursor).toBe('5');

		client.close();
		client2.close();
		await restarted.shutdown();
	});

	it('seeds the sequence from the durable checkpoint across restarts', async () => {
		const root = freshRoot();
		const checkpointPath = path.join(root, 'mcoded-checkpoint.json');
		// A checkpoint left by a previous life at watermark 100.
		fs.writeFileSync(checkpointPath, JSON.stringify(makeCheckpoint(100, 0)));

		const daemon = new McodedDaemon({ root, listenFd: null });
		await daemon.start();
		const client = await connectClient(daemon.socketPath);
		const welcome = await hello(client);
		expect(welcome.data).toMatchObject({ head: null });
		expect(daemon.hub.sequenceWatermark).toBe(100);
		client.send({ type: 'events' });
		client.send({ type: 'prompt', message: 'new life' });
		const events = await client.events(4);
		expect(events[0]?.cursor).toBe('101');
		client.close();
		await daemon.shutdown();
		// The checkpoint on disk advanced with the new life.
		const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as { lastSeq: number };
		expect(saved.lastSeq).toBe(104);
	});
});

describeSocket('socket activation (LISTEN_FDS)', () => {
	it('parses the inherited-fd environment conservatively', () => {
		expect(readInheritedListenFd({ LISTEN_FDS: '1' })).toBe(3);
		expect(readInheritedListenFd({ LISTEN_FDS: '3' })).toBe(3);
		expect(readInheritedListenFd({ LISTEN_FDS: '1', LISTEN_PID: String(process.pid) })).toBe(3);
		// A foreign LISTEN_PID means the fds were passed to someone else.
		expect(readInheritedListenFd({ LISTEN_FDS: '1', LISTEN_PID: '999999' })).toBeNull();
		// Garbage counts are ignored, not guessed.
		expect(readInheritedListenFd({ LISTEN_FDS: 'zero' })).toBeNull();
		expect(readInheritedListenFd({ LISTEN_FDS: '0' })).toBeNull();
		expect(readInheritedListenFd({})).toBeNull();
	});

	// Adoption of an already-listening fd works where Node may re-listen it
	// (Linux/systemd). On darwin, Node's listen({fd}) fails with EEXIST on an
	// already-listening socket and destroys the handle, which the daemon must
	// surface as a typed, self-explanatory refusal instead of a raw errno.
	it('adopts an inherited listening fd, or refuses with the platform explanation', async () => {
		const root = freshRoot();
		const socketPath = resolveMcodedSocketPath(root);
		const supervisor = net.createServer();
		supervisor.unref();
		await new Promise<void>((resolve) => supervisor.listen(socketPath, resolve));
		const fd = (supervisor as unknown as { _handle: { fd: number } })._handle.fd;
		expect(fd).toBeGreaterThan(0);

		const daemon = new McodedDaemon({ root, listenFd: fd });
		if (process.platform === 'darwin') {
			await expect(daemon.start()).rejects.toSatisfy((error: unknown) => {
				expect(error).toBeInstanceOf(McodedDaemonError);
				const typed = error as McodedDaemonError;
				expect(typed.code).toBe('not-started');
				expect(typed.message).toContain(`fd ${fd}`);
				expect(typed.message).toContain('already-listening');
				return true;
			});
			expect(daemon.isAdopted).toBe(false);
		} else {
			await daemon.start();
			expect(daemon.isAdopted).toBe(true);
			const client = await connectClient(socketPath);
			expect((await hello(client)).success).toBe(true);
			client.close();
			await daemon.shutdown();
			// An adopted socket belongs to the supervisor: the path survives.
			expect(fs.existsSync(socketPath)).toBe(true);
		}
		await new Promise<void>((resolve) => supervisor.close(() => resolve()));
	});

	it('follows LISTEN_FDS from the environment when no override is given', async () => {
		const root = freshRoot();
		const socketPath = resolveMcodedSocketPath(root);
		const supervisor = net.createServer();
		supervisor.unref();
		await new Promise<void>((resolve) => supervisor.listen(socketPath, resolve));

		const previous = { ...process.env };
		process.env['LISTEN_FDS'] = '1';
		process.env['LISTEN_PID'] = String(process.pid);
		try {
			const daemon = new McodedDaemon({ root });
			if (process.platform === 'darwin') {
				// The env was consumed: the daemon tried fd 3 — the supervisor's
				// socket — and surfaced the adoption refusal, not a fresh bind.
				await expect(daemon.start()).rejects.toMatchObject({
					name: 'McodedDaemonError',
					code: 'not-started',
				});
			} else {
				await daemon.start();
				expect(daemon.isAdopted).toBe(true);
				const client = await connectClient(socketPath);
				expect((await hello(client)).success).toBe(true);
				client.close();
				await daemon.shutdown();
			}
		} finally {
			for (const key of Object.keys(process.env)) {
				if (!(key in previous)) delete process.env[key];
			}
			Object.assign(process.env, previous);
			await new Promise<void>((resolve) => supervisor.close(() => resolve()));
		}
	});
});

describe('argv surface (platform-independent)', () => {
	it('parses --profile and --root in both flag and = forms', () => {
		expect(parseMcodedArgs(['--profile', 'work'])).toEqual({ profile: 'work' });
		expect(parseMcodedArgs(['--profile=work'])).toEqual({ profile: 'work' });
		expect(parseMcodedArgs(['--root', '/tmp/r'])).toEqual({ root: '/tmp/r' });
		expect(parseMcodedArgs(['--root=/tmp/r'])).toEqual({ root: '/tmp/r' });
		expect(parseMcodedArgs(['--unknown', 'x', '--profile', 'p'])).toEqual({ profile: 'p' });
		expect(parseMcodedArgs([])).toEqual({});
	});

	it('mcodedMain starts on the resolved root and shuts down cleanly', async () => {
		const root = freshRoot();
		const logs: string[] = [];
		const daemon = await mcodedMain({
			argv: ['--root', root],
			homeDir: path.join(tempRoots[0] as string, 'home'),
			log: (line) => logs.push(line),
		});
		expect(daemon.socketPath).toBe(resolveMcodedSocketPath(root));
		const client = await connectClient(daemon.socketPath);
		expect((await hello(client)).success).toBe(true);
		client.close();
		await daemon.shutdown();
		expect(logs.some((line) => line.includes('listening'))).toBe(true);
	});
});
