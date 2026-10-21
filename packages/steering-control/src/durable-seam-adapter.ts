/**
 * Adapter from the wave-3 `@mavis/durable-seam` to this package's
 * {@link DelegationControlSeam} — the ONE bridging point between the
 * reactive release control and the durable seam that owns T_release /
 * T_complete (steering-design-sol.md §3: "один переход с одним
 * operationId/CAS").
 *
 * Ownership (round-1 review fix): `DurableSeam` is the WAIT-OUTCOME
 * authority. It writes the single `mcode.delegation.backgrounded` control
 * entry and the single tool-result per `toolCallId`; this adapter never
 * writes a second representation of the same outcome — it routes every
 * release through `DurableSeam.prepareRelease` / `DurableSeam.finalizeTool`
 * and maps the results onto the control contracts.
 *
 * Error mapping (contract, see `DelegationControlSeam`): durable-seam
 * `VERSION_CONFLICT`, `OWNER_LOST` and `GENERATION_SEALED` all mean "this
 * writer's token is stale" and surface as
 * {@link StaleStateVersionError} (the `stale-version` branch: visible
 * blocker, refresh-and-retry); every other error passes through unchanged.
 * The mapping is structural — by stable `code`, never by message text.
 *
 * The durable-seam import is TYPE-only: the adapter receives the seam
 * instance and speaks its public surface, so the runtime stays decoupled
 * from the seam package while the type dependency keeps the two contracts
 * compile-time aligned.
 *
 * @module
 */

import type {
	BackgroundOutcome,
	DurableSeam,
	PrepareReleaseInput,
	PreparedRelease as DurablePreparedRelease,
	SeamWaitView,
} from '@mavis/durable-seam';

import { StaleStateVersionError, isStaleStateVersionError } from './errors.js';
import type {
	BackgroundHandle,
	DelegationControlSeam,
	PreparedRelease,
	PreparedReleaseQuery,
	ReleaseRequest,
	ToolFinalization,
} from './types.js';

/**
 * Durable-seam error codes that mean "the caller's token is stale": the
 * `stateVersion` CAS did not hold (`VERSION_CONFLICT`), or this writer lost
 * the single-writer epoch / generation (`OWNER_LOST`, `GENERATION_SEALED`).
 * All three map to `STALE_STATE_VERSION` (see the `DelegationControlSeam`
 * contract); everything else is not a stale refusal.
 */
const STALE_SEAM_CODES: ReadonlySet<string> = new Set(['VERSION_CONFLICT', 'OWNER_LOST', 'GENERATION_SEALED']);

/**
 * Map a durable-seam failure onto the control-seam error contract (the
 * fixed rule documented on {@link DelegationControlSeam}). Recognition is
 * structural — by the stable `code` property — so it survives the seam
 * boundary without loading the seam's error classes at runtime.
 */
export function mapDurableSeamError(error: unknown): unknown {
	if (isStaleStateVersionError(error)) return error;
	if (typeof error === 'object' && error !== null) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === 'string' && STALE_SEAM_CODES.has(code)) {
			return new StaleStateVersionError(error instanceof Error ? error.message : `stale seam token (${code})`, {
				cause: error,
			});
		}
	}
	return error;
}

/** Options of {@link createDurableSeamControlSeam}. */
export interface DurableSeamAdapterOptions {
	/**
	 * Stable task ID reported for a wait's single background tool-result
	 * (the ID the original `task` call is known under). Defaults to the
	 * wait's `toolCallId` — the native identity of that tool call.
	 */
	readonly taskIdFor?: (wait: { readonly waitId: string; readonly toolCallId: string }) => string;
	/**
	 * Background handle recorded inside the committed outcome (§3 Владение:
	 * the supervisor's stable anchor). Receives the delegation identity of the
	 * durable wait. Defaults to that identity as-is; integrators supervising
	 * the child through `DelegationSupervisor` should supply the real
	 * `supervisorTaskId` here.
	 */
	readonly backgroundHandleFor?: (identity: {
		readonly delegationId: string | null;
		readonly childConversationId: string | null;
	}) => BackgroundHandle;
	/**
	 * Urgent control-plane flush (§2: bypass the ≤200 ms batching window).
	 * The controller calls it once per release pass, before the prepares.
	 */
	readonly flushUrgent?: () => Promise<void>;
}

