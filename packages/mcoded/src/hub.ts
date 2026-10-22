/**
 * The mcoded hub: the transport-agnostic daemon core. It owns the event
 * sequence, the replay ring, the set of connected clients and the runtime
 * adapter seam; the socket layer in `daemon.ts` only feeds connections in and
 * triggers the graceful shutdown.
 *
 * Semantics pinned here (Ф4 contract):
 * - every runtime event gets one daemon-wide monotonically increasing cursor;
 * - `events` attach without `after` replays the whole retained window, attach
 *   with `after` resumes exactly after that cursor, an unretained cursor
 *   answers `replay_gap` (never a silent skip);
 * - mutations (prompt/steer/follow_up) acknowledge the request-id once the
 *   adapter has accepted the submission;
 * - crash-only recovery: on start the hub loads the checkpoint and resumes the
 *   sequence at `lastSeq + 1`, so a restart never reassigns a cursor;
 * - graceful shutdown: refuse new work, stop the event flow, wait (bounded)
 *   for in-flight submissions, flush the final checkpoint, `bye` every client.
 *
 * @module
 */

import type { CheckpointStore } from './checkpoint.js';
import { makeCheckpoint } from './checkpoint.js';
import {
	type ClientFrame,
	type Cursor,
	type HelloData,
	MCODED_PROTOCOL_VERSION,
	compareCursors,
} from './protocol.js';
import {
	DEFAULT_REPLAY_LIMITS,
	type ReplayFrame,
	type ReplayLimits,
	ReplayRing,
} from './replay-ring.js';
import type { RuntimeAdapter, SubmissionKind } from './runtime-adapter.js';
import type { LineTransport } from './transport.js';
import { RpcConnection, type RpcConnectionHost } from './wire.js';

/** Hub construction options; every field has a skeleton-safe default. */
export interface McodedHubOptions {
	/** The agent runtime behind the wire. */
	readonly adapter: RuntimeAdapter;
	/** Durable checkpoint seam. */
	readonly checkpoint: CheckpointStore;
	/** Replay window limits; defaults to the Ф4 contract budget (2000 / 8 MB). */
	readonly replayLimits?: Partial<ReplayLimits>;
	/** Bounded wait for in-flight submissions during drain. Default 5000 ms. */
	readonly drainTimeoutMs?: number;
}

interface AttachedClient {
	readonly connection: RpcConnection;
	/**
	 * Newest cursor already delivered to this client. `null` means the client
	 * has not attached to the event stream yet; `'0'` means attached while the
	 * stream was empty, so every future cursor is deliverable.
	 */
	lastDelivered: Cursor | null;
}

/** Server core serving RPC connections over any line transports. */
export class McodedHub implements RpcConnectionHost {
	private readonly ring: ReplayRing;
	private readonly clients = new Set<AttachedClient>();
	private readonly pendingSubmissions = new Set<Promise<unknown>>();
	private readonly drainTimeoutMs: number;
	private readonly adapter: RuntimeAdapter;
	private readonly checkpointStore: CheckpointStore;

	private nextSeq = 1;
	private started = false;
	private stopping = false;
	private stopped = false;
	private pumpTask: Promise<void> | undefined;
	private checkpointWrite: Promise<void> = Promise.resolve();
	private checkpointDirty = false;
	private mintedRequestIds = 0;

	/** Set by the daemon: a client asked for a graceful daemon shutdown. */
	onShutdownRequested: (() => void) | undefined;

	constructor(options: McodedHubOptions) {
		this.ring = new ReplayRing({ ...DEFAULT_REPLAY_LIMITS, ...options.replayLimits });
		this.adapter = options.adapter;
		this.checkpointStore = options.checkpoint;
		this.drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
	}

	/** Newest assigned cursor, `null` before the first event. */
	get head(): Cursor | null {
		return this.ring.head;
	}

	/** Sequence watermark of the newest assigned cursor (checkpoint unit). */
	get sequenceWatermark(): number {
		return this.nextSeq - 1;
	}

