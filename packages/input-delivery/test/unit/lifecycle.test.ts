// Full lifecycle of ONE owner-input line (steering-design-sol.md §2):
// saving → saved → admitted → answered, the queued detour, committed replay
// semantics, fail-closed rejections, and the one-row-per-input invariant that
// keeps receipt/placed/control entries from becoming replies of their own.

import { describe, expect, it } from 'vitest';

import { DELIVERY_ACTION_LABELS, DeliveryIndexError, createDeliveryIndex } from '../../src/index.js';
import { acceptCommitted, actionIds, indexWithSavingRow, steerMeta } from './helpers.js';

describe('steer happy path: saving → saved → admitted → answered', () => {
	it('walks the lifecycle and ends as ONE linked terminal row', () => {
		const { index, inputId } = indexWithSavingRow();

		// Optimistic row: drawn by the client, not yet a committed fact.
		const saving = index.get(inputId);
		expect(saving.state).toBe('saving');
		expect(saving.committed).toBe(false);
		expect(saving.terminal).toBe(false);
		expect(saving.active).toBe(true);
		expect(saving.receipt).toBeNull();
		expect(saving.placement).toBeNull();
		expect(saving.linked).toBe(false);
		expect(saving.history).toEqual([{ state: 'saving', atMs: null, commitSeq: null }]);
		// Nothing is committed, so there is nothing to control durably yet.
		expect(actionIds(saving)).toEqual([]);

		// T_accept committed: submission + receipt + delivery metadata in one commit.
		acceptCommitted(index);
		const saved = index.get(inputId);
		expect(saved.state).toBe('saved');
		expect(saved.committed).toBe(true);
		expect(saved.receipt).toEqual({ entryId: 'r1', submissionId: 'sub_1' });
		expect(saved.placement).toBeNull();
		expect(saved.linked).toBe(false);
		expect(saved.delegationId).toBe('dlg_1');
		expect(saved.childConversationId).toBe('conv-child');
		// Quick actions as data, each with an explicit target.
		expect(actionIds(saved)).toEqual([
			'background',
			'stop-delegate',
			'withdraw',
			'copy-to-child',
			'task-query',
			'task-output',
		]);
		const byId = new Map(saved.actions.map((action) => [action.id, action]));
		expect(byId.get('withdraw')?.target).toEqual({ kind: 'input', inputId: 'in_1' });
		expect(byId.get('background')?.target).toEqual({ kind: 'delegation', delegationId: 'dlg_1' });
		expect(byId.get('copy-to-child')?.target).toEqual({
			kind: 'conversation',
			conversationId: 'conv-child',
		});

		// Native admission: the placed entry commits, receipt and placement
		// join by inputEntryId into the SAME row.
		index.transition(inputId, 'admitted', {
			inputEntryId: 'in-entry-1',
			placedEntryId: 'p1',
			commitSeq: 9,
			atMs: 200,
		});
		const admitted = index.get(inputId);
		expect(admitted.state).toBe('admitted');
		expect(admitted.inputEntryId).toBe('in-entry-1');
		expect(admitted.placement).toEqual({ inputEntryId: 'in-entry-1', entryId: 'p1' });
		expect(admitted.receipt).toEqual({ entryId: 'r1', submissionId: 'sub_1' });
		expect(admitted.linked).toBe(true);
		// «В фон» is stale after admission (the release already happened), and
		// an admitted input can never be withdrawn — but the delegate controls
		// and the copy stay.
		expect(actionIds(admitted)).toEqual(['stop-delegate', 'copy-to-child', 'task-query', 'task-output']);
		// Admission does not promise an answer; exactly one row exists so far.
		expect(index.active()).toHaveLength(1);

		// The parent answered: terminal, out of the active index.
		index.transition(inputId, 'answered', { commitSeq: 12, atMs: 300 });
		expect(index.active()).toEqual([]);
		expect(index.has(inputId)).toBe(false);
		const answered = index.get(inputId);
		expect(answered.state).toBe('answered');
		expect(answered.terminal).toBe(true);
		expect(answered.active).toBe(false);
		expect(actionIds(answered)).toEqual([]);
		expect(answered.history.map((record) => record.state)).toEqual([
			'saving',
			'saved',
			'admitted',
			'answered',
		]);
		expect(answered.history.map((record) => record.commitSeq)).toEqual([null, 7, 9, 12]);
	});

	it('keeps the row bounded to committed facts and never invents timestamps', () => {
		const index = createDeliveryIndex();
		index.register('in_1', steerMeta({ registeredMs: 5 }));
		expect(index.get('in_1').history).toEqual([{ state: 'saving', atMs: 5, commitSeq: null }]);
	});
});

