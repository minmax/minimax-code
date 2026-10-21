// Public contracts of the context MMU.
//
// The MMU decides which pages (CAS-backed blobs) live as resident bytes inside
// the agent's working set and which are represented only by a digest
// placeholder. The CAS is always injected: this package never imports
// `@mavis/cas` at runtime — the import below is type-only and erased, so any
// object structurally satisfying the wave-1 `CasStore` contract works.

import type { CasStore } from '../../cas/src/index.js';

export type { CasStore };

/** Reference to content identified by its CAS digest. */
export interface PageRef {
  /** Lowercase hex SHA-256 of the content (the CAS digest). */
  sha256: string;
  /** MIME type of the content, e.g. `image/png`. */
  mime: string;
  /**
   * Raw content bytes. Optional: when omitted the blob must already be
   * published in the injected store, otherwise the first `fault` publishes
   * them (`putBytes`) and then keeps serving from the CAS.
   */
  bytes?: Buffer;
  /** Intrinsic content width, when known (e.g. an image). */
  width?: number;
  /** Intrinsic content height, when known. */
  height?: number;
}

/** Extra metadata for creating a page bound to a file on disk. */
export interface PageFileMeta {
  /** MIME type; defaults to `application/octet-stream`. */
  mime?: string;
  width?: number;
  height?: number;
}

/**
 * Opaque handle to a page. Consumers only read its fields; all lifecycle
 * mutation (staleness, replacement, residency) is owned by the MMU that
 * issued the handle.
 */
export interface PageHandle {
  /** Stable id, unique per handle within its MMU instance. */
  readonly id: string;
  /** Lowercase hex SHA-256 of the page content. */
  readonly sha256: string;
  readonly mime: string;
  readonly width: number | undefined;
  readonly height: number | undefined;
  /** Size of the content in bytes. */
  readonly bytes: number;
  /** Resolved path this page is bound to, when created via `pageFile`. */
  readonly sourcePath: string | undefined;
  /** Whether the watched underlying file changed after this handle was issued. */
  readonly stale: boolean;
  /** The replacement handle issued after the bound file changed. */
  readonly replacedBy: PageHandle | undefined;
  /** For a replacement handle: digest of the version it replaced (the diff). */
  readonly previousSha256: string | undefined;
}

/** Aggregate residency counters. */
export interface MmuStats {
  /** Number of pages currently in the resident set. */
  resident: number;
  /** Total bytes budgeted by resident pages. */
  bytes: number;
}

/**
 * What codemode/scripts receive: the only ways to observe a page. Reads
 * return bytes to the caller without the bytes ever entering the model
 * context — the context holds the `digest` placeholder instead.
 */
export interface Pages {
  read(handle: PageHandle): Promise<Buffer>;
  digest(handle: PageHandle): string;
}

/** Whether `admit` placed a page into the resident set or left it digest-only. */
export type AdmitResult = 'resident' | 'digest';

/** Lifecycle status of a handle, for diagnostics and tests. */
export type PageStatus = 'new' | 'resident' | 'digest' | 'stale' | 'released';

export interface MmuOptions {
  /**
   * Byte budget of the resident set. Eviction keeps unpinned residency at or
   * under this value; pinned pages may legitimately oversubscribe it because
   * a pin is an explicit caller contract. Default: 12 MiB.
   */
  maxResidentBytes?: number;
  /** Default lifetime (in turns) of a `pin()` without an explicit count. Default: 4. */
  pinTurns?: number;
  /**
   * Turns a page stays evict-protected after `unpin()` — the hysteresis that
   * keeps a page unpinned mid-turn from being evicted within the same turn.
   * Default: 1.
   */
  unpinGraceTurns?: number;
  /**
   * Batch eviction drains the resident set down to
   * `maxResidentBytes * batchEvictRatio` instead of evicting one page per
   * admission, so a page near the LRU tail is not evicted and re-faulted on
   * every turn. Default: 0.75.
   */
  batchEvictRatio?: number;
  /** Coalescing window for `fs.watch` event bursts, in ms. Default: 25. */
  watchDebounceMs?: number;
}

/** The context MMU: paging facade over an injected CAS. */
export interface ContextMmu {
  /**
   * Creates a handle for `ref`. When `ref.bytes` are given they are verified
   * against `ref.sha256` and published to the CAS on the first `fault`
   * (deduplicated); otherwise the blob must already exist in the store.
   * Creating a page never makes it resident.
   */
  page(ref: PageRef): PageHandle;
  /**
   * Creates a handle from a file on disk (stored verbatim via
   * `cas.putFile`) and binds it to the resolved path for `watch` coherence.
   */
  pageFile(filePath: string, meta?: PageFileMeta): Promise<PageHandle>;
  /**
   * Explicit residency decision: reserves the page's bytes in the resident
   * set (evicting others in batches as needed) or, when the page can never
   * fit the budget, leaves it digest-only. Purely synchronous: residency is
   * budget accounting; the byte buffer is hydrated lazily by `fault`.
   */
  admit(handle: PageHandle): AdmitResult;
  /**
   * Returns the page's original bytes, hydrating the CAS blob on demand.
   * Faulting never changes residency: use `admit` for that.
   */
  fault(handle: PageHandle): Promise<Buffer>;
  /**
   * Drops the page: frees its resident slot and buffered bytes. Idempotent.
   * Every later use of the handle rejects.
   */
  release(handle: PageHandle): void;
  /** Deterministic digest placeholder that stands in for the page in context. */
  digest(handle: PageHandle): string;
  /** Resident-set counters (count and budgeted bytes). */
  stats(): MmuStats;
  /** Lifecycle status of a handle. */
  statusOf(handle: PageHandle): PageStatus;
  /** Protects the page from eviction for `turns` turns (default `pinTurns`). */
  pin(handle: PageHandle, turns?: number): void;
  /**
   * Ends a pin early; the page keeps a small evict-protection grace
   * (`unpinGraceTurns`) so intra-turn evictions cannot thrash it.
   */
  unpin(handle: PageHandle): void;
  /** Current turn counter (starts at 0). */
  readonly turn: number;
  /** Advances the turn; pin countdowns and hysteresis are measured in turns. */
  advanceTurn(): number;
  /**
   * Watches files or directories (non-recursive) with `fs.watch`. When a
   * watched file changes, every live page bound to it is marked `stale` and
   * replaced by a diff handle pointing at the new content. Returns a
   * disposer; the returned function is idempotent.
   */
  watch(paths: string | readonly string[]): () => void;
  /** The `ctx.pages` contract handed to codemode/scripts. */
  readonly pages: Pages;
  /** Stops all watchers and drops all state. */
  close(): void;
}
