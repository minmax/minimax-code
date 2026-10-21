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
 * 'tsx']` via `workerExecArgv`). The split/replay logic is NOT inlined here:
 * the dynamically imported `sqlite-zstd-adapter.ts` is builtin-only at
 * runtime (like `engine.ts`), so this thread reuses the exact same
 * replay-safe splitting, duplicate backstop, and commit aggregation as the
 * main-thread adapter — one implementation, no divergent copy (IC-F1-005 /
 * SW-01 / OPT-H4).
 *
 * Protocol (see `off-thread.ts` for the main-thread side):
 *   worker -> main: { type: 'ready' } | { type: 'readyError', message }
 *                   { type: 'flushResult', requestId, commit | null }
 *                   { type: 'flushError', requestId, error }
 *                   { type: 'checkpointResult', requestId }
 *                   { type: 'checkpointError', requestId, error }
 *                   { type: 'terminalError', error }
 *                   { type: 'quarantined', entries, error }
 *                   { type: 'committed', bytes }
 *                   { type: 'disposed' }
 *   main -> worker: { type: 'entries', entries }
 *                   { type: 'flush', requestId }
 *                   { type: 'checkpoint', requestId }
 *                   { type: 'dispose' }
 *
 * @module
 */

import { parentPort, workerData } from 'node:worker_threads';

import type { Entry } from './contracts.js';
import type {
	SqliteZstdBackendLike,
	SqliteZstdCommitLike,
} from './sqlite-zstd-adapter.ts';

/** Structural surface of the factory-produced backend this thread drives. */
type RawBackend = SqliteZstdBackendLike & {
	close?(): unknown | Promise<unknown>;
	checkpoint?(): SqliteZstdCommitLike | undefined | Promise<SqliteZstdCommitLike | undefined>;
};

const DEFAULT_BATCH_CAP_BYTES = 256 * 1024;

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

	// Both modules are builtin-only at runtime, so they load under raw Node
	// type stripping exactly like this file does; `worker.ts` is NOT imported
	// here on purpose — its module top-level wires the main-thread append
	// bridge, which this thread must not start (it owns the backend itself).
	const [
		{ createBatchEngine, DEAD_LETTER_ENTRY_KIND, buildDeadLetterEntry },
		{ sqliteZstdStorageBackend, commitFromSqliteZstd },
		{ serializeWorkerError },
	] = await Promise.all([
		import('./engine.ts'),
		import('./sqlite-zstd-adapter.ts'),
		import('./errors.ts'),
	]);

	// The adapter is the SINGLE split/replay implementation of this package:
	// draft mapping, replay-safe committed-id tracking (marks only after a
	// sub-batch commits), duplicate-insert backstop, cap splitting over
	// once-measured sizes, and firstSeq..head commit aggregation all live
	// there. This thread just hands it the raw backend.
	const seam = sqliteZstdStorageBackend(raw);

	const engine = createBatchEngine(
		{
			windowMs: data.windowMs ?? 200,
			windowBytes: data.windowBytes ?? DEFAULT_BATCH_CAP_BYTES,
			maxConsecutiveFlushFailures: data.maxConsecutiveFlushFailures,
			checkpoint: async () => {
				const produced = await raw.checkpoint?.();
				// Map the raw commit onto the wire shape (the plain cast used to
				// leak branded numeric batchId/head to the caller).
				return produced ? commitFromSqliteZstd(produced) : null;
			},
			onTerminal: (error) => {
				// Terminal backend refusal: tell the main thread to fail its
				// admission queue closed (IC-F1-004).
				port.postMessage({ type: 'terminalError', error: serializeWorkerError(error) });
			},
			onQuarantine: (entries: readonly Entry[], error: Error) => {
				port.postMessage({ type: 'quarantined', entries, error: serializeWorkerError(error) });
				// Durable dead letters (SW-03): a metadata record of the buried
				// entries rides the SAME engine into the SAME backend log, so a
				// crash cannot erase the fact of the quarantine. Dead letters
				// are never re-wrapped (that would recurse forever on a backend
				// that rejects dead letters too).
				const sources = entries.filter((entry) => entry.kind !== DEAD_LETTER_ENTRY_KIND);
				if (sources.length > 0) engine.add(buildDeadLetterEntry(sources, error));
			},
			onCommit: (bytes) => {
				// Release admission bytes as soon as the batch is durable; without
				// this the caller-side queue wedges at its ceiling after
				// ceiling/windowBytes batches (no per-batch round trip exists here).
				port.postMessage({ type: 'committed', bytes });
			},
		},
		// The adapter seam speaks the worker's Entry/Commit contract directly.
		(entries: Entry[]) => seam.appendBatch(entries),
	);

	port.on('message', (message: {
		type: string;
		requestId?: number;
		entries?: Entry[];
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
						error: serializeWorkerError(error),
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
						error: serializeWorkerError(error),
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
