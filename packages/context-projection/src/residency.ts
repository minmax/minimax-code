// Context MMU hook.
//
// The projection stores handles (entryId + byteLen), never payload content.
// A residency policy decides which of those pages a consumer must treat as
// materialized and serves the content on demand. Without a policy every page
// is resident: the segments of the manifest are the digest+handle view and
// `fault()` resolves locally from the manifest.

import type { Segment } from './projection.js';

/**
 * Residency policy of the derived context ("Context MMU").
 *
 * Implementations own the content store behind the handles. The projection
 * consults `resident` when building the LLM context view and routes any
 * non-resident page through `onFault`, which must materialize the full
 * segment for that entry id (typically from a CAS or the durable log).
 */
export interface ResidencyPolicy {
	/** Whether the page for this entry id is currently materialized. */
	resident(entryId: string): boolean;
	/** Materializes a non-resident page, resolving to its full segment. */
	onFault(entryId: string): Promise<Segment>;
}
