/**
 * @mavis/speculation — speculative pipeline skeleton (F5 groundwork).
 *
 * This wave ships classification and admission plumbing only; no call is
 * ever executed speculatively by this package:
 * - tool classifier: 38 canonical tools → speculatable-read-only /
 *   effectful / interactive, default table plus overrides;
 * - permission pre-decision seam where `ask` is never auto-resolved;
 * - bounded budget (parallel calls, tokens) with steering-change
 *   cancellation;
 * - speculated / confirmed / wasted counters.
 *
 * @module
 */

export {
	CANONICAL_TOOL_NAMES,
	DEFAULT_TOOL_CATEGORIES,
	createToolClassifier,
	inferCategoryFromDescription,
	isToolCategory,
	type ToolClassifierOptions,
} from './classifier.js';
export {
	SpeculationMetrics,
} from './metrics.js';
export {
	AskSubstitutionError,
	assertAskNotSubstituted,
	combinePreDecisions,
	executionModeForDecision,
} from './pre-decision.js';
export type {
	PermissionDecision,
	PermissionPreDecision,
	PreDecisionExecutionMode,
	PreDecisionRequest,
	SpeculationMetricsSnapshot,
	ToolCategory,
	ToolCategoryOverrides,
	ToolClassifier,
	ToolDescriptor,
} from './types.js';
export {
	createSpeculationBudget,
	type AcquireFailureReason,
	type AcquireResult,
	type BudgetSnapshot,
	type LeaseOutcome,
	type SpeculationBudget,
	type SpeculationBudgetOptions,
	type SpeculationLease,
	type SteeringCancellation,
	type SteeringChangeReport,
} from './budget.js';
