/**
 * The desktop Bash seam delegates the persisted complete output to the
 * optional spill hook: a returned reference replaces the temp-file path in the
 * model-visible notice and continuation hint, and a failing or absent hook
 * keeps the previous full-output behavior.
 */

import { readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalBashTool } from './local-pi-tools.js';
import type { LocalRuntimeToolContext } from './types.js';

const SESSION_CTX = {
  sessionId: 'bash-spill-session',
  turnId: 'bash-spill-turn',
} satisfies LocalRuntimeToolContext;

describe('LocalBashTool — full-output spill delegation', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'bash-spill-'));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const largeOutputCommand = (): string => {
    const script = `for(let i=0;i<400;i++) console.log('row-'+i+'-'+'x'.repeat(90))`;
    return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
  };

  it('spills the complete output and surfaces the spill reference instead of the file path', async () => {
    const calls: string[] = [];
    const spill = {
      spill: async (payload: string) => {
        calls.push(payload);
        return 'cas://sha256/spilled';
      },
    };
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' }, undefined, undefined, spill);
    const result = await tool.execute(SESSION_CTX, { command: largeOutputCommand() });

    expect(calls).toHaveLength(1);
    const payload = calls[0] ?? '';
    expect(payload.split('\n').filter(Boolean)).toHaveLength(400);
    expect(payload).toContain('row-200-');

    expect(result.text).toContain('Full output: cas://sha256/spilled');
    expect(result.text).not.toContain('Full output: /');
    expect(result.details?.spill_reference).toBe('cas://sha256/spilled');
    const continuation = result.details
      ?.desktop_output_continuation as { continuation_hint?: { instruction?: string } };
    expect(continuation.continuation_hint?.instruction).toContain('cas://sha256/spilled');
  });

  it('falls back to the persisted file path when the hook returns undefined', async () => {
    const calls: string[] = [];
    const spill = {
      spill: async (payload: string) => {
        calls.push(payload);
        return undefined;
      },
    };
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' }, undefined, undefined, spill);
    const result = await tool.execute(SESSION_CTX, { command: largeOutputCommand() });

    expect(calls).toHaveLength(1);
    const fullPath = result.details?.fullOutputPath as string;
    expect(fullPath).toBeTruthy();
    expect(result.text).toContain(`Full output: ${fullPath}`);
    expect(result.details?.spill_reference).toBeUndefined();
    await expect(readFile(fullPath, 'utf8')).resolves.toContain('row-200-');
  });

  it('falls back to the persisted file path when the hook throws', async () => {
    const spill = {
      spill: async () => {
        throw new Error('cas offline');
      },
    };
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' }, undefined, undefined, spill);
    const result = await tool.execute(SESSION_CTX, { command: largeOutputCommand() });

    const fullPath = result.details?.fullOutputPath as string;
    expect(fullPath).toBeTruthy();
    expect(result.text).toContain(`Full output: ${fullPath}`);
    expect(result.details?.spill_reference).toBeUndefined();
  });

  it('does not spill untruncated output', async () => {
    const calls: string[] = [];
    const spill = {
      spill: async (payload: string) => {
        calls.push(payload);
        return 'cas://sha256/spilled';
      },
    };
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' }, undefined, undefined, spill);
    const result = await tool.execute(SESSION_CTX, { command: `printf 'short'` });

    expect(calls).toHaveLength(0);
    expect(result.text).toBe('short');
    expect(result.details?.spill_reference).toBeUndefined();
  });
});
