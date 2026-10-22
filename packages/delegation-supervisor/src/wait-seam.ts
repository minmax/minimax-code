/**
 * Structural port to the wait-outcome authority (steering-design-sol.md §3
 * "Атомарные переходы": T_release is ONE transition with one operationId/CAS).
 *
 * The authority is `@mavis/durable-seam`'s `DurableSeam`: it owns the single
 * `mcode.delegation.backgrounded` entry per waitId and the single tool-result
 * per toolCallId. The supervisor never writes a second durable representation
 * of a wait outcome — `detachToBackground` ROUTES the decision through this
 * port and then projects the committed decision into its own index document
 * (kind `mcode.delegations.document`), which is a different entry kind, so
 * one release still produces exactly one backgrounded record per waitId.
 *
 * The port is STRUCTURAL on purpose (like `DelegationLog`): this package
 * imports nothing from the seam package at runtime; `DurableSeam` satisfies
 * it as-is.
 *
 * @module
 */

/** The committed wait state the authority reports for a waitId. */
export type ForegroundWaitSeamState = 'foreground' | 'backgrounded' | 'completed';

/** Point-read view of one wait in the authority (subset the supervisor uses). */
export interface ForegroundWaitSeamView {
  readonly state: ForegroundWaitSeamState;
  /** The authority's optimistic-concurrency version (its OWN version space). */
  readonly stateVersion: number;
  /** The prepared outcome when `backgrounded` (the seam's durable record). */
  readonly preparedOutcome:
    | {
        readonly operationId: string;
        readonly waitId: string;
        readonly toolCallId: string;
        readonly reason: string;
        readonly initiator: string;
        readonly backgroundHandle: unknown;
      }
    | null;
}

/** Draft the supervisor hands to the authority when anchoring a wait. */
export interface ForegroundWaitSeamDraft {
  readonly waitId: string;
  readonly toolCallId: string;
  readonly conversationId: string;
  readonly delegationId?: string;
  readonly childConversationId?: string;
  readonly childRunId?: string;
  readonly cancelOnParentAbort?: boolean;
}

/** Release input routed to the authority (T_release). */
export interface ForegroundWaitSeamReleaseInput {
  readonly waitId: string;
  /** CAS expectation against the AUTHORITY's stateVersion. */
  readonly expectedVersion: number;
  /** Identity of the release decision (deterministic default per waitId). */
  readonly operationId?: string;
  readonly reason?: string;
  readonly initiator?: string;
  readonly backgroundHandle?: unknown;
}

/** The committed prepared outcome the authority returns. */
export interface ForegroundWaitSeamPrepared {
  readonly status: 'committed' | 'replayed';
  /** The authority's version AFTER the transition. */
  readonly stateVersion: number;
  readonly outcome: {
    readonly operationId: string;
    readonly waitId: string;
    readonly toolCallId: string;
    readonly reason: string;
    readonly initiator: string;
    readonly backgroundHandle: unknown;
  };
}

/**
 * The wait-outcome authority surface the supervisor routes through.
 * `DurableSeam` from `@mavis/durable-seam` implements this as-is.
 */
export interface ForegroundWaitSeam {
  /** Idempotently anchor the foreground wait of a spawn (T_spawn, §3). */
  openForegroundWait(draft: ForegroundWaitSeamDraft): Promise<unknown>;
  /** Point read of one wait; `undefined` when the id is unknown. */
  getWait(waitId: string): ForegroundWaitSeamView | undefined;
  /** THE release transition: one entry, one CAS, one outcome per waitId. */
  prepareRelease(input: ForegroundWaitSeamReleaseInput): Promise<ForegroundWaitSeamPrepared>;
}
