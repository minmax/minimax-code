/**
 * @mavis/mcoded — skeleton of the resident `mcoded` daemon (Ф4 contract).
 *
 * Layering, socket to core:
 * - `daemon.ts` — unix socket lifecycle: durable-path socket at `0600`,
 *   `LISTEN_FDS` adoption, stale-socket crash recovery, graceful shutdown;
 * - `hub.ts` — transport-agnostic core: cursor assignment, replay ring,
 *   client fan-out, drain + checkpoint;
 * - `wire.ts` / `protocol.ts` — the pi-rpc-semantics JSONL contract
 *   (prompt/steer/follow_up/events; version, cursor, request-id);
 * - `transport.ts` / `socket-transport.ts` — the line transports the wire
 *   runs over (in-memory loopback for tests, unix socket in the daemon);
 * - `runtime-adapter.ts` — the seam the live agent runtime plugs into; the
 *   shipped echo stub keeps the skeleton runtime-free;
 * - `checkpoint.ts` — the durable watermark that makes restarts crash-only.
 *
 * @module
 */

export { MCODED_PROTOCOL_VERSION, ProtocolError, compareCursors, parseFrame, serializeFrame } from './protocol.js';
export type {
	ClientCommandName,
	ClientFrame,
	Cursor,
	HelloData,
	ServerFrame,
} from './protocol.js';

export { DEFAULT_REPLAY_LIMITS, ReplayRing } from './replay-ring.js';
export type { ReplayFrame, ReplayLimits, ReplaySlice } from './replay-ring.js';

export { EchoRuntimeAdapter, PushableIterable } from './runtime-adapter.js';
export type { RuntimeAdapter, RuntimeSubmission, SubmissionKind } from './runtime-adapter.js';

export { createInMemoryTransportPair } from './transport.js';
export type { LineTransport } from './transport.js';
export { SocketLineTransport } from './socket-transport.js';

export {
	MCODED_CHECKPOINT_BASENAME,
	FileCheckpointStore,
	InMemoryCheckpointStore,
	makeCheckpoint,
} from './checkpoint.js';
export type { CheckpointStore, DaemonCheckpoint } from './checkpoint.js';

export { RpcConnection } from './wire.js';
export type { RpcConnectionHost, RpcConnectionState } from './wire.js';

export { McodedHub } from './hub.js';
export type { McodedHubOptions } from './hub.js';

export {
	LISTEN_FD_START,
	McodedDaemon,
	McodedDaemonError,
	readInheritedListenFd,
} from './daemon.js';
export type {
	DaemonHubOptions,
	McodedDaemonErrorCode,
	McodedDaemonOptions,
} from './daemon.js';

export { mcodedMain, parseMcodedArgs } from './main.js';
export type { McodedMainOptions } from './main.js';
