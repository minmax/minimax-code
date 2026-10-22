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
// with the Ф2 R2 overlay beside it: an optional Context-MMU residency
// (`ContextWireOptions.residency`) decides which window entries' images ride
// the payload with their real bytes; everything else keeps the dialect
// placeholder. Without the overlay the path is the all-evicted baseline the
// equivalence gates pin.
//
// — and exposes the two operations the turn loop needs: `applyCommit` per
// durable commit (O(entries of the commit)) and `prepare()` per provider
// request. `prepare()` is warm-path O(delta) at the conversion stage: the
// per-entry stage is MEMOIZED by the convert-to-llm record key
// `(entryId, dialect, normalizerVersion)` — including the residency
// `#resident@<sha16>` cache state — so only new or residency-flipped entries
// re-convert (final-architecture.md:74/:90); segment bytes and hashing were
// already cached below it (wire-compiler LRU). The byte guard (`maxBytes`)
// runs inside every `prepare`, so a payload breach fails the request
// preparation with `WireBudgetExceeded` before anything is sent — and the
// optional `ContextWireOptions.compaction` seam wires the byte-axis trigger
// (a real `BackgroundCompactionScheduler`) so the window compacts UP TO that
// guard (75%/90% of `maxBytes` by default) instead of at it
// (final-architecture.md:397).
//
// Window selection (steering D+C contract, `convert-to-llm/src/audit.ts`):
// the projection manifest never carries `mcode.*` segments, but TWO control
// kinds are model-visible and reach the payload from the retained window
// pages — `mcode.owner-input.placed` (the executed user input; deduplicated
// by `inputEntryId`, first log occurrence wins, so it enters EXACTLY once —
// input-delivery's "the input entered the model context (exactly once)") and
// `mcode.system-reminder` (a reminder TAIL record, positioned strictly after
// the stable prefix). The compiled body therefore matches
// `assembleManifestPayload` (convert-to-llm) byte for byte on the same
// window — pinned by `context-wire.test.ts`.
//
// RAM: the projection stores handles only, so THIS module owns the window's
// content pages — and prunes them to the manifest segments plus the
// model-visible control pages after every commit (a compaction also cuts the
// control pages that logged before `firstKeptEntryId`). Retention is bounded
// by the WINDOW, never by history length: what a compaction cuts is dropped
// here too.
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
import {
  convertEntry,
  convertEntryTails,
  compileKey,
  decodeEntryPayload,
  isPlacedEntryKind,
  isReminderEntryKind,
  isVisibleControlKind,
  MINIMAX_M3_DIALECT,
  recordCacheKey,
  type CompiledEntry,
  type ImageRendering,
} from '../../../../../convert-to-llm/src/index.js';
// Context MMU: type-only here (the runtime wires the instance in via
// `ContextWireOptions.residency`) — the packages do not link until the
// integrator registers them, same as the backend types above.
import type { ContextMmu, PageHandle } from '../../../../../context-mmu/src/index.js';
// Background compaction (the `pi-durable-background-compaction` slot): the
// double-trigger scheduler the composed pipeline drives from `applyCommit`.
// Workspace-relative like every wave-2 import above.
import {
  createBackgroundCompactionScheduler,
  type BackgroundCompactionScheduler,
  type CompactionBudgets,
  type DurableEntryDraft,
  type LogEntry,
  type Summarizer,
} from '../../../../../context-compaction/src/index.js';
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

/**
 * Context-MMU residency seam (Ф2 R2 overlay): decides which window entries'
 * images ride the payload with their real bytes. Absent, every image converts
 * to its dialect placeholder — the all-evicted baseline the equivalence gates
 * pin.
 */
export interface ContextWireResidency {
  /** The MMU owning the session's pages; `statusOf` decides resident vs digest. */
  readonly mmu: ContextMmu;
  /**
   * The page handle of `entry`'s image content; `undefined` when the entry
   * carries no MMU-managed image (plain text pages are always resident).
   */
  readonly pageOf: (entry: Entry) => PageHandle | undefined;
}

