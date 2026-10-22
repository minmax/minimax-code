/**
 * Audit/control exclusion and placed-entry dedup (steering D+C contract,
 * node `mcode-input-delivery-status`):
 * - `mcode.*` audit/control kinds never reach the provider payload;
 * - the placed entry (`mcode.owner-input.placed`) lands exactly once per
 *   `inputEntryId`, even when a recovery artifact appended it twice.
 */

import { describe, expect, it } from 'vitest';

import {
  assemblePayload,
  convertEntry,
  isAuditControlKind,
  isVisibleControlKind,
} from '../../src/index.js';
import { makeEntry, resetEntrySeq, userEntry } from './helpers.js';

describe('audit/control exclusion', () => {
  it('classifies every mcode.* kind as audit except the model-visible two', () => {
    expect(isAuditControlKind('mcode.owner-input.received')).toBe(true);
    expect(isAuditControlKind('mcode.delegation.backgrounded')).toBe(true);
    expect(isAuditControlKind('mcode.delegation.completed')).toBe(true);
    expect(isAuditControlKind('mcode.delegation.stop-requested')).toBe(true);
    expect(isAuditControlKind('mcode.some-future-app-kind')).toBe(true);
    expect(isAuditControlKind('mcode.owner-input.placed')).toBe(false);
    expect(isAuditControlKind('mcode.system-reminder')).toBe(false);
    expect(isVisibleControlKind('mcode.owner-input.placed')).toBe(true);
    expect(isVisibleControlKind('mcode.system-reminder')).toBe(true);
    expect(isVisibleControlKind('mcode.owner-input.received')).toBe(false);
  });

  it('convertEntry returns null for audit/control kinds', () => {
    const receipt = makeEntry('r1', 'mcode.owner-input.received', {
      inputId: 'in_1',
      contentHash: 'abc',
    });
    const control = makeEntry('d1', 'mcode.delegation.backgrounded', {
      delegationId: 'dlg_1',
      reason: 'owner_input',
    });
    expect(convertEntry(receipt)).toBeNull();
    expect(convertEntry(control)).toBeNull();
  });

  it('assembles a payload without audit/control records but counts them', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      userEntry('u1', 'hello'),
      makeEntry('r1', 'mcode.owner-input.received', { inputId: 'in_1' }),
      makeEntry('d1', 'mcode.delegation.backgrounded', { delegationId: 'dlg_1' }),
      userEntry('u2', 'again'),
    ]);
    expect(payload.records.map((record) => record.entryId)).toEqual(['u1', 'u2']);
    expect(payload.stats.auditDropped).toBe(2);
    expect(payload.stats.placedDropped).toBe(0);
  });
});

describe('placed-entry dedup by inputEntryId', () => {
  const placedPayload = (inputEntryId: string, text: string) => ({
    inputEntryId,
    model: [{ role: 'user', content: text, timestamp: 5 }],
  });

  it('keeps the first placement and drops the duplicate', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      userEntry('u0', 'before'),
      makeEntry('p1', 'mcode.owner-input.placed', placedPayload('in_7', 'steer text')),
      // Recovery artifact: same input placed again after a crash between the
      // admission commit and the delivery-index update.
      makeEntry('p2', 'mcode.owner-input.placed', placedPayload('in_7', 'steer text')),
      userEntry('u3', 'after'),
    ]);

    const placed = payload.records.filter(
      (record) => record.kind === 'mcode.owner-input.placed',
    );
    expect(placed).toHaveLength(1);
    expect(placed[0]!.entryId).toBe('p1');
    expect(placed[0]!.inputEntryId).toBe('in_7');
    expect(placed[0]!.role).toBe('user');
    expect(placed[0]!.content).toBe('steer text');
    expect(payload.stats.placedDropped).toBe(1);
    expect(payload.stats.auditDropped).toBe(0);
  });

  it('keeps placements of different inputs', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      makeEntry('p1', 'mcode.owner-input.placed', placedPayload('in_1', 'one')),
      makeEntry('p2', 'mcode.owner-input.placed', placedPayload('in_2', 'two')),
    ]);
    expect(payload.records.filter((record) => record.role === 'user')).toHaveLength(2);
    expect(payload.stats.placedDropped).toBe(0);
  });

  it('dedups even when the duplicate carries different payload bytes', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      makeEntry('p1', 'mcode.owner-input.placed', placedPayload('in_9', 'original')),
      makeEntry('p2', 'mcode.owner-input.placed', placedPayload('in_9', 'corrupt copy')),
    ]);
    const users = payload.records.filter((record) => record.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]!.content).toBe('original');
    expect(payload.stats.placedDropped).toBe(1);
  });

  // Regression (wave-2 review): the dedup used to consume the slot at filter
  // time — BEFORE conversion. An undecodable first occurrence (broken payload,
  // `model: []`) therefore ate the `inputEntryId` slot, and the valid duplicate
  // was dropped as a repeat: "placed exactly once" degraded to "placed zero
  // times" and the user input never reached the provider.
  it('promotes a valid duplicate when the first placement is undecodable', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      makeEntry('p1', 'mcode.owner-input.placed', { inputEntryId: 'in_7', model: [] }),
      makeEntry('p2', 'mcode.owner-input.placed', placedPayload('in_7', 'steer text')),
    ]);

    const placed = payload.records.filter((record) => record.kind === 'mcode.owner-input.placed');
    expect(placed).toHaveLength(1);
    expect(placed[0]!.entryId).toBe('p2');
    expect(placed[0]!.content).toBe('steer text');
    // The failed try is counted, never silent; the promoted one is not a drop.
    expect(payload.stats.noProviderRecord).toBe(1);
    expect(payload.stats.placedDropped).toBe(0);
  });

  it('counts every failed placement when no occurrence converts', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      makeEntry('p1', 'mcode.owner-input.placed', { inputEntryId: 'in_8', model: [] }),
      makeEntry('p2', 'mcode.owner-input.placed', { inputEntryId: 'in_8', model: [] }),
    ]);
    expect(payload.records).toHaveLength(0);
    expect(payload.stats.noProviderRecord).toBe(2);
    expect(payload.stats.placedDropped).toBe(0);
  });

  // Regression (wave-2 review): an EMPTY inputEntryId used to pass the decoder
  // as a valid string and became the dedup key — every empty-linked placement
  // collapsed into one record, dropping distinct user inputs. The decoder now
  // applies the same non-empty discipline as `immediateSendBatchId`, so an
  // empty linkage means "no linkage" and the entry-id fallback dedups.
  it('does not collapse placements that carry an empty inputEntryId', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      makeEntry('p1', 'mcode.owner-input.placed', placedPayload('', 'first input')),
      makeEntry('p2', 'mcode.owner-input.placed', placedPayload('', 'second input')),
    ]);
    const users = payload.records.filter((record) => record.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[0]!.content).toBe('first input');
    expect(users[1]!.content).toBe('second input');
    expect(payload.stats.placedDropped).toBe(0);
  });

  it('dedups a placed entry without decodable inputEntryId by its entry id', () => {
    resetEntrySeq();
    const payload = assemblePayload([
      makeEntry('p1', 'mcode.owner-input.placed', {
        model: [{ role: 'user', content: 'no linkage', timestamp: 1 }],
      }),
      makeEntry('p2', 'mcode.owner-input.placed', {
        model: [{ role: 'user', content: 'no linkage', timestamp: 1 }],
      }),
    ]);
    expect(payload.records.filter((record) => record.role === 'user')).toHaveLength(2);
  });
});
