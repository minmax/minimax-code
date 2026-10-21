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

import { isAuditControlKind, isPlacedEntryKind, isReminderEntryKind } from './audit.js';
import { convertBatch, convertEntry, convertEntryTails } from './convert-entry.js';
import { decodeEntryPayload } from './decode.js';
import { MINIMAX_M3_DIALECT } from './dialect.js';
import type {
  AssembleStats,
  AssembledPayload,
  CompiledEntry,
  Dialect,
  DurableEntry,
} from './types.js';

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

function sumBytes(records: readonly CompiledEntry[]): number {
  let total = 0;
  for (const record of records) total += record.byteLen;
  return total;
}
