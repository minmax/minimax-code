/**
 * Tool classifier: the 38 canonical builtin tools mapped to speculation
 * categories, with per-name overrides and description-based inference for
 * tools outside the table.
 *
 * The default table is derived from the tool descriptions in
 * `packages/agent-tools` (desktop/builtin-defs.ts,
 * desktop/builtin-browser-defs.ts, desktop/local-website-deploy.ts,
 * shared/web-search.ts, mcp-disclosure/tool-search.ts,
 * mcp-disclosure/mcp-invoke.ts). Callers that already hold the live registry
 * can pass its descriptors as a list instead of importing it here; the
 * classifier stays dependency-free.
 *
 * Classification is deliberately conservative: anything the table and the
 * descriptors cannot vouch for falls back to `effectful`, so the later
 * pipeline fails closed — an unclassified tool is never speculated.
 *
 * @module
 */

import type {
	ToolCategory,
	ToolCategoryOverrides,
	ToolClassifier,
	ToolDescriptor,
} from './types.js';

/**
 * Default category of every canonical builtin tool (38 entries).
 *
 * Per-tool rationale, citing the agent-tools description that drives it:
 *
 * speculatable-read-only — pure observation (file/network/task reads):
 * - `read` reads a file; `grep` searches file contents; `glob` matches paths.
 * - `web_fetch` fetches a URL; `web_search` queries the web (network reads).
 * - `tool_search` searches the deferred MCP tool index (disclosure only).
 * - `task_query` lists/fetches background-task status; `task_output` reads a
 *   task's output stream.
 *
 * effectful — writes, mutations, stateful drivers and management commands:
 * - `write`/`edit` mutate files; `bash` executes shell commands.
 * - `todowrite` mutates session todo state (also on the canonical
 *   read-only-blocked list in canonical-tool-policy.ts).
 * - `skill` loads instructions that change active agent behaviour.
 * - `code_review` runs review execution (inline or hidden subagent).
 * - `memory` appends/edits/creates/deletes local memory.
 * - `task` spawns delegated work; `task_append` sends follow-ups into a child
 *   agent; `task_stop` aborts tasks.
 * - `mavis` dispatches management commands (agent/cron/session/mcp
 *   create/update/delete/send).
 * - `mcp_invoke` executes an arbitrary external MCP tool of unknown effect.
 * - `website_deploy` deploys a website.
 * - All 15 `browser*` tools: the browser description states "Browser calls
 *   are stateful and must not be parallel" — session-scoped live state, so
 *   even observation tools default to effectful. Callers with a provably
 *   read-only provider can still override individual names.
 *
 * interactive — pauses the turn for a human decision:
 * - `ask_user` presents a questionnaire and pauses the current turn.
 * - `request_feature_enable` requests user consent and pauses the turn.
 */
export const DEFAULT_TOOL_CATEGORIES: Readonly<Record<string, ToolCategory>> = Object.freeze({
	// speculatable-read-only (8)
	read: 'speculatable-read-only',
	grep: 'speculatable-read-only',
	glob: 'speculatable-read-only',
	web_fetch: 'speculatable-read-only',
	web_search: 'speculatable-read-only',
	tool_search: 'speculatable-read-only',
	task_query: 'speculatable-read-only',
	task_output: 'speculatable-read-only',

	// effectful — core (13)
	write: 'effectful',
	edit: 'effectful',
	bash: 'effectful',
	todowrite: 'effectful',
	skill: 'effectful',
	code_review: 'effectful',
	memory: 'effectful',
	task: 'effectful',
	task_append: 'effectful',
	task_stop: 'effectful',
	mavis: 'effectful',
	mcp_invoke: 'effectful',
	website_deploy: 'effectful',

	// effectful — browser family (15, session-scoped live state)
	browser: 'effectful',
	browser_inspect: 'effectful',
	browser_navigate: 'effectful',
	browser_click: 'effectful',
	browser_run_script: 'effectful',
	browser_type: 'effectful',
	browser_press_key: 'effectful',
	browser_scroll: 'effectful',
	browser_hover: 'effectful',
	browser_wait_for: 'effectful',
	browser_get_dom: 'effectful',
	browser_screenshot: 'effectful',
	browser_paste: 'effectful',
	browser_verify_text: 'effectful',
	browser_inspect_editable_targets: 'effectful',

	// interactive (2)
	ask_user: 'interactive',
	request_feature_enable: 'interactive',
});

