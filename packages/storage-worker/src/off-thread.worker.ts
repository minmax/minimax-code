/**
 * Worker-thread body of the off-thread storage worker: OWNS the backend
 * handle, so `JSON.stringify` + zstd + the SQLite fsync all execute on this
 * thread — never on the caller's main thread (durable-core acceptance: commit
 * cost lives in the worker, not on the stream).
 *
 * Like `worker.ts`, this file is loaded DIRECTLY by `node:worker_threads` and
 * therefore imports only `node:*` builtins statically. The backend factory is
 * loaded through the module specifier in `workerData` (a built `dist` path or
 * a plain-JS factory; for TypeScript source pass `execArgv: ['--import',
 * 'tsx']` via `workerExecArgv`). The sqlite-zstd adapter logic is inlined
 * here on purpose: this file must stay loadable by raw Node, and the main
 * module graph (which also serves main-thread backends) must not leak into
 * the thread.
 *
 * Protocol (see `off-thread.ts` for the main-thread side):
 *   worker -> main: { type: 'ready' } | { type: 'readyError', message }
 *                   { type: 'flushResult', requestId, commit | null }
 *                   { type: 'flushError', requestId, message, errorName? }
 *                   { type: 'checkpointResult', requestId }
 *                   { type: 'checkpointError', requestId, message }
 *                   { type: 'quarantined', entries, message, errorName? }
 *                   { type: 'disposed' }
 *   main -> worker: { type: 'entries', entries }
 *                   { type: 'flush', requestId }
 *                   { type: 'checkpoint', requestId }
 *                   { type: 'dispose' }
 *
 * @module
 */

import { Buffer } from 'node:buffer';
import { parentPort, workerData } from 'node:worker_threads';

interface WorkerEntry {
	entryId: string;
	parentId: string | null;
	kind: string;
	payload: unknown;
	bytes: number;
}

interface WorkerCommit {
	batchId: string;
	seq: number;
	head: string;
}

interface Draft {
	id: string;
	parentId?: string | null;
	kind: string;
	payload: unknown;
}

interface RawCommit {
	batchId: number | string;
	seq: number;
	head: number;
}

interface RawBackend {
	appendBatch(drafts: readonly Draft[]): Promise<RawCommit>;
	checkpoint?(): unknown | Promise<unknown>;
	readonly maxBatchUncompressedBytes?: number;
}

/** Same classification contract as `errors.ts`; names must not diverge. */
class EntryTooLargeError extends Error {
	readonly entryId: string;
	readonly serializedBytes: number;
	readonly capBytes: number;

	constructor(entryId: string, serializedBytes: number, capBytes: number) {
		super(
			`entry ${entryId} serializes to ${serializedBytes} bytes, above the backend ` +
				`batch cap of ${capBytes} bytes; quarantined instead of retrying forever`,
		);
		this.name = 'EntryTooLargeError';
		this.entryId = entryId;
		this.serializedBytes = serializedBytes;
		this.capBytes = capBytes;
	}
}

const DEFAULT_BATCH_CAP_BYTES = 256 * 1024;

function toDraft(entry: WorkerEntry): Draft {
	return { id: entry.entryId, parentId: entry.parentId, kind: entry.kind, payload: entry.payload };
}

function fromRawCommit(commit: RawCommit): WorkerCommit {
	return { batchId: String(commit.batchId), seq: commit.seq, head: String(commit.head) };
}

