// Context MMU: a page cache over an injected content-addressed store.
//
// Pages are CAS-backed blobs (typically images). The MMU keeps a bounded
// resident set of budgeted pages and represents everything else — and any
// page too large for the budget — by a deterministic digest placeholder that
// stands in for the bytes inside the model context; the bytes themselves only
// ever reach codemode/scripts through `fault`/`pages.read`.
//
// Budget policy: LRU by bytes with batch eviction — an over-budget admission
// drains the resident set down to `maxResidentBytes * batchEvictRatio` in one
// pass instead of evicting a single page, and the gap between the watermark
// and the hard budget is the slack that stops a page near the LRU tail from
// being evicted and re-faulted every turn. Pins add hysteresis on top: a page
// pinned for N turns is skipped by eviction until the countdown (advanced by
// `advanceTurn`) expires, and `unpin` keeps a short grace so an intra-turn
// unpin cannot thrash. Pins are explicit caller contracts, so a resident set
// that is entirely pinned may oversubscribe the budget; unpinned residency
// always stays within it.
//
// Coherence: `watch` attaches `fs.watch` to the bound paths. A change to a
// watched file publishes the new content into the CAS, marks every live page
// bound to that path `stale`, and issues a replacement "diff" handle whose
// `previousSha256` names the version it replaced. Stale handles are dead:
// `fault`/`admit`/`digest` on them reject loudly so an outdated image can
// never silently re-enter a context.
//
// The store is injected and only the wave-1 `CasStore` contract is required
// (type-only import, erased at runtime).

import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import type { CasStore, PutResult } from '../../cas/src/index.js';
import { formatPageDigest } from './digest.js';
import type { PageDigestInfo } from './digest.js';
import { PathWatcher } from './watch.js';
import type {
  AdmitResult,
  ContextMmu,
  MmuOptions,
  MmuStats,
  PageFileMeta,
  PageHandle,
  PageRef,
  PageStatus,
  Pages,
} from './types.js';

const DEFAULT_MAX_RESIDENT_BYTES = 12 * 1024 * 1024;
const DEFAULT_PIN_TURNS = 4;
const DEFAULT_UNPIN_GRACE_TURNS = 1;
const DEFAULT_BATCH_EVICT_RATIO = 0.75;
const DEFAULT_WATCH_DEBOUNCE_MS = 25;
// fs.watch delivery is best-effort (FSEvents latency under load, silent stop
// after unlink); the poll backstop guarantees eventual staleness regardless.
const DEFAULT_WATCH_POLL_MS = 2_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_FILE_MIME = 'application/octet-stream';

/** Lowercases and validates a digest, rejecting traversal-prone input. */
function toDigest(sha256: string): string {
  const digest = sha256.toLowerCase();
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`invalid SHA-256 digest: ${JSON.stringify(sha256)}`);
  }
  return digest;
}

interface PageRecord {
  id: string;
  sha256: string;
  mime: string;
  width: number | undefined;
  height: number | undefined;
  size: number;
  sourcePath: string | undefined;
  /** Content handed to `page()` and not yet published to the CAS. */
  pendingBytes: Buffer | undefined;
  /** Hydrated cache, valid only while the record occupies a resident slot. */
  loadedBytes: Buffer | undefined;
  /** Turn until which eviction must skip this record (0 = never pinned). */
  pinnedUntilTurn: number;
  stale: boolean;
  replacedBy: PageRecord | undefined;
  previousSha256: string | undefined;
  released: boolean;
  everAdmitted: boolean;
  handle: PageHandle;
}

/** Read-only handle facade handed out to consumers. */
class PageHandleImpl implements PageHandle {
  constructor(private readonly record: PageRecord) {}

