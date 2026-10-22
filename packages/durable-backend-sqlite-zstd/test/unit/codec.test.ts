import * as zlib from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { decodeFrame, encodeFrame, isZstdSupported, resolveCodec } from '../../src/codec.js';

// Regression gate for the zstd detection (risk register final-architecture.md,
// risk 4: "zstd in node:zlib — verify on the exact 22.22.2"). On Node 22.22.2
// the ESM `node:zlib` namespace exposes the checksum flag ONLY through
// `zlib.constants` (`ZSTD_c_checksumFlag` === 201); the top-level
// `zlib.ZSTD_c_checksumFlag` is undefined. The detector read the top-level
// flag only, so every ESM runtime silently resolved `resolveCodec(undefined)`
// to gzip — zstd-per-batch never engaged. These tests pin the corrected
// detection on a runtime that actually ships the zstd bindings.

const runtimeHasZstdBindings = typeof zlib.zstdCompressSync === 'function';

describe('codec: zstd detection on the ESM zlib surface', () => {
  it.runIf(runtimeHasZstdBindings)('detects zstd when the runtime ships the bindings', () => {
    expect(isZstdSupported()).toBe(true);
  });

  it.runIf(runtimeHasZstdBindings)('resolves the automatic codec to zstd, never the silent gzip fallback', () => {
    // The preferred-codec-less resolution is the production path (the storage
    // worker compresses every batch through it off-thread).
    expect(resolveCodec(undefined).name).toBe('zstd');
    expect(resolveCodec().name).toBe('zstd');
  });

  it.runIf(runtimeHasZstdBindings)('documents the split flag surface this detection exists for', () => {
    // If a future Node moves the constant again, this assertion fails first
    // and points at the detector instead of at silent gzip batches.
    const surface = zlib as typeof zlib & { ZSTD_c_checksumFlag?: number };
    const flag = zlib.constants.ZSTD_c_checksumFlag ?? surface.ZSTD_c_checksumFlag;
    expect(typeof flag).toBe('number');
  });

  it.runIf(runtimeHasZstdBindings)('writes checksummed zstd frames: a flipped byte fails the frame', () => {
    const payload = Buffer.from('batch-payload\n'.repeat(1000), 'utf8');
    const envelope = encodeFrame('zstd', payload);

    const decoded = decodeFrame(envelope);
    expect(decoded.name).toBe('zstd');
    expect(decoded.data.equals(payload)).toBe(true);

    const torn = Buffer.from(envelope);
    torn[torn.length - 2] = (torn[torn.length - 2] ?? 0) ^ 0xff;
    expect(() => decodeFrame(torn)).toThrow(/decompression/);
  });

  it.skipIf(runtimeHasZstdBindings)(
    'still falls back to gzip when the runtime has no zstd bindings',
    () => {
      expect(isZstdSupported()).toBe(false);
      expect(resolveCodec(undefined).name).toBe('gzip');
    },
  );
});
