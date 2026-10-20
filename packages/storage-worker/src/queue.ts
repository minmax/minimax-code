/**
 * Byte-bounded admission queue with promise-based backpressure.
 *
 * The queue tracks the bytes of all entries that have been admitted but not
 * yet reported committed by the worker thread. `enqueue` resolves immediately
 * while there is capacity; once the ceiling is hit, the caller's promise is
 * parked FIFO-style and resolved in enqueue order as committed bytes are
 * released — entries are never dropped on overflow.
 *
 * @module
 */

import type { Entry } from './contracts.js';

interface ParkedEnqueue {
  bytes: number;
  admit(): void;
  reject(error: unknown): void;
}

export interface BoundedByteQueue {
  /** Bytes admitted but not yet released as committed. */
  readonly pendingBytes: number;
  /**
   * Accounts `entry.bytes` against the ceiling and invokes `onAdmit` (which
   * should hand the entry to the pump). Resolves immediately when there is
   * capacity; otherwise parks and resolves after enough committed bytes free
   * room, preserving enqueue order.
   */
  reserve(entry: Entry, onAdmit: (entry: Entry) => void): Promise<void>;
  /** Releases bytes of a committed batch and wakes parked enqueues in order. */
  release(bytes: number): void;
  /** Rejects every parked enqueue (used when the worker dies). */
  failAll(error: unknown): void;
}

export function createBoundedByteQueue(limitBytes: number): BoundedByteQueue {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    throw new RangeError(`queueBytes must be a positive finite number, got ${limitBytes}`);
  }
  let pendingBytes = 0;
  const parked: ParkedEnqueue[] = [];

  function admitHeadUntilFull(): void {
    for (let head = parked[0]; head && pendingBytes + head.bytes <= limitBytes; head = parked[0]) {
      parked.shift();
      head.admit();
    }
  }

  return {
    get pendingBytes(): number {
      return pendingBytes;
    },
    reserve(entry, onAdmit): Promise<void> {
      if (pendingBytes + entry.bytes > limitBytes) {
        return new Promise<void>((resolve, reject) => {
          parked.push({
            bytes: entry.bytes,
            admit: () => {
              pendingBytes += entry.bytes;
              onAdmit(entry);
              resolve();
            },
            reject,
          });
        });
      }
      pendingBytes += entry.bytes;
      onAdmit(entry);
      return Promise.resolve();
    },
    release(bytes): void {
      pendingBytes = Math.max(0, pendingBytes - bytes);
      admitHeadUntilFull();
    },
    failAll(error): void {
      for (const waiter of parked.splice(0)) waiter.reject(error);
    },
  };
}
