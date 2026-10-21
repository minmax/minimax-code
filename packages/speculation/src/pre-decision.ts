/**
 * Permission pre-decision seam: the interface the F5 speculative pipeline
 * consults before running any call, plus the ask-preserving composition and
 * decision → execution-mode mapping.
 *
 * Contract (F5 overlay #5): an `ask` verdict is never replaced by an
 * automatic decision. Composition may only tighten a verdict (deny beats
 * ask beats allow); mapping always routes `ask` to the real permission
 * prompt, regardless of speculation flags.
 *
 * @module
 */

import type {
	PermissionDecision,
	PermissionPreDecision,
	PreDecisionExecutionMode,
	PreDecisionRequest,
} from './types.js';

/** Raised when a transform downgrades `ask` to an automatic decision. */
export class AskSubstitutionError extends Error {
	constructor(message = 'ask was substituted by an automatic decision') {
		super(message);
		this.name = 'AskSubstitutionError';
	}
}

/**
 * Compose pre-decisions left to right under strictest-wins semantics:
 * `deny` short-circuits; otherwise any `ask` keeps the pipeline on the
 * prompt path; `allow` only survives when every decider allowed.
 *
 * The composition can therefore tighten an `ask` into a `deny` but can
 * never loosen it into an `allow` — the "ask is never auto-resolved"
 * contract holds for any input order.
 */
export function combinePreDecisions(
	...deciders: readonly PermissionPreDecision[]
): PermissionPreDecision {
	return {
		async decide(call: PreDecisionRequest): Promise<PermissionDecision> {
			let seenAsk = false;
			for (const decider of deciders) {
				const decision = await decider.decide(call);
				if (decision === 'deny') return 'deny';
				if (decision === 'ask') seenAsk = true;
			}
			return seenAsk ? 'ask' : 'allow';
		},
	};
}

/**
 * Map a pre-decision verdict to the execution mode the pipeline must take.
 *
 * `ask` always maps to `prompt` — the real permission prompt — even when
 * speculation is allowed; speculative execution is reachable only from
 * `allow`. This is the enforcement point of the ask contract.
 */
export function executionModeForDecision(
	decision: PermissionDecision,
	options: { speculationAllowed: boolean },
): PreDecisionExecutionMode {
	switch (decision) {
		case 'deny':
			return 'skip';
		case 'ask':
			// Contract: ask is never substituted by an automatic decision.
			return 'prompt';
		case 'allow':
			return options.speculationAllowed ? 'speculative-run' : 'run';
	}
}

/**
 * Guard for decision transforms (caches, wrappers, adapters): verifies that a
 * transform never downgrades `ask` into an automatic decision. Throws
 * {@link AskSubstitutionError} when the output is less demanding than an
 * input `ask`; tightening `ask → deny` is allowed.
 */
export function assertAskNotSubstituted(
	before: PermissionDecision,
	after: PermissionDecision,
): void {
	if (before === 'ask' && after !== 'ask' && after !== 'deny') {
		throw new AskSubstitutionError(`ask was downgraded to "${after}"`);
	}
}
