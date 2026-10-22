/**
 * One client connection of the mcoded wire: the per-connection protocol state
 * machine that runs the pi-rpc-semantics JSONL frames from `protocol.ts` over
 * any {@link LineTransport}.
 *
 * The connection owns exactly two protocol rules; everything else is delegated
 * to the hub:
 * 1. the handshake — the FIRST frame must be `hello` carrying
 *    {@link MCODED_PROTOCOL_VERSION}; anything else, or any other version,
 *    answers with a failed `hello` response and closes;
 * 2. framing discipline — a line that does not parse answers with a failed
 *    response naming the offending command, never tears the stream down
 *    silently.
 *
 * @module
 */

import {
	type ClientFrame,
	type ServerFrame,
	MCODED_PROTOCOL_VERSION,
	ProtocolError,
	parseFrame,
	serializeFrame,
} from './protocol.js';
import type { LineTransport } from './transport.js';

/** Callbacks the hub implements to serve a handshaken connection. */
export interface RpcConnectionHost {
	/** Handle a post-handshake command frame (responses are sent by the hub). */
	onCommand(frame: ClientFrame, connection: RpcConnection): Promise<void>;
	/** The peer closed the transport or the connection was closed locally. */
	onClose(connection: RpcConnection): void;
}

/** Connection lifecycle stage. */
export type RpcConnectionState = 'awaiting-hello' | 'open' | 'closed';

/** Per-client protocol machine over one duplex line transport. */
export class RpcConnection {
	private state: RpcConnectionState = 'awaiting-hello';
	private readonly reader: AsyncIterableIterator<string>;
	private readLoop: Promise<void> | undefined;

	constructor(
		private readonly transport: LineTransport,
		private readonly host: RpcConnectionHost,
	) {
		this.reader = transport.lines();
	}

	/** Current protocol stage of this client. */
	get connectionState(): RpcConnectionState {
		return this.state;
	}

	/** True once the handshake succeeded and the hub is serving the client. */
	get isOpen(): boolean {
		return this.state === 'open';
	}

	/** Begin reading frames. Idempotent; called by the hub on attach. */
	start(): void {
		if (this.readLoop) return;
		this.readLoop = this.drain();
	}

	/** Queue one server frame to this client. */
	send(frame: ServerFrame): void {
		if (this.state === 'closed') return;
		this.transport.write(serializeFrame(frame));
	}

	/**
	 * Close the connection politely: a `bye` frame, then transport end.
	 * Idempotent.
	 */
	close(reason?: string): void {
		if (this.state === 'closed') return;
		const wasOpen = this.state !== 'awaiting-hello';
		this.state = 'closed';
		if (wasOpen) {
			this.transport.write(serializeFrame({ type: 'bye', ...(reason ? { reason } : {}) }));
		}
		this.transport.end();
		this.host.onClose(this);
	}

	/** Read frames until the transport dies; protocol errors answer inline. */
	private async drain(): Promise<void> {
		try {
			for (;;) {
				const next = await this.reader.next();
				if (next.done) break;
				this.handleLine(next.value);
				if (this.state === 'closed') break;
			}
		} finally {
			if (this.state !== 'closed') {
				this.state = 'closed';
				this.host.onClose(this);
			}
		}
	}

	private handleLine(line: string): void {
		let frame: ClientFrame;
		try {
			frame = parseFrame(line);
		} catch (error) {
			// Error responses echo the client-declared command when the line
			// declared one (pi-rpc lets error responses name any command).
			const hint = error instanceof ProtocolError ? error.commandHint : null;
			const message = error instanceof Error ? error.message : 'unparsable frame';
			this.send({
				type: 'response',
				command: hint ?? 'invalid',
				success: false,
				error: `protocol error: ${message}`,
			});
			return;
		}

		if (this.state === 'awaiting-hello') {
			this.handleHello(frame);
			return;
		}
		if (frame.type === 'hello') {
			this.send({
				type: 'response',
				command: 'hello',
				success: false,
				error: 'already handshaken',
			});
			return;
		}
		void this.host.onCommand(frame, this);
	}

	private handleHello(frame: ClientFrame): void {
		if (frame.type !== 'hello') {
			// Tolerant like pi-rpc: the connection stays open so the client can
			// still send the handshake it forgot.
			this.send({
				type: 'response',
				command: frame.type,
				success: false,
				error: 'handshake required: the first frame must be hello',
			});
			return;
		}
		if (frame.version !== MCODED_PROTOCOL_VERSION) {
			this.send({
				type: 'response',
				command: 'hello',
				success: false,
				error: `unsupported protocol version ${String(frame.version)}; daemon speaks ${MCODED_PROTOCOL_VERSION}`,
			});
			this.close('handshake-failed');
			return;
		}
		this.state = 'open';
		void this.host.onCommand(frame, this);
	}
}
