import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { casSpillRef as agentToolsCasSpillRef, parseCasSpillRef as agentToolsParseCasSpillRef } from '@mavis/agent-tools/truncation/cas-spill';
import { MINIMAX_M3_DIALECT } from '@mavis/wire-compiler';
import { parseCasSpillRef as v2ParseCasSpillRef } from '../../src/index.js';

// Cross-reading gate for the `cas://sha256/<digest>#<size>` contract. The
// reference format reaches the durable log of the new data path: spilled tool
// outputs (built by @mavis/agent-tools) must stay resolvable by the v2
// importer's readers, and vice versa — and the wire compiler's image
// placeholders build the same format so a compiled wire body never carries a
// link the readers would reject. All three packages now import the single
// definition from `@mavis/cas/cas-ref`; these assertions pin the WIRING — a
// package that drops the re-export or restates the format locally fails here.

describe('cas:// reference contract is shared across the wave packages', () => {
  it('a reference built by agent-tools parses in v2-adapter', () => {
    const reference = agentToolsCasSpillRef('a'.repeat(64), 1234);
    expect(reference).toBe(`cas://sha256/${'a'.repeat(64)}#1234`);

    const parsed = v2ParseCasSpillRef(reference);
    expect(parsed).toEqual({ sha256: 'a'.repeat(64), size: 1234 });
  });

  it('a reference built by v2-adapter parses in agent-tools', () => {
    const imageHookRef = `cas://sha256/${'b'.repeat(64)}#5`;
    const parsed = agentToolsParseCasSpillRef(imageHookRef);
    expect(parsed).toEqual({ sha256: 'b'.repeat(64), size: 5 });
  });

  it('a cas:// link built by the wire-compiler dialect parses in v2-adapter', () => {
    // The wire body never carries image bytes: the minimax-m3 dialect reduces
    // an inline base64 block to a deterministic `cas://` placeholder link.
    // That link is part of the compiled wire bytes, so it must be canonical.
    const base64 = Buffer.from('wire-compiler-image-payload').toString('base64');
    const normalized = MINIMAX_M3_DIALECT.normalizeEntry({
      kind: 'text',
      role: 'user',
      content: [{ type: 'image', data: base64, mimeType: 'image/png' }],
    } as never) as { content: Array<{ type: string; text: string }> };

    const placeholder = normalized.content[0]?.text ?? '';
    expect(placeholder).toMatch(/^\[image: cas:\/\/sha256\//u);
    const link = placeholder.slice('[image: '.length, -1);

    const parsed = v2ParseCasSpillRef(link);
    expect(parsed).not.toBeNull();
    const expectedBytes = Buffer.from(base64, 'base64');
    expect(parsed!.sha256).toBe(createHash('sha256').update(expectedBytes).digest('hex'));
    expect(parsed!.size).toBe(expectedBytes.length);
    // And the agent-tools reader agrees on the very same link.
    expect(agentToolsParseCasSpillRef(link)).toEqual(parsed);
  });

  it('both packages reject foreign references identically', () => {
    for (const foreign of ['file:///tmp/blob', 'cas://sha256/nothex#1', `cas://sha256/${'c'.repeat(64)}`]) {
      expect(agentToolsParseCasSpillRef(foreign)).toBeNull();
      expect(v2ParseCasSpillRef(foreign)).toBeNull();
    }
  });
});
