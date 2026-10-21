/**
 * Classifier tests: the reference classification of the 38 canonical tools,
 * override precedence, description-based inference for out-of-table names
 * and fail-closed behaviour for unknown tools.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
	CANONICAL_TOOL_NAMES,
	DEFAULT_TOOL_CATEGORIES,
	createToolClassifier,
	inferCategoryFromDescription,
} from '../src/classifier.js';
import type { ToolCategory } from '../src/types.js';

// Reference groups: the expected category of every canonical builtin tool,
// derived from the descriptions in packages/agent-tools.
const READ_ONLY_REFERENCE = [
	'read',
	'grep',
	'glob',
	'web_fetch',
	'web_search',
	'tool_search',
	'task_query',
	'task_output',
] as const;

const EFFECTFUL_REFERENCE = [
	'write',
	'edit',
	'bash',
	'todowrite',
	'skill',
	'code_review',
	'memory',
	'task',
	'task_append',
	'task_stop',
	'mavis',
	'mcp_invoke',
	'website_deploy',
	'browser',
	'browser_inspect',
	'browser_navigate',
	'browser_click',
	'browser_run_script',
	'browser_type',
	'browser_press_key',
	'browser_scroll',
	'browser_hover',
	'browser_wait_for',
	'browser_get_dom',
	'browser_screenshot',
	'browser_paste',
	'browser_verify_text',
	'browser_inspect_editable_targets',
] as const;

const INTERACTIVE_REFERENCE = ['ask_user', 'request_feature_enable'] as const;

function expectCategory(classifier: ReturnType<typeof createToolClassifier>, names: readonly string[], category: ToolCategory) {
	for (const name of names) {
		expect(classifier.classify(name)).toBe(category);
	}
}

describe('default table', () => {
	it('covers exactly the 38 canonical builtin tools', () => {
		expect(CANONICAL_TOOL_NAMES).toHaveLength(38);
		expect(new Set(CANONICAL_TOOL_NAMES).size).toBe(38);
		expect([...Object.keys(DEFAULT_TOOL_CATEGORIES)].sort()).toEqual([...CANONICAL_TOOL_NAMES].sort());
	});

	it('classifies every reference tool into its expected category', () => {
		const classifier = createToolClassifier();
		expectCategory(classifier, READ_ONLY_REFERENCE, 'speculatable-read-only');
		expectCategory(classifier, EFFECTFUL_REFERENCE, 'effectful');
		expectCategory(classifier, INTERACTIVE_REFERENCE, 'interactive');
	});

	it('leaves no canonical name unclassified', () => {
		const classifier = createToolClassifier();
		const reference = [...READ_ONLY_REFERENCE, ...EFFECTFUL_REFERENCE, ...INTERACTIVE_REFERENCE];
		expect(reference).toHaveLength(38);
		for (const name of reference) {
			expect(classifier.classify(name)).not.toBeUndefined();
		}
	});

	it('reports only speculatable-read-only tools as speculatable', () => {
		const classifier = createToolClassifier();
		expect(classifier.isSpeculatable('read')).toBe(true);
		expect(classifier.isSpeculatable('write')).toBe(false);
		expect(classifier.isSpeculatable('ask_user')).toBe(false);
	});
});

describe('overrides', () => {
	it('take precedence over the default table in both directions', () => {
		const classifier = createToolClassifier({
			overrides: {
				// Tighten a table read into effectful.
				read: 'effectful',
				// Relax a session-scoped browser observer for a provably
				// read-only provider.
				browser_get_dom: 'speculatable-read-only',
			},
		});
		expect(classifier.classify('read')).toBe('effectful');
		expect(classifier.classify('browser_get_dom')).toBe('speculatable-read-only');
		// Untouched neighbours keep their table categories.
		expect(classifier.classify('grep')).toBe('speculatable-read-only');
		expect(classifier.classify('browser_click')).toBe('effectful');
	});

	it('reject invalid override values and names', () => {
		expect(() =>
			createToolClassifier({ overrides: { read: 'maybe' as ToolCategory } }),
		).toThrow(TypeError);
		expect(() => createToolClassifier({ overrides: { '': 'effectful' } })).toThrow(TypeError);
		expect(() =>
			createToolClassifier({ unknownCategory: 'unknown' as ToolCategory }),
		).toThrow(TypeError);
	});
});

describe('descriptor lists', () => {
	it('infer categories from descriptions for names outside the table', () => {
		const classifier = createToolClassifier({
			descriptors: [
				{ name: 'custom_scan', description: 'Reads matching lines from indexed files.' },
				{ name: 'custom_publish', description: 'Deploys the built site to the target host.' },
				{
					name: 'custom_gate',
					description: 'Ask the user to choose between two options and pause the turn.',
				},
			],
		});
		expect(classifier.classify('custom_scan')).toBe('speculatable-read-only');
		expect(classifier.classify('custom_publish')).toBe('effectful');
		expect(classifier.classify('custom_gate')).toBe('interactive');
	});

	it('fail closed: undescribed and unmatched names default to effectful', () => {
		const classifier = createToolClassifier({
			descriptors: [{ name: 'custom_opaque', description: 'Does the thing.' }],
		});
		expect(classifier.classify('custom_opaque')).toBe('effectful');
		expect(classifier.classify('never_heard_of_it')).toBe('effectful');
		expect(classifier.classify('never_heard_of_it')).not.toBe('speculatable-read-only');
	});

	it('honour an explicit unknownCategory and reject malformed descriptors', () => {
		const classifier = createToolClassifier({ unknownCategory: 'interactive' });
		expect(classifier.classify('mystery')).toBe('interactive');
		expect(() =>
			createToolClassifier({ descriptors: [{ name: '', description: 'x' }] }),
		).toThrow(TypeError);
	});

	it('lose to the default table and to overrides', () => {
		const classifier = createToolClassifier({
			overrides: { read: 'effectful' },
			descriptors: [{ name: 'read', description: 'Reads a file.' }],
		});
		expect(classifier.classify('read')).toBe('effectful');
	});
});

describe('inferCategoryFromDescription', () => {
	it('is interactive-first, then effectful, then read-only', () => {
		expect(inferCategoryFromDescription('Ask the user a blocking question.')).toBe('interactive');
		expect(inferCategoryFromDescription('Writes a file to disk.')).toBe('effectful');
		expect(inferCategoryFromDescription('Reads a file and returns its lines.')).toBe(
			'speculatable-read-only',
		);
	});

	it('returns undefined for empty or unmatched descriptions', () => {
		expect(inferCategoryFromDescription(undefined)).toBeUndefined();
		expect(inferCategoryFromDescription('   ')).toBeUndefined();
		expect(inferCategoryFromDescription('Does the thing.')).toBeUndefined();
	});
});
