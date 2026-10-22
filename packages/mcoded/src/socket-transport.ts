/**
 * `net.Socket` → {@link LineTransport} adapter: splits the byte stream on
 * newline boundaries and forwards JSONL frames between the daemon and a unix
 * socket client. The in-memory pair in `transport.ts` implements the same
 * interface, so the wire layer is transport-agnostic.
 *
 * @module
 */

import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

import type { LineTransport } from './transport.js';

export class SocketLineTransport implements LineTransport {
	private readonly socket: net.Socket;
	private readonly decoder = new StringDecoder('utf8');
	private readonly inbox: string[] = [];
	private readonly waiters: Array<(result: IteratorResult<string>) => void> = [];
	private buffer = '';
	private resolveClosed: (() => void) | undefined;
	private ended = false;

	readonly closed: Promise<void>;

	constructor(socket: net.Socket) {
		this.socket = socket;
		this.closed = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
		socket.setNoDelay(true);
		socket.on('data', (chunk: Buffer) => this.onData(chunk));
		socket.on('close', () => this.settle());
		socket.on('error', () => this.settle());
	}

	private onData(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		let newline = this.buffer.indexOf('\n');
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			this.deliver(line);
			newline = this.buffer.indexOf('\n');
		}
	}

	private deliver(line: string): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ done: false, value: line });
			return;
		}
		this.inbox.push(line);
	}

	write(line: string): void {
		if (this.ended || this.socket.destroyed) return;
		// Backpressure is delegated to Node's internal socket buffer; the Ф4
		// hardening pass adds an explicit byte-bounded write queue.
		this.socket.write(`${line}\n`);
	}

	lines(): AsyncIterableIterator<string> {
		const iterator: AsyncIterableIterator<string> = {
			[Symbol.asyncIterator]: () => iterator,
			next: () => {
				const line = this.inbox.shift();
				if (line !== undefined) {
					return Promise.resolve({ done: false as const, value: line });
				}
				if (this.ended || this.socket.destroyed) {
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

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.socket.end();
		this.settle();
	}

	/** Destroy the socket immediately (no flush) — for daemon teardown. */
	destroy(): void {
		this.ended = true;
		this.socket.destroy();
		this.settle();
	}

	private settle(): void {
		this.resolveClosed?.();
		for (const waiter of this.waiters.splice(0)) {
			waiter({ done: true, value: undefined });
		}
	}
}
