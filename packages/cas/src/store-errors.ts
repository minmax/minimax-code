/**
 * Store-failure classification shared by every CAS consumer (THE single
 * definition).
 *
 * Both consumers of the store face the same question when a `put` fails: may
 * the payload degrade to an inline representation, or does the failure mean
 * the storage volume itself is broken? The policy is stated once here:
 *
 * - fatal errno codes ({@link FATAL_STORE_ERROR_CODES}) mean the volume or
 *   the store is broken (disk full, quota, permission, read-only, I/O);
 *   degrading would silently push the blob bytes back into the history log
 *   the CAS was supposed to keep out — consumers must fail loudly instead;
 * - any other failure is a non-fatal store error; consumers may degrade by
 *   their documented policy, but must report the degradation to their
 *   diagnostics channel.
 *
 * Consumers:
 *
 * - `@mavis/agent-tools` (`src/truncation/cas-spill.ts`) — tool-output and
 *   inline-image spill on the pre-commit hot path;
 * - `@mavis/v2-adapter` (`src/cas-image-hook.ts`) — image externalization
 *   during the v2 import.
 *
 * @module
 */

/**
 * errno codes that mean the store or its volume is broken. A `putBytes` (or
 * `putFile`/`putBase64`) failure with one of these must never degrade to an
 * inline representation: the history log would silently absorb the blob
 * bytes the CAS was supposed to keep out.
 */
export const FATAL_STORE_ERROR_CODES: ReadonlySet<string> = new Set([
	'ENOSPC', // volume full
	'EDQUOT', // quota exceeded
	'EACCES', // permission denied
	'EPERM', // operation not permitted
	'EROFS', // read-only filesystem
	'EIO', // I/O error
]);

/** The `code` of an errno-style error, `undefined` when it carries none. */
export function errnoCodeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null | undefined)?.code;
}

/** Whether `error` is a store failure that must never degrade to inline. */
export function isFatalStoreError(error: unknown): boolean {
	const code = errnoCodeOf(error);
	return code !== undefined && FATAL_STORE_ERROR_CODES.has(code);
}