async function start(port: NonNullable<typeof parentPort>): Promise<void> {
	const data = workerData as {
		windowMs?: number;
		windowBytes?: number;
		maxConsecutiveFlushFailures?: number;
		backend: { module: string; exportName: string; args?: readonly unknown[] };
	};
	const spec = data.backend;
	const moduleUrl = await import(spec.module);
	const factory = (moduleUrl as Record<string, unknown>)[spec.exportName];
	if (typeof factory !== 'function') {
		throw new TypeError(
			`backend module ${spec.module} does not export a function named ${spec.exportName}`,
		);
	}
	const raw = (await (factory as (...args: unknown[]) => unknown)(...(spec.args ?? []))) as RawBackend;
	if (typeof raw?.appendBatch !== 'function') {
		throw new TypeError('backend factory did not produce a backend with appendBatch()');
	}
	const cap = raw.maxBatchUncompressedBytes ?? DEFAULT_BATCH_CAP_BYTES;
	const committedIds = new Set<string>();

	async function appendWithinCap(drafts: readonly Draft[]): Promise<WorkerCommit> {
		if (drafts.length === 0) throw new TypeError('batch must contain at least one entry');
		const serializedBytes = Buffer.byteLength(JSON.stringify(drafts), 'utf8');
		if (cap <= 0 || serializedBytes <= cap) {
			return fromRawCommit(await raw.appendBatch(drafts));
		}
		if (drafts.length === 1) {
			throw new EntryTooLargeError(drafts[0].id, serializedBytes, cap);
		}
		const midpoint = drafts.length >> 1;
		await appendWithinCap(drafts.slice(0, midpoint));
		return appendWithinCap(drafts.slice(midpoint));
	}

	// The engine module is builtin-only at runtime, so it loads under raw Node
	// type stripping exactly like this file does; `worker.ts` is NOT imported
	// here on purpose — its module top-level wires the main-thread append
	// bridge, which this thread must not start (it owns the backend itself).
	const { createBatchEngine } = await import('./engine.ts');

	const engine = createBatchEngine(
		{
			windowMs: data.windowMs ?? 200,
			windowBytes: data.windowBytes ?? DEFAULT_BATCH_CAP_BYTES,
			maxConsecutiveFlushFailures: data.maxConsecutiveFlushFailures,
			checkpoint: async () => {
				const produced = await raw.checkpoint?.();
				return (produced ?? null) as WorkerCommit | null;
			},
			onQuarantine: (entries, error) => {
				port.postMessage({
					type: 'quarantined',
					entries,
					message: error.message,
					errorName: error.name,
				});
			},
			onCommit: (bytes) => {
				// Release admission bytes as soon as the batch is durable; without
				// this the caller-side queue wedges at its ceiling after
				// ceiling/windowBytes batches (no per-batch round trip exists here).
				port.postMessage({ type: 'committed', bytes });
			},
		},
		async (entries: WorkerEntry[]) => {
			const drafts = entries.map(toDraft).filter((draft) => {
				if (committedIds.has(draft.id)) return false;
				committedIds.add(draft.id);
				return true;
			});
			if (drafts.length === 0) {
				const replayed = new Error(
					`all ${entries.length} entries of the batch are already committed by this worker`,
				);
				replayed.name = 'SqliteZstdAdapterStateError';
				throw replayed;
			}
			try {
				return await appendWithinCap(drafts);
			} catch (error) {
				for (const draft of drafts) committedIds.delete(draft.id);
				throw error;
			}
		},
	);

	port.on('message', (message: {
		type: string;
		requestId?: number;
		entries?: WorkerEntry[];
	}) => {
		if (message.type === 'entries' && Array.isArray(message.entries)) {
			for (const entry of message.entries) engine.add(entry);
			return;
		}
		if (message.type === 'flush' && typeof message.requestId === 'number') {
			engine
				.flush()
				.then((commit) => port.postMessage({ type: 'flushResult', requestId: message.requestId, commit }))
				.catch((error: unknown) =>
					port.postMessage({
						type: 'flushError',
						requestId: message.requestId,
						message: error instanceof Error ? error.message : String(error),
						errorName: error instanceof Error ? error.name : undefined,
					}),
				);
			return;
		}
		if (message.type === 'checkpoint' && typeof message.requestId === 'number') {
			void Promise.resolve()
				.then(() => raw.checkpoint?.())
				.then(() => port.postMessage({ type: 'checkpointResult', requestId: message.requestId }))
				.catch((error: unknown) =>
					port.postMessage({
						type: 'checkpointError',
						requestId: message.requestId,
						message: error instanceof Error ? error.message : String(error),
					}),
				);
			return;
		}
		if (message.type === 'dispose') {
			void Promise.resolve()
				.then(() => raw.close?.()) // release the backend handle (locks, files)
				.catch(() => {}) // best effort: termination is the hard barrier
				.then(() => port.postMessage({ type: 'disposed' }));
		}
	});

	port.postMessage({ type: 'ready' });
}

const port = parentPort;
if (port) {
	start(port).catch((error: unknown) => {
		port.postMessage({
			type: 'readyError',
			message: error instanceof Error ? error.message : String(error),
		});
	});
}
