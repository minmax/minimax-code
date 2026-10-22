/**
 * Control-plane scheduler for the steering reaction (§2 priorities).
 *
 * Control work runs one job at a time through the fixed lanes P0–P4:
 * cancel/permission → owner input/release → stream → commit-drain →
 * maintenance. A queued higher-priority job always runs before queued
 * lower-priority work; an ALREADY RUNNING atomic job is never interrupted
 * (§2: "уже исполняющийся атомарный commit не прерывается"). The scheduler
 * itself introduces no timers — only microtasks — so a P1 release is never
 * delayed by scheduling overhead on its way to the 250 ms gate.
 *
 * @module
 */

/** Control-plane priority lanes; the lowest number runs first. */
export type ControlPriority = 0 | 1 | 2 | 3 | 4;

/** Named lanes in spec order: cancel/permission, owner input, stream, commit-drain, maintenance. */
export const CONTROL_PRIORITY = {
	CANCEL_PERMISSION: 0,
	OWNER_INPUT: 1,
	STREAM: 2,
	COMMIT_DRAIN: 3,
	MAINTENANCE: 4,
} as const satisfies Record<string, ControlPriority>;

export interface ControlPlane {
	/** Runs `job` through the priority lanes; FIFO within one lane. */
	run<T>(priority: ControlPriority, job: () => T | Promise<T>): Promise<T>;
	/** Number of queued (not yet started) jobs. */
	pendingCount(): number;
	/** Resolves when no job is running and the queue is empty. */
	onIdle(): Promise<void>;
}

interface QueuedJob {
	readonly priority: ControlPriority;
	/** Monotonic submission order; ties inside a lane stay FIFO. */
	readonly seq: number;
	readonly job: () => unknown;
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

export function createControlPlane(): ControlPlane {
	/** Insertion-ordered queue; the scan picks the earliest job of the highest lane. */
	const queue: QueuedJob[] = [];
	let seqCounter = 0;
	let running = false;
	let idleWaiters: Array<() => void> = [];

	function nextJob(): QueuedJob | undefined {
		let best: QueuedJob | undefined;
		for (const candidate of queue) {
			// Strictly-lower priority only: the first-encountered job of a lane
			// (earliest seq) wins ties, preserving FIFO order within the lane.
			if (best === undefined || candidate.priority < best.priority) {
				best = candidate;
			}
		}
		return best;
	}

	function fireIdle(): void {
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const waiter of waiters) waiter();
	}

	/**
	 * Defers the pump by one microtask so jobs submitted in the same tick are
	 * all visible when the lanes are evaluated (a P1 arriving in the same
	 * synchronous burst as a P4 must not lose to it). Microtask deferral adds
	 * no timer delay to the release path.
	 */
	function schedule(): void {
		void Promise.resolve().then(pump);
	}

	function pump(): void {
		if (running) return;
		const job = nextJob();
		if (job === undefined) {
			fireIdle();
			return;
		}
		queue.splice(queue.indexOf(job), 1);
		running = true;
		void Promise.resolve()
			.then(job.job)
			.then(
				value => job.resolve(value),
				error => job.reject(error),
			)
			.then(() => {
				running = false;
				schedule();
			});
	}

	return {
		run<T>(priority: ControlPriority, job: () => T | Promise<T>): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				queue.push({
					priority,
					seq: seqCounter++,
					job: job as () => unknown,
					resolve: resolve as (value: unknown) => void,
					reject,
				});
				schedule();
			});
		},

		pendingCount(): number {
			return queue.length;
		},

		onIdle(): Promise<void> {
			if (!running && queue.length === 0) return Promise.resolve();
			return new Promise<void>(resolve => {
				idleWaiters.push(resolve);
				schedule();
			});
		},
	};
}
