/**
 * CAS-backed {@link ToolOutputSpill}: the complete truncated tool output is
 * stored as a content-addressed blob, and the model gets a `cas://` reference
 * back instead of the payload.
 *
 * The store is structural (`CasSpillStoreLike`), so this module works with the
 * real `@mavis/cas` store without importing it — the composition happens at
 * the call site:
 *
 * ```ts
 * const cas = await openCas(dataRoot);
 * const spill = createCasToolOutputSpill(cas);
 * applyTruncation(result, { spill, ... });
 * ```
 *
 * @module
 */

import { open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The `cas://` reference format and the fatal store-error classification are
// single-sourced in `@mavis/cas` (`cas-ref` / `store-errors`); both are
// re-exported here so this module stays the truncation-seam's public surface.
// Only the FORMAT module is a runtime import — the store itself stays
// structural (`CasSpillStoreLike`), composition happens at the call site.
import { casSpillRef } from '@mavis/cas/cas-ref';
import { errnoCodeOf, isFatalStoreError } from '@mavis/cas/store-errors';

import type { ToolOutputSpill } from './spill.js';

export { casSpillRef, parseCasSpillRef } from '@mavis/cas/cas-ref';
export { FATAL_STORE_ERROR_CODES, isFatalStoreError } from '@mavis/cas/store-errors';

/** Result of publishing content into the spill store. */
export interface CasSpillPutResult {
	readonly sha256: string;
	readonly size: number;
}

/**
 * Structural surface of the CAS store this spill needs. `putBytes` is the
 * only required member; the optional members are the store's native entry
 * points for payloads that already exist in a non-buffer shape. The real
 * `@mavis/cas` store satisfies this interface as-is (`putFile` and
 * `putBase64` match `CasStore`).
 */
export interface CasSpillStoreLike {
	/** Stores bytes and returns their digest and size (see `@mavis/cas`). */
	putBytes(data: Uint8Array): Promise<CasSpillPutResult>;
	/**
	 * Optional file-native put (satisfied structurally by `@mavis/cas`).
	 * Two uses: {@link CasToolOutputSpill.spillFile} ingests an output that
	 * already lives on disk without reading it back, and large string
	 * payloads are staged through a chunk-written temp file so no full UTF-8
	 * buffer is ever materialized (see {@link STRING_SPILL_FILE_THRESHOLD_BYTES}).
	 */
	putFile?(sourcePath: string): Promise<CasSpillPutResult>;
	/**
	 * Optional base64-native put (satisfied structurally by `@mavis/cas`):
	 * the store decodes in aligned chunks, so inline base64 image blocks are
	 * externalized without materializing the decoded payload, and the digest
	 * covers the decoded bytes — the same convention as the v2 importer.
	 */
	putBase64?(base64: string): Promise<CasSpillPutResult>;
}

/**
 * A {@link ToolOutputSpill} that can also ingest a file or an inline base64
 * payload directly. Ordinary `ToolOutputSpill` consumers keep working
 * unchanged; call sites holding a payload on disk (bash full-output file) or
 * in base64 form (inline image blocks) can probe for the extra members to
 * skip the string/decode round-trip.
 */
export interface CasToolOutputSpill extends ToolOutputSpill {
	/**
	 * Stores the bytes of the file at `sourcePath` and returns the canonical
	 * `cas://` reference, or undefined on failure (same degradation as
	 * {@link spill}). Falls back to undefined when the underlying store has no
	 * file-native put.
	 */
	spillFile(sourcePath: string): Promise<string | undefined>;
	/**
	 * Stores the decoded bytes of an inline base64 payload (an image block's
	 * `data`) and returns the canonical `cas://` reference, or undefined on
	 * failure or when the store has no base64-native put.
	 */
	spillBase64(base64: string): Promise<string | undefined>;
}

/**
 * Payload size at or above which the string spill stages the payload through
 * a chunk-written temp file and the store's `putFile` instead of encoding it
 * into a single `putBytes` buffer: `putBytes` stays on the small-payload path
 * only, and a multi-megabyte truncation never doubles its memory footprint.
 */
export const STRING_SPILL_FILE_THRESHOLD_BYTES = 1024 * 1024;

/** Code units per chunk when staging a large string payload through a file. */
const STRING_STAGING_CHUNK_UNITS = 1 << 16;

/**
 * Thrown when the store fails with a fatal filesystem error (disk full,
 * quota, permission, read-only, I/O — the {@link FATAL_STORE_ERROR_CODES}
 * family classified by `@mavis/cas/store-errors`). The spill never degrades
 * such a failure to `undefined`: for the image path that would silently
 * flood the history log with inline base64, the exact outcome the CAS
 * exists to prevent (same policy as the v2 importer's `CasSpillError`).
 * Non-fatal store failures degrade to `undefined` and are reported to the
 * caller's diagnostics listener instead.
 */
export class CasSpillFatalError extends Error {
	readonly code: string | undefined;

	constructor(message: string, options?: { readonly cause?: unknown; readonly code?: string }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'CasSpillFatalError';
		this.code = options?.code;
	}
}

/** Whether `error` is a spill failure that must never degrade to `undefined`. */
export function isCasSpillFatalError(error: unknown): boolean {
	return error instanceof CasSpillFatalError;
}

/** One reported spill degradation (a non-fatal store failure). */
export interface CasSpillIssue {
	readonly message: string;
	/** errno-style code when the underlying failure carries one. */
	readonly code?: string | undefined;
	readonly cause?: unknown;
}

/** Diagnostics channel: receives every non-fatal spill degradation. */
export type CasSpillIssueListener = (issue: CasSpillIssue) => void;

/**
 * Creates a spill hook that persists the full output payload into the CAS
 * store. Failure policy is differentiated, never silent:
 *
 * - fatal store errors (ENOSPC/EDQUOT/EACCES/EPERM/EROFS/EIO) throw
 *   {@link CasSpillFatalError} — the caller fails loudly instead of writing
 *   the payload inline into the log;
 * - any other store failure degrades to `undefined` (the truncated result
 *   simply carries no full-output reference) and is reported to `onIssue`.
 */
export function createCasToolOutputSpill(
	store: CasSpillStoreLike,
	onIssue?: CasSpillIssueListener,
): CasToolOutputSpill {
	const degrade = (operation: string, error: unknown): undefined => {
		const code = errnoCodeOf(error);
		if (isFatalStoreError(error)) {
			throw new CasSpillFatalError(
				`CAS store rejected the spill (${operation}${code === undefined ? '' : `, ${code}`}); ` +
					`refusing to fall back to an unreferenced/inline payload: ${errorText(error)}`,
				{ cause: error, code },
			);
		}
		onIssue?.({
			message:
				`CAS store ${operation} failed (${code ?? 'unknown error'}); ` +
				`degrading to a result without a full-output reference: ${errorText(error)}`,
			code,
			cause: error,
		});
		return undefined;
	};
	return {
		async spill(payload: string): Promise<string | undefined> {
			try {
				const put =
					byteLength(payload) >= STRING_SPILL_FILE_THRESHOLD_BYTES && store.putFile
						? await putStringViaFile(store, payload)
						: await store.putBytes(Buffer.from(payload, 'utf8'));
				return casSpillRef(put.sha256, put.size);
			} catch (error) {
				return degrade('putBytes', error);
			}
		},
		async spillFile(sourcePath: string): Promise<string | undefined> {
			if (!store.putFile) return undefined;
			try {
				const put = await store.putFile(sourcePath);
				return casSpillRef(put.sha256, put.size);
			} catch (error) {
				return degrade('putFile', error);
			}
		},
		async spillBase64(base64: string): Promise<string | undefined> {
			try {
				// The base64-native put decodes in aligned chunks; the fallback
				// decodes once. Either way the digest covers the decoded bytes.
				const put = store.putBase64
					? await store.putBase64(base64)
					: await store.putBytes(Buffer.from(base64, 'base64'));
				return casSpillRef(put.sha256, put.size);
			} catch (error) {
				return degrade('putBase64', error);
			}
		},
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Stages `payload` into a temp file in code-point-aligned chunks and hands
 * the file to the store's `putFile`: peak extra memory is one chunk, never a
 * full UTF-8 copy of the payload. The temp file is always removed; a failure
 * propagates to the caller's degradation.
 */
async function putStringViaFile(store: CasSpillStoreLike, payload: string): Promise<CasSpillPutResult> {
	if (!store.putFile) throw new Error('file-native put required for large payload staging');
	const tmpPath = join(tmpdir(), `tool-output-spill-${randomUUID()}.tmp`);
	const handle = await open(tmpPath, 'w');
	try {
		for (let offset = 0; offset < payload.length; ) {
			let end = Math.min(offset + STRING_STAGING_CHUNK_UNITS, payload.length);
			if (end < payload.length) {
				// Never split a surrogate pair across chunks: a lone high
				// surrogate would be encoded as U+FFFD and corrupt the blob.
				const last = payload.charCodeAt(end - 1);
				if (last >= 0xd800 && last <= 0xdbff) end -= 1;
			}
			if (end > offset) await handle.write(payload.slice(offset, end));
			offset = end;
		}
	} finally {
		await handle.close();
	}
	try {
		return await store.putFile(tmpPath);
	} finally {
		await unlink(tmpPath).catch(() => {});
	}
}

/**
 * Structural probe: returns the hook's file-native spill when it has one.
 * Lets call sites holding an on-disk payload (bash full-output file) persist
 * it without reading it into memory, while plain `ToolOutputSpill` hooks keep
 * working through the string path.
 */
export function fileSpillFromHook(
	hook: ToolOutputSpill,
): ((sourcePath: string) => Promise<string | undefined>) | undefined {
	const spillFile = (hook as Partial<CasToolOutputSpill>).spillFile;
	return typeof spillFile === 'function' ? spillFile.bind(hook) : undefined;
}

/**
 * Structural probe: returns the hook's base64-native spill when it has one.
 * The truncation seam uses it to externalize inline base64 image blocks with
 * the digest taken over the decoded bytes.
 */
export function base64SpillFromHook(
	hook: ToolOutputSpill,
): ((base64: string) => Promise<string | undefined>) | undefined {
	const spillBase64 = (hook as Partial<CasToolOutputSpill>).spillBase64;
	return typeof spillBase64 === 'function' ? spillBase64.bind(hook) : undefined;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, 'utf8');
}
