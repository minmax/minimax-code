// Input delivery status: the committed-state projection of owner-input lines
// (`mcode-input-delivery-status`, steering-design-sol.md §2/§7).
//
// One row per input; receipt and placed entry joined by `inputEntryId`;
// control entries never become rows; quick actions as data; bounded active
// index with terminal cleanup. Runtime-dependency-free.

export { createDeliveryIndex } from './delivery-index.js';
export { DELIVERY_ACTION_LABELS, deriveDeliveryActions } from './actions.js';
export type { DeliveryActionSource } from './actions.js';
export {
	INITIAL_DELIVERY_STATE,
	TERMINAL_DELIVERY_STATES,
	assertDeliveryTransition,
	isTerminalDeliveryState,
} from './machine.js';
export { DeliveryIndexError } from './types.js';
export type {
	DeliveryAction,
	DeliveryActionId,
	DeliveryActionTarget,
	DeliveryAdmittedDetail,
	DeliveryIndex,
	DeliveryIndexErrorCode,
	DeliveryIndexOptions,
	DeliveryInputMeta,
	DeliveryPendingState,
	DeliveryPlacementFacts,
	DeliveryQueuedDetail,
	DeliveryReceiptFacts,
	DeliveryRouteTarget,
	DeliverySavedDetail,
	DeliveryState,
	DeliveryTerminalDetail,
	DeliveryTerminalState,
	DeliveryTransitionDetail,
	DeliveryTransitionRecord,
	DeliveryWhenBusy,
	Projection,
} from './types.js';