  get id(): string {
    return this.record.id;
  }
  get sha256(): string {
    return this.record.sha256;
  }
  get mime(): string {
    return this.record.mime;
  }
  get width(): number | undefined {
    return this.record.width;
  }
  get height(): number | undefined {
    return this.record.height;
  }
  get bytes(): number {
    return this.record.size;
  }
  get sourcePath(): string | undefined {
    return this.record.sourcePath;
  }
  get stale(): boolean {
    return this.record.stale;
  }
  get replacedBy(): PageHandle | undefined {
    return this.record.replacedBy?.handle;
  }
  get previousSha256(): string | undefined {
    return this.record.previousSha256;
  }
}

class ContextMmuImpl implements ContextMmu {
  private readonly maxResidentBytes: number;
  private readonly pinTurns: number;
  private readonly unpinGraceTurns: number;
  private readonly batchEvictRatio: number;
  private readonly watchDebounceMs: number;
  private readonly watchPollMs: number;

  /** All live records keyed by handle id. */
  private readonly records = new Map<string, PageRecord>();
  /** Resident records in LRU order (first = least recently used). */
  private readonly lru = new Map<string, PageRecord>();
  /** Resolved source path -> ids of live records bound to it. */
  private readonly bindings = new Map<string, Set<string>>();
  private residentBytes = 0;
  private currentTurn = 0;
  private closed = false;
  private watcher: PathWatcher | undefined;
  /** Serializes refreshes per path so bursts cannot interleave. */
  private readonly refreshChains = new Map<string, Promise<void>>();

  readonly pages: Pages;

  constructor(
    private readonly cas: CasStore,
    options: MmuOptions,
  ) {
    if (options.maxResidentBytes !== undefined && options.maxResidentBytes < 0) {
      throw new Error('maxResidentBytes must be >= 0');
    }
    if (options.batchEvictRatio !== undefined && (options.batchEvictRatio <= 0 || options.batchEvictRatio > 1)) {
      throw new Error('batchEvictRatio must be in (0, 1]');
    }
    this.maxResidentBytes = options.maxResidentBytes ?? DEFAULT_MAX_RESIDENT_BYTES;
    this.pinTurns = options.pinTurns ?? DEFAULT_PIN_TURNS;
    this.unpinGraceTurns = Math.max(0, options.unpinGraceTurns ?? DEFAULT_UNPIN_GRACE_TURNS);
    this.batchEvictRatio = options.batchEvictRatio ?? DEFAULT_BATCH_EVICT_RATIO;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.watchPollMs = options.watchPollMs ?? DEFAULT_WATCH_POLL_MS;
    this.pages = {
      read: (handle) => this.fault(handle),
      digest: (handle) => this.digest(handle),
    };
  }

  // -- page creation -------------------------------------------------------

  page(ref: PageRef): PageHandle {
    this.assertOpen();
    const sha256 = toDigest(ref.sha256);
    if (typeof ref.mime !== 'string' || ref.mime.length === 0) {
      throw new Error('page ref requires a non-empty mime');
    }
    let size: number;
    let pendingBytes: Buffer | undefined;
    if (ref.bytes !== undefined) {
      if (!Buffer.isBuffer(ref.bytes)) {
        throw new Error('page ref bytes must be a Buffer');
      }
      size = ref.bytes.length;
      const actual = createHash('sha256').update(ref.bytes).digest('hex');
      if (actual !== sha256) {
        throw new Error(`page ref bytes do not match sha256: expected ${sha256}, got ${actual}`);
      }
      pendingBytes = ref.bytes;
    } else {
      // No in-hand bytes: the blob must already be durable; its size comes
      // from the published blob itself (`pathFor` is part of the CAS contract).
      if (!this.cas.has(sha256)) {
        throw new Error(`page ref has no bytes and the blob is not in the CAS: ${sha256}`);
      }
      size = statSync(this.cas.pathFor(sha256)).size;
    }
    const record = this.createRecord({
      sha256,
      mime: ref.mime,
      width: ref.width,
      height: ref.height,
      size,
      sourcePath: undefined,
      pendingBytes,
    });
    return record.handle;
  }

