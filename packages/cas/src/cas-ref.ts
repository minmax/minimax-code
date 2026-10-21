/**
 * Canonical `cas://` reference format — THE single definition.
 *
 * A stored blob is referenced as `cas://sha256/<digest>#<size in bytes>`:
 * parseable, and human- and model-readable. This format reaches the durable
 * log of the new data path (spilled tool outputs, `image_ref` blocks of the
 * v2 import), so it is declared exactly once and every producer and reader
 * imports it from here:
 *
 * - `@mavis/agent-tools` (`src/truncation/cas-spill.ts`) re-exports both
 *   helpers and builds spill references with the builder;
 * - `@mavis/v2-adapter` (`src/cas-image-hook.ts`) re-exports them and builds
 *   `image_ref` blob descriptors with the same builder.
 *
 * Both packages previously carried byte-identical hand-synced copies ("if
 * either side changes the format, update both") — a drift would break
 * cross-reading references between the spill tools and the v2 import. Do not
 * restate the pattern or the builder anywhere else; import from this module
 * (`@mavis/cas/cas-ref`, also re-exported from the package root).
 *
 * @module
 */

/**
 * A reference is a lowercase-hex SHA-256 digest followed by the byte size.
 * Anchored: a foreign or corrupted reference parses as `null`, never as a
 * wrong blob.
 */
const CAS_SPILL_REF_PATTERN = /^cas:\/\/sha256\/([0-9a-f]{64})#(\d+)$/u;

/** Builds the canonical `cas://sha256/<digest>#<size in bytes>` reference. */
export function casSpillRef(sha256: string, size: number): string {
	return `cas://sha256/${sha256}#${size}`;
}

/** Parsed content of a {@link casSpillRef} reference. */
export interface CasSpillRefParts {
	/** Lowercase-hex SHA-256 digest of the stored bytes. */
	readonly sha256: string;
	/** Declared byte size of the stored bytes. */
	readonly size: number;
}

/** Parses a reference produced by {@link casSpillRef}; `null` when foreign. */
export function parseCasSpillRef(reference: string): CasSpillRefParts | null {
	const match = CAS_SPILL_REF_PATTERN.exec(reference);
	if (match === null) return null;
	return { sha256: match[1]!, size: Number(match[2]) };
}
