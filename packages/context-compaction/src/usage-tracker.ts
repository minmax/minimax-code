/**
 * Incremental window usage for the compaction triggers.
 *
 * Maintains BOTH trigger axes as running counters over the projected window,
 * consuming each appended entry exactly once at O(its contribution):
 *
 * - tokens — the usage-anchored estimate: the last valid assistant usage
 *   anchors the total, everything after it adds its `chars/4` estimate; any
 *   control entry (`mcode.compaction` / `mcode.context_edit`) after the anchor
 *   invalidates it and the estimate goes pure (window + frozen system
 *   prompt), matching `estimateProjectedContextTokens` exactly;
 * - bytes — Σ serialized payload bytes of the window the projection
 *   materializes: kept message entries, the winning checkpoint payload (the
 *   summary travels on the wire) and the active system prompt. Audit/control
 *   bookkeeping (`mcode.owner-input.received` and friends) contributes
 *   NOTHING, and a checkpoint RESETS the axis to its kept tail — the raw-log
 *   measure this replaces never reset, so every notify after the first
 *   byte-triggered compaction re-fired blocking forever.
 *
 * `usage()` is O(1); `ingest` is O(delta) over the entries appended since the
 * last call. `estimateMessageTokens` results and payload byte lengths are
 * memoized per entry id, so an entry is measured exactly once — never a
 * re-stringify of the whole log per notification.
 *
 * Histories the counters cannot mirror incrementally (a checkpoint whose
 * `firstKeptEntryId` is no longer in the window — the re-expansion of an
 * omitted checkpoint — or the retraction of the system source) fall back to
 * ONE slow re-projection that re-syncs the counters from `projectContext`;
 * O(log), and only on those rare shapes. `resync` is also the property-test
 * oracle: after ANY ingest prefix the counters must equal the slow reference
 * (`estimateProjectedContextTokens().tokens` + `windowManifestBytes()`).
 *
 * @module
 */

import {
  calculateUsageTokens,
  estimateMessageTokens,
  estimateProjectedContextTokens,
  hasValidUsageAnchor,
} from './estimate.js';
import { projectContext } from './project.js';
import {
  COMPACTION_ENTRY_KIND,
  CONTEXT_EDIT_ENTRY_KIND,
  MESSAGE_ENTRY_KIND,
  SYSTEM_ENTRY_KIND,
  type CompactionEntryPayload,
  type LogEntry,
} from './types.js';

/** Snapshot behind both trigger axes. */
export interface WindowUsage {
  /** Usage-anchored (or pure) token estimate of the projected window. */
  readonly tokens: number;
  /** Σ serialized bytes of the window (kept entries + checkpoint payload + system prompt). */
  readonly bytes: number;
}

/** One LLM-visible window member: the winning checkpoint or a kept message entry. */
interface WindowMember {
  readonly id: string;
  /** Memoized `chars/4` estimate of the entry's context message. */
  readonly tokens: number;
  /** Memoized UTF-8 byte length of the serialized payload. */
  readonly bytes: number;
}

function isPayloadObject(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === 'object' && payload !== null;
}

function parseCompactionPayload(payload: unknown): CompactionEntryPayload | undefined {
  if (!isPayloadObject(payload)) return undefined;
  if (typeof payload.summary !== 'string' || typeof payload.firstKeptEntryId !== 'string') return undefined;
  return payload as unknown as CompactionEntryPayload;
}

function parseOmissionTargetIds(payload: unknown): readonly string[] | undefined {
  if (!isPayloadObject(payload) || payload.action !== 'omission' || !Array.isArray(payload.targetIds)) return undefined;
  return payload.targetIds.filter((id): id is string => typeof id === 'string');
}

function parseSystemText(payload: unknown): string | undefined {
  if (!isPayloadObject(payload) || typeof payload.text !== 'string') return undefined;
  return payload.text;
}

function serializedBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function estimateTokensOf(payload: unknown): number {
  return estimateMessageTokens(payload as Parameters<typeof estimateMessageTokens>[0]);
}

