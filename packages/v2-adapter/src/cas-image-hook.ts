/**
 * Default image externalization for the v2 import: inline base64 `image`
 * blocks are stored in the CAS and replaced with `image_ref` blocks, so image
 * bytes never live in the history log ("images never in the history, from the
 * first commit").
 *
 * The default CAS location is the durable data root (`~/.mcode-durable`,
 * resolved through `@mavis/config`'s `resolveDurableRoot` +
 * `resolveCasDirPath`, which pins the blob layout to `<root>/cas/<aa>/...`)
 * — never the legacy `~/.minimax` tree, which the durable runtime only reads.
 * `openCas` takes the PARENT root and appends `cas` itself, so this module
 * hands it the durable root, never the `cas` directory (handing it the
 * `cas` directory produced the historical `<root>/cas/cas` double nesting).
 *
 * The CAS store is structural (`CasStoreLike`) and resolved lazily: a store
 * instance may be handed in directly, a directory path opens the real
 * `@mavis/cas` store on that root, and the default (`undefined`) opens the
 * store under the durable root. Nothing in this module degrades silently:
 * when the CAS cannot be opened, the issue is reported to the caller's
 * diagnostics listener, and degrading to inline images happens only through
 * the explicit `casUnavailable: 'keep-inline'` policy — the default is to
 * fail the import loudly.
 *
 * @module
 */

import os from 'node:os';
import { join } from 'node:path';

// The `cas://` reference format and the fatal store-error classification are
// single-sourced in `@mavis/cas` (`cas-ref` / `store-errors`). The local
// copies this module used to carry ("format synchronized with
// @mavis/agent-tools truncation/cas-spill; if either side changes, update
// both") were removed: a drift between the copies would break cross-reading
// references between the spill tools and the v2 import. The re-exports below
// keep this module's public surface unchanged.
import { casSpillRef, parseCasSpillRef } from '@mavis/cas/cas-ref';
import { errnoCodeOf, FATAL_STORE_ERROR_CODES } from '@mavis/cas/store-errors';

import type { V2ImageHook } from './session-reader.js';

export { casSpillRef, parseCasSpillRef };

/**
 * Canonical base64 acceptance for image payloads. `Buffer.from(..., 'base64')`
 * is lenient — it skips invalid characters and silently distorts the bytes,
 * after which the size recorded in the reference no longer describes the
 * source payload — so bytes are accepted only when they are canonical base64
 * (alphabet, grouping, padding) and rejected otherwise.
 */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/u;

/** Whether `value` is a non-empty canonical base64 payload (strict, not lenient). */
export function isValidBase64(value: string): boolean {
	return value.length > 0 && BASE64_PATTERN.test(value);
}

/** Structural surface of the CAS store the image hook needs. */
export interface CasStoreLike {
	/**
	 * Stores bytes and returns their digest and size. Declared with
	 * `Uint8Array`, not `Buffer`: the store must accept any bytes view, which
	 * the real `@mavis/cas` store guarantees for its `putBytes`.
	 */
	putBytes(data: Uint8Array): Promise<{ readonly sha256: string; readonly size: number }>;
}

/**
 * Store root handed to `openCas` for the default profile — the durable data
 * root itself, so blobs land in `<root>/cas/<aa>/...` exactly where
 * `@mavis/config`'s `resolveCasDirPath(resolveDurableRoot())` points. A
 * literal, by design: the durable root layout (`~/.mcode-durable`, profile
 * suffixes for non-default profiles) is pinned by `@mavis/config`'s
 * `durable-paths.ts`, and this adapter must never fall back into the legacy
 * `~/.minimax` family regardless of which packages the runtime resolved.
 * Profile-aware callers hand an explicit root (the `cas` option) instead of
 * relying on the default.
 *
 * Snapshot taken at module load: resolve the root with
 * {@link resolveDefaultCasRoot} when `$HOME` may have been overridden after
 * this module was imported.
 */
export const DEFAULT_CAS_ROOT = join(os.homedir(), '.mcode-durable');

/** Explicit import option: a store, a CAS root directory, or `null` to keep images inline. */
export type CasImageOption = CasStoreLike | string | null;

/** What went wrong while externalizing images; always reported, never swallowed. */
export type CasImportIssueKind =
	/** The CAS package or store root could not be opened. */
	| 'cas-unavailable'
	/** A non-fatal store error; the block degraded to inline by policy. */
	| 'store-error'
	/** The image payload is not canonical base64; kept inline verbatim. */
	| 'invalid-base64'
	/** A hook returned a non-canonical descriptor; treated as a decline. */
	| 'invalid-blob-ref';

/** One reported CAS issue (degradation, rejection, or unavailability). */
export interface CasImportIssue {
	readonly kind: CasImportIssueKind;
	readonly message: string;
	/** errno-style code when the underlying failure carries one. */
	readonly code?: string | undefined;
	readonly cause?: unknown;
}

/** Diagnostics channel: receives every non-fatal CAS issue. */
export type CasIssueListener = (issue: CasImportIssue) => void;

/**
 * Thrown when the CAS cannot sustain the import: it cannot be opened at all
 * (unless the caller opted into `casUnavailable: 'keep-inline'`), or the
 * store fails with a fatal filesystem error (disk full, permission, I/O) —
 * silently flooding the history log with inline base64 would be the worse
 * outcome, so the import fails loudly instead.
 */
export class CasSpillError extends Error {
	readonly code: string | undefined;

	constructor(message: string, options?: { readonly cause?: unknown; readonly code?: string }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'CasSpillError';
		this.code = options?.code;
	}
}

