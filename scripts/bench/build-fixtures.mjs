#!/usr/bin/env node
// Builds the synthetic fixture corpus for the perf gates (Ф1 §355): the
// "messages" corpus (5.1 MB / 2061 messages shape), the "images" corpus
// (~100 MB of inline base64 image blocks), and opt-in giant synthetic files
// (1 GiB / 10 GiB) for the scaling rows. Everything is generated — per
// src/AGENTS.md no real sessions are ever committed or shipped.
//
// Usage:
//   node scripts/bench/build-fixtures.mjs messages [--out DIR] [--target-mb 5.1] [--count 2061]
//   node scripts/bench/build-fixtures.mjs images   [--out DIR] [--target-mb 99.7]
//   node scripts/bench/build-fixtures.mjs giant    [--out DIR] [--target-gb 1]
// Prints "fixture=<path> bytes=<n> lines=<n>" for scripting.
import { mkdirSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MIB = 1048576;

const fail = (message) => {
  console.error(`build-fixtures: ${message}`);
  process.exit(2);
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = value;
    } else {
      args._.push(token);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const kind = args._[0];
if (kind !== 'messages' && kind !== 'images' && kind !== 'giant') {
  fail('usage: build-fixtures.mjs <messages|images|giant> [--out DIR] [--target-mb N] [--count N] [--target-gb N]');
}
const outDir = typeof args.out === 'string' ? args.out : join(tmpdir(), 'mcode-bench-fixtures');
mkdirSync(outDir, { recursive: true });

const turnId = randomUUID();

/** One text message record of the canonical v2 history shape. */
function messageLine(index, textBytes) {
  const line = {
    message_id: `msg-bench-${String(index).padStart(8, '0')}`,
    turn_id: turnId,
    message: {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: 'm'.repeat(Math.max(16, textBytes)) }],
      timestamp: 1760755230000 + index * 1000,
    },
  };
  return JSON.stringify(line);
}

/** One image-block record: base64 of size `base64Bytes`. */
function imageLine(index, base64Bytes) {
  const line = {
    message_id: `msg-bench-${String(index).padStart(8, '0')}`,
    turn_id: turnId,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: `screenshot ${index}` },
        { type: 'image', data: 'A'.repeat(base64Bytes) },
      ],
      timestamp: 1760755230000 + index * 1000,
    },
  };
  return JSON.stringify(line);
}

/** Streams lines until the target byte size is reached; returns { bytes, lines }. */
function build(targetBytes, makeLine, outputPath) {
  const stream = createWriteStream(outputPath);
  let bytes = 0;
  let lines = 0;
  while (bytes < targetBytes) {
    const line = makeLine(lines);
    stream.write(line + '\n');
    bytes += Buffer.byteLength(line) + 1;
    lines += 1;
  }
  return new Promise((resolve, reject) => {
    stream.end(() => resolve({ bytes: statSync(outputPath).size, lines }));
    stream.on('error', reject);
  });
}

const targetMb = Number(args['target-mb'] ?? (kind === 'images' ? 99.7 : 5.1));
const targetGb = Number(args['target-gb'] ?? 1);
const targetBytes = kind === 'giant' ? Math.round(targetGb * 1024 * MIB) : Math.round(targetMb * MIB);
const outputPath = join(outDir, `${kind}-${targetBytes}.jsonl`);

if (kind === 'messages') {
  // 2061 messages of ~2.5 KB text each => the 5.1 MB / 2061-message corpus.
  const count = Number(args.count ?? 2061);
  const perMessageBytes = Math.max(16, Math.floor(targetBytes / count) - 64);
  const built = await buildWithCount(outputPath, count, (index) => messageLine(index, perMessageBytes));
  console.log(`fixture=${outputPath} bytes=${built.bytes} lines=${built.lines}`);
} else if (kind === 'images') {
  // ~100 MB of ~64 KB base64 image blocks: the picture-heavy session shape.
  const perImageBytes = 64 * 1024;
  const built = await build(targetBytes, (index) => imageLine(index, perImageBytes), outputPath);
  console.log(`fixture=${outputPath} bytes=${built.bytes} lines=${built.lines}`);
} else {
  const built = await build(targetBytes, (index) => messageLine(index, 4096), outputPath);
  console.log(`fixture=${outputPath} bytes=${built.bytes} lines=${built.lines}`);
}

/** Fixed-count builder: writes exactly `count` lines (the corpus shape is pinned). */
async function buildWithCount(outputPath, count, makeLine) {
  const stream = createWriteStream(outputPath);
  let bytes = 0;
  for (let index = 0; index < count; index++) {
    const line = makeLine(index);
    stream.write(line + '\n');
    bytes += Buffer.byteLength(line) + 1;
  }
  return new Promise((resolve, reject) => {
    stream.end(() => resolve({ bytes: statSync(outputPath).size, lines: count }));
    stream.on('error', reject);
  });
}

writeFileSync(join(outDir, 'README.txt'), 'Synthetic bench fixtures (src/AGENTS.md: never real sessions).\n');
