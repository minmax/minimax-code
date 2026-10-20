/**
 * Event-loop stall monitor for the session-path benches.
 *
 * Samples the loop at a fixed tick and records how late each tick fired: a
 * tick scheduled every 1 ms that fires after 7 ms means a 6 ms stall. The
 * bench gates assert on the p99/max of those deltas — the Ф1 acceptance
 * "zero stream freezes" is exactly this number, not the mean.
 */

const TICK_MS = 1;

/** Starts sampling; call `stop()` before reading the summary. */
export function startStallMonitor() {
  let previous = performance.now();
  const stalls = [];
  const timer = setInterval(() => {
    const now = performance.now();
    stalls.push(now - previous);
    previous = now;
  }, TICK_MS);
  timer.unref?.();
  return {
    /** Stops sampling (keeps the collected samples). */
    stop() {
      clearInterval(timer);
    },
    /** Total observed samples. */
    get samples() {
      return stalls.length;
    },
    /** Nearest-rank percentile of the tick deltas, in ms. */
    percentileMs(quantile) {
      if (stalls.length === 0) return 0;
      const sorted = [...stalls].sort((a, b) => a - b);
      const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
      return sorted[index] - TICK_MS; // the planned tick itself is not a stall
    },
    /** Worst observed tick delta minus the planned tick, in ms. */
    maxMs() {
      if (stalls.length === 0) return 0;
      return Math.max(...stalls) - TICK_MS;
    },
  };
}