/**
 * errno codes that mean the store or its volume is broken live in
 * `@mavis/cas/store-errors` ({@link FATAL_STORE_ERROR_CODES}, imported
 * above): the same set the agent-tools spill classifies with, so both seams
 * refuse the inline degradation on exactly the same failures. A `putBytes`
 * failure with one of these must never degrade to inline: the history log
 * would silently absorb the blob bytes the CAS was supposed to keep out.
 */

/** Bound on the base64 -> reference memoization (repeated image blocks). */
const REF_CACHE_LIMIT = 128;

function rememberRef(cache: Map<string, string>, base64: string, ref: string): void {
	if (cache.size >= REF_CACHE_LIMIT) {
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}
	cache.set(base64, ref);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the image hook: validates the base64 strictly, stores the exact
 * bytes in the CAS, and returns the canonical `cas://` reference. Failure
 * policy is differentiated, never silent:
 *
 * - non-canonical base64 -> issue reported, block stays inline verbatim
 *   (storing lenient-decoded bytes would corrupt them and lie about size);
 * - fatal store errors (ENOSPC/EACCES/EIO/...) -> {@link CasSpillError},
 *   failing the import instead of quietly inlining the blob into the log;
 * - any other store error -> issue reported, block degrades to inline by
 *   the documented tolerant policy;
 * - repeated identical payloads reuse the cached reference (the CAS is
 *   content-addressed, so the result is identical without re-hashing).
 */
export function createCasImageHook(store: CasStoreLike, onIssue?: CasIssueListener): V2ImageHook {
	const refCache = new Map<string, string>();
	return async (base64: string): Promise<string | undefined> => {
		const cached = refCache.get(base64);
		if (cached !== undefined) return cached;
		if (!isValidBase64(base64)) {
			onIssue?.({
				kind: 'invalid-base64',
				message: 'image payload is not canonical base64; keeping the block inline verbatim',
			});
			return undefined;
		}
		// Strict validation above makes the lenient decoder exact: the decoded
		// bytes are precisely the source payload (a Buffer is a Uint8Array, so
		// this satisfies the CasStoreLike contract without another copy).
		const bytes = Buffer.from(base64, 'base64');
		try {
			const { sha256, size } = await store.putBytes(bytes);
			const ref = casSpillRef(sha256, size);
			rememberRef(refCache, base64, ref);
			return ref;
		} catch (error) {
			const code = errnoCodeOf(error);
			if (code !== undefined && FATAL_STORE_ERROR_CODES.has(code)) {
				throw new CasSpillError(
					`CAS store rejected image bytes (${code}); refusing to keep the blob inline: ${errorText(error)}`,
					{ cause: error, code },
				);
			}
			onIssue?.({
				kind: 'store-error',
				code,
				message: `CAS store putBytes failed (${code ?? 'unknown error'}); degrading to inline: ${errorText(error)}`,
				cause: error,
			});
			return undefined;
		}
	};
}

/** Resolves the durable CAS root for the default profile. */
export function resolveDefaultCasRoot(): string {
	// Resolved per call, not from the DEFAULT_CAS_ROOT snapshot: os.homedir()
	// reads $HOME dynamically, so a harness that overrides HOME after this
	// module loaded still resolves its own durable root (the same caveat
	// @mavis/config documents for LEGACY_ROOT).
	return join(os.homedir(), '.mcode-durable');
}

/** Policy for a CAS that cannot be opened at all. */
export type CasUnavailablePolicy =
	/** Fail the import with {@link CasSpillError} (default). */
	| 'fail'
	/** Report the issue and keep images inline — an explicit degradation. */
	| 'keep-inline';

/** Resolution-time diagnostics and degradation policy. */
export interface CasHookPolicy {
	readonly onIssue?: CasIssueListener;
	readonly casUnavailable?: CasUnavailablePolicy;
}

/**
 * Resolves the effective image hook for an import. `undefined` means "no
 * externalization" (keep inline): either the caller disabled it with `null`,
 * or an explicit `casUnavailable: 'keep-inline'` policy accepted the
 * degradation after the CAS could not be opened. A store instance is used
 * as-is; a string opens the real `@mavis/cas` store rooted at that directory
 * (blobs land in `<root>/cas/<aa>/...`, matching `resolveCasDirPath`); the
 * default (`undefined`) opens the store under the durable root.
 */
export async function resolveImageHook(
	option: CasImageOption | undefined,
	policy?: CasHookPolicy,
): Promise<V2ImageHook | undefined> {
	if (option === null) return undefined;
	if (typeof option === 'string') {
		// An explicit root must win: previously this branch fell through to the
		// default root and the option was silently ignored.
		return openStoreHook(option, policy);
	}
	if (option !== undefined) return createCasImageHook(option, policy?.onIssue);
	return openStoreHook(resolveDefaultCasRoot(), policy);
}

/** Opens the real CAS store at `root` (the parent of the `cas` directory). */
async function openStoreHook(root: string, policy: CasHookPolicy | undefined): Promise<V2ImageHook | undefined> {
	try {
		// Lazy and structural: only resolve the real CAS package when a store
		// was not handed in directly.
		const casModule = (await import('@mavis/cas')) as { openCas: (root: string) => Promise<CasStoreLike> };
		const store = await casModule.openCas(root);
		return createCasImageHook(store, policy?.onIssue);
	} catch (error) {
		const code = errnoCodeOf(error);
		const message = `CAS is unavailable at "${root}" (${code ?? 'unresolvable @mavis/cas'}): ${errorText(error)}`;
		if (policy?.casUnavailable !== 'keep-inline') {
			// Default policy: never degrade silently — fail the import loudly.
			throw new CasSpillError(message, { cause: error, code });
		}
		policy?.onIssue?.({ kind: 'cas-unavailable', code, message, cause: error });
		return undefined;
	}
}
