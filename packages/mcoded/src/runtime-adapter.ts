/**
 * The runtime seam of the daemon: the wire and the socket layers never talk to
 * an agent directly, only to a {@link RuntimeAdapter}. The Ф4 product version
 * plugs the live agent runtime (local-runtime-v2 conversation pipeline) in
 * here; this wave ships {@link EchoRuntimeAdapter}, a deterministic stub that
 * exercises the full wire path without any model dependency.
 *
 * @module
 */

/** Submission kinds — the prompting subset of the pi-rpc command set. */
export type SubmissionKind = 'prompt' | 'steer' | 'follow_up';

/** One accepted wire mutation, handed to the runtime for execution. */
export interface RuntimeSubmission {
	readonly kind: SubmissionKind;
	/** Verbatim client message text. */
	readonly message: string;
	/** The wire request-id the daemon assigned for correlation. */
	readonly requestId: string;
}

/**
 * The daemon-facing surface of the agent runtime.
 *
 * Implementations push opaque JSON events into `events`; the daemon stamps
 * them with cursors and fans them out. Nothing here may know about sockets,
 * cursors or replay — those are wire concerns.
 */
export interface RuntimeAdapter {
	/** Accept a prompt (start/queue a turn) or steer/follow-up input. */
	submit(submission: RuntimeSubmission): Promise<void>;
	/** Best-effort cancel of the active turn. */
	abort(): Promise<void>;
	/** Live stream of opaque runtime events; ends when the runtime stops. */
	readonly events: AsyncIterable<unknown>;
	/**
	 * End the event stream for good (graceful shutdown calls this before
	 * draining). Idempotent; after it returns, `events` must finish.
	 */
	stop(): void;
}

/** Minimal pushable async iterable backing adapter event streams. */
export class PushableIterable<T> implements AsyncIterable<T> {
	private readonly queue: T[] = [];
	private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
	private ended = false;

	push(value: T): void {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ done: false, value });
			return;
		}
		this.queue.push(value);
	}

	/** End the stream; pending and future `next()` calls observe `done`. */
	end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter({ done: true, value: undefined });
		}
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		const iterator: AsyncIterableIterator<T> = {
			[Symbol.asyncIterator]: () => iterator,
			next: () => {
				const value = this.queue.shift();
				if (value !== undefined) {
					return Promise.resolve({ done: false as const, value });
				}
				if (this.ended) {
					return Promise.resolve({ done: true as const, value: undefined });
				}
				return new Promise((resolve) => this.waiters.push(resolve));
			},
			return: async () => {
				this.end();
				return { done: true as const, value: undefined };
			},
		};
		return iterator;
	}
}

/**
 * Deterministic stub runtime: turns each submission into a fixed event burst
 * so the daemon skeleton can be exercised end to end. The Ф4 runtime replaces
 * this class; its event names below are placeholders, not a contract.
 */
export class EchoRuntimeAdapter implements RuntimeAdapter {
	private readonly stream = new PushableIterable<unknown>();
	private aborted = false;

	readonly events: AsyncIterable<unknown> = this.stream;

	async submit(submission: RuntimeSubmission): Promise<void> {
		if (submission.kind === 'prompt') {
			this.aborted = false;
			this.stream.push({ type: 'message_started', requestId: submission.requestId });
			const chunks = EchoRuntimeAdapter.chunk(submission.message);
			for (let index = 0; index < chunks.length; index += 1) {
				if (this.aborted) {
					this.stream.push({ type: 'turn_aborted', requestId: submission.requestId });
					return;
				}
				this.stream.push({
					type: 'message_delta',
					requestId: submission.requestId,
					seq: index,
					text: chunks[index],
				});
			}
			this.stream.push({
				type: 'message_completed',
				requestId: submission.requestId,
				text: submission.message,
			});
			return;
		}
		// steer / follow_up: acknowledged as queued input for the active turn.
		this.stream.push({
			type: 'input_queued',
			kind: submission.kind,
			requestId: submission.requestId,
			text: submission.message,
		});
	}

	async abort(): Promise<void> {
		this.aborted = true;
		this.stream.push({ type: 'turn_aborted' });
	}

	/** Stop the event stream (used by graceful shutdown). */
	stop(): void {
		this.stream.end();
	}

	/** Split text into two deterministic chunks so replays have >1 frame. */
	private static chunk(message: string): [string, string] {
		if (message.length < 2) return [message, ''];
		const split = Math.ceil(message.length / 2);
		return [message.slice(0, split), message.slice(split)];
	}
}
