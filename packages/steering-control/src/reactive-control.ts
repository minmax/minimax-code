/**
 * Reactive delegation control (steering-design-sol.md §2.3, node
 * `mcode-reactive-delegation-control`): the committed-steer reaction.
 *
 * A committed parent steer wakes the control channel, which is served
 * independently of the foreground tool promise. The control finds the
 * parent's ForegroundWaitSet and performs the single durable release
 * transition per wait:
 *
 * 1. urgent flush of the control plane (bypassing the ≤200 ms batching
 *    window), when the seam supports it;
 * 2. `seam.prepareRelease` — T_release: validate owner-epoch/stateVersion,
 *    choose the `backgrounded` outcome, persist background handle + control
 *    entry + replayable prepared outcome (resolves only after the commit);
 * 3. `seam.finalizeTool` — the native tool finalizer records the ONE final
 *    tool-result: the standard background result with the same task ID;
 * 4. settle the waiter with that single outcome and engage the effect fence
 *    so the parent's next conflicting effects get DELEGATION_EFFECT_BLOCKED.
 *
 * The release never fakes another long tool: only registered delegation
 * waits are touched; any remaining non-delegation tool keeps its native
 * steering boundary and stays visible to the caller's own blocker view.
 *
 * @module
 */

import { CONTROL_PRIORITY, createControlPlane } from './control-plane.js';
import { errorMessage, isStaleStateVersionError } from './errors.js';
import { createForegroundWaitSetRegistry, DEFAULT_MAX_WAITS_PER_ROUND, DEFAULT_SETTLED_ARCHIVE_LIMIT, type InternalWaitHandle } from './wait-set.js';
import type {
	CommittedSteer,
	DelegationControlSeam,
	FenceEngagement,
	FenceEngageRequest,
	PreparedRelease,
	ReactiveControlOptions,
	ReactiveDelegationControl,
	RecoverFailure,
	RecoveryReport,
	ReleaseRequest,
	ReleaseResult,
	ToolFinalization,
	WaitHandle,
	WaitReleaseRecord,
	WaitRegistration,
	BlockerFilter,
	ActiveBlocker,
	DelegationFenceRef,
} from './types.js';

const OWNER_INPUT_REASON = 'owner_input' as const;

/** A committed prepared outcome whose waiter is not settled yet. */
interface PendingFinalizationEntry {
	readonly handle: InternalWaitHandle;
	readonly prepared: PreparedRelease;
}

