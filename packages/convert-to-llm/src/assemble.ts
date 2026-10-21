/**
 * Payload assembly: the inter-entry rules that turn a converted entry stream
 * into the ordered provider payload.
 *
 * Contracts implemented here (final-architecture.md §1.2, steering-design-sol.md
 * §3/§7):
 *
 * - audit/control entries (`mcode.*` kinds) are excluded; the steering
 *   placed entry (`mcode.owner-input.placed`) passes exactly once — repeated
 *   placements of the same `inputEntryId` (a recovery artifact between the
 *   admission commit and the delivery-index update) are deduplicated, first
 *   log occurrence wins (node `mcode-input-delivery-status`, crash-matrix
 *   gate "no double placed entries");
 * - immediate-send batch members merge into one user record at the first
 *   member's position (`outbound-message-normalizer` semantics, including
 *   non-adjacent members);
 * - reminder records are positioned strictly AFTER the stable cache prefix;
 *   the prefix section therefore only ever appends between requests, which is
 *   what keeps provider prompt-cache bytes stable.
 */

import { createHash } from 'node:crypto';

import {
  isAuditControlKind,
  isPlacedEntryKind,
  isReminderEntryKind,
  isVisibleControlKind,
} from './audit.js';
import { convertBatch, convertEntry, convertEntryTails } from './convert-entry.js';
import { decodeEntryPayload } from './decode.js';
import { compileKey, MINIMAX_M3_DIALECT } from './dialect.js';
import { buildCompiledEntry } from './reminders.js';
import type { ContextManifest } from '../../context-projection/src/index.js';
import type {
  AssembleStats,
  AssembledPayload,
  CompiledEntry,
  Dialect,
  DurableEntry,
} from './types.js';

/**
 * Provenance kind of the synthesized compaction-summary record; the literal
 * is pinned by `@mavis/context-projection` (`COMPACTION_KIND` in
 * `src/kinds.ts`). Declared locally to keep this package's src imports
 * type-only.
 */
const COMPACTION_ENTRY_KIND = 'mcode.compaction';

/**
 * Stable wire id of the compaction-summary record for a summary text — the
 * same content-keyed convention as the runtime seam
 * (`local-runtime-v2 .../context-wire.ts` `summaryEntryId`): keyed by the
 * summary content, so a newer checkpoint over the SAME cut with a different
 * summary recompiles instead of reusing stale bytes, and identical summaries
 * share cache-stable bytes.
 */
function compactionSummaryEntryId(summary: string): string {
  const digest = createHash('sha256').update(summary, 'utf8').digest('hex').slice(0, 16);
  return `mcode-compaction-summary#${digest}`;
}

/** Assembly options; the dialect defaults to the built-in `minimax-m3`. */
export interface AssembleOptions {
  readonly dialect?: Dialect;
}

/**
 * Assemble the ordered provider payload over entries in log order.
 *
 * Deterministic: the same entry list and dialect produce byte-identical
 * output. The result separates the stable prefix from the reminder tails so
 * callers (wire compiler, byte guard, token accounting) can measure each
 * section.
 */
export function assemblePayload(
  entries: readonly DurableEntry[],
  options: AssembleOptions = {},
): AssembledPayload {
  const dialect = options.dialect ?? MINIMAX_M3_DIALECT;

  // 1. Kind-level exclusion and placed-entry dedup (steering D+C contract).
  const auditDropped = { count: 0 };
  const placedDropped = { count: 0 };
  const seenInputEntryIds = new Set<string>();
  const kept: DurableEntry[] = [];
  for (const entry of entries) {
    if (isAuditControlKind(entry.kind)) {
      auditDropped.count += 1;
      continue;
    }
    if (isPlacedEntryKind(entry.kind)) {
      const { inputEntryId } = decodeEntryPayload(entry.kind, entry.payload);
      const dedupId = inputEntryId ?? entry.id;
      if (seenInputEntryIds.has(dedupId)) {
        placedDropped.count += 1;
        continue;
      }
      seenInputEntryIds.add(dedupId);
    }
    kept.push(entry);
  }

  // 2. Immediate-send batching: consecutive bookkeeping merges any later
  // member sharing the batch id into the first member's unit.
  const batchPositions = new Map<string, number>();
  const units: DurableEntry[][] = [];
  for (const entry of kept) {
    const batchId = decodeEntryPayload(entry.kind, entry.payload).messages[0]?.batchId;
    const position = batchId === undefined ? undefined : batchPositions.get(batchId);
    if (batchId !== undefined && position !== undefined) {
      units[position]?.push(entry);
      continue;
    }
    if (batchId !== undefined) batchPositions.set(batchId, units.length);
    units.push([entry]);
  }

  // 3. Per-unit conversion, preserving log order in both sections.
  const prefixRecords: CompiledEntry[] = [];
  const tailRecords: CompiledEntry[] = [];
  let batchJoins = 0;
  let noProviderRecord = 0;
  for (const unit of units) {
    const head = unit[0];
    if (head === undefined) continue;

    let main: CompiledEntry | null;
    if (unit.length > 1) {
      batchJoins += unit.length - 1;
      main = convertBatch(unit, dialect);
    } else {
      main = convertEntry(head, dialect);
    }

    if (isReminderEntryKind(head.kind)) {
      // A dedicated reminder entry IS a tail record; convertEntry built it
      // with `tail: true`.
      if (main !== null) tailRecords.push(main);
    } else {
      if (main === null) noProviderRecord += 1;
      else prefixRecords.push(main);
      for (const entry of unit) {
        tailRecords.push(...convertEntryTails(entry, dialect));
      }
    }
  }

  const records = [...prefixRecords, ...tailRecords];
  const prefixBytes = sumBytes(prefixRecords);
  const tailBytes = sumBytes(tailRecords);

  const stats: AssembleStats = {
    totalEntries: entries.length,
    auditDropped: auditDropped.count,
    placedDropped: placedDropped.count,
    noProviderRecord,
    batchJoins,
    reminderTails: tailRecords.length,
    prefixBytes,
    tailBytes,
    totalBytes: prefixBytes + tailBytes,
  };

  return {
    records,
    prefix: prefixRecords,
    tails: tailRecords,
    dialect,
    stats,
  };
}

