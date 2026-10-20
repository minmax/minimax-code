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

import type { ToolOutputSpill } from './spill.js';

/** Structural surface of the CAS store this spill needs. */
export interface CasSpillStoreLike {
	/** Stores bytes and returns their digest and size (see `@mavis/cas`). */
	putBytes(data: Uint8Array): Promise<{ readonly sha256: string; readonly size: number }>;
}

/**
 * Canonical `cas://` reference for a stored blob: parseable, and human- and
 * model-readable (`cas://sha256/<digest>#<size in bytes>`).
 */
export function casSpillRef(sha256: string, size: number): string {
	return `cas://sha256/${sha256}#${size}`;
}

/** Parses a reference produced by {@link casSpillRef}; `null` when foreign. */
export function parseCasSpillRef(reference: string): { readonly sha256: string; readonly size: number } | null {
	const match = /^cas:\/\/sha256\/([0-9a-f]{64})#(\d+)$/u.exec(reference);
	if (match === null) return null;
	return { sha256: match[1], size: Number(match[2]) };
}

/**
 * Creates a spill hook that persists the full output payload into the CAS
 * store. Ordinary store failures degrade to `undefined` (the truncated result
 * simply carries no full-output reference), matching the hook contract.
 */
export function createCasToolOutputSpill(store: CasSpillStoreLike): ToolOutputSpill {
	return {
		async spill(payload: string): Promise<string | undefined> {
			try {
				const bytes = Buffer.from(payload, 'utf8');
				const { sha256, size } = await store.putBytes(bytes);
				return casSpillRef(sha256, size);
			} catch {
				return undefined;
			}
		},
	};
}