	/**
	 * Load durable state and start relaying runtime events.
	 *
	 * Crash-only recovery: the replay ring starts empty (event history is
	 * rebuilt from the durable store by the Ф4 runtime), but the cursor
	 * watermark resumes after the checkpoint, so pre-crash client cursors can
	 * only ever land behind the head — surfacing as `replay_gap` — never
	 * collide with new events.
	 */
	async start(): Promise<void> {
		if (this.started) throw new Error('McodedHub.start called twice');
		this.started = true;
		const saved = await this.checkpointStore.load();
		const resumeSeq = (saved?.lastSeq ?? 0) + 1;
		// The ring must continue the durable cursor sequence, not restart it:
		// cursors are only unique across restarts if the new life counts on.
		this.ring.resumeFrom(resumeSeq);
		this.nextSeq = resumeSeq;
		this.pumpTask = this.pumpAdapterEvents();
	}

	/**
	 * Accept one transport as a client connection. The connection reads frames
	 * immediately; until `hello` succeeds the hub serves it nothing.
	 */
	attachTransport(transport: LineTransport): RpcConnection {
		const client: AttachedClient = {
			connection: new RpcConnection(transport, this),
			lastDelivered: null,
		};
		this.clients.add(client);
		client.connection.start();
		return client.connection;
	}

	/** Implement {@link RpcConnectionHost}. */
	async onCommand(frame: ClientFrame, connection: RpcConnection): Promise<void> {
		if (this.stopping && frame.type !== 'shutdown') {
			connection.send({
				type: 'response',
				command: frame.type,
				success: false,
				error: 'daemon is shutting down',
			});
			return;
		}
		switch (frame.type) {
			case 'hello':
				this.respondHello(connection);
				return;
			case 'prompt':
			case 'steer':
			case 'follow_up':
				await this.submit(frame.type, frame.message, frame.id, connection);
				return;
			case 'abort':
				await this.abort(frame.id, connection);
				return;
			case 'events':
				this.attachEvents(frame.after, connection);
				return;
			case 'shutdown':
				connection.send({
					type: 'response',
					command: 'shutdown',
					success: true,
					...(frame.id ? { id: frame.id } : {}),
				});
				this.onShutdownRequested?.();
				return;
		}
	}

	/** Implement {@link RpcConnectionHost}. */
	onClose(connection: RpcConnection): void {
		for (const client of this.clients) {
			if (client.connection === connection) {
				this.clients.delete(client);
				return;
			}
		}
	}

	/**
	 * Graceful shutdown: drain queues, persist the checkpoint, close clients.
	 *
	 * Order matters and is pinned:
	 * 1. refuse further commands (`stopping` gate) and stop the event pump;
	 * 2. wait, bounded by `drainTimeoutMs`, for in-flight adapter submissions
	 *    so no acknowledged mutation is dropped mid-flight;
	 * 3. flush the final checkpoint (awaited — the watermark must be durable
	 *    before the process may exit);
	 * 4. `bye` + close every client connection.
	 */
	async shutdown(): Promise<void> {
		if (this.stopped) return;
		this.stopping = true;
		this.adapter.stop();
		await this.drainSubmissions();
		await this.checkpointStore.save(makeCheckpoint(this.sequenceWatermark));
		for (const client of [...this.clients]) {
			client.connection.close('daemon-shutdown');
		}
		this.clients.clear();
		this.stopped = true;
		await this.pumpTask;
	}

	/** Await the coalesced checkpoint writer so tests can pin durability. */
	async flushCheckpoint(): Promise<void> {
		await this.checkpointWrite;
	}

	/**
	 * Relay adapter events: stamp a cursor, retain in the ring, fan out to
	 * attached clients, and track the watermark durably.
	 */
	private async pumpAdapterEvents(): Promise<void> {
		try {
			for await (const event of this.adapter.events) {
				if (this.stopping) break;
				const frame: ReplayFrame = this.ring.append(event);
				this.nextSeq = Number(frame.cursor) + 1;
				this.scheduleCheckpoint();
				for (const client of [...this.clients]) {
					this.deliver(client, frame);
				}
			}
		} catch {
			// A throwing runtime must not kill the daemon; the Ф4 runtime adds
			// structured error events. The pump simply stops relaying.
		}
	}

	/** Deliver one live event unless the client has already seen the cursor. */
	private deliver(client: AttachedClient, frame: ReplayFrame): void {
		if (!client.connection.isOpen) return;
		if (client.lastDelivered === null) return;
		if (compareCursors(frame.cursor, client.lastDelivered) <= 0) return;
		client.lastDelivered = frame.cursor;
		client.connection.send({ type: 'event', cursor: frame.cursor, event: frame.event });
	}