/**
 * Memo cache of the per-entry conversion stage (Ф2: `pi-convert-to-llm` is
 * "the memoized per-entry stage inside the wire compiler",
 * final-architecture.md:74/:90). `records` maps {@link recordCacheKey} —
 * `(entryId, dialect, normalizerVersion)` extended with the residency
 * `cacheState` (`resident@<sha16>`) when a rendering is active — to the
 * converted record (`null` included: an audit/control page converts to
 * `null`, and memoizing that keeps the miss a one-time cost too). `tails`
 * maps the base key (a `#tails` suffix namespace) to the entry's reminder
 * tail records — rendering-independent by convert-to-llm's rule (a tail's
 * bytes are its reminder block, which no image rendering can touch).
 *
 * Correctness rests on the same frozen-entry guarantee the wire compiler's
 * segment cache already rests on (wire-compiler `compile.ts`): an entryId
 * never maps to different content, and a rendering change folds its
 * `cacheState` into the key.
 *
 * The memo is pruned to the keys of the CURRENT window after every
 * {@link compileWindow} pass, so it holds O(window), never O(history).
 */
export interface ContextWireConversionMemo {
  readonly records: Map<string, CompiledEntry | null>;
  readonly tails: Map<string, readonly CompiledEntry[]>;
}

/** Fresh conversion memo (one pipeline's warm-path state). */
export function createConversionMemo(): ContextWireConversionMemo {
  return { records: new Map(), tails: new Map() };
}

/** Memo key of one entry's primary record under its residency rendering. */
function conversionMemoKey(entryId: string, rendering: ImageRendering | undefined): string {
  return recordCacheKey(entryId, MINIMAX_M3_DIALECT, rendering);
}

/** Memo key of one entry's reminder tail records (rendering-independent). */
function tailsMemoKey(entryId: string): string {
  return `${compileKey(entryId, MINIMAX_M3_DIALECT)}#tails`;
}

/**
 * Background-compaction seam (Ф2: "`pi-compaction`/`split-turn`/
 * `overflow-recovery` with the byte trigger; background-compaction as the
 * scheduler", final-architecture.md:397) — the composed pipeline OWNS the
 * double trigger when this is wired: {@link BackgroundCompactionScheduler}
 * is created over the caller's log/append/summarizer and notified on every
 * {@link ContextWirePipeline.applyCommit}.
 *
 * The byte axis defaults to the pipeline's wire guard (`maxBytes`, the Ф2
 * 32-МБ payload budget): the window compacts UP TO the guard — background
 * compaction starts at 75% of the budget, compaction becomes blocking at
 * 90% — and the wire guard itself stays the last-resort hard line that fails
 * a request with {@link WireBudgetExceeded}, never the working trigger.
 *
 * The caller owns the durable side: `entries` serves the raw append-only log
 * in the compaction package's vocabulary (`mcode.message` / `mcode.system` /
 * ... — adapting the session's own message kinds is the log owner's job, and
 * the `mcode.*` control kinds pass through natively; a compaction checkpoint
 * MUST be visible there, it is what resets the byte axis), `append`
 * persists the produced `mcode.compaction` draft under the writer gate AND
 * applies it back into this pipeline (via `applyCommit`), so the next
 * `prepare()` compiles the cut window. A blocking-level job (90%) must be
 * awaited before the next provider request —
 * {@link ContextWirePipeline.whenCompactionIdle} is that admission point.
 */
export interface ContextWireCompaction {
  /** Summary backend of `pi-compaction` (an injected async function). */
  readonly summarizer: Summarizer;
  /** Live append-only session log, oldest first, growing only. */
  readonly entries: () => readonly LogEntry[];
  /** Durable append of checkpoint drafts (writer-gated; applies back into the pipeline). */
  readonly append: (drafts: readonly DurableEntryDraft[]) => Promise<void>;
  /**
   * Double-trigger budgets. `byteBudget` defaults to the pipeline's
   * `maxBytes` (the wire guard) when omitted; `tokenBudget` has no default —
   * set it to enable the token axis (`0` disables an axis).
   */
  readonly budgets?: Omit<CompactionBudgets, 'byteBudget'> & { readonly byteBudget?: number };
  /** Recent-context budget for the cut point. Default: the scheduler's own. */
  readonly keepRecentTokens?: number;
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
  /** Context-MMU image residency (Ф2 R2). Default: everything evicted. */
  readonly residency?: ContextWireResidency;
  /**
   * Background-compaction seam; when wired, the pipeline creates and drives
   * the double-trigger scheduler (byte axis defaults to `maxBytes`).
   * Default: no scheduler — the wire guard alone bounds the window.
   */
  readonly compaction?: ContextWireCompaction;
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
  private readonly residency: ContextWireResidency | undefined;
  private readonly scheduler: BackgroundCompactionScheduler | undefined;
  /** Content pages of the current window; pruned to the manifest after each commit. */
  private readonly content = new Map<string, Entry>();
  /** Warm-path conversion memo: one record per `(entryId, dialect, cacheState)`. */
  private readonly conversions: ContextWireConversionMemo = createConversionMemo();

