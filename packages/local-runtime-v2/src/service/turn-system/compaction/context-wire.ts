// Context wire pipeline — the Ф2 context path composed for the runtime.
//
// Wave-2 review finding: none of the five context packages was imported by
// the runtime, so the Ф2 budgets (prep ≤50 мс, payload ≤32 МБ, открытие ≤1 с)
// were unmeasurable "on the real path". This module is the runtime seam: it
// wires the three packages of the request path together ONCE —
//
//   durable commits → ProjectionService (window manifest, incremental fold)
//                   → convert-to-llm (per-entry stage, convertEntry)
//                   → wire-compiler  (cached Buffer segments, byte guard)
//
// — and exposes the two operations the turn loop needs: `applyCommit` per
// durable commit (O(entries of the commit)) and `prepare()` per provider
// request (O(window); warm requests reuse cached segments without
// re-hashing). The byte guard (`maxBytes`) runs inside every `prepare`, so a
// payload breach fails the request preparation with `WireBudgetExceeded`
// before anything is sent.
//
// RAM: the projection stores handles only, so THIS module owns the window's
// content pages — and prunes them to the manifest segments after every
// commit. Retention is bounded by the WINDOW, never by history length: what
// a compaction cuts is dropped here too.
//
// Package imports are workspace-relative on purpose: wave-2 packages do not
// link each other in `node_modules` until the integrator registers them —
// the same precedent as `@mavis/context-projection` importing the backend
// types. Backend `Entry`/`Commit`/`Seq` come in type-only (wave-1 contract).

import type { Commit, Entry, Seq } from '../../../../../durable-backend-sqlite-zstd/src/types.js';
import { createHash } from 'node:crypto';

import {
  ProjectionService,
  buildProjection,
  type CommitWithEntries,
  type ContextManifest,
  type ResumeCapsule,
} from '../../../../../context-projection/src/index.js';
import { convertEntry } from '../../../../../convert-to-llm/src/index.js';
import {
  WireBudgetExceeded,
  compile,
  compiledEntryToWireEntry,
  compiledRecordDialect,
  createLruSegmentCache,
  type CompiledBody,
  type Entry as WireEntry,
  type WireSegmentCache,
} from '../../../../../wire-compiler/src/index.js';

/** Default hard cap of the provider payload: the Ф2 "payload ≤32 МБ всегда" gate. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Stable wire id of the compaction summary record for a mark: keyed by the
 * summary content, so a newer checkpoint over the SAME cut with a different
 * summary recompiles instead of reusing stale bytes.
 */
function summaryEntryId(summary: string): string {
  const digest = createHash('sha256').update(summary, 'utf8').digest('hex').slice(0, 16);
  return `mcode-compaction-summary#${digest}`;
}

/**
 * The compaction summary as a wire entry: the checkpoint entry itself is
 * audit/control (never a provider record), but its summary replaces the
 * compacted prefix in the window — the manifest's mark, projected as the
 * leading user record ([summary, ...kept tail...]).
 */
function summaryWireEntry(manifest: ContextManifest): WireEntry | undefined {
  const mark = manifest.compaction;
  if (mark === undefined) return undefined;
  return { entryId: summaryEntryId(mark.summary), kind: 'text', role: 'user', content: mark.summary };
}

export interface ContextWireOptions {
  /**
   * Hard cap on the compiled provider payload in bytes; `prepare()` throws
   * {@link WireBudgetExceeded} on breach. Default {@link DEFAULT_MAX_PAYLOAD_BYTES}.
   */
  readonly maxBytes?: number;
  /** Segment cache capacity. Default 4096 (one multi-hour session's window). */
  readonly cacheCapacity?: number;
  /** Explicit segment cache (tests). Default: a private LRU. */
  readonly cache?: WireSegmentCache;
}

/** The prepared provider payload plus the facts the turn loop reports. */
export interface PreparedContext {
  /** NDJSON wire body: one normalized provider record per line. */
  readonly body: Buffer;
  /** Exact byte length of `body` — the provider payload byte truth. */
  readonly totalBytes: number;
  /** Σ manifest segment bytes (the compaction byte-trigger axis, for contrast). */
  readonly manifestBytes: number;
  /** The manifest the body was compiled from. */
  readonly manifest: ContextManifest;
  readonly segments: CompiledBody['segments'];
}

/**
 * The incremental context path over one durable log. Feed every committed
 * batch through {@link applyCommit}; call {@link prepare} for each provider
 * request. The window manifest, the resume capsule and the segment cache
 * stay warm — nothing re-reads applied history.
 */
export class ContextWirePipeline {
  private readonly service: ProjectionService;
  private readonly cache: WireSegmentCache;
  private readonly maxBytes: number;
  /** Content pages of the current window; pruned to the manifest after each commit. */
  private readonly content = new Map<string, Entry>();

  constructor(options?: ContextWireOptions) {
    this.service = new ProjectionService();
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.cache = options?.cache ?? createLruSegmentCache(options?.cacheCapacity ?? 4096);
  }