export function createReactiveControl(
	seam: DelegationControlSeam,
	options: ReactiveControlOptions = {},
): ReactiveDelegationControl {
	if (
		typeof seam?.prepareRelease !== 'function' ||
		typeof seam?.finalizeTool !== 'function' ||
		typeof seam?.listPreparedReleases !== 'function'
	) {
		throw new TypeError(
			'createReactiveControl: seam must provide prepareRelease, finalizeTool and listPreparedReleases',
		);
	}

	const clock = options.clock ?? Date.now;
	const registry = createForegroundWaitSetRegistry({
		maxWaitsPerRound: options.maxWaitsPerRound ?? DEFAULT_MAX_WAITS_PER_ROUND,
		settledArchiveLimit: options.settledArchiveLimit ?? DEFAULT_SETTLED_ARCHIVE_LIMIT,
	});
	const plane = createControlPlane();
	const effectFence = options.effectFence;
	let operationCounter = 0;
	const makeOperationId =
		options.makeOperationId ?? ((waitId: string) => `release:${waitId}:${++operationCounter}`);

	async function engageFence(request: FenceEngageRequest): Promise<FenceEngagement> {
		if (effectFence === undefined) {
			return { status: 'failed', error: 'no effect fence wired' };
		}
		try {
			return await effectFence.engage(request);
		} catch (error) {
			// The fence is a control-plane advisory: a failed engagement must
			// never rewrite the committed release — it is reported instead (§4).
			return { status: 'failed', error: errorMessage(error) };
		}
	}

	function fenceRef(prepared: PreparedRelease): DelegationFenceRef {
		return {
			waitId: prepared.waitId,
			toolCallId: prepared.key.toolCallId,
			taskId: prepared.taskId,
			delegationId: prepared.backgroundHandle.delegationId,
		};
	}

	/**
	 * Waits whose release decision is committed but whose tool finalization
	 * has not settled them yet. The committed prepared outcome is kept so a
	 * later steer or recover() can retry the idempotent finalization — a
	 * failed finalize must never wedge the wait or the control plane (§3:
	 * the prepared outcome is reproduced, the child is not restarted).
	 */
	const pendingFinalization = new Map<string, PendingFinalizationEntry>();

	/**
	 * Finalizes a committed prepared outcome and settles the waiter with the
	 * single background tool-result. Registers the entry so a failure can be
	 * retried by a later steer or by recover(); idempotent to call again.
	 */
	async function finalizePrepared(entry: PendingFinalizationEntry): Promise<WaitReleaseRecord> {
		const { handle, prepared } = entry;
		const base = { waitId: handle.waitId, toolCallId: handle.key.toolCallId } as const;
		pendingFinalization.set(handle.waitId, entry);
		let finalization: ToolFinalization;
		try {
			// Native tool finalizer: exactly one tool-result per toolCallId,
			// idempotent per operationId. If this fails the committed decision
			// stands: the entry is kept for a retry, never rolled back to
			// foreground (that would risk a second tool-result, §3 T_release).
			finalization = await seam.finalizeTool(prepared);
		} catch (error) {
			return { ...base, status: 'failed', error: errorMessage(error) };
		}
		pendingFinalization.delete(handle.waitId);
		const settled = handle.settle({ kind: 'backgrounded', prepared, finalization });
		if (!settled) {
			return { ...base, status: 'already-final', outcome: await handle.outcome };
		}
		return {
			...base,
			status: 'released',
			operationId: prepared.operationId,
			prepared,
			finalization,
		};
	}

	/**
	 * Releases exactly one wait through the two-phase seam. The claim happens
	 * before the durable prepare, guaranteeing one outcome per waitId even if
	 * child completion races the release.
	 */
	async function releaseOne(handle: InternalWaitHandle): Promise<WaitReleaseRecord> {
		const base = { waitId: handle.waitId, toolCallId: handle.key.toolCallId } as const;
		if (!handle.claimForRelease()) {
			if (handle.isSettled()) {
				// The wait already settled (completed, or released by an earlier
				// pass): report the saved outcome, never a second transition.
				return { ...base, status: 'already-final', outcome: await handle.outcome };
			}
			// Still 'releasing': an earlier pass committed the decision but its
			// finalization failed. Retry the idempotent finalization instead of
			// awaiting an outcome that would never settle on its own.
			const pending = pendingFinalization.get(handle.waitId);
			if (pending === undefined) {
				return { ...base, status: 'failed', error: 'wait is mid-release without a committed prepared outcome' };
			}
			return finalizePrepared(pending);
		}

		const request: ReleaseRequest = {
			operationId: makeOperationId(handle.waitId),
			reason: OWNER_INPUT_REASON,
			urgent: true,
			wait: {
				waitId: handle.waitId,
				key: { ...handle.key },
				stateVersion: handle.stateVersion,
			},
		};

		let prepared: PreparedRelease;
		try {
			// Seam contract: resolves only after the durable T_release commit.
			prepared = await seam.prepareRelease(request);
		} catch (error) {
			// Explicit refusal (§4 Гонки): the wait returns to foreground and
			// stays visible in blockers(); a completion that arrived inside the
			// claim→prepare window is replayed by unclaim(). A refreshed
			// version may retry.
			handle.unclaim();
			if (isStaleStateVersionError(error)) {
				return { ...base, status: 'stale-version', error: errorMessage(error) };
			}
			return { ...base, status: 'failed', error: errorMessage(error) };
		}

		return finalizePrepared({ handle, prepared });
	}

	async function runReleasePass(steer: CommittedSteer, startedAtMs: number): Promise<ReleaseResult | null> {
		// Urgent control-plane flush first (§2): the release commit must not
		// queue behind a half-open batching window.
		if (typeof seam.flushUrgent === 'function') {
			await seam.flushUrgent();
		}

		const handles = registry.takeReleaseSet(steer.parentConversationId, steer.parentRunId);
		if (handles.length === 0) {
			// No active ForegroundWaitSet: the child already finished (normal
			// result path) or this waitset was released earlier — no detach.
			return null;
		}

		const released: WaitReleaseRecord[] = [];
		const skipped: WaitReleaseRecord[] = [];
		for (const handle of handles) {
			const record = await releaseOne(handle);
			(record.status === 'released' ? released : skipped).push(record);
		}

		// Gate §6.2 is measured up to the committed release; the fence comes
		// after and is not part of the release latency.
		const elapsedMs = clock() - startedAtMs;

		let fence: FenceEngagement | undefined;
		if (released.length > 0) {
			fence = await engageFence({
				parentConversationId: steer.parentConversationId,
				reason: OWNER_INPUT_REASON,
				refs: released.map(record => {
					const prepared = record.prepared;
					if (prepared === undefined) {
						throw new Error(`released record ${record.waitId} without prepared outcome`);
					}
					return fenceRef(prepared);
				}),
			});
		}

		return {
			reason: OWNER_INPUT_REASON,
			parentConversationId: steer.parentConversationId,
			released,
			skipped,
			fence,
			elapsedMs,
		};
	}

	return {
		onCommittedSteer(steer: CommittedSteer): Promise<ReleaseResult | null> {
			if (
				steer === null ||
				typeof steer !== 'object' ||
				typeof steer.parentConversationId !== 'string' ||
				steer.parentConversationId.length === 0
			) {
				throw new TypeError('onCommittedSteer: steer.parentConversationId must be a non-empty string');
			}
			const startedAtMs = clock();
			return plane.run(CONTROL_PRIORITY.OWNER_INPUT, () => runReleasePass(steer, startedAtMs));
		},

		registerWait(registration: WaitRegistration): WaitHandle {
			return registry.register(registration, clock()).handle;
		},

		blockers(filter?: BlockerFilter): readonly ActiveBlocker[] {
			return registry.blockers(filter, clock());
		},

		recover(): Promise<RecoveryReport> {
			return plane.run(CONTROL_PRIORITY.OWNER_INPUT, async () => {
				// Recovery reads bounded active state: prepared-but-unfinalized
				// outcomes only, never the whole history (§3 recovery).
				const preparedList = await seam.listPreparedReleases();
				const finalized: ToolFinalization[] = [];
				const failed: RecoverFailure[] = [];
				const refsByConversation = new Map<string, DelegationFenceRef[]>();

				for (const prepared of preparedList) {
					try {
						const finalization = await seam.finalizeTool(prepared);
						finalized.push(finalization);
						const conversationRefs = refsByConversation.get(prepared.key.parentConversationId) ?? [];
						conversationRefs.push(fenceRef(prepared));
						refsByConversation.set(prepared.key.parentConversationId, conversationRefs);
						// Same-process crash window: settle the still-claimed waiter.
						const pending = pendingFinalization.get(prepared.waitId);
						if (pending !== undefined) {
							pendingFinalization.delete(prepared.waitId);
							pending.handle.settle({ kind: 'backgrounded', prepared, finalization });
						}
					} catch (error) {
						failed.push({
							operationId: prepared.operationId,
							waitId: prepared.waitId,
							error: errorMessage(error),
						});
					}
				}

				const fence: FenceEngagement[] = [];
				if (effectFence !== undefined) {
					for (const [conversationId, refs] of refsByConversation) {
						fence.push(await engageFence({ parentConversationId: conversationId, reason: OWNER_INPUT_REASON, refs }));
					}
				}
				return { finalized, failed, fence };
			});
		},
	};
}
