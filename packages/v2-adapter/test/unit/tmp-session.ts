import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Builds one canonical JSONL history line for a synthetic envelope. */
export function envelopeLine(envelope: Record<string, unknown>): string {
  return JSON.stringify(envelope);
}

/** Basic user envelope factory used by the streaming tests. */
export function userEnvelope(messageId: string, text: string): Record<string, unknown> {
  return {
    message_id: messageId,
    turn_id: '3f7d9c2e-1a4b-4c8d-9e2f-5a6b7c8d9e01',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1760755230000 },
  };
}

/**
 * Creates a temporary session directory whose `messages.jsonl` holds the
 * given raw lines (joined with newlines plus a trailing newline).
 * Caller must dispose; disposal never throws.
 */
export async function writeTempSession(
  lines: readonly string[],
): Promise<{ dir: string; messagesPath: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'v2-adapter-test-'));
  const messagesPath = join(dir, 'messages.jsonl');
  await writeFile(messagesPath, `${lines.join('\n')}\n`, 'utf8');
  return { dir, messagesPath, dispose: () => rm(dir, { recursive: true, force: true }) };
}
