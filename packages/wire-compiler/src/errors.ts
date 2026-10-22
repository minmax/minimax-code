/** Error hierarchy of the wire compiler. */

/** Base class of every error this package raises. */
export class WireCompilerError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'WireCompilerError';
  }
}

/**
 * The compiled body would exceed the caller's byte budget. Raised before any
 * body is handed out; `breakdown` carries the per-entry byte lens so callers
 * can decide which entries to drop or compact (the guard is arithmetic over
 * segment lengths, so the breakdown is exact, not estimated).
 */
export class WireBudgetExceeded extends WireCompilerError {
  /** Total byte size the compiled body would have had. */
  readonly totalBytes: number;
  /** The budget that was exceeded. */
  readonly maxBytes: number;
  /** Byte contribution of every segment, in manifest order. */
  readonly breakdown: readonly SegmentBreakdownEntry[];

  constructor(params: {
    readonly totalBytes: number;
    readonly maxBytes: number;
    readonly breakdown: readonly SegmentBreakdownEntry[];
  }) {
    super(formatBudgetMessage(params.totalBytes, params.maxBytes, params.breakdown));
    this.name = 'WireBudgetExceeded';
    this.totalBytes = params.totalBytes;
    this.maxBytes = params.maxBytes;
    this.breakdown = params.breakdown;
  }
}

/** One entry's byte contribution inside a {@link WireBudgetExceeded}. */
export type SegmentBreakdownEntry = {
  readonly entryId: string;
  readonly bytes: number;
};

/**
 * Bounded message: names the top offenders (largest first, entryId as the
 * deterministic tie-break) so logs stay readable on thousand-entry windows.
 */
function formatBudgetMessage(
  totalBytes: number,
  maxBytes: number,
  breakdown: readonly SegmentBreakdownEntry[],
): string {
  const ranked = [...breakdown].sort(
    (a, b) => b.bytes - a.bytes || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0),
  );
  const top = ranked.slice(0, 8).map((part) => `${part.entryId}:${part.bytes}`);
  const rest = ranked.length - top.length;
  const detail = rest > 0 ? `${top.join(', ')} +${rest} more` : top.join(', ');
  return `wire budget exceeded: ${totalBytes} > ${maxBytes} bytes across ${breakdown.length} segments (${detail})`;
}