/**
 * Assemble the provider payload over the projection window: the manifest's
 * segments decide which context entries are compiled, in log order.
 *
 * Relationship to the projection (the contract this function implements —
 * see `@mavis/context-projection/src/kinds.ts`, where `isControlKind` covers
 * EVERY `mcode.*` kind):
 *
 * - Real manifests NEVER carry `mcode.*` segments, including the two
 *   model-visible control kinds. Those therefore reach the payload from the
 *   entry log directly: `mcode.owner-input.placed` (deduplicated by
 *   `inputEntryId` by {@link assemblePayload}, so the steering D+C contract
 *   "placed exactly once" holds on this path too) and
 *   `mcode.system-reminder` (converted to tail records). The number of
 *   entries admitted this way — outside the manifest — is reported in
 *   `stats.modelVisibleSelected`, so the divergence between the projection's
 *   window and the provider payload is measurable, never silent.
 * - `manifest.compaction` is honored: its summary is the replacement for the
 *   cut prefix and enters the payload as the LEADING user record, with the
 *   content-keyed id `mcode-compaction-summary#<sha256[:16]>` (the same
 *   convention as the runtime seam's `summaryWireEntry`), so the cut context
 *   is not lost together with its substitute. Reported in
 *   `stats.compactionSummaryIncluded`.
 *
 * Integrity (loud, mirroring the wire compiler's manifest handling in
 * `compile()` — duplicate and unresolved manifest references are errors
 * there, never silent repeats or drops):
 *
 * - a duplicate `segment.entryId` throws `TypeError` (the wire compiler
 *   throws `WireCompilerError` on the same corruption);
 * - a segment whose entry is absent from `entries` throws `TypeError`
 *   (assembling a window with silently missing context pages would understate
 *   the payload exactly like a botched compaction would).
 *
 * Entries that are NEITHER in the manifest nor one of the two model-visible
 * control kinds (compaction-cut history, audit/control kinds) are excluded —
 * the direct-entries {@link assemblePayload} remains the path for assembling
 * a whole log without a projection.
 */
export function assembleManifestPayload(
  entries: readonly DurableEntry[],
  manifest: ContextManifest,
  options: AssembleOptions = {},
): AssembledPayload {
  const dialect = options.dialect ?? MINIMAX_M3_DIALECT;

  // Manifest integrity first: duplicates would double window context after a
  // botched fold; unresolved references would silently shrink the payload.
  const segmentIds = new Set<string>();
  for (const segment of manifest.segments) {
    if (segmentIds.has(segment.entryId)) {
      throw new TypeError(
        'assembleManifestPayload: duplicate entryId in manifest segments: ' +
          JSON.stringify(segment.entryId),
      );
    }
    segmentIds.add(segment.entryId);
  }
  const entryIds = new Set(entries.map((entry) => entry.id));
  for (const segment of manifest.segments) {
    if (!entryIds.has(segment.entryId)) {
      throw new TypeError(
        'assembleManifestPayload: manifest segment references entry absent from entries: ' +
          JSON.stringify(segment.entryId),
      );
    }
  }

  // Union selection in log order: the manifest window plus the two
  // model-visible control kinds, which real manifests never carry.
  let modelVisibleSelected = 0;
  const selected = entries.filter((entry) => {
    if (segmentIds.has(entry.id)) return true;
    if (isVisibleControlKind(entry.kind)) {
      modelVisibleSelected += 1;
      return true;
    }
    return false;
  });

  const assembled = assemblePayload(selected, options);

  const manifestStats = {
    ...assembled.stats,
    manifestSegments: manifest.segments.length,
    modelVisibleSelected,
    compactionSummaryIncluded: false,
  };
  if (manifest.compaction === undefined) {
    return { ...assembled, stats: manifestStats };
  }

  // The compaction summary replaces the cut prefix: leading user record,
  // content-keyed id (same summary → same bytes → cache-stable).
  const summaryEntryId = compactionSummaryEntryId(manifest.compaction.summary);
  const summaryRecord = buildCompiledEntry({
    cacheKey: compileKey(summaryEntryId, dialect),
    entryId: summaryEntryId,
    sourceEntryIds: [summaryEntryId],
    kind: COMPACTION_ENTRY_KIND,
    role: 'user',
    content: manifest.compaction.summary,
    tail: false,
  });
  const prefix = [summaryRecord, ...assembled.prefix];
  const records = [...prefix, ...assembled.tails];
  const prefixBytes = sumBytes(prefix);
  return {
    records,
    prefix,
    tails: assembled.tails,
    dialect,
    stats: {
      ...manifestStats,
      compactionSummaryIncluded: true,
      prefixBytes,
      totalBytes: prefixBytes + assembled.stats.tailBytes,
    },
  };
}

function sumBytes(records: readonly CompiledEntry[]): number {
  let total = 0;
  for (const record of records) total += record.byteLen;
  return total;
}
