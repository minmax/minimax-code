/**
 * Pre-decision tests: composition under strictest-wins semantics and the
 * core contract — an `ask` verdict is never substituted by an automatic
 * decision.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
	AskSubstitutionError,
	assertAskNotSubstituted,
	combinePreDecisions,
	executionModeForDecision,
} from '../src/pre-decision.js';
import type {
	PermissionDecision,
	PermissionPreDecision,
	PreDecisionRequest,
} from '../src/types.js';

/** Decider stub returning a canned verdict and recording what it saw. */
function fixedDecider(
	decision: PermissionDecision,
	seen: PreDecisionRequest[] = [],
): PermissionPreDecision {
	return {
		async decide(call: PreDecisionRequest) {
			seen.push(call);
			return decision;
		},
	};
}

const CALL: PreDecisionRequest = {
	toolName: 'read',
	args: { path: 'a.ts' },
	speculative: true,
};

describe('combinePreDecisions', () => {
	it('returns allow only when every decider allows', async () => {
		await expect(combinePreDecisions(fixedDecider('allow')).decide(CALL)).resolves.toBe('allow');
		await expect(
			combinePreDecisions(fixedDecider('allow'), fixedDecider('allow')).decide(CALL),
		).resolves.toBe('allow');
	});

	it('preserves ask over allow in any order (ask is never downgraded)', async () => {
		await expect(
			combinePreDecisions(fixedDecider('ask'), fixedDecider('allow')).decide(CALL),
		).resolves.toBe('ask');
		await expect(
			combinePreDecisions(fixedDecider('allow'), fixedDecider('ask')).decide(CALL),
		).resolves.toBe('ask');
	});

	it('lets deny win over ask and allow in any order', async () => {
		await expect(
			combinePreDecisions(fixedDecider('deny'), fixedDecider('ask')).decide(CALL),
		).resolves.toBe('deny');
		await expect(
			combinePreDecisions(fixedDecider('ask'), fixedDecider('deny')).decide(CALL),
		).resolves.toBe('deny');
		await expect(
			combinePreDecisions(fixedDecider('deny'), fixedDecider('allow')).decide(CALL),
		).resolves.toBe('deny');
	});

	it('short-circuits on deny without consulting later deciders', async () => {
		const later: PreDecisionRequest[] = [];
		const combined = combinePreDecisions(fixedDecider('deny'), fixedDecider('allow', later));
		await expect(combined.decide(CALL)).resolves.toBe('deny');
		expect(later).toHaveLength(0);
	});

	it('forwards the full call to every consulted decider', async () => {
		const seen: PreDecisionRequest[] = [];
		await combinePreDecisions(fixedDecider('allow', seen), fixedDecider('allow', seen)).decide(CALL);
		expect(seen).toEqual([CALL, CALL]);
		expect(seen[0]?.speculative).toBe(true);
	});
});

describe('executionModeForDecision', () => {
	it('maps ask to the prompt path even when speculation is allowed (contract)', () => {
		expect(executionModeForDecision('ask', { speculationAllowed: true })).toBe('prompt');
		expect(executionModeForDecision('ask', { speculationAllowed: false })).toBe('prompt');
	});

	it('maps allow to run or speculative-run depending on the flag', () => {
		expect(executionModeForDecision('allow', { speculationAllowed: true })).toBe('speculative-run');
		expect(executionModeForDecision('allow', { speculationAllowed: false })).toBe('run');
	});

	it('maps deny to skip', () => {
		expect(executionModeForDecision('deny', { speculationAllowed: true })).toBe('skip');
	});
});

describe('assertAskNotSubstituted', () => {
	it('accepts preservation and tightening of ask', () => {
		expect(() => assertAskNotSubstituted('ask', 'ask')).not.toThrow();
		expect(() => assertAskNotSubstituted('ask', 'deny')).not.toThrow();
	});

	it('rejects downgrading ask to an automatic decision', () => {
		expect(() => assertAskNotSubstituted('ask', 'allow')).toThrow(AskSubstitutionError);
		expect(() => assertAskNotSubstituted('ask', 'allow')).toThrow(/ask was downgraded/);
	});

	it('places no constraint on non-ask inputs', () => {
		expect(() => assertAskNotSubstituted('allow', 'deny')).not.toThrow();
		expect(() => assertAskNotSubstituted('deny', 'allow')).not.toThrow();
	});
});
