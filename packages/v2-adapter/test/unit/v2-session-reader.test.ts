import { execFile } from 'node:child_process';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  openV2Session,
  V2_MESSAGES_FILE,
  V2SessionFormatError,
  type V2Envelope,
} from '../../src/index.js';
import { envelopeLine, userEnvelope, writeTempSession } from './tmp-session.js';

const run = promisify(execFile);
const fixtureDir = fileURLToPath(new URL('../fixtures/v2-session', import.meta.url));

async function readFixtureEnvelopes(): Promise<V2Envelope[]> {
  const envelopes: V2Envelope[] = [];
  await openV2Session(fixtureDir).readEnvelopes((envelope) => {
    envelopes.push(envelope);
  });
  return envelopes;
}

describe('openV2Session', () => {
  it('streams every envelope of the fixture in file order', async () => {
    const envelopes = await readFixtureEnvelopes();
    expect(envelopes.map((envelope) => envelope.message_id)).toEqual([
      'msg-user-v1-0001',
      'msg-0002',
      'msg-0003',
      'msg-0004',
    ]);
    expect(envelopes.map((envelope) => envelope.message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
  });

  it('passes turn_config and history_artifact through as opaque records', async () => {
    const [first] = await readFixtureEnvelopes();
    expect(first?.turn_config).toEqual({
      system_prompt: 'You are a helpful coding agent.',
      model: { id: 'minimax-m3' },
    });
    expect(first?.history_artifact).toMatchObject({ schemaVersion: 1, generation: 1 });
  });

  it('exposes the messages.jsonl path inside the session directory', () => {
    expect(openV2Session(fixtureDir).messagesPath).toBe(join(fixtureDir, V2_MESSAGES_FILE));
  });

  it('rejects an empty session directory name', () => {
    expect(() => openV2Session('')).toThrow(TypeError);
  });

  it('stats reports the file size and the number of non-empty lines', async () => {
    const { bytes, lines } = await openV2Session(fixtureDir).stats();
    const expected = await stat(join(fixtureDir, V2_MESSAGES_FILE));
    expect(bytes).toBe(expected.size);
    expect(lines).toBe(4);
  });
});

describe('readEnvelopes streaming', () => {
  it('skips blank lines while numbering only real records', async () => {
    const session = await writeTempSession([
      '',
      envelopeLine(userEnvelope('msg-1', 'first')),
      '   ',
      envelopeLine(userEnvelope('msg-2', 'second')),
      '',
    ]);
    try {
      const reader = openV2Session(session.dir);
      const ids: string[] = [];
      await reader.readEnvelopes((envelope) => {
        ids.push(envelope.message_id);
      });
      expect(ids).toEqual(['msg-1', 'msg-2']);
      expect((await reader.stats()).lines).toBe(2);
    } finally {
      await session.dispose();
    }
  });

  // The writer stays open on purpose: a reader that materialized the whole
  // file before decoding would block on the FIFO forever and time out here.
  it.skipIf(process.platform === 'win32')(
    'delivers envelopes before the end of the file is reached',
    { timeout: 15_000 },
    async () => {
      const dir = await mkdtempSession();
      try {
        const fifo = join(dir, V2_MESSAGES_FILE);
        await run('mkfifo', [fifo]);
        const reader = openV2Session(dir);
        const ids: string[] = [];
        const reading = reader.readEnvelopes((envelope) => {
          ids.push(envelope.message_id);
        });
        // fs/promises keeps the blocking FIFO open off the event loop; it
        // resolves once the reader has opened the read end.
        const writer = await open(fifo, 'w');
        try {
          await writer.write(
            `${envelopeLine(userEnvelope('msg-1', 'first'))}\n${envelopeLine(userEnvelope('msg-2', 'second'))}\n`,
          );
          await vi.waitFor(() => expect(ids).toEqual(['msg-1', 'msg-2']), { timeout: 5_000 });
          await writer.write(
            `${envelopeLine(userEnvelope('msg-3', 'third'))}\n${envelopeLine(userEnvelope('msg-4', 'fourth'))}\n`,
          );
        } finally {
          await writer.close();
        }
        await reading;
        expect(ids).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
      } finally {
        await rmForce(dir);
      }
    },
  );

  it('parses a multi-megabyte line without truncation', async () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 0xa5);
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
      const envelopes: V2Envelope[] = [];
      await openV2Session(session.dir).readEnvelopes((envelope) => {
        envelopes.push(envelope);
      });
      const content = envelopes[0]?.message.content;
      expect(content).toHaveLength(2);
      const image = content?.[1];
      expect(image?.['type']).toBe('image');
      expect(Buffer.from(String(image?.['data']), 'base64').equals(payload)).toBe(true);
    } finally {
      await session.dispose();
    }
  });
});

describe('readEnvelopes validation', () => {
  it('reports malformed JSON with the line number and without the payload', async () => {
    const junk = `not-json-${'x'.repeat(4096)}`;
    const session = await writeTempSession([
      envelopeLine(userEnvelope('msg-1', 'first')),
      junk,
    ]);
    try {
      const error = await openV2Session(session.dir)
        .readEnvelopes(() => {})
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(V2SessionFormatError);
      const formatError = error as V2SessionFormatError;
      expect(formatError.lineNo).toBe(2);
      expect(formatError.message).toContain('invalid JSON');
      // The raw line must never leak into the diagnostic.
      expect(formatError.message).not.toContain(junk);
    } finally {
      await session.dispose();
    }
  });

  it.each([
    ['unknown envelope key', { message_id: 'msg-1', turn_id: 't', message: { role: 'user' }, extra: 1 }],
    ['message_id outside the canonical shape', { message_id: 'abc', turn_id: 't', message: { role: 'user' } }],
    ['empty turn_id', { message_id: 'msg-1', turn_id: '', message: { role: 'user' } }],
    ['message is not an object', { message_id: 'msg-1', turn_id: 't', message: 'user' }],
    ['message without role', { message_id: 'msg-1', turn_id: 't', message: { content: [] } }],
    ['content is not an array', { message_id: 'msg-1', turn_id: 't', message: { role: 'user', content: {} } }],
    [
      'content block is not an object',
      { message_id: 'msg-1', turn_id: 't', message: { role: 'user', content: ['text'] } },
    ],
    [
      'content block has no type',
      { message_id: 'msg-1', turn_id: 't', message: { role: 'user', content: [{ text: 'x' }] } },
    ],
  ])('rejects a session with %s at the offending line', async (_label, badEnvelope) => {
    const good = envelopeLine(userEnvelope('msg-0', 'first'));
    const bad = JSON.stringify(badEnvelope);
    const session = await writeTempSession([good, bad, good]);
    try {
      await expect(
        openV2Session(session.dir).readEnvelopes(() => {}),
      ).rejects.toMatchObject({ name: 'V2SessionFormatError', lineNo: 2 });
    } finally {
      await session.dispose();
    }
  });
});

async function mkdtempSession(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'v2-adapter-fifo-'));
}

async function rmForce(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
