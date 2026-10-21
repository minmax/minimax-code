/**
 * Contract types of the wire compiler (Context-as-Bytes).
 *
 * Every frozen log entry is compiled independently into a Buffer segment under
 * the cache key `(entryId, dialect, normalizerVersion)`; a request body is the
 * concatenation of the segments of the current window manifest — never a
 * `JSON.stringify` over the whole message array.
 *
 * Entries arrive from the durable log and are therefore JSON-shaped: the
 * backend already rejects non-JSON payloads on write. The compiler relies on
 * the frozen-entry guarantee (an entryId never maps to different content) for
 * cache correctness.
 */

/** JSON value accepted in entry payloads; the durable log only stores these. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/** Kinds of entries the compiler knows how to serialize as independent wire stages. */
export type EntryKind = 'system' | 'tool-deltas' | 'text' | 'toolResult';

/**
 * One content block of a message. Structural pass-through of the log payload:
 * `type` is the discriminator, every other key travels untouched. The dialect
 * decides which block types it rewrites (thinking, images) and which it keeps.
 */
export type ContentBlock = { readonly type: string } & {
  readonly [key: string]: JsonValue;
};

/** One tool definition carried by a `tool-deltas` entry (the stable prefix). */
export type ToolDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: JsonValue;
} & {
  readonly [key: string]: JsonValue;
};

/** One frozen log entry handed to the compiler. */
export type Entry = {
  /** Stable identity of the frozen log entry; unique across the database. */
  readonly entryId: string;
  /** Which per-entry serialization stage runs for this entry. */
  readonly kind: EntryKind;
  /**
   * Wire role hint. The default dialect substitutes a kind-specific default
   * when omitted: `system` → "system", `text` → "user", `tool-deltas` →
   * "tool-deltas", `toolResult` → "toolResult".
   */
  readonly role?: string;
  /**
   * Message payload of `system`/`text` entries: a plain string or content
   * blocks. `toolResult` entries carry their blocks here as well.
   */
  readonly content?: string | readonly ContentBlock[];
  /** Tool definitions payload of a `tool-deltas` entry. */
  readonly tools?: readonly ToolDefinition[];
  /** Tool result identity (`toolResult` kind). */
  readonly toolCallId?: string;
  /** Tool result source tool (`toolResult` kind). */
  readonly toolName?: string;
  /** Whether the tool failed (`toolResult` kind). */
  readonly isError?: boolean;
};

/**
 * One ordered reference of the context window manifest, mirroring the
 * architecture's `manifest [{entryId, segOff, len, hash}]`. The advisory
 * fields (`segOff`, `len`, `hash`) describe a previous materialization;
 * `compile()` re-derives all of them and reports fresh values in its stats,
 * so callers can publish an updated manifest from one compile pass.
 */
export type ContextManifestSegment = {
  readonly entryId: string;
  readonly segOff?: number;
  readonly len?: number;
  readonly hash?: string;
};

/**
 * Ordered window manifest: last compaction summary, then kept tail, then
 * delta. Compilation follows exactly this order.
 */
export type ContextManifest = readonly ContextManifestSegment[];

/** Per-entry normalization contract of one provider wire format. */
export interface WireDialect {
  /** Stable dialect identifier; part of the segment cache key. */
  readonly name: string;
  /**
   * Revision of the normalize rules. Bump it whenever `normalizeEntry`'s
   * output would change for some existing entry; never mutate the rules under
   * an unchanged version.
   */
  readonly normalizerVersion: string;
  /** Normalizes one entry into its wire JSON value. Must be deterministic. */
  normalizeEntry(entry: Entry): JsonValue;
}

/** Structural cache seam so callers can plug their own eviction policy. */
export interface WireSegmentCache {
  /** Returns the cached segment and refreshes its recency, or `undefined`. */
  get(key: string): Buffer | undefined;
  /** Stores (or overwrites) a segment as the most recently used entry. */
  set(key: string, segment: Buffer): void;
}

/** Options of {@link compile}. */
export type CompileOptions = {
  /**
   * Hard cap on the compiled body size in bytes. The guard runs on the
   * per-entry byte lengths (arithmetic over the manifest, no serialization
   * work); a breach aborts the compile with {@link WireBudgetExceeded}.
   */
  readonly maxBytes: number;
  /** Wire dialect driving per-entry normalization. Default: minimax-m3. */
  readonly dialect?: WireDialect;
  /**
   * Segment cache. Default: the module-level shared LRU bounded by
   * `DEFAULT_SEGMENT_CACHE_CAPACITY`, keyed by
   * `(dialect.name, dialect.normalizerVersion, entryId)`.
   */
  readonly cache?: WireSegmentCache;
};

/** Byte/size facts about one compiled segment, in manifest order. */
export type SegmentStat = {
  readonly entryId: string;
  readonly kind: EntryKind;
  /** Size of the segment in bytes. */
  readonly bytes: number;
  /** Lowercase hex SHA-256 of the segment bytes (for manifest publication). */
  readonly sha256: string;
  /** Whether the segment came from the cache instead of being serialized. */
  readonly cacheHit: boolean;
};

/** Result of one compile pass. */
export type CompiledBody = {
  /**
   * The wire body: newline-delimited JSON, one normalized entry per line,
   * assembled with a single `Buffer.concat` over the cached segments.
   */
  readonly body: Buffer;
  /** Exact byte length of `body`. */
  readonly totalBytes: number;
  /** Per-entry breakdown in manifest order; the budget guard uses the same lens. */
  readonly segments: readonly SegmentStat[];
};
