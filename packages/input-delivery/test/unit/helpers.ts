// Shared fixtures of the input-delivery suite.

import { createDeliveryIndex } from '../../src/index.js';
import type { DeliveryInputMeta, DeliveryIndex } from '../../src/index.js';

/** Metadata of a parent-steering input with overridable fields. */
export function steerMeta(overrides?: Partial<DeliveryInputMeta>): DeliveryInputMeta {
	return {
		requestId: 'req-1',
		conversationId: 'conv-parent',
		target: { conversationId: 'conv-parent', kind: 'parent' },
		whenBusy: 'steer',
		...overrides,
	};
}

/** Metadata of an explicit child-targeted input (child-steering, §4). */
export function childMeta(inputId: string, overrides?: Partial<DeliveryInputMeta>): DeliveryInputMeta {
	return steerMeta({
		requestId: `req-${inputId}`,
		target: { conversationId: 'conv-child', kind: 'child' },
		...overrides,
	});
}

/** An index with one registered parent-steering row `in_1` (still `saving`). */
export function indexWithSavingRow(): { index: DeliveryIndex; inputId: string } {
	const index = createDeliveryIndex();
	index.register('in_1', steerMeta());
	return { index, inputId: 'in_1' };
}

/** Drives `in_1` through the committed `saved` fact bound to a delegation. */
export function acceptCommitted(
	index: DeliveryIndex,
	inputId: string = 'in_1',
	overrides?: { commitSeq?: number },
): void {
	index.transition(inputId, 'saved', {
		submissionId: 'sub_1',
		receiptEntryId: 'r1',
		delegationId: 'dlg_1',
		childConversationId: 'conv-child',
		commitSeq: overrides?.commitSeq ?? 7,
		atMs: 100,
	});
}

/** Action ids of a projection, in derived order. */
export function actionIds(projection: { readonly actions: readonly { readonly id: string }[] }): string[] {
	return projection.actions.map((action) => action.id);
}