describe('queued detour (followUp / one-at-a-time order)', () => {
	it('parks a committed input with a named blocker before admission', () => {
		const index = createDeliveryIndex();
		index.register('in_1', steerMeta({ whenBusy: 'followUp' }));
		index.transition('in_1', 'queued', {
			blocker: 'sibling tool still running',
			commitSeq: 3,
			atMs: 60,
		});

		const queued = index.get('in_1');
		expect(queued.state).toBe('queued');
		expect(queued.committed).toBe(true);
		expect(queued.blocker).toBe('sibling tool still running');
		// No delegation bound yet: only the pending-input control is offered.
		expect(actionIds(queued)).toEqual(['withdraw']);

		// A later committed control fact may refresh the named blocker.
		index.transition('in_1', 'queued', { blocker: 'permission wait', commitSeq: 3 });
		expect(index.get('in_1').blocker).toBe('permission wait');
		expect(index.get('in_1').history).toHaveLength(2); // replay added no state change

		index.transition('in_1', 'admitted', { inputEntryId: 'in-entry-1', commitSeq: 4 });
		expect(index.get('in_1').blocker).toBeNull();
	});

	it('can demote a saved steer to queued while admission waits', () => {
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index);
		index.transition(inputId, 'queued', { commitSeq: 8 });
		expect(index.get(inputId).state).toBe('queued');
		index.transition(inputId, 'admitted', { inputEntryId: 'in-entry-1', commitSeq: 9 });
		expect(index.get(inputId).state).toBe('admitted');
	});
});

describe('committed replay is idempotent', () => {
	it('accepts a redelivered fact without changing the row', () => {
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index);
		const before = index.get(inputId);

		// Crash-recovery redelivery of the same T_accept commit.
		acceptCommitted(index);
		expect(index.get(inputId)).toEqual(before);
		expect(index.get(inputId).history).toHaveLength(2);
	});

	it('rejects a replay whose linkage ids or commitSeq differ', () => {
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index);

		// Same state, different submission: a caller bug, not a new commit.
		expect(() =>
			index.transition(inputId, 'saved', {
				submissionId: 'sub_OTHER',
				receiptEntryId: 'r1',
				commitSeq: 7,
			}),
		).toThrowError(DeliveryIndexError);

		// Same state, different commit sequence: stale ordering.
		expect(() =>
			index.transition(inputId, 'saved', {
				submissionId: 'sub_1',
				receiptEntryId: 'r1',
				commitSeq: 8,
			}),
		).toThrowError(/commitSeq/);
		expect(index.get(inputId).state).toBe('saved');
	});

	it('rejects a replay that introduces or changes a binding fact', () => {
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index); // binds dlg_1 / conv-child at commitSeq 7

		// Saved replay with a rebound delegation: not a replay — a conflict.
		expect(() =>
			index.transition(inputId, 'saved', {
				submissionId: 'sub_1',
				receiptEntryId: 'r1',
				delegationId: 'dlg_B',
				commitSeq: 7,
			}),
		).toThrowError(/replayed saved fact carries delegation/);

		// Queued replay carrying a binding the row does not have: a same-state
		// fact with a new binding is not a replay, and the machine has no path
		// for it — fail closed instead of silently adopting it.
		const other = createDeliveryIndex();
		other.register('in_2', steerMeta({ requestId: 'req-2' }));
		other.transition('in_2', 'queued', { commitSeq: 3 });
		expect(() =>
			other.transition('in_2', 'queued', { delegationId: 'dlg_NEW', commitSeq: 3 }),
		).toThrowError(/replayed queued fact carries delegation/);
		expect(other.get('in_2').delegationId).toBeNull();

		// Identical bindings on the replay path stay accepted.
		index.transition(inputId, 'saved', {
			submissionId: 'sub_1',
			receiptEntryId: 'r1',
			delegationId: 'dlg_1',
			childConversationId: 'conv-child',
			commitSeq: 7,
		});
		expect(index.get(inputId).delegationId).toBe('dlg_1');
		expect(index.get(inputId).history).toHaveLength(2);
	});
});