/** The canonical builtin tool names the default table covers. */
export const CANONICAL_TOOL_NAMES: readonly string[] = Object.freeze(
	Object.keys(DEFAULT_TOOL_CATEGORIES),
);

/** Runtime guard for categories arriving from untyped config. */
export function isToolCategory(value: unknown): value is ToolCategory {
	return (
		value === 'speculatable-read-only' || value === 'effectful' || value === 'interactive'
	);
}

const INTERACTIVE_DESCRIPTION = /\bask\b.{0,24}\buser\b|pauses? (the |this )?(current )?turn|user (responds|consent|reply|takeover)/i;
const EFFECTFUL_DESCRIPTION =
	/\b(writ(e|es|ing)|edit|delet|creat|updat|execut(e|es|ing)|run[s]? |deploy|send|append|stop|abort|invok|click|navigat|type |paste|press|scroll|hover|upload|spawn|schedule|archiv)/i;
const READ_ONLY_DESCRIPTION =
	/\b(read(s)?|search(es|ing)?|quer(y|ies)|list(s)?|inspect(s)?|screenshot|fetch(es)?|return(s)? page state|page state|output stream)\b/i;

/**
 * Best-effort category inference from a tool description, used only for names
 * absent from the default table. Order is interactive → effectful → read-only
 * so that mutating phrasing always wins over incidental "read" wording.
 * Returns `undefined` when nothing matches; callers must fail closed.
 */
export function inferCategoryFromDescription(description: string | undefined): ToolCategory | undefined {
	if (description === undefined || description.trim() === '') return undefined;
	if (INTERACTIVE_DESCRIPTION.test(description)) return 'interactive';
	if (EFFECTFUL_DESCRIPTION.test(description)) return 'effectful';
	if (READ_ONLY_DESCRIPTION.test(description)) return 'speculatable-read-only';
	return undefined;
}

export interface ToolClassifierOptions {
	/** Per-name redefinitions applied on top of the default table. */
	readonly overrides?: ToolCategoryOverrides;
	/**
	 * Tool descriptors (e.g. the agent-tools registry passed as a list) used
	 * to classify names the default table does not cover, via
	 * {@link inferCategoryFromDescription}.
	 */
	readonly descriptors?: readonly ToolDescriptor[];
	/** Category for names resolvable by no other source. Defaults to `effectful`. */
	readonly unknownCategory?: ToolCategory;
}

/**
 * Build a classifier. Resolution order per name:
 * overrides → default table → descriptor description inference →
 * `unknownCategory` (default `effectful`, fail closed).
 */
export function createToolClassifier(options: ToolClassifierOptions = {}): ToolClassifier {
	const overrides = options.overrides ?? {};
	for (const [name, category] of Object.entries(overrides)) {
		if (name === '') throw new TypeError('Tool override names must be non-empty');
		if (!isToolCategory(category)) {
			throw new TypeError(`Override for "${name}" is not a ToolCategory: ${String(category)}`);
		}
	}
	if (options.unknownCategory !== undefined && !isToolCategory(options.unknownCategory)) {
		throw new TypeError(
			`unknownCategory is not a ToolCategory: ${String(options.unknownCategory)}`,
		);
	}
	const descriptorIndex = new Map<string, string>();
	for (const descriptor of options.descriptors ?? []) {
		if (typeof descriptor.name !== 'string' || descriptor.name === '') {
			throw new TypeError('Tool descriptor names must be non-empty strings');
		}
		if (descriptor.description !== undefined) {
			descriptorIndex.set(descriptor.name, descriptor.description);
		}
	}
	const unknownCategory: ToolCategory = options.unknownCategory ?? 'effectful';

	function classify(name: string): ToolCategory {
		const override = overrides[name];
		if (override !== undefined) return override;
		const fromTable = DEFAULT_TOOL_CATEGORIES[name];
		if (fromTable !== undefined) return fromTable;
		const description = descriptorIndex.get(name);
		const inferred = inferCategoryFromDescription(description);
		return inferred ?? unknownCategory;
	}

	return {
		classify,
		isSpeculatable: (name: string) => classify(name) === 'speculatable-read-only',
		canonicalToolNames: CANONICAL_TOOL_NAMES,
	};
}