  async pageFile(filePath: string, meta: PageFileMeta = {}): Promise<PageHandle> {
    this.assertOpen();
    const resolved = path.resolve(filePath);
    const put = await this.cas.putFile(resolved);
    const record = this.createRecord({
      sha256: put.sha256,
      mime: meta.mime ?? DEFAULT_FILE_MIME,
      width: meta.width,
      height: meta.height,
      size: put.size,
      sourcePath: resolved,
      pendingBytes: undefined,
    });
    this.bindPath(resolved, record);
    return record.handle;
  }

  private createRecord(init: {
    sha256: string;
    mime: string;
    width: number | undefined;
    height: number | undefined;
    size: number;
    sourcePath: string | undefined;
    pendingBytes: Buffer | undefined;
    previousSha256?: string;
  }): PageRecord {
    const record: PageRecord = {
      id: randomUUID(),
      sha256: init.sha256,
      mime: init.mime,
      width: init.width,
      height: init.height,
      size: init.size,
      sourcePath: init.sourcePath,
      pendingBytes: init.pendingBytes,
      loadedBytes: undefined,
      pinnedUntilTurn: 0,
      stale: false,
      replacedBy: undefined,
      previousSha256: init.previousSha256,
      released: false,
      everAdmitted: false,
      handle: undefined as unknown as PageHandle,
    };
    record.handle = new PageHandleImpl(record);
    this.records.set(record.id, record);
    return record;
  }

  // -- residency -----------------------------------------------------------

  admit(handle: PageHandle): AdmitResult {
    const record = this.liveRecordOf(handle);
    if (record.stale) {
      throw new Error(this.staleMessage(record));
    }
    if (record.size > this.maxResidentBytes) {
      // Can never fit, no matter what gets evicted: stay digest-only.
      record.everAdmitted = true;
      return 'digest';
    }
    if (!this.lru.has(record.id)) {
      record.everAdmitted = true;
      // Residency is budget accounting here; `fault` hydrates the buffer.
      this.lru.set(record.id, record);
      this.residentBytes += record.size;
      // The incoming page is the reason for this eviction pass and must
      // survive it even when the watermark drain would reach it.
      this.evict(record.id);
    } else {
      this.touch(record);
    }
    return 'resident';
  }

  async fault(handle: PageHandle): Promise<Buffer> {
    const record = this.liveRecordOf(handle);
    if (record.stale) {
      throw new Error(this.staleMessage(record));
    }
    if (this.lru.has(record.id)) {
      this.touch(record);
      if (record.loadedBytes !== undefined) {
        return record.loadedBytes;
      }
      const bytes = await this.obtainBytes(record);
      // The record may have been evicted while the CAS read was in flight;
      // only a still-resident record keeps the hydrated cache.
      if (this.lru.has(record.id)) {
        record.loadedBytes = bytes;
      }
      return bytes;
    }
    // Digest-mode (or never admitted): a load-through that never occupies a
    // budget slot — residency is decided exclusively by `admit`.
    return this.obtainBytes(record);
  }

  release(handle: PageHandle): void {
    const record = this.records.get(handle.id);
    if (record === undefined) {
      throw new Error(`unknown page handle: ${handle.id}`);
    }
    if (record.released) {
      return; // Idempotent: disposers may race or double-fire.
    }
    if (this.lru.delete(record.id)) {
      this.residentBytes -= record.size;
    }
    record.released = true;
    record.loadedBytes = undefined;
    record.pendingBytes = undefined;
    if (record.sourcePath !== undefined) {
      this.unbindPath(record.sourcePath, record.id);
    }
  }

  // -- turns and pins ------------------------------------------------------

  get turn(): number {
    return this.currentTurn;
  }

  advanceTurn(): number {
    this.currentTurn += 1;
    return this.currentTurn;
  }

  pin(handle: PageHandle, turns?: number): void {
    const record = this.liveRecordOf(handle);
    const count = turns ?? this.pinTurns;
    if (!Number.isInteger(count) || count < 1) {
      throw new Error('pin turns must be a positive integer');
    }
    record.pinnedUntilTurn = Math.max(record.pinnedUntilTurn, this.currentTurn + count);
  }

