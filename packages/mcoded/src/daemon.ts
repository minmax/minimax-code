/**
 * The mcoded daemon shell: owns the unix listening socket and wires it to the
 * {@link McodedHub}.
 *
 * Startup covers the Ф4 bootstrap requirements:
 * - the socket path comes from the durable layout (`resolveMcodedSocketPath`);
 * - the socket file gets `0600` permissions (one daemon per profile; only the
 *   owning user may talk to it);
 * - launchd/systemd-style socket activation: when the process was started
 *   with a pre-bound listening fd (`LISTEN_FDS`), that fd is adopted instead
 *   of binding a fresh socket;
 * - crash-only restart: a stale socket file left behind by a dead process is
 *   detected (nothing answers on it) and replaced; a socket that still answers
 *   means a live daemon owns the profile and startup refuses.
 *
 * Shutdown is graceful by default: stop accepting, drain the hub, persist the
 * checkpoint, then close and (when we bound it ourselves) unlink the socket.
 *
 * @module
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { ensureDurableLayout, resolveMcodedSocketPath } from '@mavis/config';

import { FileCheckpointStore } from './checkpoint.js';
import { McodedHub, type McodedHubOptions } from './hub.js';
import { EchoRuntimeAdapter, type RuntimeAdapter } from './runtime-adapter.js';
import { SocketLineTransport } from './socket-transport.js';

/** First inherited fd number of the socket-activation convention (fd 3). */
export const LISTEN_FD_START = 3;

/**
 * Servers in this process that a daemon already adopted as-is. Guards the
 * one-daemon-per-fd invariant on the reuse path: a second daemon asking for
 * the same loop-registered fd refuses instead of attaching a second hub.
 */
const adoptedServers = new WeakSet<net.Server>();

/**
 * Find the server of this process that already listens on `fd`, if any.
 *
 * Node refuses a second `listen({ fd })` on a handle that is registered in
 * the same event loop with `EEXIST` (and destroys the fresh handle), which is
 * exactly the in-process socket-activation shape: the supervisor — or the
 * test double — listens first, the daemon adopts second. Adoption therefore
 * reuses that server as-is instead of re-listening it.
 */
