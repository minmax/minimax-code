/**
 * Delegation steering composition for the turn-system (steering-design-sol.md
 * §2–§4, §7 node `mcode-reactive-delegation-control`). This module is the
 * SINGLE wiring point that connects the wave-3 steering packages to the
 * turn-system runtime:
 *
 * - `@mavis/durable-seam` — the wait-outcome authority over the wave-1
 *   sqlite-zstd backend (T_accept / T_release / T_complete: ONE durable
 *   record per outcome);
 * - `@mavis/delegation-supervisor` — child ownership; releases route through
 *   the same seam (the supervisor projects seam-owned decisions, it never
 *   writes a second copy), plus the §4 fence-disengage on terminal facts;
 * - `@mavis/steering-control` — the reactive committed-steer release over
 *   the {@link createDurableSeamControlSeam} adapter, with the supervisor's
 *   projection synced inside the release commit;
 * - `@mavis/input-delivery` — the committed-state projection of the owner
 *   input line (`saving → saved → admitted → terminal`).
 *
 * The composition exposes the flows the turn-system drives:
 * {@link DelegationSteeringComposition.acceptOwnerInput} (Enter, §2.2),
 * {@link DelegationSteeringComposition.spawnDelegation} +
 * {@link DelegationSteeringComposition.registerWait} (T_spawn, §2.1) and
 * {@link DelegationSteeringComposition.onCommittedSteer} (the release
 * reaction, §2.3) — the surface acceptance gate §6.2 ("Enter → старт
 * следующего parent provider request") and the in-process e2e (§6.9)
 * measure against. It is NOT a second execution loop: it owns no scheduling
 * and no provider I/O — the turn-system calls it and then starts the next
 * provider request itself.
 *
 * @module
 */

import {
	DurableSeam,
	sqliteZstdDurableLogPort,
	type AcceptOwnerInputResult,
	type JsonValue as SeamJsonValue,
} from '@mavis/durable-seam';
import {
	DelegationSupervisor,
	sqliteZstdDelegationLog,
	type ChildSpec,
	type DelegationView,
	type EffectFenceDisengage,
	type FenceDisengageRequest,
	type SpawnDelegationResult,
} from '@mavis/delegation-supervisor';
import {
	createDurableSeamControlSeam,
	createReactiveControl,
	type CommittedSteer,
	type DelegationControlSeam,
	type EffectFence,
	type FenceDisengagement,
	type ReleaseResult,
	type ReactiveDelegationControl,
	type WaitHandle,
	type WaitRegistration,
} from '@mavis/steering-control';
import { createDeliveryIndex, type DeliveryIndex, type DeliveryRouteTarget } from '@mavis/input-delivery';

/** Structural surface of the wave-1 sqlite-zstd backend the composition runs on. */
export interface SteeringBackendLike {
	/** `appendBatch(drafts)` — the atomic multi-entry commit of the backend. */
	appendBatch(entries: readonly unknown[]): Promise<unknown>;
	/** Point read by entry id. */
	getEntry(entryId: string): unknown;
	/** Windowed delta read with a completeness verdict. */
	readDeltaChecked(afterSeq: number, limitBytes: number): unknown;
	/** Last committed sequence; 0 when empty. */
	readonly head: number;
	/** Uncompressed byte cap of ONE batch. */
	readonly maxBatchUncompressedBytes: number;
}

/** Options of {@link createDelegationSteeringComposition}. */
export interface DelegationSteeringCompositionOptions {
	/** The durable backend (wave-1 sqlite-zstd) the whole stack commits to. */
	readonly backend: SteeringBackendLike;
	/**
	 * The permission gateway's effect fence (§4): `engage` is called by the
	 * reactive control after a committed release; `disengage` — by the
	 * supervisor after PROVEN child terminal facts. Optional: without it the
	 * fence steps are reported as failed/absent and never block a release.
	 */
	readonly effectFence?: EffectFence;
	/** Bound of one ForegroundWaitSet (see steering-control). */
	readonly maxWaitsPerRound?: number;
}

/** The wired steering stack the turn-system drives. */
export interface DelegationSteeringComposition {
	/** The wait-outcome authority (T_accept / T_release / T_complete records). */
	readonly seam: DurableSeam;
	/** Child ownership; releases route through {@link DelegationSteeringComposition.seam}. */
	readonly supervisor: DelegationSupervisor;
	/** The reactive committed-steer release control. */
	readonly control: ReactiveDelegationControl;
	/** The committed-state projection of owner-input lines. */
	readonly delivery: DeliveryIndex;

	/**
	 * Enter (§2.2): the ONE committed accept (submission + receipt +
	 * delivery index). Reflects the `saved` fact into the delivery
	 * projection on a fresh commit; the caller owns the `saving` row
	 * registration (it draws the optimistic line before calling).
	 */
	acceptOwnerInput(input: {
		readonly conversationId: string;
		readonly requestId: string;
		readonly content: unknown;
		readonly whenBusy: 'steer' | 'followUp';
		readonly actor?: string;
		readonly sourceConversationId?: string;
		readonly routeTarget?: DeliveryRouteTarget;
	}): Promise<Pick<AcceptOwnerInputResult, 'status' | 'inputEntryId' | 'commitSeq' | 'submissionId'>>;

