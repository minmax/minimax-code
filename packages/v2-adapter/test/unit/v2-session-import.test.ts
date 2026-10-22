import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  openV2Session,
  V2_MESSAGES_FILE,
  type CasImportIssue,
  type V2Envelope,
  type V2ImportTarget,
} from '../../src/index.js';
import { envelopeLine, userEnvelope, writeTempSession } from './tmp-session.js';

const fixtureDir = fileURLToPath(new URL('../fixtures/v2-session', import.meta.url));
const FIXTURE_MESSAGE_IDS = ['msg-user-v1-0001', 'msg-0002', 'msg-0003', 'msg-0004'];

/** Collecting putEntry sink shared by the import tests. */
function collectingTarget(): V2ImportTarget & { entries: V2Envelope[] } {
  const entries: V2Envelope[] = [];
  return {
    entries,
    putEntry: async (envelope) => {
      entries.push(envelope);
    },
  };
}

describe('importTo', () => {
  it('passes every envelope through unchanged when image externalization is off (`cas: null`)', async () => {
    const reader = openV2Session(fixtureDir);
    const target = collectingTarget();
    // Image externalization is ON by default; `cas: null` is the documented
    // off switch (see `resolveImageHook`).
    const stats = await reader.importTo(target, { cas: null });

    const original: V2Envelope[] = [];
    await reader.readEnvelopes((envelope) => {
      original.push(envelope);
    });
    expect(target.entries).toEqual(original);
    expect(target.entries[2]?.message.content?.[1]).toEqual({
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    });

    const expected = await stat(join(fixtureDir, V2_MESSAGES_FILE));
    // The stats invariant (IC-F2-012): every image block is either migrated
    // or kept inline — with `cas: null` the single image block counts as
    // inline. `lastLine` is the resume cursor (VA-02).
    expect(stats).toEqual({
      bytes: expected.size,
      lines: 4,
      envelopes: 4,
      imageBlocks: 1,
      imagesMigrated: 0,
      imagesInline: 1,
      lastLine: 4,
    });
  });

  it('replaces image blocks with image_ref descriptors when the hook returns one', async () => {
    const target = collectingTarget();
    const seen: string[] = [];
    // Only a canonical `cas://` descriptor is substituted (IC-F2-011); the
    // hook, not the import, owns the descriptor format.
    const canonicalRef = `cas://sha256/${'9f2c1f6b'.repeat(8)}#70`;
    const stats = await openV2Session(fixtureDir).importTo(target, {
      onImage: async (base64) => {
        seen.push(base64);
        return canonicalRef;
      },
    });

    expect(seen).toEqual([
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ]);
    const content = target.entries[2]?.message.content;
    expect(content?.[0]).toEqual({ type: 'text', text: 'ok' });
    expect(content?.[1]).toEqual({ type: 'image_ref', blob: canonicalRef });
    // Everything but the replaced block stays byte-identical.
    expect(target.entries[2]?.message).toMatchObject({ toolCallId: 'call-1', toolName: 'read' });
    expect(stats.imagesMigrated).toBe(1);
    expect(stats.imagesInline).toBe(0);
    expect(stats.imageBlocks).toBe(1);
    expect(stats.envelopes).toBe(4);
  });

  it('keeps the block inline when the hook returns a non-canonical descriptor', async () => {
    const target = collectingTarget();
    const issues: CasImportIssue[] = [];
    const inlineData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    // A foreign descriptor would be unparsable downstream, so it is treated
    // exactly like a decline: the block stays inline and is counted (IC-F2-011).
    const stats = await openV2Session(fixtureDir).importTo(target, {
      onImage: async () => 'sha256:9f2c1f6b',
      onIssue: (issue) => issues.push(issue),
    });

    expect(target.entries[2]?.message.content?.[1]).toEqual({ type: 'image', data: inlineData });
    expect(stats).toMatchObject({ imageBlocks: 1, imagesMigrated: 0, imagesInline: 1 });
    expect(issues.map((issue) => issue.kind)).toEqual(['invalid-blob-ref']);
  });

  it('keeps image blocks inline when the hook declines', async () => {
    const target = collectingTarget();
    const inlineBlock = {
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    };
    const stats = await openV2Session(fixtureDir).importTo(target, {
      onImage: async () => undefined,
    });

    expect(target.entries[2]?.message.content?.[1]).toEqual(inlineBlock);
    expect(stats.imagesInline).toBe(1);
    expect(stats.imagesMigrated).toBe(0);
  });

  it('delivers envelopes to putEntry in file order and awaits each one', async () => {
    const target = collectingTarget();
    const events: string[] = [];
    await openV2Session(fixtureDir).importTo({
      putEntry: async (envelope) => {
        events.push(`start:${envelope.message_id}`);
        // Yield so a non-sequential implementation would interleave the marks.
        await Promise.resolve();
        events.push(`end:${envelope.message_id}`);
      },
    });
    expect(events).toEqual(
      FIXTURE_MESSAGE_IDS.flatMap((id) => [`start:${id}`, `end:${id}`]),
    );
  });

  it('propagates hook failures', async () => {
    const target = collectingTarget();
    await expect(
      openV2Session(fixtureDir).importTo(target, {
        onImage: async () => {
          throw new Error('cas unavailable');
        },
      }),
    ).rejects.toThrow('cas unavailable');
    // The hook throws while migrating the third envelope, so only the first
    // two reached the sink.
    expect(target.entries).toHaveLength(2);
  });

  it('propagates putEntry failures', async () => {
    let calls = 0;
    await expect(
      openV2Session(fixtureDir).importTo({
        putEntry: async () => {
          calls += 1;
          if (calls === 3) throw new Error('sink rejected entry 3');
        },
      }),
    ).rejects.toThrow('sink rejected entry 3');
    expect(calls).toBe(3);
  });

  it('migrates a multi-megabyte inline image without truncation', async () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    const base64 = payload.toString('base64');
    const session = await writeTempSession([
      envelopeLine({
        message_id: 'msg-big',
        turn_id: 'turn-big',
        message: {
          role: 'toolResult',
          content: [
            { type: 'text', text: 'screenshot' },
            { type: 'image', data: base64 },
          ],
          toolName: 'read',
          timestamp: 1760755232000,
        },
      }),
    ]);
    try {
      const target = collectingTarget();
      let hookedBase64: string | undefined;
      // The hook must return a canonical `cas://` descriptor for the block to
      // be replaced (IC-F2-011).
      const canonicalRef = `cas://sha256/${'bb'.repeat(32)}#${payload.length}`;
      const stats = await openV2Session(session.dir).importTo(target, {
        onImage: async (data) => {
          hookedBase64 = data;
          return canonicalRef;
        },
      });

      // The hook received the exact base64 payload (the CAS contract decodes
      // it with Buffer.from(base64, 'base64')).
      expect(typeof hookedBase64).toBe('string');
      expect(Buffer.from(hookedBase64 ?? '', 'base64').equals(payload)).toBe(true);
      expect(target.entries[0]?.message.content?.[1]).toEqual({
        type: 'image_ref',
        blob: canonicalRef,
      });
      expect(stats).toMatchObject({ lines: 1, envelopes: 1, imagesMigrated: 1 });
    } finally {
      await session.dispose();
    }
  });

  it('leaves envelopes without content or without images untouched', async () => {
    const session = await writeTempSession([
      envelopeLine({
        message_id: 'msg-plain',
        turn_id: 'turn-plain',
        message: { role: 'compactionSummary', summary: 'earlier turns' },
      }),
      envelopeLine(userEnvelope('msg-user', 'plain text')),
    ]);
    try {
      const target = collectingTarget();
      let hookCalls = 0;
      const stats = await openV2Session(session.dir).importTo(target, {
        onImage: async () => {
          hookCalls += 1;
          return 'sha256:unused';
        },
      });
      expect(hookCalls).toBe(0);
      expect(stats.imageBlocks).toBe(0);
      expect(target.entries[0]?.message).toMatchObject({ role: 'compactionSummary' });
      expect(target.entries[1]?.message.content?.[0]).toEqual({
        type: 'text',
        text: 'plain text',
      });
    } finally {
      await session.dispose();
    }
  });
});
