/**
 * @mavis/steering-control — reactive delegation control for foreground
 * steering (steering-design-sol.md §2–§4).
 *
 * @module
 */

export {
	CONTROL_PRIORITY,
	createControlPlane,
	type ControlPlane,
	type ControlPriority,
} from './control-plane.js';
export {
	errorMessage,
	isStaleStateVersionError,
	StaleStateVersionError,
	WaitSetOverflowError,
} from './errors.js';
export { createReactiveControl } from './reactive-control.js';
export {
	DELEGATION_EFFECT_BLOCKED,
	type ActiveBlocker,
	type BackgroundHandle,
	type BlockerFilter,
	type CommittedSteer,
	type DelegationControlSeam,
	type DelegationFenceRef,
	type EffectFence,
	type FenceEngageRequest,
	type FenceEngagement,
	type PreparedRelease,
	type PreparedReleaseQuery,
	type ReactiveControlOptions,
	type ReactiveDelegationControl,
	type RecoverFailure,
	type RecoveryReport,
	type ReleaseReason,
	type ReleaseRequest,
	type ReleaseResult,
	type ToolFinalization,
	type WaitHandle,
	type WaitKey,
	type WaitOutcome,
	type WaitRegistration,
	type WaitReleaseRecord,
	type WaitReleaseStatus,
} from './types.js';
export {
	DEFAULT_MAX_WAITS_PER_ROUND,
	DEFAULT_SETTLED_ARCHIVE_LIMIT,
	deriveWaitId,
	type ForegroundWaitSetRegistry,
	type InternalWaitHandle,
} from './wait-set.js';
