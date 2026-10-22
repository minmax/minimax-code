/**
 * Priority-aware writer gate for the control plane.
 *
 * The durable backend allows a single writer per generation; the gate is the
 * in-process fair queue in front of it. Appends are admitted by control-plane
 * priority P0 (most urgent) through P4 (background): a background compaction
 * checkpoint waits for every urgent commit and is granted only when no
 * lower-numbered waiter is queued. Holders are expected to hold the gate
 * across short appends only — the background scheduler never holds it across
 * its summarizer call.
 *
 * @module
 */

import type { ControlPlanePriority } from './types.js';

export type GateRelease = () => void;

export interface WriterGate {
  /**
   * Acquire the writer for a critical section. Resolves with the release
   * function; waiters are granted in priority order (P0 first, P4 last),
   * FIFO within the same priority.
   */
  acquire(priority: ControlPlanePriority): Promise<GateRelease>;
  /** Whether any critical section is currently active. */
  readonly held: boolean;
  /** Number of waiters per priority (index 0 = P0), for tests and metrics. */
  readonly waiting: readonly number[];
  /** Runs the body under the gate at the given priority. */
  withGate<T>(priority: ControlPlanePriority, body: () => Promise<T>): Promise<T>;
}

interface Waiter {
  readonly priority: ControlPlanePriority;
  readonly grant: (release: GateRelease) => void;
  readonly sequence: number;
}

export function createWriterGate(): WriterGate {
  let held = false;
  let sequenceCounter = 0;
  const waiting: Waiter[] = [];
  const waitingByPriority: number[] = [0, 0, 0, 0, 0];

  /**
   * Wrap a release into a once-only closure. Without the guard a caller that
   * releases twice would run `grantNext()` twice and hand the writer to a
   * second waiter while the first still holds it — mutual exclusion broken.
   */
  function makeGuardedRelease(): GateRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      grantNext();
    };
  }

  function grantNext(): void {
    // Lowest priority NUMBER first (P0 is the most urgent); FIFO within a priority.
    let best = -1;
    for (let i = 0; i < waiting.length; i += 1) {
      const candidate = waiting[i]!;
      if (best === -1) {
        best = i;
        continue;
      }
      const chosen = waiting[best]!;
      if (
        candidate.priority < chosen.priority ||
        (candidate.priority === chosen.priority && candidate.sequence < chosen.sequence)
      ) {
        best = i;
      }
    }
    if (best === -1) {
      held = false;
      return;
    }
    const [waiter] = waiting.splice(best, 1);
    if (waiter === undefined) {
      held = false;
      return;
    }
    waitingByPriority[waiter.priority] = (waitingByPriority[waiter.priority] ?? 0) - 1;
    waiter.grant(makeGuardedRelease());
  }

  return {
    acquire(priority) {
      if (!held) {
        held = true;
        return Promise.resolve(makeGuardedRelease());
      }
      return new Promise<GateRelease>((grant) => {
        sequenceCounter += 1;
        waitingByPriority[priority] = (waitingByPriority[priority] ?? 0) + 1;
        waiting.push({ priority, grant, sequence: sequenceCounter });
      });
    },
    get held(): boolean {
      return held;
    },
    get waiting(): readonly number[] {
      return [...waitingByPriority];
    },
    async withGate(priority, body) {
      const release = await this.acquire(priority);
      try {
        return await body();
      } finally {
        release();
      }
    },
  };
}