  constructor(options?: ContextWireOptions) {
    this.service = new ProjectionService();
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.cache = options?.cache ?? createLruSegmentCache(options?.cacheCapacity ?? 4096);
    this.residency = options?.residency;
    // The byte axis defaults to the WIRE GUARD: compaction must shrink the
    // window up to (75%/90% of) the payload budget, never let the guard
    // become the only line of defense (final-architecture.md:397).
    const compaction = options?.compaction;
    this.scheduler =
      compaction === undefined
        ? undefined
        : createBackgroundCompactionScheduler({
            budgets: {
              ...compaction.budgets,
              byteBudget: compaction.budgets?.byteBudget ?? this.maxBytes,
            },
            session: {
              // The seam serves the log through a callback (`entries()`); the
              // scheduler's session wants the live array itself.
              get entries() {
                return compaction.entries();
              },
              append: compaction.append,
            },
            summarizer: compaction.summarizer,
            keepRecentTokens: compaction.keepRecentTokens,
          });
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
    // The double trigger is evaluated at the O(delta) moment — bytes grow
    // here, not in prepare(). A background-level crossing starts the job
    // fire-and-forget; a blocking-level crossing starts the same job and the
    // turn loop awaits it via `whenCompactionIdle()` before the next request.
    this.scheduler?.notify();
    return this.service.manifest();
  }

  /**
   * Resolves when no compaction job is in flight — the admission point the
   * turn loop awaits before the next `prepare()` (a blocking-level crossing
   * at 90% of the byte budget must cut the window BEFORE the request is
   * compiled). Resolves immediately without the compaction seam.
   */
  whenCompactionIdle(): Promise<void> {
    return this.scheduler?.whenIdle() ?? Promise.resolve();
  }