	/** T_spawn (§2.1): supervisor + child conversation + foreground wait. */
	spawnDelegation(request: {
		readonly parentConversationId: string;
		readonly parentRunId: string;
		readonly toolCallId: string;
		readonly childSpec?: Record<string, unknown>;
	}): Promise<SpawnDelegationResult>;

	/**
	 * Registers the foreground wait of a spawned delegation with the
	 * reactive control, under the spawn's durable waitId and version.
	 */
	registerWait(spawn: SpawnDelegationResult, request: {
		readonly parentConversationId: string;
		readonly parentRunId: string;
		readonly toolCallId: string;
	}): WaitHandle;

	/** The committed-steer release reaction (§2.3); `null` when nothing blocks. */
	onCommittedSteer(steer: CommittedSteer): Promise<ReleaseResult | null>;

	/** Startup/crash recovery (§3): reproduce prepared outcomes, re-engage fences. */
	recover(): Promise<void>;

	/** Supervisor projection sync for a wait decided outside this process. */
	syncWaitDecision(waitId: string): Promise<DelegationView | undefined>;

	/** Close the supervisor (the backend remains caller-owned). */
	close(): Promise<void>;
}

/**
 * Wire the steering stack over one backend. Every release — control-driven
 * or supervisor-driven — converges on the seam's single
 * `mcode.delegation.backgrounded` record per waitId; the supervisor's index
 * document is a projection of that record, synced inside the release ack.
 */
export async function createDelegationSteeringComposition(
	options: DelegationSteeringCompositionOptions,
): Promise<DelegationSteeringComposition> {
	// The backend instance upholds both structural ports (the seam storage
	// port and the supervisor log port); the composition receives it as the
	// narrow `SteeringBackendLike` and hands it over as the documented
	// structural shapes — the wave-1 backend satisfies both as-is.
	const backend = options.backend as unknown as Parameters<typeof sqliteZstdDurableLogPort>[0];
	const seam = await DurableSeam.open(sqliteZstdDurableLogPort(backend));
	const supervisor = await DelegationSupervisor.open({
		log: sqliteZstdDelegationLog(backend as unknown as Parameters<typeof sqliteZstdDelegationLog>[0]),
		waitSeam: seam,
		effectFence: supervisorDisengage(options.effectFence),
	});
	const baseSeamControl: DelegationControlSeam = createDurableSeamControlSeam(seam);
	const control = createReactiveControl(
		{
			prepareRelease: async (request) => {
				const prepared = await baseSeamControl.prepareRelease(request);
				// One release → both stores converge before the ack: the
				// supervisor projects the seam-owned decision (never a second
				// record — its document is a different entry kind).
				await supervisor.syncWaitDecision(request.wait.waitId);
				return prepared;
			},
			finalizeTool: (prepared) => baseSeamControl.finalizeTool(prepared),
			listPreparedReleases: (query) => baseSeamControl.listPreparedReleases(query),
			flushUrgent: baseSeamControl.flushUrgent?.bind(baseSeamControl),
		},
		{ effectFence: options.effectFence, maxWaitsPerRound: options.maxWaitsPerRound },
	);
	const delivery = createDeliveryIndex();

	return {
		seam,
		supervisor,
		control,
		delivery,

		async acceptOwnerInput(input) {
			const accepted = await seam.acceptOwnerInput({
				conversationId: input.conversationId,
				requestId: input.requestId,
				content: input.content as SeamJsonValue,
				whenBusy: input.whenBusy,
				actor: input.actor,
				sourceConversationId: input.sourceConversationId,
				route: 'turn-system',
			});
			return {
				status: accepted.status,
				inputEntryId: accepted.inputEntryId,
				commitSeq: accepted.commitSeq,
				submissionId: accepted.submissionId,
			};
		},

		spawnDelegation(request) {
			return supervisor.spawnDelegation({
				parentConversationId: request.parentConversationId,
				parentRunId: request.parentRunId,
				toolCallId: request.toolCallId,
				childSpec: (request.childSpec ?? {}) as ChildSpec,
			});
		},

		registerWait(spawn, request) {
			const registration: WaitRegistration = {
				parentConversationId: request.parentConversationId,
				parentRunId: request.parentRunId,
				toolCallId: request.toolCallId,
				stateVersion: spawn.stateVersion,
				delegationId: spawn.delegationId,
				waitId: spawn.waitId,
			};
			return control.registerWait(registration);
		},

		onCommittedSteer(steer) {
			return control.onCommittedSteer(steer);
		},

		async recover() {
			await control.recover();
		},

		syncWaitDecision(waitId) {
			return supervisor.syncWaitDecision(waitId);
		},

		async close() {
			await supervisor.dispose();
		},
	};
}

/**
 * Adapt the steering-control fence (engage + optional disengage) onto the
 * supervisor's terminal-transition disengage surface (§4/§5: the fence lifts
 * after a PROVEN terminal fact, never after a stop signal).
 */
function supervisorDisengage(fence: EffectFence | undefined): EffectFenceDisengage | undefined {
	if (fence === undefined || typeof fence.disengage !== 'function') return undefined;
	return {
		disengage(request: FenceDisengageRequest): Promise<FenceDisengagement> {
			return fence.disengage!(request);
		},
	};
}