describe('fail-closed rejections', () => {
	it('rejects transitions that contradict the committed lifecycle', () => {
		const { index, inputId } = indexWithSavingRow();

		// Admission without a committed accept, withdrawal of an optimistic
		// row, re-admission after admission — all caller bugs.
		expect(() => index.transition(inputId, 'admitted', { inputEntryId: 'in-entry-1' })).toThrowError(
			DeliveryIndexError,
		);
		expect(() => index.transition(inputId, 'withdrawn')).toThrowError(/not a committed state change/);

		acceptCommitted(index);
		index.transition(inputId, 'admitted', { inputEntryId: 'in-entry-1', commitSeq: 9 });
		expect(() => index.transition(inputId, 'withdrawn')).toThrowError(DeliveryIndexError);
		expect(() => index.transition(inputId, 'queued', { commitSeq: 10 })).toThrowError(DeliveryIndexError);

		index.transition(inputId, 'answered', { commitSeq: 12 });
		// Terminal states are final; a late duplicate must not rewrite history.
		expect(() => index.transition(inputId, 'admitted', { inputEntryId: 'in-entry-1' })).toThrowError(
			/no longer active/,
		);
		expect(index.get(inputId).state).toBe('answered');
	});

	it('rejects unknown inputs, duplicates and conflicting join keys', () => {
		const index = createDeliveryIndex();
		expect(() => index.get('missing')).toThrowError(DeliveryIndexError);
		expect(() => index.transition('missing', 'failed')).toThrowError(/unknown input/);

		index.register('in_1', steerMeta());
		expect(() => index.register('in_1', steerMeta())).toThrowError(/already registered/);

		// The join key first appears with the committed admission — the row
		// adopts it and receipt+placement become linked…
		acceptCommitted(index);
		expect(index.get('in_1').linked).toBe(false);
		index.transition('in_1', 'admitted', { inputEntryId: 'in-entry-1', commitSeq: 9 });
		expect(index.get('in_1').linked).toBe(true);

		// …and a replayed admission claiming ANOTHER placed entry is a
		// conflict: the placed entry appears exactly once per input.
		expect(() =>
			index.transition('in_1', 'admitted', { inputEntryId: 'in-entry-OTHER', commitSeq: 9 }),
		).toThrowError(/inputEntryId/);
		expect(index.get('in_1').placement?.inputEntryId).toBe('in-entry-1');
	});

	it('rejects a commitSeq that does not strictly advance', () => {
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index, inputId, { commitSeq: 7 });
		expect(() =>
			index.transition(inputId, 'admitted', { inputEntryId: 'in-entry-1', commitSeq: 7 }),
		).toThrowError(/not newer/);
	});
});

