import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ToolResult, ToolResultContent } from '@mavis/agent-core/tools';
import { openCas } from '@mavis/cas';

import { casSpillRef, createCasToolOutputSpill, parseCasSpillRef } from './cas-spill.js';
import { truncateToolResultText } from './tool-result.js';

// The CAS-backed spill: full outputs of truncated tool results are stored in
// the real content-addressed store, and the model keeps a resolvable
// `cas://` reference instead of the payload.

const directories: string[] = [];

function freshDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cas-spill-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function textResult(text: string, content: ToolResultContent[] = [{ type: 'text', text }]): ToolResult {
  return {
    tool_name: 'bash',
    text,
    content,
    details: {},
  };
}

describe('CAS tool-output spill', () => {
  it('stores the full output and returns a parseable reference', async () => {
    const root = freshDirectory();
    const cas = await openCas(root);
    const spill = createCasToolOutputSpill(cas);

    const payload = 'line\n'.repeat(500); // ~2.5 KB
    const reference = await spill.spill(payload);
    expect(reference).toBeDefined();

    const parsed = parseCasSpillRef(reference!);
    expect(parsed).not.toBeNull();
    expect(cas.has(parsed!.sha256)).toBe(true);

    const stored = await cas.get(parsed!.sha256);
    expect(stored.toString('utf8')).toBe(payload);
    expect(parsed!.size).toBe(Buffer.byteLength(payload, 'utf8'));
    expect(cas.pathFor(parsed!.sha256)).toContain(join(root, 'cas'));
  });

  it('wires into truncation so details.spill_reference points at the CAS blob', async () => {
    const root = freshDirectory();
    const cas = await openCas(root);
    const spill = createCasToolOutputSpill(cas);

    const payload = Array.from({ length: 100 }, (_, index) => `row-${String(index).padStart(4, '0')}-${'x'.repeat(60)}`).join('\n');
    const truncated = await truncateToolResultText(textResult(payload), {
      spill,
      maxLines: 10,
      maxBytes: 2048,
    });

    const reference = truncated.details?.spill_reference;
    expect(typeof reference).toBe('string');
    const parsed = parseCasSpillRef(reference as string);
    expect(parsed).not.toBeNull();
    expect(cas.has(parsed!.sha256)).toBe(true);
    expect((await cas.get(parsed!.sha256)).toString('utf8')).toBe(payload);
  });

  it('degrades to undefined when the store fails', async () => {
    const spill = createCasToolOutputSpill({
      putBytes: async () => {
        throw new Error('disk full');
      },
    });
    await expect(spill.spill('payload')).resolves.toBeUndefined();
  });

  it('parses only canonical references', () => {
    const reference = casSpillRef('a'.repeat(64), 1234);
    expect(parseCasSpillRef(reference)).toEqual({ sha256: 'a'.repeat(64), size: 1234 });
    expect(parseCasSpillRef('file:///tmp/blob')).toBeNull();
    expect(parseCasSpillRef('cas://sha256/nothex#1')).toBeNull();
  });
});