/** True when the entry kind invalidates a usage anchor behind it. */
function isRewriteEntryKind(kind: string): boolean {
  return kind === COMPACTION_ENTRY_KIND || kind === CONTEXT_EDIT_ENTRY_KIND;
}

export class WindowUsageTracker {
  /** LLM-visible window members in message order: the checkpoint summary leads, then the kept tail. */
  private window: WindowMember[] = [];
  /** Memoized token estimates keyed by entry id (one `chars/4` walk per entry, ever). */
  private readonly tokenMemo = new Map<string, number>();
  /** Memoized serialized payload sizes keyed by entry id. */
  private readonly byteMemo = new Map<string, number>();
  /** Σ member tokens (the pure-estimate path body). */
  private windowTokens = 0;
  /** Σ member payload bytes (kept entries + the winning checkpoint payload). */
  private windowEntryBytes = 0;
  /** The usage anchor, valid only while no rewrite entry follows it. */
  private anchor: { readonly id: string; readonly tokens: number } | null = null;
  /** Σ member tokens strictly after the anchor in message order. */
  private suffixTokens = 0;
  /** Active system prompt: the frozen checkpoint value, else the newest visible system entry. */
  private systemText: string | null = null;
  /** True when a checkpoint froze the system prompt (later system entries no longer win). */
  private systemFrozen = false;
  /** Newest well-formed system entry seen — the fallback for a checkpoint without a frozen prompt. */
  private lastSystemText: string | null = null;
  private lastSystemEntryId: string | null = null;
  /** The winning checkpoint's member id inside {@link window}; `null` without a checkpoint. */
  private checkpointMemberId: string | null = null;
  /** Entries already consumed from the ingested log. */
  private consumed = 0;

  /**
   * Consumes every entry appended since the last call. `entries` must be the
   * live append-only session log, oldest first. A shrunk log (never legal)
   * forces a full re-sync instead of miscounting.
   */
  ingest(entries: readonly LogEntry[]): void {
    if (entries.length < this.consumed) {
      this.resync(entries);
      return;
    }
    while (this.consumed < entries.length) {
      const entry = entries[this.consumed]!;
      this.consumed += 1;
      try {
        this.consume(entry);
      } catch {
        // The counters hit a shape they cannot mirror incrementally
        // (re-expansion of an omitted checkpoint, retracted system source):
        // one slow authoritative pass re-syncs everything.
        this.resync(entries);
        return;
      }
    }
  }

  /** Current snapshot. O(1): pure arithmetic over the maintained counters. */
  usage(): WindowUsage {
    const tokens =
      this.anchor !== null
        ? this.anchor.tokens + this.suffixTokens
        : this.windowTokens + this.systemTokens();
    return { tokens, bytes: this.bytes() };
  }

  private bytes(): number {
    let bytes = this.windowEntryBytes;
    if (this.systemText !== null) bytes += serializedBytes({ text: this.systemText });
    return bytes;
  }

  private systemTokens(): number {
    if (this.systemText === null) return 0;
    // `chars/4`, exactly the pure estimate's system-message rule.
    return Math.ceil(this.systemText.length / 4);
  }

  private memoTokens(entry: LogEntry): number {
    const cached = this.tokenMemo.get(entry.id);
    if (cached !== undefined) return cached;
    const tokens = estimateTokensOf(entry.payload);
    this.tokenMemo.set(entry.id, tokens);
    return tokens;
  }

  private memoBytes(entry: LogEntry): number {
    const cached = this.byteMemo.get(entry.id);
    if (cached !== undefined) return cached;
    const bytes = serializedBytes(entry.payload);
    this.byteMemo.set(entry.id, bytes);
    return bytes;
  }

