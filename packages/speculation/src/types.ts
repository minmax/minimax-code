/**
 * Shared contracts of the speculation skeleton (F5 groundwork).
 *
 * This wave ships no speculative execution: only the classification table,
 * the permission pre-decision seam, the resource budget and the metrics
 * counters the later pipeline will consume.
 *
 * @module
 */

/**
 * Static effect class of a tool.
 *
 * - `speculatable-read-only` — pure observation; running it speculatively
 *   cannot change any state the conversation can observe.
 * - `effectful` — the call can change state (filesystem, processes,
 *   delegation, browser, MCP side effects, session/agent management).
 * - `interactive` — the call pauses the turn for a human decision; it is
 *   never a speculation candidate and never an auto-resolution target.
 */
export type ToolCategory = 'speculatable-read-only' | 'effectful' | 'interactive';

/** Minimal description surface the classifier accepts instead of a registry import. */
export interface ToolDescriptor {
	readonly name: string;
	readonly description?: string;
}

/** Per-name category redefinitions applied on top of the default table. */
export type ToolCategoryOverrides = Readonly<Record<string, ToolCategory>>;

/** Name → category lookup the pipeline uses for admission decisions. */
export interface ToolClassifier {
	/** Classify one tool name; never throws for unknown names (see `unknownCategory`). */
	classify(name: string): ToolCategory;
	/** Convenience predicate: only `speculatable-read-only` classifies as true. */
	isSpeculatable(name: string): boolean;
	/** The canonical 38 names the default table covers (frozen copy). */
	readonly canonicalToolNames: readonly string[];
}

/** Permission decision produced by a pre-decision before any execution. */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** Input of one pre-decision. */
export interface PreDecisionRequest {
	readonly toolName: string;
	readonly args: unknown;
	/** True when the call is about to run as a speculative (stage-overlapping) execution. */
	readonly speculative: boolean;
}

/**
 * Permission pre-decision seam (F5 overlay #5).
 *
 * Contract: an `ask` verdict is never replaced by an automatic decision.
 * A pre-decision may only answer; downstream, `ask` must reach the real
 * permission prompt. Speculative execution is permitted only for `allow`.
 */
export interface PermissionPreDecision {
	decide(call: PreDecisionRequest): Promise<PermissionDecision>;
}

/** How the pipeline must proceed after a pre-decision. */
export type PreDecisionExecutionMode =
	/** Run in the foreground path. */
	| 'run'
	/** Run as a speculative execution overlapping later stages. */
	| 'speculative-run'
	/** Pause and surface the real permission prompt; never auto-resolved. */
	| 'prompt'
	/** Skip the call entirely. */
	| 'skip';

/** Immutable counter triple of the speculation pipeline. */
export interface SpeculationMetricsSnapshot {
	/** Speculative executions started (leases acquired). */
	readonly speculated: number;
	/** Speculative executions whose result was adopted by the foreground path. */
	readonly confirmed: number;
	/** Speculative executions thrown away (steering change, non-confirmation, discard). */
	readonly wasted: number;
}
