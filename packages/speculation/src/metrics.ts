/**
 * Speculation metrics: the speculated / confirmed / wasted counters.
 *
 * Invariant: `confirmed + wasted ≤ speculated`; every started speculation is
 * eventually either confirmed or wasted, and never both (settle-once).
 *
 * @module
 */

import type { SpeculationMetricsSnapshot } from './types.js';

/** Mutable counter triple with frozen snapshots; shared budget ↔ pipeline. */
export class SpeculationMetrics {
	private speculated = 0;
	private confirmed = 0;
	private wasted = 0;

	incSpeculated(): void {
		this.speculated += 1;
	}

	incConfirmed(): void {
		this.confirmed += 1;
	}

	incWasted(): void {
		this.wasted += 1;
	}

	snapshot(): SpeculationMetricsSnapshot {
		return Object.freeze({
			speculated: this.speculated,
			confirmed: this.confirmed,
			wasted: this.wasted,
		});
	}
}