  /**
   * Rebuilds the pipeline from a resume capsule and the retained slice the
   * storage layer serves for it — the lazy-open path (≤1 с budget opening).
   * The slice's entries are the initial window content pages.
   */
  static fromCapsule(capsule: ResumeCapsule, slice: readonly Entry[], options?: ContextWireOptions): ContextWirePipeline {
    const pipeline = new ContextWirePipeline(options);
    (pipeline as { service: ProjectionService }).service = ProjectionService.fromCapsule(capsule, slice);
    for (const entry of slice) pipeline.content.set(entry.id, entry);
    pipeline.pruneToWindow();
    return pipeline;
  }

  /** Applies one committed batch (the backend commit enriched with its entries). */
  applyCommit(commit: CommitWithEntries): ContextManifest {
    for (const entry of commit.entries) this.content.set(entry.id, entry);
    this.service.apply(commit);
    this.pruneToWindow();
    return this.service.manifest();
  }

  /** Current window manifest snapshot. */
  manifest(): ContextManifest {
    return this.service.manifest();
  }

  /** Resume capsule for the current fold position (≤ a few hundred bytes). */
  capsule(): ResumeCapsule {
    return this.service.capsule();
  }

  /** Number of content pages currently held (bounded by the window). */
  get pageCount(): number {
    return this.content.size;
  }

  /**
   * Compiles the current window into the provider payload. Warm requests pay
   * O(window) arithmetic — cached segments, no re-hashing; cold segments
   * serialize once and are cached by `(dialect, version, entryId)`.
   */
  prepare(): PreparedContext {
    const manifest = this.service.manifest();
    const compiled = this.compileManifest(manifest);
    return { ...compiled, manifest, manifestBytes: manifest.windowBytes };
  }

  private pruneToWindow(): void {
    const live = new Set(this.service.manifest().segments.map((segment) => segment.entryId));
    for (const id of this.content.keys()) {
      if (!live.has(id)) this.content.delete(id);
    }
  }

  private compileManifest(manifest: ContextManifest): CompiledBody {
    const wireEntries: ReturnType<typeof compiledEntryToWireEntry>[] = [];
    const wireManifest: { entryId: string }[] = [];
    const summary = summaryWireEntry(manifest);
    if (summary !== undefined) {
      wireEntries.push(summary);
      wireManifest.push({ entryId: summary.entryId });
    }
    for (const segment of manifest.segments) {
      const source = this.content.get(segment.entryId);
      if (source === undefined) {
        // The projection holds handles, not content: a missing page is a
        // caller bug here (all window pages are resident in the Ф2 baseline;
        // Context-MMU faulting is the R2 overlay).
        throw new Error(`context-wire: entry ${segment.entryId} is in the manifest but not resident`);
      }
      const record = convertEntry(source);
      if (record === null) continue; // audit/control entries carry no provider bytes
      wireEntries.push(compiledEntryToWireEntry(record));
      wireManifest.push({ entryId: segment.entryId });
    }
    return compile(wireManifest, wireEntries, { maxBytes: this.maxBytes, dialect: compiledRecordDialect(), cache: this.cache });
  }
}

/**
 * One-shot prepare over a full log — the degraded/replay mode the equivalence
 * gate drives (full rebuild, fresh conversion, no carried cache).
 */
export function prepareContextWire(entries: readonly Entry[], options?: ContextWireOptions): PreparedContext {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const manifest = buildProjection(entries);
  const cache = options?.cache ?? createLruSegmentCache(options?.cacheCapacity ?? 4096);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const wireEntries: ReturnType<typeof compiledEntryToWireEntry>[] = [];
  const wireManifest: { entryId: string }[] = [];
  const summary = summaryWireEntry(manifest);
  if (summary !== undefined) {
    wireEntries.push(summary);
    wireManifest.push({ entryId: summary.entryId });
  }
  for (const segment of manifest.segments) {
    const source = byId.get(segment.entryId);
    if (source === undefined) {
      throw new Error(`context-wire: manifest references unknown entry ${segment.entryId}`);
    }
    const record = convertEntry(source);
    if (record === null) continue;
    wireEntries.push(compiledEntryToWireEntry(record));
    wireManifest.push({ entryId: segment.entryId });
  }
  const compiled = compile(wireManifest, wireEntries, { maxBytes, dialect: compiledRecordDialect(), cache });
  return { ...compiled, manifest, manifestBytes: manifest.windowBytes };
}

/** Builds a backend-shaped commit enriched with its entries (test/caller helper). */
export function commitOfEntries(seq: number, entries: readonly Entry[]): CommitWithEntries {
  const commit: Commit = {
    seq: seq as Seq,
    batchId: seq as Commit['batchId'],
    entryCount: entries.length,
    head: seq as Seq,
    codec: 'zstd',
    compressedBytes: 0,
    uncompressedBytes: entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.payload), 'utf8'), 0),
  };
  return { ...commit, entries };
}