  unpin(handle: PageHandle): void {
    const record = this.liveRecordOf(handle);
    // Only a genuinely pinned record gets the grace; unpinning an already
    // unpinned page must not conjure protection out of nowhere.
    if (record.pinnedUntilTurn > this.currentTurn) {
      record.pinnedUntilTurn = this.currentTurn + this.unpinGraceTurns;
    }
  }

  // -- digest placeholder --------------------------------------------------

  digest(handle: PageHandle): string {
    const record = this.liveRecordOf(handle);
    if (record.released) {
      throw new Error(`page already released: ${record.id}`);
    }
    if (record.stale) {
      throw new Error(this.staleMessage(record));
    }
    return formatPageDigest(record);
  }

  // -- observability -------------------------------------------------------

  stats(): MmuStats {
    return { resident: this.lru.size, bytes: this.residentBytes };
  }

  statusOf(handle: PageHandle): PageStatus {
    const record = this.records.get(handle.id);
    if (record === undefined) {
      throw new Error(`unknown page handle: ${handle.id}`);
    }
    if (record.released) {
      return 'released';
    }
    if (record.stale) {
      return 'stale';
    }
    if (this.lru.has(record.id)) {
      return 'resident';
    }
    return record.everAdmitted ? 'digest' : 'new';
  }

  // -- coherence -----------------------------------------------------------

  watch(paths: string | readonly string[]): () => void {
    this.assertOpen();
    const list = (Array.isArray(paths) ? paths : [paths]).map((p) => path.resolve(p));
    if (this.watcher === undefined) {
      this.watcher = new PathWatcher([], {
        debounceMs: this.watchDebounceMs,
        pollMs: this.watchPollMs,
        onChange: (resolved) => this.handleChange(resolved),
      });
    }
    this.watcher.extend(list);
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      this.watcher?.detach(list);
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.lru.clear();
    this.records.clear();
    this.bindings.clear();
    this.refreshChains.clear();
    this.residentBytes = 0;
  }

  private handleChange(resolved: string): void {
    // Serialize refreshes per path: a debounced burst must observe file state
    // in publish order, and a failed refresh must not poison the next one.
    const previous = this.refreshChains.get(resolved) ?? Promise.resolve();
    const next = previous
      .then(() => this.refreshPath(resolved))
      .catch(() => {
        // Watcher callbacks cannot throw; a failed refresh leaves pages
        // fresh and the next file change retries.
      })
      .finally(() => {
        // Drop the tail once it settles so the map does not grow per path.
        if (this.refreshChains.get(resolved) === next) {
          this.refreshChains.delete(resolved);
        }
      });
    this.refreshChains.set(resolved, next);
  }

  private async refreshPath(resolved: string): Promise<void> {
    const ids = this.bindings.get(resolved);
    if (ids === undefined || ids.size === 0 || this.closed) {
      return;
    }
    let put: PutResult | undefined;
    let vanished = false;
    try {
      put = await this.cas.putFile(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        vanished = true; // The file was deleted: stale without a replacement.
      } else {
        throw error;
      }
    }
    for (const id of [...ids]) {
      const record = this.records.get(id);
      if (record === undefined || record.released || record.stale) {
        continue;
      }
      if (put !== undefined && put.sha256 === record.sha256) {
        continue; // Content touch without a content change.
      }
      this.replaceWithFresh(record, put, resolved, vanished);
    }
  }

