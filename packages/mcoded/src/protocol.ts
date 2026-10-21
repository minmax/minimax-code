/**
 * The mcoded wire contract: pi-rpc semantics (`third_party/pi-mono` coding-agent
 * `modes/rpc`) carried as JSONL frames with the daemon additions the Ф4 plan
 * pins — a protocol version, a replay cursor on every event, and request-id
 * correlation on every mutation.
 *
 * The frame shapes mirror `rpc-types.ts`:
 * - client commands `{ id?, type: "prompt" | "steer" | "follow_up" | ... }`;
 * - responses `{ id?, type: "response", command, success, data? | error }`;
 * - daemon events `{ type: "event", cursor, event }`, where `event` is the
 *   opaque runtime payload relayed verbatim.
 *
 * The module is transport-agnostic: frames are plain JSON values, and the only
 * framing assumption is the JSONL line discipline (`serializeFrame` appends one
 * newline; JSON string escapes guarantee no payload contains a raw newline).
 *
 * @module
 */

/** Protocol version spoken by this build. Handshake fails on any other value. */
export const MCODED_PROTOCOL_VERSION = 1;

/** Commands a client may send before the handshake completes. */
export type ClientCommandName =
	| 'hello'
	| 'prompt'
	| 'steer'
	| 'follow_up'
	| 'abort'
	| 'events'
	| 'shutdown';

/**
 * Client → daemon frames (JSONL). The prompting commands keep the pi-rpc
 * command set; `hello` negotiates the protocol version, `events` attaches the
 * caller to the replayable event stream (optionally resuming after a cursor),
 * and `shutdown` asks the daemon for a graceful drain.
 */
export type ClientFrame =
	| { type: 'hello'; version: number }
	| { type: 'prompt'; id?: string; message: string }
	| { type: 'steer'; id?: string; message: string }
	| { type: 'follow_up'; id?: string; message: string }
	| { type: 'abort'; id?: string }
	| { type: 'events'; after?: string }
	| { type: 'shutdown'; id?: string };

/** Data payload of a successful `hello` response. */
export interface HelloData {
	/** The one version the daemon accepts (echoed for confirmation). */
	version: number;
	/** Newest event cursor assigned so far, `null` when the stream is empty. */
	head: string | null;
}

/** Daemon → client frames (JSONL). */
export type ServerFrame =
	| { type: 'response'; id?: string; command: ClientCommandName; success: true; data?: unknown }
	/** Failure responses echo any declared command, including unknown ones. */
	| { type: 'response'; id?: string; command: string; success: false; error: string }
	/** One replayable runtime event; `cursor` is its position in the stream. */
	| { type: 'event'; cursor: string; event: unknown }
	/** The requested `after` cursor is not retained (evicted or never existed). */
	| { type: 'replay_gap'; after: string; head: string | null }
	/** Sent immediately before the daemon closes the connection. */
	| { type: 'bye'; reason?: string };

/** Cursor type alias: a decimal string of a monotonically increasing integer. */
export type Cursor = string;

/** Thrown when a received line is not a well-formed client frame. */
export class ProtocolError extends Error {
	readonly code = 'PROTOCOL_ERROR';
	/** Client-declared command type when one was recognizable; else `null`. */
	readonly commandHint: string | null;

	constructor(message: string, commandHint: string | null = null) {
		super(message);
		this.name = 'ProtocolError';
		this.commandHint = commandHint;
	}
}

/** Serialize one frame to a JSONL line (newline included). */
export function serializeFrame(frame: ServerFrame | ClientFrame): string {
	return `${JSON.stringify(frame)}\n`;
}

/**
 * Parse one JSONL line into a client frame.
 *
 * @throws {ProtocolError} on invalid JSON, a non-object line, an unknown
 * command type, or a payload that does not satisfy the declared shape. The
 * error carries a `commandHint` when the line declared a recognizable type,
 * so error responses can echo the offending command.
 */
export function parseFrame(line: string): ClientFrame {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new ProtocolError('frame is not valid JSON');
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ProtocolError('frame must be a JSON object');
	}
	const record = value as Record<string, unknown>;
	const rawType = record['type'];
	const hint = typeof rawType === 'string' ? rawType : null;
	switch (rawType) {
		case 'hello':
			if (typeof record['version'] !== 'number' || !Number.isInteger(record['version'])) {
				throw new ProtocolError('hello requires an integer "version"', 'hello');
			}
			return { type: 'hello', version: record['version'] };
		case 'prompt':
		case 'steer':
		case 'follow_up':
			if (typeof record['message'] !== 'string') {
				throw new ProtocolError(`${rawType} requires a string "message"`, rawType);
			}
			return {
				type: rawType,
				message: record['message'],
				...(isRequestId(record['id']) ? { id: record['id'] } : {}),
			};
		case 'abort':
			return { type: 'abort', ...(isRequestId(record['id']) ? { id: record['id'] } : {}) };
		case 'events': {
			const after = record['after'];
			if (after !== undefined && (typeof after !== 'string' || after.length === 0)) {
				throw new ProtocolError('events "after" must be a non-empty string cursor', 'events');
			}
			return { type: 'events', ...(after !== undefined ? { after } : {}) };
		}
		case 'shutdown':
			return { type: 'shutdown', ...(isRequestId(record['id']) ? { id: record['id'] } : {}) };
		default:
			throw new ProtocolError(
				`unknown frame type ${JSON.stringify(rawType ?? null)}`,
				hint,
			);
	}
}

/** Optional request-id: pi-rpc lets clients omit `id`; the response echoes it. */
function isRequestId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/**
 * Compare two cursors emitted by this daemon.
 *
 * Cursors are decimal integers, so numeric comparison is exact well past any
 * realistic sequence volume; the helper exists so call sites never compare
 * cursor strings lexicographically by accident.
 */
export function compareCursors(a: Cursor, b: Cursor): number {
	return Number(a) - Number(b);
}