  /** Resets every counter and rebuilds them from one slow `projectContext` pass. */
  private resync(entries: readonly LogEntry[]): void {
    this.clearCounters();
    const projected = projectContext(entries);

    // Members in log order first; the winning checkpoint member is re-queued
    // to the FRONT afterwards (message order: summary leads the kept tail).
    const members: WindowMember[] = [];
    let checkpointMember: WindowMember | null = null;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const contextMessages = projected.entries[i]!.contextMessages;
      if (contextMessages.length === 0) continue;
      const member: WindowMember = {
        id: entry.id,
        tokens: this.memoTokens(entry),
        bytes: this.memoBytes(entry),
      };
      if (entry.kind === COMPACTION_ENTRY_KIND) checkpointMember = member;
      else members.push(member);
    }
    this.window = checkpointMember !== null ? [checkpointMember, ...members] : members;
    this.checkpointMemberId = checkpointMember?.id ?? null;
    this.windowTokens = this.window.reduce((sum, member) => sum + member.tokens, 0);
    this.windowEntryBytes = this.window.reduce((sum, member) => sum + member.bytes, 0);

    // Anchor rule of `estimateProjectedContextTokens`: the last projected
    // entry carrying a valid usage anchor, invalidated by any rewrite kind
    // after it in the RAW log; trailing = members after it in message order.
    this.anchor = null;
    this.suffixTokens = 0;
    let anchorIndex = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const contextMessages = projected.entries[i]!.contextMessages;
      if (contextMessages.some(hasValidUsageAnchor)) {
        anchorIndex = i;
        break;
      }
    }
    if (anchorIndex !== -1) {
      let invalidated = false;
      for (let i = anchorIndex + 1; i < entries.length; i += 1) {
        if (isRewriteEntryKind(entries[i]!.kind)) {
          invalidated = true;
          break;
        }
      }
      if (!invalidated) {
        const anchorEntry = entries[anchorIndex]!;
        const anchorMessage = projected.entries[anchorIndex]!.contextMessages.find(hasValidUsageAnchor) as
          | { readonly usage?: Record<string, number> }
          | undefined;
        const anchorTokens = calculateUsageTokens(anchorMessage?.usage ?? {});
        this.anchor = { id: anchorEntry.id, tokens: anchorTokens };
        const position = this.window.findIndex((member) => member.id === anchorEntry.id);
        if (position !== -1) {
          for (let i = position + 1; i < this.window.length; i += 1) {
            this.suffixTokens += this.window[i]!.tokens;
          }
        }
      }
    }

    // System prompt: the projected value is authoritative; the newest visible
    // system entry stays the fallback for future checkpoints without a freeze.
    this.systemText = projected.systemMessage;
    this.systemFrozen = false;
    const omitted = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== CONTEXT_EDIT_ENTRY_KIND) continue;
      const targets = parseOmissionTargetIds(entry.payload);
      if (targets !== undefined) for (const id of targets) omitted.add(id);
    }
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]!;
      if (entry.kind !== SYSTEM_ENTRY_KIND || omitted.has(entry.id)) continue;
      const text = parseSystemText(entry.payload);
      if (text === undefined) continue;
      this.lastSystemText = text;
      this.lastSystemEntryId = entry.id;
      break;
    }
  }

  private clearCounters(): void {
    this.window = [];
    this.windowTokens = 0;
    this.windowEntryBytes = 0;
    this.anchor = null;
    this.suffixTokens = 0;
    this.systemText = null;
    this.systemFrozen = false;
    this.lastSystemText = null;
    this.lastSystemEntryId = null;
    this.checkpointMemberId = null;
  }

  private consume(entry: LogEntry): void {
    switch (entry.kind) {
      case MESSAGE_ENTRY_KIND:
        this.consumeMessage(entry);
        return;
      case SYSTEM_ENTRY_KIND:
        this.consumeSystem(entry);
        return;
      case COMPACTION_ENTRY_KIND:
        this.consumeCompaction(entry);
        return;
      case CONTEXT_EDIT_ENTRY_KIND:
        this.consumeContextEdit(entry);
        return;
      default:
        // Plain audit/control bookkeeping: advances the head only — an anchor
        // stays valid (only the two rewrite kinds invalidate it), matching
        // `estimateProjectedContextTokens`.
        return;
    }
  }

  private consumeMessage(entry: LogEntry): void {
    const tokens = this.memoTokens(entry);
    const bytes = this.memoBytes(entry);
    this.window.push({ id: entry.id, tokens, bytes });
    this.windowTokens += tokens;
    this.windowEntryBytes += bytes;
    if (this.anchor !== null) this.suffixTokens += tokens;
    // A NEW valid usage anchor (a successful assistant turn) re-anchors the
    // window; everything before it is inside the provider's reported total.
    if (hasValidUsageAnchor(entry.payload as never)) {
      const usage = (entry.payload as { readonly usage?: Record<string, number> | undefined }).usage;
      this.anchor = { id: entry.id, tokens: calculateUsageTokens(usage ?? {}) };
      this.suffixTokens = 0;
    }
  }

  private consumeSystem(entry: LogEntry): void {
    const text = parseSystemText(entry.payload);
    if (text === undefined) return; // malformed system entries project nothing
    this.lastSystemText = text;
    this.lastSystemEntryId = entry.id;
    if (!this.systemFrozen) this.systemText = text;
  }

  private consumeCompaction(entry: LogEntry): void {
    // The KIND invalidates the anchor even when the payload is malformed
    // (the slow reference tests kinds, not payloads).
    this.anchor = null;
    this.suffixTokens = 0;
    const payload = parseCompactionPayload(entry.payload);
    if (payload === undefined) return; // projects as plain audit noise

    const keptFrom = this.window.findIndex((member) => member.id === payload.firstKeptEntryId);
    if (keptFrom < 0) {
      // The checkpoint references an entry outside the maintained window
      // (re-expansion of an omitted checkpoint, or a foreign history) —
      // beyond the incremental mirror; ingest re-syncs.
      throw new RangeError(`window re-expansion for checkpoint ${entry.id}`);
    }
    const kept = this.window.slice(keptFrom);
    this.windowTokens -= this.windowTokens - kept.reduce((sum, member) => sum + member.tokens, 0);
    this.windowEntryBytes -= this.windowEntryBytes - kept.reduce((sum, member) => sum + member.bytes, 0);
    this.window = kept;

    // The checkpoint contributes its summary (a user message) and its payload
    // bytes — both travel on the wire — and leads the message order.
    const summaryTokens = estimateTokensOf({ role: 'user', content: payload.summary });
    const checkpointMember: WindowMember = { id: entry.id, tokens: summaryTokens, bytes: serializedBytes(entry.payload) };
    this.window = [checkpointMember, ...this.window];
    this.checkpointMemberId = entry.id;
    this.windowTokens += summaryTokens;
    this.windowEntryBytes += checkpointMember.bytes;

    if (payload.systemMessage !== null) {
      this.systemText = payload.systemMessage;
      this.systemFrozen = true;
    } else {
      // The checkpoint defers to the newest visible system entry (which may
      // predate it — the projection searches the whole log backwards).
      this.systemFrozen = false;
      this.systemText = this.lastSystemText;
    }
  }

  private consumeContextEdit(entry: LogEntry): void {
    this.anchor = null;
    this.suffixTokens = 0;
    const targetIds = parseOmissionTargetIds(entry.payload);
    if (targetIds === undefined || targetIds.length === 0) return;
    const hidden = new Set(targetIds);
    if (this.lastSystemEntryId !== null && hidden.has(this.lastSystemEntryId)) {
      // The "newest visible system entry" rule cannot be mirrored once its
      // source is retracted — ingest re-syncs.
      throw new RangeError(`system source retracted by ${entry.id}`);
    }
    if (this.checkpointMemberId !== null && hidden.has(this.checkpointMemberId)) {
      // Retracting the WINNING checkpoint re-expands the window to raw
      // history the counters had already cut — ingest re-syncs.
      throw new RangeError(`winning checkpoint retracted by ${entry.id}`);
    }
    const kept: WindowMember[] = [];
    let removedTokens = 0;
    let removedBytes = 0;
    for (const member of this.window) {
      if (hidden.has(member.id)) {
        removedTokens += member.tokens;
        removedBytes += member.bytes;
        continue;
      }
      kept.push(member);
    }
    if (removedTokens === 0 && removedBytes === 0) return;
    this.window = kept;
    this.windowTokens -= removedTokens;
    this.windowEntryBytes -= removedBytes;
  }
}