describe('rejected transitions are atomic (fail-closed, nothing leaks)', () => {
	it('discards a rejected queued fact entirely and accepts the corrected retry', () => {
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index); // binds dlg_1 at commitSeq 7

		// The fact carries a rebound delegation (conflict), a poison blocker
		// and a fresh commitSeq — ALL of it must be discarded together.
		expect(() =>
			index.transition(inputId, 'queued', {
				delegationId: 'dlg_OTHER',
				blocker: 'poison',
				commitSeq: 8,
				atMs: 120,
			}),
		).toThrowError(/rebind/);

		// Nothing leaked into the projection: no blocker, no rebind, no new
		// history entry.
		const row = index.get(inputId);
		expect(row.state).toBe('saved');
		expect(row.blocker).toBeNull();
		expect(row.delegationId).toBe('dlg_1');
		expect(row.history).toHaveLength(2);

		// And the commitSeq watermark did NOT advance: the corrected retry of
		// the same committed fact is accepted, not dismissed as stale forever
		// (crash-recovery replay contract).
		index.transition(inputId, 'queued', {
			delegationId: 'dlg_1',
			blocker: 'permission wait',
			commitSeq: 8,
		});
		expect(index.get(inputId).state).toBe('queued');
		expect(index.get(inputId).blocker).toBe('permission wait');
	});

	it('also discards a rejected admitted fact without adopting the join key', () => {
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index);

		// Simulated untyped caller: admission without the required inputEntryId
		// throws and must not advance the watermark; the retry then lands.
		expect(() =>
			index.transition(inputId, 'admitted', { commitSeq: 9 } as never),
		).toThrowError(TypeError);
		expect(() =>
			index.transition(inputId, 'admitted', { inputEntryId: 'in-entry-1', commitSeq: 9 }),
		).not.toThrow();
		expect(index.get(inputId).state).toBe('admitted');
		expect(index.get(inputId).inputEntryId).toBe('in-entry-1');
	});
});

describe('action vocabulary and frozen snapshots', () => {
	it('declares the full steering vocabulary, including «Остановить дерево»', () => {
		// The label is declared so the contract's action vocabulary is complete
		// (steering-design-sol.md §2)...
		expect(DELIVERY_ACTION_LABELS['stop-tree']).toBe('Остановить дерево');
		// ...but the per-input derivation does not emit it: a subtree stop
		// targets the delegation tree (the delegation supervisor's surface),
		// not one input line.
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index);
		expect(actionIds(index.get(inputId))).not.toContain('stop-tree');
	});

	it('hands out deep-frozen projections', () => {
		const { index, inputId } = indexWithSavingRow();
		acceptCommitted(index);
		const projection = index.get(inputId);
		expect(Object.isFrozen(projection)).toBe(true);
		expect(Object.isFrozen(projection.target)).toBe(true);
		expect(Object.isFrozen(projection.receipt)).toBe(true);
		expect(Object.isFrozen(projection.actions)).toBe(true);
		expect(Object.isFrozen(projection.actions[0])).toBe(true);
		expect(Object.isFrozen(projection.history)).toBe(true);
		expect(Object.isFrozen(projection.history[0])).toBe(true);
		// Strict mode (ESM): mutating a frozen snapshot throws instead of
		// silently writing into the caller's copy.
		expect(() => {
			(projection as { state: string }).state = 'answered';
		}).toThrow();
	});
});

describe('control entries never become rows', () => {
	it('absorbs receipt, placed and delegation facts into the inputs they belong to', () => {
		const index = createDeliveryIndex();
		index.register('in_1', steerMeta());
		index.register('in_2', steerMeta({ requestId: 'req-2', whenBusy: 'followUp' }));

		acceptCommitted(index); // receipt r1 + delegation facts for in_1
		index.transition('in_2', 'queued', { delegationId: 'dlg_1', commitSeq: 4 });

		// Exactly one row per input line — never one per entry.
		const rows = index.active();
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.inputId)).toEqual(['in_1', 'in_2']);

		// Entry ids of the receipt/placement are NOT addressable as rows: the
		// delegation backgrounded control and the receipt are phases of the
		// same command, merged into the input's row.
		expect(() => index.get('r1')).toThrowError(/unknown input/);
		expect(() => index.get('p1')).toThrowError(/unknown input/);
		expect(() => index.get('dlg_1')).toThrowError(/unknown input/);
	});
});