  /** The double-trigger scheduler when the compaction seam is wired. */
  get compactionScheduler(): BackgroundCompactionScheduler | undefined {
    return this.scheduler;
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
   * Compiles the current window into the provider payload. The per-entry
   * conversion stage is MEMOIZED across prepares by
   * `(entryId, dialect, normalizerVersion, residency cacheState)` —
   * final-architecture.md:74/:90 — so a warm request re-converts only the
   * delta (entries appended since the last prepare, plus entries whose
   * residency state flipped); everything else reuses the converted record
   * and its cached wire segment. Warm requests pay O(window) arithmetic —
   * cached segments, no re-hashing; cold entries serialize once.
   */
  prepare(): PreparedContext {
    const manifest = this.service.manifest();
    const compiled = compileWindow([...this.content.values()], manifest, {
      maxBytes: this.maxBytes,
      cache: this.cache,
      residency: this.residency,
      conversionMemo: this.conversions,
    });
    return { ...compiled, manifest, manifestBytes: manifest.windowBytes };
  }

  /**
   * Prunes the content pages to the current window: the manifest segments
   * plus the model-visible control pages logged at or after the compaction
   * cut (`firstKeptEntryId`) — the same set the storage layer's retained
   * slice serves a resumed pipeline, so an incremental and a resumed
   * `prepare()` compile identical bodies.
   */
  private pruneToWindow(): void {
    const manifest = this.service.manifest();
    const live = new Set(manifest.segments.map((segment) => segment.entryId));
    // The compaction cut as a log position: control pages logged before the
    // first KEPT entry are cut together with the prefix they steered.
    let cut: { seq: Seq; ordinal: number } | undefined;
    if (manifest.compaction !== undefined) {
      const kept = this.content.get(manifest.compaction.firstKeptEntryId);
      if (kept !== undefined) cut = { seq: kept.seq, ordinal: kept.ordinal };
    }
    for (const [id, entry] of this.content) {
      if (live.has(id)) continue;
      if (
        isVisibleControlKind(entry.kind) &&
        (cut === undefined || entry.seq > cut.seq || (entry.seq === cut.seq && entry.ordinal >= cut.ordinal))
      ) {
        continue;
      }
      this.content.delete(id);
    }
  }
}

/**
 * Compiles one projection window into the wire body — the shared selection
 * and ordering of the incremental pipeline ({@link ContextWirePipeline.prepare})
 * and the one-shot replay ({@link prepareContextWire}).
 *
 * Selection (steering D+C, `convert-to-llm/src/audit.ts`): every manifest
 * segment plus the two model-visible control kinds from the window pages, in
 * log order. Ordering: the compaction summary is the LEADING user record,
 * then every prefix record in log order, then every reminder TAIL record —
 * the exact record order `assembleManifestPayload` produces, so the two
 * manifest assembly paths are byte-identical on the same window.
 *
 * The per-entry conversion stage is memoized through `options.conversionMemo`
 * by {@link recordCacheKey} — `(entryId, dialect, normalizerVersion)` plus
 * the residency `cacheState` — so warm callers (the pipeline's `prepare`)
 * re-convert only the delta; tail records memoize under a `#tails` suffix
 * (rendering-independent by convert-to-llm's rule). The memo is pruned to
 * the current pass's keys, so it holds O(window). Omitted (the one-shot
 * replay), every page converts fresh — "no carried cache".
 *
 * A manifest segment without a resident page throws: the projection holds
 * handles, not content, and a missing page is a caller bug here (all window
 * pages are resident in the Ф2 baseline; Context-MMU faulting is the R2
 * overlay). A duplicate placed `inputEntryId` (a recovery artifact between
 * the admission commit and the delivery-index update) is dropped — first log
 * occurrence wins, "placed exactly once".
 *
 * Image residency (Ф2 R2, `options.residency`): an entry whose MMU page is
 * RESIDENT renders its real bytes (a data URL) into the record; every other
 * image stays the dialect placeholder. A resident record compiles under a
 * content-keyed wire identity (`<entryId>#resident@<sha16>`, the same
 * convention as the compaction summary record) — the segment cache keys on
 * the wire id, so a residency flip always recompiles instead of serving the
 * other state's cached bytes. `options.requireHashes` passes through to
 * `compile` (the degraded equivalence mode's hash-verification path).
 */
export function compileWindow(
  windowPages: readonly Entry[],
  manifest: ContextManifest,
  options: {
    readonly maxBytes: number;
    readonly cache: WireSegmentCache;
    readonly residency?: ContextWireResidency;
    readonly conversionMemo?: ContextWireConversionMemo;
    readonly requireHashes?: boolean;
  },
): CompiledBody {
  const segmentIds = new Set(manifest.segments.map((segment) => segment.entryId));

  // Manifest integrity first: unresolved references would silently shrink
  // the payload exactly like a botched compaction would.
  const resident = new Set(windowPages.map((page) => page.id));
  for (const segment of manifest.segments) {
    if (!resident.has(segment.entryId)) {
      throw new Error(`context-wire: entry ${segment.entryId} is in the manifest but not resident`);
    }
  }

  const prefixEntries: WireEntry[] = [];
  const prefixRefs: { entryId: string }[] = [];
  const tailEntries: WireEntry[] = [];
  const tailRefs: { entryId: string }[] = [];
  const seenInputEntryIds = new Set<string>();
  const memo = options.conversionMemo;
  const liveRecordKeys = new Set<string>();
  const liveTailsKeys = new Set<string>();
  const memoRecord = (key: string, convert: () => CompiledEntry | null): CompiledEntry | null => {
    if (memo === undefined) return convert();
    liveRecordKeys.add(key);
    let record = memo.records.get(key);
    if (record === undefined) {
      record = convert();
      memo.records.set(key, record);
    }
    return record;
  };
  const memoTails = (key: string, convert: () => readonly CompiledEntry[]): readonly CompiledEntry[] => {
    if (memo === undefined) return convert();
    liveTailsKeys.add(key);
    let tails = memo.tails.get(key);
    if (tails === undefined) {
      tails = convert();
      memo.tails.set(key, tails);
    }
    return tails;
  };
  for (const page of windowPages) {
    if (!segmentIds.has(page.id) && !isVisibleControlKind(page.kind)) continue;
    if (isPlacedEntryKind(page.kind)) {
      // Dedup by the steering linkage id, BEFORE conversion — the same rule
      // as `assemblePayload` (first log occurrence wins).
      const { inputEntryId } = decodeEntryPayload(page.kind, page.payload);
      const dedupId = inputEntryId ?? page.id;
      if (seenInputEntryIds.has(dedupId)) continue;
      seenInputEntryIds.add(dedupId);
    }
    // Residency decision FIRST, then one conversion under it: a resident
    // image page renders its bytes, everything else the placeholder.
    const imagePage = options.residency?.pageOf(page);
    const rendering: ImageRendering | undefined =
      imagePage !== undefined && options.residency.mmu.statusOf(imagePage) === 'resident'
        ? {
            cacheState: `resident@${imagePage.sha256.slice(0, 16)}`,
            renderImage: (part) =>
              part.data === undefined ? undefined : `data:${part.mimeType};base64,${part.data}`,
          }
        : undefined;
    const record = memoRecord(conversionMemoKey(page.id, rendering), () => convertEntry(page, undefined, rendering));
    if (isReminderEntryKind(page.kind)) {
      // A dedicated reminder entry IS a tail record: strictly after the
      // stable prefix, never inside it.
      if (record !== null) {
        tailEntries.push(compiledEntryToWireEntry(record));
        tailRefs.push({ entryId: record.entryId });
      }
      continue;
    }
    if (record !== null) {
      // A resident rendering compiles under its own content-keyed wire
      // identity — never under the plain entry id the digest placeholder
      // uses (see the residency note above).
      const wireRecord =
        rendering === undefined
          ? record
          : { ...record, entryId: `${record.entryId}#${rendering.cacheState}` };
      prefixEntries.push(compiledEntryToWireEntry(wireRecord));
      prefixRefs.push({ entryId: wireRecord.entryId });
    }
    // Embedded `<system-reminder>` blocks split into tail records; the
    // prefix record keeps the residual bytes (convert-to-llm's split rule).
    // Tails are rendering-independent, so their memo key never carries a
    // cache state.
    for (const tail of memoTails(tailsMemoKey(page.id), () => convertEntryTails(page, MINIMAX_M3_DIALECT))) {
      tailEntries.push(compiledEntryToWireEntry(tail));
      tailRefs.push({ entryId: tail.entryId });
    }
  }
  if (memo !== undefined) {
    // Keep the memo O(window): a key the current window no longer converts
    // (the entry was cut, or its residency state flipped back) is dropped.
    for (const key of memo.records.keys()) {
      if (!liveRecordKeys.has(key)) memo.records.delete(key);
    }
    for (const key of memo.tails.keys()) {
      if (!liveTailsKeys.has(key)) memo.tails.delete(key);
    }
  }

  const summary = summaryWireEntry(manifest);
  const wireEntries: WireEntry[] = summary ? [summary, ...prefixEntries, ...tailEntries] : [...prefixEntries, ...tailEntries];
  const wireManifest: { entryId: string }[] = summary
    ? [{ entryId: summary.entryId }, ...prefixRefs, ...tailRefs]
    : [...prefixRefs, ...tailRefs];
  return compile(wireManifest, wireEntries, {
    maxBytes: options.maxBytes,
    dialect: compiledRecordDialect(),
    cache: options.cache,
    requireHashes: options.requireHashes === true,
  });
}

/**
 * One-shot prepare over a full log — the degraded/replay mode the equivalence
 * gate drives (full rebuild, fresh conversion, no carried cache).
 */
export function prepareContextWire(entries: readonly Entry[], options?: ContextWireOptions): PreparedContext {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const manifest = buildProjection(entries);
  const cache = options?.cache ?? createLruSegmentCache(options?.cacheCapacity ?? 4096);
  const compiled = compileWindow(entries, manifest, { maxBytes, cache, residency: options?.residency });
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
