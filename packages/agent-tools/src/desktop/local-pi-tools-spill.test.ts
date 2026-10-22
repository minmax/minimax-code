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

import { openCas } from '@mavis/cas';

import { createCasToolOutputSpill, parseCasSpillRef } from '../truncation/cas-spill.js';
import type { ToolOutputSpill } from '../truncation/spill.js';
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

  it('hands the persisted file to a CAS spill without reading it back into the hook', async () => {
    const casRoot = await mkdtemp(join(tmpdir(), 'bash-spill-cas-'));
    try {
      const cas = await openCas(casRoot);
      const casSpill = createCasToolOutputSpill(cas);
      let stringSpillCalls = 0;
      const hook: ToolOutputSpill & {
        spillFile(path: string): Promise<string | undefined>;
      } = {
        spill: async (payload) => {
          stringSpillCalls += 1;
          return casSpill.spill(payload);
        },
        spillFile: (path) => casSpill.spillFile(path),
      };
      const tool = new LocalBashTool(workspace, undefined, { mode: 'off' }, undefined, undefined, hook);
      const result = await tool.execute(SESSION_CTX, { command: largeOutputCommand() });

      // The file-native path must win: the payload never travels through the
      // string spill, so no second full copy of the output is materialized.
      expect(stringSpillCalls).toBe(0);

      const reference = result.details?.spill_reference as string;
      const parsed = parseCasSpillRef(reference);
      expect(parsed).not.toBeNull();
      const fullPath = result.details?.fullOutputPath as string;
      const fileBytes = await readFile(fullPath);
      expect(parsed!.size).toBe(fileBytes.byteLength);
      expect((await cas.get(parsed!.sha256)).equals(fileBytes)).toBe(true);
    } finally {
      await rm(casRoot, { recursive: true, force: true });
    }
  });
});
