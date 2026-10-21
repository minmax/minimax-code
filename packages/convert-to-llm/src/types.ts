/**
 * Contract types of the per-entry convert-to-llm stage.
 *
 * The input {@link DurableEntry} mirrors `Entry` from
 * `@mavis/durable-backend-sqlite-zstd/src/types.ts`, and {@link Segment}
 * mirrors the segment record of `@mavis/context-projection`
 * (`ContextManifest.segments`). The shapes are kept structurally identical on
 * purpose: wave-2 packages do not link each other in `node_modules` until the
 * integrator registers them, so every package declares the agreed contract
 * locally (same precedent as `packages/storage-worker/src/contracts.ts`).
 */

/**
 * JSON value accepted as an entry payload. Structurally identical to the
 * backend's `JsonValue`; declared locally so this package stays buildable
 * before workspace registration.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** One durable log entry; mirrors the sqlite-zstd backend `Entry` shape. */
export interface DurableEntry {
  /** Stable application identity, unique across the whole database. */
  readonly id: string;
  /** Log position of the predecessor entry, `null` for the first entry. */
  readonly parentId?: string | null;
  /** Application-defined discriminator (`pi.*` message kinds, `mcode.*` app kinds). */
  readonly kind: string;
  /** JSON payload stored inside the batch frame. */
  readonly payload: JsonValue;
  /** Sequence of the batch (commit) that appended this entry. */
  readonly seq: number;
  /** Zero-based position of the entry inside its batch. */
  readonly ordinal: number;
}

/** Manifest segment reference; mirrors the context-projection `Segment` shape. */
export interface Segment {
  /** Entry the segment was compiled from. */
  readonly entryId: string;
  /** Byte length as defined by the projection (raw payload serialization). */
  readonly byteLen: number;
  /** Entry kind the segment belongs to. */
  readonly kind: string;
}

/** Provider-side tool call projected from an assistant `toolCall` content block. */
export interface ProviderToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    /** JSON-encoded arguments string, byte-stable for identical stored payloads. */
    readonly arguments: string;
  };
}

/** Provider role used in a compiled record. */
export type ProviderRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Deterministic output of the per-entry conversion stage: one provider record
 * plus everything the wire compiler needs to place it into the payload
 * (cache key, byte length, prefix/tail positioning).
 */
export interface CompiledEntry {
  /**
   * Compile cache key: `(entryId, dialect, normalizerVersion)`. Batch-merged
   * records derive the key from every contributing source id, so appending a
   * batch member changes the key instead of silently reusing stale bytes.
   */
  readonly cacheKey: string;
  /** Source entry id; tail records split out of an entry use `entryId#reminder:N`. */
  readonly entryId: string;
  /** Every contributing source entry id in log order (one for plain records). */
  readonly sourceEntryIds: readonly string[];
  /** Entry kind of the source. */
  readonly kind: string;
  /** Provider role assigned by the dialect. */
  readonly role: ProviderRole;
  /** Provider text content (images are replaced by deterministic placeholders). */
  readonly content: string;
  /** Assistant tool-call deltas, projected to the provider shape. */
  readonly toolCalls?: readonly ProviderToolCall[];
  /** Correlating tool-call id of a `tool` record. */
  readonly toolCallId?: string;
  /** Tool name of a `tool` record. */
  readonly toolName?: string;
  /** Error flag of a `tool` record. */
  readonly isError?: boolean;
  /** Steering receipt linkage of a placed entry (`mcode.owner-input.placed`). */
  readonly inputEntryId?: string;
  /**
   * True when the record must be positioned after the cache prefix
   * (system-reminder tails). Prefix records never change bytes because of
   * tails; tails are appended after the prefix on every request.
   */
  readonly tail: boolean;
  /**
   * UTF-8 byte length of {@link serializeCompiledEntry} — the wire segment
   * body the record contributes to the compiled payload. This is NOT the
   * projection manifest's `Segment.byteLen` (that one measures the raw
   * stored payload for budgeting; this one measures the outgoing bytes).
   */
  readonly byteLen: number;
}

/**
 * A dialect pins the provider-format rules of the conversion. Normalization
 * rules may only change together with a `normalizerVersion` bump, so cached
 * per-entry results keyed by `(entryId, name, normalizerVersion)` never mix
 * bytes from two rule sets.
 */
export interface Dialect {
  /** Stable dialect name; first key component. */
  readonly name: string;
  /** Version of the normalization rules; second key component. */
  readonly normalizerVersion: number;
  /** Prior-turn thinking blocks: `cut` drops them entirely. */
  readonly thinking: 'cut';
  /** Joiner for several text blocks of one message. */
  readonly textJoin: '\n\n';
  /** Batch member joiner for immediate-send merges. */
  readonly batchJoin: '\n\n';
  /** Deterministic placeholder substituted for image blocks. */
  readonly imagePlaceholder: (mimeType: string) => string;
}

/** Aggregate counters reported by {@link assemblePayload}. */
export interface AssembleStats {
  /** Entries inspected. */
  readonly totalEntries: number;
  /** Audit/control entries dropped by the `mcode.*` kind filter. */
  readonly auditDropped: number;
  /** Duplicate placed entries dropped by the `inputEntryId` dedup. */
  readonly placedDropped: number;
  /** Kept entries that produced no provider record (reset boundaries, undecodable payloads, reminder-consumed text, empty system records). */
  readonly noProviderRecord: number;
  /** Immediate-send batch merges performed (extra members joined). */
  readonly batchJoins: number;
  /** Reminder tails emitted (dedicated entries plus split-out blocks). */
  readonly reminderTails: number;
  /** Bytes of the stable cache prefix (all non-tail records). */
  readonly prefixBytes: number;
  /** Bytes of the tail section. */
  readonly tailBytes: number;
  /** Total serialized payload bytes. */
  readonly totalBytes: number;
}

/** Ordered payload assembly over a list of durable entries. */
export interface AssembledPayload {
  /** Records in payload order: stable prefix first, reminder tails last. */
  readonly records: readonly CompiledEntry[];
  /** The prefix section: everything before the first tail record. */
  readonly prefix: readonly CompiledEntry[];
  /** The tail section: reminder records after the prefix. */
  readonly tails: readonly CompiledEntry[];
  /** Dialect the payload was compiled with. */
  readonly dialect: Dialect;
  readonly stats: AssembleStats;
}
