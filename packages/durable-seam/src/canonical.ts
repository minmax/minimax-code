/**
 * Canonical JSON serialization and hashing.
 *
 * Payload equality across retries (the REQUEST_ID_CONFLICT check, the
 * prepared-outcome reproduction check) must be decided on a CANONICAL image:
 * key order or whitespace differences of an equivalent JSON value must not
 * manufacture a conflict, and a genuinely different payload must never pass.
 * The canonical form sorts object keys and drops nothing.
 *
 * @module
 */

import { createHash } from 'node:crypto';

/**
 * Serialize a JSON value canonically: object keys sorted, arrays in order,
 * numbers through `JSON.stringify` (seam payloads are JSON by construction —
 * the caller passes `JsonValue`, and the storage contract re-validates before
 * any write). Cyclic structures raise a `RangeError`; callers wrap it into
 * `INVALID_INPUT` before it reaches this module's callers.
 */
export function canonicalJson(value: unknown): string {
	return serialize(value, new Set());
}

function serialize(value: unknown, onPath: Set<object>): string {
	if (value === null || typeof value === 'boolean') return String(value);
	if (typeof value === 'number') return JSON.stringify(value);
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value !== 'object') {
		throw new RangeError(`value is not a JSON value: ${typeof value}`);
	}
	if (onPath.has(value as object)) {
		throw new RangeError('value contains a cyclic structure');
	}
	const container = value as object;
	onPath.add(container);
	try {
		if (Array.isArray(container)) {
			return `[${container.map((item) => serialize(item, onPath)).join(',')}]`;
		}
		const keys = Object.keys(container).sort();
		return `{${keys
			.map((key) => `${JSON.stringify(key)}:${serialize((container as Record<string, unknown>)[key], onPath)}`)
			.join(',')}}`;
	} finally {
		onPath.delete(container);
	}
}

/** SHA-256 hex digest of the canonical JSON image of `value`. */
export function hashJson(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** SHA-256 hex digest of a plain string (used for composite dedup keys). */
export function hashString(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}
