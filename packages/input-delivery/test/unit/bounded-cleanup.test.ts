// Bounded cleanup (steering-design-sol.md §3, document `mcode.input-delivery`):
// terminal rows leave the ACTIVE index in the committing transition; a small
// bounded LRU of tombstones keeps recent terminal rows addressable for late
// UI refreshes. Durable deduplication stays in the native submissions — the
// index never resurrects a terminal row as active.

import { describe, expect, it } from 'vitest';

import { DeliveryIndexError, createDeliveryIndex } from '../../src/index.js';
import type { DeliveryIndex } from '../../src/index.js';
import { actionIds, steerMeta } from './helpers.js';

/** Registers `inputId` and drives it to the given terminal state in two commits. */
function driveToTerminal(
	index: DeliveryIndex,
	inputId: string,
	terminal: 'answered' | 'withdrawn' | 'unanswered',
	seq: number,
): void {
	index.register(inputId, steerMeta({ requestId: `req-${inputId}` }));
	index.transition(inputId, 'saved', {
		submissionId: `sub-${inputId}`,
		receiptEntryId: `r-${inputId}`,
		commitSeq: seq,
	});
	if (terminal === 'withdrawn') {
		index.transition(inputId, 'withdrawn', { commitSeq: seq + 1 });
		return;
	}
	index.transition(inputId, 'admitted', { inputEntryId: `in-entry-${inputId}`, commitSeq: seq + 1 });
	if (terminal === 'answered') index.transition(inputId, 'answered', { commitSeq: seq + 2 });
	if (terminal === 'unanswered') index.transition(inputId, 'unanswered', { commitSeq: seq + 2 });
}

describe('terminal cleanup of the active index', () => {
	it('keeps only non-terminal rows active while tombstones stay addressable', () => {
		const index = createDeliveryIndex();
		driveToTerminal(index, 'in_1', 'answered', 10);
		driveToTerminal(index, 'in_2', 'unanswered', 20);
		index.register('in_3', steerMeta({ requestId: 'req-in_3' })); // still saving
		index.register('in_4', steerMeta({ requestId: 'req-in_4' }));
		index.transition('in_4', 'saved', { submissionId: 'sub-4', receiptEntryId: 'r-4', commitSeq: 30 });

		// Active = exactly the two non-terminal rows, in registration order.
		expect(index.active().map((row) => row.inputId)).toEqual(['in_3', 'in_4']);
		expect(index.has('in_1')).toBe(false);
		expect(index.has('in_2')).toBe(false);

		// Tombstones: terminal state, out of the index, ids still inspectable.
		const tombstone = index.get('in_1');
		expect(tombstone.state).toBe('answered');
		expect(tombstone.terminal).toBe(true);
		expect(tombstone.active).toBe(false);
		expect(tombstone.receipt).toEqual({ entryId: 'r-in_1', submissionId: 'sub-in_1' });
		expect(tombstone.inputEntryId).toBe('in-entry-in_1');
		expect(actionIds(tombstone)).toEqual([]);
		expect(index.get('in_2').state).toBe('unanswered');
	});

	it('drops an abandoned optimistic row through failed without a receipt', () => {
		const index = createDeliveryIndex();
		index.register('in_1', steerMeta());
		index.transition('in_1', 'failed', { reason: 'client-replaced', commitSeq: 1 });
		expect(index.active()).toEqual([]);
		expect(index.get('in_1').receipt).toBeNull();
	});
});

describe('the tombstone store is bounded', () => {
	it('evicts the least recently read tombstone beyond maxTerminalRetained', () => {
		const index = createDeliveryIndex({ maxTerminalRetained: 3 });
		driveToTerminal(index, 'in_1', 'answered', 10);
		driveToTerminal(index, 'in_2', 'answered', 20);
		driveToTerminal(index, 'in_3', 'answered', 30);
		driveToTerminal(index, 'in_4', 'answered', 40); // evicts in_1 (cap 3)

		expect(() => index.get('in_1')).toThrowError(DeliveryIndexError);
		expect(index.get('in_2').state).toBe('answered'); // LRU refresh: in_2 -> newest

		driveToTerminal(index, 'in_5', 'answered', 50); // evicts in_3 now, in_2 survives
		expect(() => index.get('in_3')).toThrowError(/unknown input/);
		expect(index.get('in_2').state).toBe('answered');
		expect(index.get('in_4').state).toBe('answered');
		expect(index.get('in_5').state).toBe('answered');

		// The evicted rows are gone for good — the durable records are the only
		// remaining authority, which is exactly the boundedness contract.
		expect(() => index.get('in_1')).toThrowError(DeliveryIndexError);
	});

	it('applies a default cap and rejects a malformed one', () => {
		const index = createDeliveryIndex();
		for (let i = 1; i <= 65; i += 1) {
			driveToTerminal(index, `in_${i}`, 'answered', i * 10);
		}
		// 65 terminal rows against the default cap of 64: the oldest is evicted.
		expect(() => index.get('in_1')).toThrowError(/unknown input/);
		expect(index.get('in_65').state).toBe('answered');

		expect(() => createDeliveryIndex({ maxTerminalRetained: -1 })).toThrowError(TypeError);
		expect(() => createDeliveryIndex({ maxTerminalRetained: 1.5 })).toThrowError(TypeError);
	});
});

describe('the index never resurrects terminal rows', () => {
	it('rejects re-registration of a terminal id (dedup lives in submissions)', () => {
		const index = createDeliveryIndex();
		driveToTerminal(index, 'in_1', 'answered', 10);

		// A redelivered input id is a replay of the original row: the durable
		// dedup of (conversationId, requestId) stays in the native submissions.
		expect(() => index.register('in_1', steerMeta())).toThrowError(/already registered/);
		expect(index.active()).toEqual([]);
	});

	it('refuses to mutate a retained tombstone through transitions', () => {
		const index = createDeliveryIndex({ maxTerminalRetained: 8 });
		driveToTerminal(index, 'in_1', 'withdrawn', 10);
		expect(() => index.transition('in_1', 'saved', { submissionId: 'x', receiptEntryId: 'y' })).toThrowError(
			/no longer active/,
		);
	});
});