function findLoopServerByFd(fd: number): net.Server | null {
	const active =
		(process as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
	for (const resource of active) {
		if (resource instanceof net.Server) {
			const handle = (resource as { _handle?: { fd?: number } | null })._handle;
			if (handle && handle.fd === fd) return resource;
		}
	}
	return null;
}

/**
 * Read the socket-activation environment: return the listening fd the parent
 * passed, or `null` when the process was started cold.
 *
 * Recognizes the shared `LISTEN_FDS` convention (systemd) plus the
 * `LISTEN_PID` guard; launchd check-in can be fronted by the same convention
 * (launchd-compat shims set `LISTEN_FDS=1`).
 */
export function readInheritedListenFd(env: NodeJS.ProcessEnv = process.env): number | null {
	if (process.platform === 'win32') return null;
	const count = env['LISTEN_FDS'];
	if (count === undefined || count === '') return null;
	const pid = env['LISTEN_PID'];
	if (pid !== undefined && pid !== '' && Number(pid) !== process.pid) return null;
	const parsed = Number(count);
	if (!Number.isInteger(parsed) || parsed < 1) return null;
	return LISTEN_FD_START;
}

/** Why a daemon operation refused. */
export type McodedDaemonErrorCode = 'daemon-alive' | 'not-started' | 'unsupported-platform';

/** Typed refusal of a daemon lifecycle operation. */
export class McodedDaemonError extends Error {
	readonly code: McodedDaemonErrorCode;

	constructor(code: McodedDaemonErrorCode, message: string) {
		super(message);
		this.name = 'McodedDaemonError';
		this.code = code;
	}
}

/** Hub tuning forwarded to the {@link McodedHub}. */
export interface DaemonHubOptions {
	/** Replay window limits; defaults to the Ф4 contract budget (2000 / 8 MB). */
	readonly replayLimits?: McodedHubOptions['replayLimits'];
	/** Bounded wait for in-flight submissions during drain. */
	readonly drainTimeoutMs?: number;
}

/** Daemon construction options. */
export interface McodedDaemonOptions {
	/** Durable data root (the socket lives at `resolveMcodedSocketPath(root)`). */
	readonly root: string;
	/** Agent runtime behind the wire. Default: the echo stub. */
	readonly adapter?: RuntimeAdapter;
	/** Hub tuning forwarded as-is (replay limits, drain window). */
	readonly hub?: DaemonHubOptions;
	/**
	 * Explicit socket-activation fd; `null` disables adoption entirely.
	 * Default: follow the `LISTEN_FDS` environment.
	 */
	readonly listenFd?: number | null;
	/** Checkpoint file name inside `root`. Default `mcoded-checkpoint.json`. */
	readonly checkpointFileName?: string;
}

/**
 * The resident daemon: unix socket in front of an {@link McodedHub}.
 *
 * The skeleton ships {@link EchoRuntimeAdapter} as the runtime; the Ф4
 * product version injects the live conversation runtime through
 * `options.adapter` without touching this class.
 */
export class McodedDaemon {
	private readonly root: string;
	private readonly adapter: RuntimeAdapter;
	private readonly hubOptions: DaemonHubOptions | undefined;
	private readonly listenFdOverride: number | null | undefined;
	private readonly checkpointFileName: string;

	private server: net.Server | undefined;
	private hubInstance: McodedHub | undefined;
	private readonly connections = new Set<SocketLineTransport>();
	private adoptedFd: number | null = null;
	private selfBound = false;
	/**
	 * Set when adoption reused an already-listening server of this process
	 * (in-process socket activation): we never owned its handle, so shutdown
	 * detaches our wiring and leaves the server — and the socket path — to
	 * its owner.
	 */
	private borrowedServer: net.Server | undefined;
	private connectionListener: ((socket: net.Socket) => void) | undefined;
	private starting: Promise<void> | undefined;

	readonly socketPath: string;

	constructor(options: McodedDaemonOptions) {
		this.root = options.root;
		this.adapter = options.adapter ?? new EchoRuntimeAdapter();
		this.hubOptions = options.hub;
		this.listenFdOverride = options.listenFd;
		this.checkpointFileName = options.checkpointFileName ?? 'mcoded-checkpoint.json';
		this.socketPath = resolveMcodedSocketPath(this.root);
	}

	/** The hub behind the socket (available after `start`). */
	get hub(): McodedHub {
		if (!this.hubInstance) throw new McodedDaemonError('not-started', 'daemon is not started');
		return this.hubInstance;
	}

	/** Whether the socket is listening. */
	get isListening(): boolean {
		return this.server?.listening ?? false;
	}

	/** Whether the listening socket was adopted from `LISTEN_FDS`. */
	get isAdopted(): boolean {
		return this.adoptedFd !== null;
	}

	/**
	 * Bind (or adopt) the socket and start serving.
	 *
	 * Idempotent within one instance: a second call awaits the first.
	 */
	start(): Promise<void> {
		this.starting ??= this.startOnce();
		return this.starting;
	}

	/**
	 * Graceful shutdown: stop accepting, drain the hub (queued frames,
	 * in-flight submissions), persist the checkpoint, close the socket. The
	 * socket file is unlinked only when this process bound it itself — an
	 * adopted (socket-activation) fd belongs to the supervisor, which owns
	 * the path.
	 */
	async shutdown(): Promise<void> {
		const server = this.server;
		if (!server) return;
		const hub = this.hubInstance;
		this.server = undefined;
		this.hubInstance = undefined;
		// Drain first: refuse new work, flush in-flight submissions, persist
		// the checkpoint, say bye. Only then does the socket actually go away.
		await hub?.shutdown();
		this.detachConnections(server);
		if (this.borrowedServer) {
			// Never ours: leave the server (and the socket path) with its owner.
			this.releaseBorrowedServer();
			return;
		}
		await new Promise<void>((resolve) => {
			// Bounded teardown grace: clients should be gone after the hub said
			// bye; anything still hanging on is dropped, not waited for.
			const grace = setTimeout(() => {
				for (const transport of [...this.connections]) transport.destroy();
			}, 1_000);
			grace.unref?.();
			server.close(() => {
				clearTimeout(grace);
				resolve();
			});
		});
		if (this.selfBound) {
			try {
				fs.unlinkSync(this.socketPath);
			} catch {
				// The file may already be gone (stale-socket race) — fine.
			}
		}
		this.selfBound = false;
		this.adoptedFd = null;
		this.starting = undefined;
	}

	/**
	 * Test/crash seam: reproduce an unclean exit — connections drop and the
	 * listener closes without draining and without a checkpoint save, exactly
	 * like a `kill -9`. Whether the socket file survives is platform behavior
	 * (Linux leaves the inode; current darwin unlinks it on close); this
	 * method itself never unlinks. Not part of the product surface.
	 */
	async crash(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		this.hubInstance = undefined;
		for (const transport of [...this.connections]) transport.destroy();
		this.detachConnections(server);
		if (this.borrowedServer) {
			// A crashed daemon does not take the supervisor's server down.
			this.releaseBorrowedServer();
			return;
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
		this.selfBound = false;
		this.adoptedFd = null;
		this.starting = undefined;
	}

	/**
	 * Wire the hub to connections accepted on `server`. Kept as a named
	 * handler so an adopted-as-is (borrowed) server can be released again on
	 * shutdown without disturbing its owner.
	 */
	private attachConnections(server: net.Server): void {
		this.connectionListener = (socket) => {
			const transport = new SocketLineTransport(socket);
			this.connections.add(transport);
			void transport.closed.then(() => this.connections.delete(transport));
			this.hubInstance?.attachTransport(transport);
		};
		server.on('connection', this.connectionListener);
	}

	/** Stop accepting new transports; in-flight ones are dropped by the caller. */
	private detachConnections(server: net.Server): void {
		if (this.connectionListener) {
			server.off('connection', this.connectionListener);
			this.connectionListener = undefined;
		}
	}

	/** Give the borrowed (adopted-as-is) server back to its owner. */
	private releaseBorrowedServer(): void {
		const borrowed = this.borrowedServer;
		this.borrowedServer = undefined;
		if (borrowed) adoptedServers.delete(borrowed);
		this.selfBound = false;
		this.adoptedFd = null;
		this.starting = undefined;
	}

	private async startOnce(): Promise<void> {
		if (process.platform === 'win32') {
			throw new McodedDaemonError(
				'unsupported-platform',
				'mcoded skeleton listens on unix-domain sockets only; Windows support lands with the Ф4 runtime',
			);
		}
		// The durable layout is the idempotent on-disk precondition (it also
		// refuses legacy-family roots for free).
		ensureDurableLayout(this.root);

		const hub = new McodedHub({
			adapter: this.adapter,
			checkpoint: new FileCheckpointStore(path.join(this.root, this.checkpointFileName)),
			replayLimits: this.hubOptions?.replayLimits,
			drainTimeoutMs: this.hubOptions?.drainTimeoutMs,
		});

		const requestedFd =
			this.listenFdOverride === undefined ? readInheritedListenFd() : this.listenFdOverride;
		const server = net.createServer();
		let serving: net.Server;
		if (requestedFd !== null) {
			serving = await this.listenAdopted(server, requestedFd);
		} else {
			await this.listenFresh(server);
			serving = server;
		}

		this.attachConnections(serving);

		this.server = serving;
		this.hubInstance = hub;
		await hub.start();
	}

	/**
	 * Adopt a pre-bound listening fd (socket activation).
	 *
	 * The fd may already be listening when the daemon starts — that is the
	 * point of socket activation. Adoption never re-listens such a socket:
	 * - A server of THIS event loop already holds the fd (in-process
	 *   supervisor, test double). Node refuses any second `listen({ fd })` on
	 *   a loop-registered handle with `EEXIST` and destroys the fresh handle,
	 *   so the existing server is adopted as-is: the daemon attaches its
	 *   connection wiring to it and serves through it. The handle — and the
	 *   socket path — stay with the owner. Discovery runs over the loop's
	 *   active handles, which report ref'd owners; an unref'd owner (or a
	 *   non-`net.Server` holder) falls through to the shape below.
	 * - The fd comes from a cross-process supervisor (systemd/launchd), or
	 *   the in-process owner is not discoverable. If the platform allows
	 *   re-listening (older Linux kernels), Node binds the handle to the fd
	 *   and the daemon serves. Otherwise `listen()` fails with `EEXIST` —
	 *   read as "already listening": the fd is adopted without a re-listen
	 *   rather than refused (accepting stays with the owner of the socket).
	 * - Any other error is not an adoption shape and surfaces as the typed
	 *   {@link McodedDaemonError} refusal.
	 *
	 * Returns the server the daemon serves on.
	 */
	private async listenAdopted(server: net.Server, fd: number): Promise<net.Server> {
		this.adoptedFd = fd;

		const existing = findLoopServerByFd(fd);
		if (existing) {
			if (adoptedServers.has(existing)) {
				this.adoptedFd = null;
				throw new McodedDaemonError(
					'daemon-alive',
					`listen fd ${fd} is already adopted by another mcoded daemon`,
				);
			}
			adoptedServers.add(existing);
			this.borrowedServer = existing;
			return existing;
		}

		return await new Promise<net.Server>((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException) => {
				cleanup();
				if (error.code === 'EEXIST') {
					// Already listening: the inherited fd stays with its owner
					// (cross-process supervisor). Adopted as-is, no re-listen.
					this.chmodSocketBestEffort();
					resolve(server);
					return;
				}
				this.adoptedFd = null;
				reject(
					new McodedDaemonError(
						'not-started',
						`could not adopt inherited listen fd ${fd}: ${error.code ?? error.message}. ` +
							(this.platformCannotReListen(error.code)
								? // Node calls listen() on the inherited fd; a socket that
									// cannot take the listen() call leaves the handle dead.
									'The fd exists but Node cannot listen on it; ' +
									'pass the socket path and let the daemon bind, or check ' +
									'the supervisor hand-off.'
								: error.message),
					),
				);
			};
			const cleanup = () => server.off('error', onError);
			server.once('error', onError);
			server.listen({ fd }, () => {
				cleanup();
				this.chmodSocketBestEffort();
				resolve(server);
			});
		});
	}

	/** Error codes that mean "the fd cannot take a listen() call at all". */
	private platformCannotReListen(code: string | undefined): boolean {
		return (
			code === 'EADDRINUSE' || code === 'EINVAL' || code === 'EALREADY' || code === 'EISCONN'
		);
	}

	/**
	 * Bind a fresh socket, replacing any stale file a crashed predecessor
	 * left, but never disturbing a socket a live daemon owns.
	 */
	private async listenFresh(server: net.Server): Promise<void> {
		if (fs.existsSync(this.socketPath)) {
			if (await this.socketAnswers()) {
				throw new McodedDaemonError(
					'daemon-alive',
					`another mcoded daemon owns ${this.socketPath}; one daemon per durable root`,
				);
			}
			// Nobody answers: the file is debris from a crashed process.
			fs.unlinkSync(this.socketPath);
		}
		await new Promise<void>((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException) => {
				cleanup();
				if (error.code === 'EADDRINUSE') {
					reject(
						new McodedDaemonError(
							'daemon-alive',
							`socket ${this.socketPath} is taken by another listener`,
						),
					);
					return;
				}
				reject(error);
			};
			const cleanup = () => server.off('error', onError);
			server.once('error', onError);
			server.listen(this.socketPath, () => {
				cleanup();
				this.selfBound = true;
				this.chmodSocketBestEffort();
				resolve();
			});
		});
	}

	/** Probe whether anything accepts connections on the existing socket file. */
	private socketAnswers(): Promise<boolean> {
		return new Promise((resolve) => {
			const probe = net.connect(this.socketPath);
			probe.once('connect', () => {
				probe.destroy();
				resolve(true);
			});
			probe.once('error', () => {
				probe.destroy();
				resolve(false);
			});
		});
	}

	/**
	 * Enforce `0600` on the socket file. Best-effort: the path may not resolve
	 * for supervisor-managed sockets; missing the chmod only leaves the
	 * umask default in place, never widens access.
	 */
	private chmodSocketBestEffort(): void {
		try {
			fs.chmodSync(this.socketPath, 0o600);
		} catch {
			// Adopted sockets: the supervisor owns the path; leave it be.
		}
	}
}