  /**
   * Marks `record` stale and issues its replacement. The replacement is a
   * diff handle: it carries `previousSha256` naming the version it replaces
   * and inherits the stale record's resident slot when it had one.
   */
  private replaceWithFresh(
    record: PageRecord,
    put: PutResult | undefined,
    resolved: string,
    vanished: boolean,
  ): void {
    const wasResident = this.lru.delete(record.id);
    if (wasResident) {
      this.residentBytes -= record.size;
    }
    record.stale = true;
    record.loadedBytes = undefined;
    record.pendingBytes = undefined;
    this.unbindPath(resolved, record.id);
    if (vanished || put === undefined) {
      return;
    }
    const fresh = this.createRecord({
      sha256: put.sha256,
      mime: record.mime,
      width: undefined, // New content: intrinsic dimensions are unknown.
      height: undefined,
      size: put.size,
      sourcePath: resolved,
      pendingBytes: undefined,
      previousSha256: record.sha256,
    });
    this.bindPath(resolved, fresh);
    record.replacedBy = fresh;
    if (wasResident && fresh.size <= this.maxResidentBytes) {
      this.lru.set(fresh.id, fresh);
      this.residentBytes += fresh.size;
      this.evict(fresh.id);
    }
  }

  // -- internals -----------------------------------------------------------

  /**
   * Batch eviction: drain to the watermark, stale records first, LRU then.
   * `exceptId` (the page that triggered the pass) is never evicted here.
   */
  private evict(exceptId?: string): void {
    if (this.residentBytes <= this.maxResidentBytes) {
      return;
    }
    const target = Math.floor(this.maxResidentBytes * this.batchEvictRatio);
    this.evictPass(target, exceptId, (record) => record.stale);
    this.evictPass(target, exceptId, (record) => record.pinnedUntilTurn <= this.currentTurn);
    // Whatever is left over the budget is pinned: pins are explicit caller
    // contracts and win over the budget.
  }

  private evictPass(
    targetBytes: number,
    exceptId: string | undefined,
    eligible: (record: PageRecord) => boolean,
  ): void {
    for (const record of this.lru.values()) {
      if (this.residentBytes <= targetBytes) {
        return;
      }
      if (record.id === exceptId || !eligible(record)) {
        continue;
      }
      this.lru.delete(record.id);
      this.residentBytes -= record.size;
      record.loadedBytes = undefined;
    }
  }

  private touch(record: PageRecord): void {
    // Re-inserting moves the record to the LRU tail (most recently used).
    this.lru.delete(record.id);
    this.lru.set(record.id, record);
  }

  /** Returns the original content bytes, publishing pending bytes first. */
  private async obtainBytes(record: PageRecord): Promise<Buffer> {
    const pending = record.pendingBytes;
    if (pending !== undefined) {
      const put = await this.cas.putBytes(pending);
      if (put.sha256 !== record.sha256) {
        throw new Error(`published bytes do not match page digest: ${record.sha256}`);
      }
      record.pendingBytes = undefined; // Durable now; the memory copy can go.
      return pending;
    }
    return this.cas.get(record.sha256);
  }

  private liveRecordOf(handle: PageHandle): PageRecord {
    const record = this.records.get(handle.id);
    if (record === undefined) {
      throw new Error(`unknown page handle: ${handle.id}`);
    }
    if (record.released) {
      throw new Error(`page already released: ${record.id}`);
    }
    return record;
  }

  private staleMessage(record: PageRecord): string {
    const next = record.replacedBy?.sha256 ?? '<gone>';
    return `page is stale: ${record.sha256} was replaced by ${next}; use the replacement handle`;
  }

  private bindPath(resolved: string, record: PageRecord): void {
    let ids = this.bindings.get(resolved);
    if (ids === undefined) {
      ids = new Set();
      this.bindings.set(resolved, ids);
    }
    ids.add(record.id);
  }

  private unbindPath(resolved: string, id: string): void {
    const ids = this.bindings.get(resolved);
    if (ids === undefined) {
      return;
    }
    ids.delete(id);
    if (ids.size === 0) {
      this.bindings.delete(resolved);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('context MMU is closed');
    }
  }
}

/**
 * Creates a context MMU over an injected CAS. `formatPageDigest` re-exported
 * below is the pure placeholder renderer used by `digest()`.
 */
export function createMMU(cas: CasStore, opts: MmuOptions = {}): ContextMmu {
  return new ContextMmuImpl(cas, opts);
}

/** Re-exported for consumers that need to pre-render placeholders. */
export { formatPageDigest };
export type { PageDigestInfo };