/**
 * The durable outcome behind a control-shaped {@link PreparedRelease}: kept
 * by operation id so `finalizeTool` can reproduce the EXACT committed
 * outcome bytes (the seam verifies the outcome hash — a near-miss would be a
 * `TOOL_RESULT_CONFLICT`). Cross-process recovery goes through
 * `listPreparedReleases`, which re-reads the durable prepared outcomes.
 */
function controlPrepared(durable: DurablePreparedRelease, context: AdapterContext): PreparedRelease {
	context.outcomesByOperationId.set(durable.outcome.operationId, durable.outcome);
	return {
		operationId: durable.outcome.operationId,
		waitId: durable.waitId,
		key: {
			parentConversationId: durable.outcome.conversationId,
			parentRunId: parentRunIdOf(durable),
			toolCallId: durable.toolCallId,
		},
		reason: toReleaseReason(durable.outcome.reason),
		stateVersion: durable.stateVersion,
		urgent: true,
		taskId: context.taskIdFor({ waitId: durable.waitId, toolCallId: durable.toolCallId }),
		backgroundHandle: context.backgroundHandleFor({
			delegationId: durable.outcome.delegationId,
			childConversationId: durable.outcome.childConversationId,
		}),
	};
}

/**
 * The prepared outcome is keyed by waitId in the store; the parent run id is
 * not part of the seam's wait identity (it lives in the waitId string of the
 * control registry). Recovery replays go through `listPreparedReleases`,
 * which only needs the key the controller matches waits on.
 */
function parentRunIdOf(durable: DurablePreparedRelease): string {
	// waitId shape (control registry): `wait:<conversation>:<run>:<toolCallId>`;
	// the seam treats waitId as opaque, so parse defensively.
	const parts = durable.waitId.split(':');
	return parts.length >= 3 ? parts[parts.length - 2]! : '';
}

const RELEASE_REASONS: ReadonlySet<string> = new Set(['owner_input', 'manual_background', 'timer']);

function toReleaseReason(reason: string): PreparedRelease['reason'] {
	return RELEASE_REASONS.has(reason) ? (reason as PreparedRelease['reason']) : 'owner_input';
}

interface AdapterContext {
	readonly taskIdFor: (wait: { readonly waitId: string; readonly toolCallId: string }) => string;
	readonly backgroundHandleFor: (identity: {
		readonly delegationId: string | null;
		readonly childConversationId: string | null;
	}) => BackgroundHandle;
	/** Durable outcomes seen by THIS process, by operation id. */
	readonly outcomesByOperationId: Map<string, BackgroundOutcome>;
}

/**
 * Adapt a `DurableSeam` into the control seam of the reactive release
 * control. The seam instance is the wait-outcome authority; this adapter
 * adds no durable representation of its own.
 */
