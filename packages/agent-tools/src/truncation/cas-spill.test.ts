import { mkdtempSync, rmSync, writeFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { ToolResult, ToolResultContent } from '@mavis/agent-core/tools';
import { openCas } from '@mavis/cas';

import {
  CasSpillFatalError,
  casSpillRef,
  createCasToolOutputSpill,
  fileSpillFromHook,
  isCasSpillFatalError,
  parseCasSpillRef,
  STRING_SPILL_FILE_THRESHOLD_BYTES,
} from './cas-spill.js';
import { truncateToolResultText } from './tool-result.js';

const writeFileAsync = promisify(writeFile);

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

  it('reports every non-fatal degradation to the diagnostics channel', async () => {
    const issues: string[] = [];
    const spill = createCasToolOutputSpill(
      {
        putBytes: async () => {
          throw Object.assign(new Error('transient'), { code: 'EAGAIN' });
        },
      },
      (issue) => issues.push(`${issue.code}: ${issue.message}`),
    );
    await expect(spill.spill('payload')).resolves.toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('EAGAIN');
    expect(issues[0]).toContain('degrading');
  });

  it('refuses to degrade on fatal store errors: ENOSPC throws, never returns undefined', async () => {
    const failure = (): Error => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    const spill = createCasToolOutputSpill({
      putBytes: async () => {
        throw failure();
      },
      putFile: async () => {
        throw failure();
      },
      putBase64: async () => {
        throw failure();
      },
    });
    // The image path depends on this: an `undefined` here would put the
    // inline base64 payload back into the history log.
    await expect(spill.spillBase64('aGVsbG8=')).rejects.toThrow(CasSpillFatalError);
    await expect(spill.spillBase64('aGVsbG8=')).rejects.toThrow(/ENOSPC/);
    await expect(spill.spill('payload')).rejects.toThrow(CasSpillFatalError);
    await expect(spill.spillFile('/tmp/any-path')).rejects.toThrow(CasSpillFatalError);
    expect(isCasSpillFatalError(new Error('plain'))).toBe(false);
  });

  it('classifies the same fatal errno family as the v2 importer on every put entry point', async () => {
    for (const code of ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO']) {
      const spill = createCasToolOutputSpill({
        putBytes: async () => {
          throw Object.assign(new Error(code), { code });
        },
        putBase64: async () => {
          throw Object.assign(new Error(code), { code });
        },
        putFile: async () => {
          throw Object.assign(new Error(code), { code });
        },
      });
      await expect(spill.spillBase64('aGVsbG8=')).rejects.toThrow(CasSpillFatalError);
      await expect(spill.spill('payload')).rejects.toThrow(CasSpillFatalError);
      await expect(spill.spillFile('/tmp/any-path')).rejects.toThrow(CasSpillFatalError);
    }
  });

  it('fails truncation loudly instead of keeping an inline image on a fatal store error', async () => {
    // The gate from the wave invariant ("base64 is forbidden in the log from
    // the first commit"): putBytes fails with ENOSPC -> there is NO result
    // containing the inline base64, the externalization fails the result.
    // The text fits the limits on purpose: only the image path runs.
    const spill = createCasToolOutputSpill({
      putBytes: async () => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      },
      putBase64: async () => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      },
    });
    const image = { type: 'image' as const, data: 'aGVsbG8='.repeat(16384), mimeType: 'image/png' };
    const result: ToolResult = {
      tool_name: 'bash',
      text: 'tiny',
      content: [{ type: 'text', text: 'tiny' }, image],
      details: {},
    };
    await expect(truncateToolResultText(result, { spill })).rejects.toThrow(CasSpillFatalError);
    // A non-fatal store error keeps the documented tolerant degradation.
    const tolerant = createCasToolOutputSpill({
      putBytes: async () => {
        throw Object.assign(new Error('transient'), { code: 'EAGAIN' });
      },
      putBase64: async () => {
        throw Object.assign(new Error('transient'), { code: 'EAGAIN' });
      },
    });
    const degraded = await truncateToolResultText(result, { spill: tolerant });
    expect(degraded.content[1]).toBe(image);
  });

  it('rethrows a fatal error from the full-output text spill instead of losing the payload silently', async () => {
    const spill = createCasToolOutputSpill({
      putBytes: async () => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      },
    });
    const text = Array.from({ length: 5000 }, (_, index) => `row-${index}-${'x'.repeat(60)}`).join('\n');
    await expect(truncateToolResultText(textResult(text), { spill })).rejects.toThrow(/ENOSPC/);
  });

  it('prefers putBytes for small payloads and stages large ones through a chunked temp file', async () => {
    const putBytesPayloads: Buffer[] = [];
    const stagedFiles: Buffer[] = [];
    let putBytesCalls = 0;
    const spill = createCasToolOutputSpill({
      putBytes: async (data) => {
        putBytesCalls += 1;
        putBytesPayloads.push(Buffer.from(data));
        return { sha256: 'a'.repeat(64), size: data.length };
      },
      putFile: async (sourcePath) => {
        const bytes = await readFile(sourcePath);
        stagedFiles.push(bytes);
        return { sha256: 'b'.repeat(64), size: bytes.length };
      },
    });

    // Small payload: single encode into putBytes, no temp file.
    const small = await spill.spill('tiny payload');
    expect(small).toBe(`cas://sha256/${'a'.repeat(64)}#${Buffer.byteLength('tiny payload', 'utf8')}`);
    expect(putBytesCalls).toBe(1);
    expect(stagedFiles).toHaveLength(0);

    // Payload at the threshold: staged chunk-wise through putFile, and the
    // staged file holds exactly the UTF-8 payload bytes.
    const large = 'ж'.repeat(STRING_SPILL_FILE_THRESHOLD_BYTES); // 2 bytes/char in UTF-8
    const reference = await spill.spill(large);
    expect(reference).toBe(`cas://sha256/${'b'.repeat(64)}#${Buffer.byteLength(large, 'utf8')}`);
    expect(putBytesCalls).toBe(1);
    expect(stagedFiles).toHaveLength(1);
    expect(stagedFiles[0]?.toString('utf8')).toBe(large);
  });

  it('spills an on-disk file through the store-native putFile', async () => {
    const root = freshDirectory();
    const cas = await openCas(root);
    const spill = createCasToolOutputSpill(cas);
    const source = join(root, 'full-output.log');
    const payload = 'line\n'.repeat(500);
    await writeFileAsync(source, payload, 'utf8');

    const reference = await spill.spillFile(source);
    expect(reference).toBeDefined();
    const parsed = parseCasSpillRef(reference!);
    expect(parsed).not.toBeNull();
    expect(cas.has(parsed!.sha256)).toBe(true);
    expect((await cas.get(parsed!.sha256)).toString('utf8')).toBe(payload);
    expect(parsed!.size).toBe(Buffer.byteLength(payload, 'utf8'));
  });

  it('spillFile degrades to undefined when the store has no file-native put', async () => {
    const spill = createCasToolOutputSpill({
      putBytes: async (data) => ({ sha256: 'c'.repeat(64), size: data.length }),
    });
    await expect(spill.spillFile('/tmp/any-path')).resolves.toBeUndefined();
  });

  it('exposes the file path only through fileSpillFromHook for CAS-backed hooks', async () => {
    expect(fileSpillFromHook({ spill: async () => undefined })).toBeUndefined();
    const cas = await openCas(freshDirectory());
    expect(typeof fileSpillFromHook(createCasToolOutputSpill(cas))).toBe('function');
  });

  it('spillBase64 stores the decoded bytes with a digest over them', async () => {
    const root = freshDirectory();
    const cas = await openCas(root);
    const spill = createCasToolOutputSpill(cas);

    const reference = await spill.spillBase64('aGVsbG8='); // "hello"
    expect(reference).toBeDefined();
    const parsed = parseCasSpillRef(reference!);
    expect(parsed).not.toBeNull();
    expect(parsed!.size).toBe(5);
    expect((await cas.get(parsed!.sha256)).toString('utf8')).toBe('hello');
  });

  it('never stores the same image twice: identical base64 yields one blob', async () => {
    const root = freshDirectory();
    const cas = await openCas(root);
    const spill = createCasToolOutputSpill(cas);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

    const first = await spill.spillBase64(png);
    const second = await spill.spillBase64(png);
    expect(first).toBe(second);

    const parsed = parseCasSpillRef(first!);
    expect(parsed).not.toBeNull();
    // Both references resolve to the single deduplicated blob, byte-equal to
    // the decoded image.
    expect(await cas.hasAsync(parsed!.sha256)).toBe(true);
    expect((await cas.get(parsed!.sha256)).equals(Buffer.from(png, 'base64'))).toBe(true);
    expect(parsed!.size).toBe(Buffer.from(png, 'base64').byteLength);
  });

  it('spillBase64 falls back to putBytes when the store has no base64 put', async () => {
    const decoded: Buffer[] = [];
    const spill = createCasToolOutputSpill({
      putBytes: async (data) => {
        decoded.push(Buffer.from(data));
        return { sha256: 'c'.repeat(64), size: data.length };
      },
    });
    const reference = await spill.spillBase64('aGVsbG8=');
    expect(reference).toBe(`cas://sha256/${'c'.repeat(64)}#5`);
    expect(decoded.map((buffer) => buffer.toString('utf8'))).toEqual(['hello']);
  });

  it('parses only canonical references', () => {
    const reference = casSpillRef('a'.repeat(64), 1234);
    expect(parseCasSpillRef(reference)).toEqual({ sha256: 'a'.repeat(64), size: 1234 });
    expect(parseCasSpillRef('file:///tmp/blob')).toBeNull();
    expect(parseCasSpillRef('cas://sha256/nothex#1')).toBeNull();
  });
});
