/**
 * Streaming fixture scanner for the session-path benches.
 *
 * Reads a JSONL fixture in bounded chunks (constant RAM regardless of file
 * size), counts the lines, and optionally retains the LAST `keepLast` lines —
 * the "fixed window" the new context path materializes on open.
 */

import { createReadStream } from 'node:fs';

/**
 * Streams the fixture; resolves `{ totalLines, lastLines, bytes }` where
 * `lastLines` holds at most `keepLast` trailing lines in file order.
 */
export function scanFixture(fixturePath, keepLast) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(fixturePath, { encoding: 'utf8' });
    let tail = '';
    const lastLines = [];
    let totalLines = 0;
    let bytes = 0;
    const pushLine = (line) => {
      totalLines += 1;
      if (!Number.isInteger(keepLast) || keepLast < 1) return;
      lastLines.push(line);
      if (lastLines.length > keepLast) lastLines.shift();
    };
    stream.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      tail += chunk;
      let newlineIndex = tail.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = tail.slice(0, newlineIndex).replace(/\r$/, '');
        tail = tail.slice(newlineIndex + 1);
        if (line.length > 0) pushLine(line);
        newlineIndex = tail.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (tail.trimEnd().length > 0) pushLine(tail.trimEnd());
      resolve({ totalLines, lastLines, bytes });
    });
    stream.on('error', reject);
  });
}

/** Forces GC when the bench runs with --expose-gc; a no-op otherwise. */
export function gc() {
  globalThis.gc?.();
}

/** Resident set size in MiB. */
export function rssMiB() {
  return process.memoryUsage().rss / 1048576;
}

/** Nearest-rank percentile of a sample list, in ms. */
export function percentileMs(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

/** Prints one machine-readable `metric=value` line (the benches' contract). */
export function metric(name, value) {
  const rounded = typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(3)) : value;
  console.log(`${name}=${rounded}`);
}