export function createDurableSeamControlSeam(
	seam: DurableSeam,
	options: DurableSeamAdapterOptions = {},
): DelegationControlSeam {
	if (seam === null || typeof seam !== 'object') {
		throw new TypeError('createDurableSeamControlSeam: seam must be a DurableSeam instance');
	}
	for (const method of ['prepareRelease', 'finalizeTool', 'listPendingPrepared', 'openForegroundWait', 'getWait'] as const) {
		// Runtime surface guard — the type comes in via `DurableSeam`, but the
		// adapter is intentional about failing fast on a foreign object.
		if (typeof (seam as unknown as Record<string, unknown>)[method] !== 'function') {
			throw new TypeError(`createDurableSeamControlSeam: seam.${method} must be a function`);
		}
	}

	const taskIdFor =
		options.taskIdFor ??
		((wait: { readonly waitId: string; readonly toolCallId: string }) => wait.toolCallId);
	const backgroundHandleFor =
		options.backgroundHandleFor ??
		((identity: { readonly delegationId: string | null; readonly childConversationId: string | null }) => ({
			delegationId: identity.delegationId ?? '',
			supervisorTaskId: identity.delegationId ?? '',
			childConversationId: identity.childConversationId ?? '',
		}));
	const context: AdapterContext = {
		taskIdFor,
		backgroundHandleFor,
		outcomesByOperationId: new Map(),
	};

	function viewOrThrow(waitId: string): SeamWaitView {
		const view = seam.getWait(waitId);
		if (view === undefined) {
			throw new StaleStateVersionError(`wait ${JSON.stringify(waitId)} is not open in the durable seam`);
		}
		return view;
	}

	return {
		async prepareRelease(request: ReleaseRequest): Promise<PreparedRelease> {
			// The durable wait must exist (the spawn path opens it); a missing
			// wait is a stale/foreign token for the release decision, not a
			// fresh anchor — never open a SECOND wait for the id from here.
			const view = viewOrThrow(request.wait.waitId);
			// A fresh literal: the control's BackgroundHandle interface carries
			// no index signature, so build the JsonValue the seam stores.
			const handle = backgroundHandleFor({
				delegationId: view.delegationId,
				childConversationId: view.childConversationId,
			});
			const input: PrepareReleaseInput = {
				waitId: request.wait.waitId,
				expectedVersion: request.wait.stateVersion,
				// THE operationId of the transition: one release = one committed
				// entry carrying exactly this identity (§3).
				operationId: request.operationId,
				reason: request.reason,
				initiator: 'owner-input',
				backgroundHandle: {
					delegationId: handle.delegationId,
					supervisorTaskId: handle.supervisorTaskId,
					childConversationId: handle.childConversationId,
				},
			};
			let prepared: DurablePreparedRelease;
			try {
				// THE single durable transition (§3): the seam commits the one
				// `mcode.delegation.backgrounded` entry under its own CAS.
				prepared = await seam.prepareRelease(input);
			} catch (error) {
				throw mapDurableSeamError(error);
			}
			return controlPrepared(prepared, context);
		},

		async finalizeTool(prepared: PreparedRelease): Promise<ToolFinalization> {
			const outcome = context.outcomesByOperationId.get(prepared.operationId) ?? viewOrThrow(prepared.waitId).preparedOutcome;
			if (outcome === null || outcome === undefined) {
				// No durable outcome to reproduce: the prepared outcome was never
				// committed by this seam — refuse loudly instead of inventing one.
				throw new StaleStateVersionError(
					`no committed prepared outcome for operation ${prepared.operationId} (wait ${prepared.waitId})`,
				);
			}
			try {
				const result = await seam.finalizeTool({ toolCallId: prepared.key.toolCallId, outcome });
				return {
					toolCallId: result.toolCallId,
					taskId: prepared.taskId,
					outcome: 'background',
					replayed: result.status === 'replayed',
				};
			} catch (error) {
				throw mapDurableSeamError(error);
			}
		},

		async listPreparedReleases(query?: PreparedReleaseQuery): Promise<readonly PreparedRelease[]> {
			const pending = seam.listPendingPrepared();
			const result: PreparedRelease[] = [];
			for (const durable of pending) {
				if (query?.waitId !== undefined && durable.waitId !== query.waitId) continue;
				const prepared = controlPrepared(durable, context);
				if (
					query?.parentConversationId !== undefined &&
					prepared.key.parentConversationId !== query.parentConversationId
				) {
					continue;
				}
				result.push(prepared);
			}
			return result;
		},

		flushUrgent: options.flushUrgent,
	};
}
