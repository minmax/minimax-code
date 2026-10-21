// Withdrawal semantics (steering-design-sol.md §5, abort and queued-cancel
// rows): a still-pending input can be withdrawn while its text stays
// recoverable from the durable receipt; an ALREADY ADMITTED input can never
// become "undelivered" — its answer may still end unanswered.

import { describe, expect, it } from 'vitest';

import { DeliveryIndexError, createDeliveryIndex } from '../../src/index.js';
import { acceptCommitted, actionIds, indexWithSavingRow, steerMeta } from './helpers.js';

describe('withdraw a still-pending input', () => {
	it('ends the row terminally, leaves the index and keeps the receipt linkage', () => {
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index); // owner stop while the steer is saved/queued
		expect(actionIds(index.get(inputId))).toContain('withdraw');

		index.transition(inputId, 'withdrawn', { reason: 'owner-stop', commitSeq: 8, atMs: 150 });

		// Terminal cleanup happened in the same transition.
		expect(index.active()).toEqual([]);
		expect(index.has(inputId)).toBe(false);

		const withdrawn = index.get(inputId);
		expect(withdrawn.state).toBe('withdrawn');
		expect(withdrawn.terminal).toBe(true);
		expect(withdrawn.active).toBe(false);
		expect(actionIds(withdrawn)).toEqual([]);
		// The projection holds NO payload; the text restore path points at the
		// durable receipt entry, which keeps the content after the inbox purge.
		expect(withdrawn.receipt).toEqual({ entryId: 'r1', submissionId: 'sub_1' });
		expect(withdrawn.delegationId).toBe('dlg_1');
		expect(withdrawn.history.at(-1)).toEqual({ state: 'withdrawn', atMs: 150, commitSeq: 8 });
	});

	it('is also available from the queued state', () => {
		const index = createDeliveryIndex();
		index.register('in_1', steerMeta({ whenBusy: 'followUp' }));
		index.transition('in_1', 'queued', { commitSeq: 3 });
		index.transition('in_1', 'withdrawn', { reason: 'owner-stop', commitSeq: 4 });
		expect(index.get('in_1').state).toBe('withdrawn');
		expect(index.active()).toEqual([]);
	});
});

describe('withdrawal after admission is rejected', () => {
	it('keeps the admitted input delivered; the answer path stays open', () => {
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index);
		index.transition(inputId, 'admitted', { inputEntryId: 'in-entry-1', commitSeq: 9 });

		// An admitted input is part of the context; "undelivered" does not exist.
		expect(() => index.transition(inputId, 'withdrawn', { reason: 'late', commitSeq: 10 })).toThrowError(
			DeliveryIndexError,
		);
		const still = index.get(inputId);
		expect(still.state).toBe('admitted');
		expect(still.terminal).toBe(false);
		expect(index.has(inputId)).toBe(true);
		// §4: the copy-to-child stays available even after admission; withdrawing is gone.
		expect(actionIds(still)).toEqual(['stop-delegate', 'copy-to-child', 'task-query', 'task-output']);

		// The answer may still be a normal one…
		index.transition(inputId, 'answered', { commitSeq: 12 });
		expect(index.get(inputId).state).toBe('answered');

		// …or, when the run dies without answering, unanswered.
		const other = createDeliveryIndex();
		other.register('in_2', steerMeta({ requestId: 'req-2' }));
		other.transition('in_2', 'saved', {
			submissionId: 'sub_2',
			receiptEntryId: 'r2',
			commitSeq: 20,
		});
		other.transition('in_2', 'admitted', { inputEntryId: 'in-entry-2', commitSeq: 21 });
		other.transition('in_2', 'unanswered', { reason: 'run-aborted', commitSeq: 22 });
		expect(other.get('in_2').state).toBe('unanswered');
		expect(other.active()).toEqual([]);
	});
});

describe('the optimistic saving row', () => {
	it('offers no durable withdrawal and dies through failed', () => {
		const { index, inputId } = indexWithSavingRow();

		// Nothing is committed: a native submission.abort() has no target, so
		// the state machine rejects the withdrawal…
		expect(() => index.transition(inputId, 'withdrawn')).toThrowError(DeliveryIndexError);
		expect(index.has(inputId)).toBe(true);

		// …and the storage error path removes the row instead (the text stays
		// in the editor; no accepted state exists).
		index.transition(inputId, 'failed', { reason: 'queue-overflow', commitSeq: 2 });
		expect(index.active()).toEqual([]);
		expect(index.get(inputId).state).toBe('failed');
		expect(index.get(inputId).receipt).toBeNull();
	});
});