	private respondHello(connection: RpcConnection): void {
		const data: HelloData = { version: MCODED_PROTOCOL_VERSION, head: this.head };
		connection.send({ type: 'response', command: 'hello', success: true, data });
	}

	/**
	 * Attach the client to the event stream. `after` semantics:
	 * - omitted → deliver the whole retained window, then live events;
	 * - a retained cursor → replay strictly after it, then live;
	 * - anything else → `replay_gap` with the current head; the client must
	 *   re-attach (the cursor was evicted, or belongs to a previous daemon
	 *   life after a restart).
	 */
	private attachEvents(after: string | undefined, connection: RpcConnection): void {
		const client = this.findClient(connection);
		if (!client) return;
		const replay = this.ring.replayAfter(after);
		if (!replay.ok) {
			connection.send({ type: 'replay_gap', after: after ?? '', head: this.head });
			return;
		}
		connection.send({
			type: 'response',
			command: 'events',
			success: true,
			data: { replayed: replay.frames.length, head: this.head },
		});
		for (const frame of replay.frames) {
			client.connection.send({ type: 'event', cursor: frame.cursor, event: frame.event });
		}
		const newestReplayed = replay.frames[replay.frames.length - 1];
		client.lastDelivered = newestReplayed?.cursor ?? this.head ?? '0';
	}

	private async submit(
		kind: SubmissionKind,
		message: string,
		requestId: string | undefined,
		connection: RpcConnection,
	): Promise<void> {
		const submissionId = requestId ?? this.freshRequestId();
		try {
			const submission = this.adapter.submit({ kind, message, requestId: submissionId });
			this.track(submission);
			await submission;
			connection.send({ type: 'response', command: kind, id: submissionId, success: true });
		} catch (error) {
			connection.send({
				type: 'response',
				command: kind,
				id: submissionId,
				success: false,
				error: error instanceof Error ? error.message : 'runtime adapter failed',
			});
		}
	}

	private async abort(requestId: string | undefined, connection: RpcConnection): Promise<void> {
		try {
			const running = this.adapter.abort();
			this.track(running);
			await running;
			connection.send({
				type: 'response',
				command: 'abort',
				success: true,
				...(requestId ? { id: requestId } : {}),
			});
		} catch (error) {
			connection.send({
				type: 'response',
				command: 'abort',
				success: false,
				...(requestId ? { id: requestId } : {}),
				error: error instanceof Error ? error.message : 'runtime adapter failed',
			});
		}
	}

	/** Track an adapter operation so graceful shutdown can wait it out. */
	private track(operation: Promise<unknown>): void {
		const recorded = operation.catch(() => undefined);
		this.pendingSubmissions.add(recorded);
		void recorded.finally(() => this.pendingSubmissions.delete(recorded));
	}

	private freshRequestId(): string {
		// Daemon-minted ids are unique within one process; clients that care
		// about correlation send their own ids (pi-rpc optional `id`).
		this.mintedRequestIds += 1;
		return `mcoded-req-${this.mintedRequestIds}`;
	}

	private findClient(connection: RpcConnection): AttachedClient | undefined {
		for (const client of this.clients) {
			if (client.connection === connection) return client;
		}
		return undefined;
	}

	/**
	 * Wait, bounded by `drainTimeoutMs`, for the in-flight adapter operations.
	 * New ones cannot appear: the `stopping` gate refuses commands first.
	 */
	private async drainSubmissions(): Promise<void> {
		if (this.pendingSubmissions.size === 0) return;
		let timer: NodeJS.Timeout | undefined;
		try {
			const deadline = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, this.drainTimeoutMs);
				timer.unref?.();
			});
			await Promise.race([
				Promise.allSettled([...this.pendingSubmissions]),
				deadline,
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Coalesced checkpoint writer: at most one write in flight, the latest
	 * watermark wins, appends never wait on disk. A crash can therefore lose
	 * only the very tail of the watermark — and losing ground means cursors
	 * get SKIPPED after restart, never reused (see `start`).
	 */
	private scheduleCheckpoint(): void {
		this.checkpointDirty = true;
		this.checkpointWrite = this.checkpointWrite
			.catch(() => undefined)
			.then(async () => {
				if (!this.checkpointDirty || this.stopping) return;
				this.checkpointDirty = false;
				await this.checkpointStore.save(makeCheckpoint(this.sequenceWatermark));
			});
	}
}
