// fs.watch plumbing for context coherence: watches files or directories and
// coalesces bursts of events (a single save can emit several) into one
// debounced `onChange` callback per resolved path.
//
// A file is watched through its parent directory and filtered by basename:
// watching the file's own inode breaks as soon as an editor saves by
// rename-over, while the parent directory keeps receiving events for the new
// inode. Directories are watched non-recursively; every top-level change is
// reported (the consumer simply ignores paths it has no bindings for).
//
// fs.watch is best-effort, though: FSEvents (darwin) can delay delivery by
// tens of seconds under heavy concurrent I/O, some platforms stop emitting
// entirely once the watched file is unlinked, and a directory that vanishes
// and is recreated leaves the old watcher pointed at a dead inode. A stat
// poll backstop (pollMs) therefore stats every subscribed path on a fixed
// interval and reports mtime/size/inode changes — and disappearances — so
// coherence is eventually correct even when the event stream stays silent.
//
// Subscriptions are reference-counted per resolved path: several `watch()`
// calls may cover the same path, and the underlying `FSWatcher` is closed
// only when the last disposer for that path detaches.

import { watch, type FSWatcher } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'node:path';

export interface PathWatcherOptions {
  /** Coalescing window in ms; events within the window collapse into one callback. */
  debounceMs: number;
  /**
   * Stat-poll backstop interval in ms; `0` disables the backstop and trusts
   * the fs.watch event stream alone. Default: 2000.
   */
  pollMs: number;
  /** Called with the resolved path of the changed file once the burst settles. */
  onChange(resolvedPath: string): void;
}

/** The stat fields the poll compares to detect a change or disappearance. */
interface StatSnapshot {
  ino: number;
  mtimeMs: number;
  size: number;
}

interface Subscription {
  /** The resolved path this subscription covers (map key). */
  target: string;
  /** Directory that `fs.watch` is attached to. */
  dir: string;
  /** Basename filter for file subscriptions; `undefined` watches a directory. */
  base: string | undefined;
  refs: number;
  watcher: FSWatcher;
  /** Inode the current `fs.watch` is attached to (dirs: detects recreation). */
  watchedIno: number;
  /** Last stat seen by the poll; `undefined` after a seen disappearance. */
  snapshot: StatSnapshot | undefined;
  /** Backstop interval handle; absent when polling is disabled. */
  pollTimer: NodeJS.Timeout | undefined;
}

export class PathWatcher {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(
    paths: readonly string[],
    private readonly options: PathWatcherOptions,
  ) {
    try {
      this.extend(paths);
    } catch (error) {
      // A missing path must not leak the subscriptions made before it.
      this.dispose();
      throw error;
    }
  }

  /** Adds one reference to each path's subscription, creating it if absent. */
  extend(paths: readonly string[]): void {
    for (const target of paths) {
      const existing = this.subscriptions.get(target);
      if (existing !== undefined) {
        existing.refs += 1;
        continue;
      }
      this.subscriptions.set(target, this.subscribe(target));
    }
  }

  /** Drops one reference per path; a subscription reaching zero closes. */
  detach(paths: readonly string[]): void {
    for (const target of paths) {
      const subscription = this.subscriptions.get(target);
      if (subscription === undefined) {
        continue;
      }
      subscription.refs -= 1;
      if (subscription.refs <= 0) {
        this.subscriptions.delete(target);
        subscription.watcher.close();
        this.cancelTimer(target);
        this.cancelPoll(subscription);
      }
    }
  }

  /** Stops all watchers and drops pending timers. Idempotent. */
  dispose(): void {
    this.disposed = true;
    for (const [target, subscription] of this.subscriptions) {
      subscription.watcher.close();
      this.cancelTimer(target);
      this.cancelPoll(subscription);
    }
    this.subscriptions.clear();
  }

  private subscribe(target: string): Subscription {
    // Throws ENOENT for a missing path — watching a nonexistent path is a
    // caller error and must fail loudly instead of silently never firing.
    const stats = statSync(target);
    const isDirectory = stats.isDirectory();
    const dir = isDirectory ? target : path.dirname(target);
    const base = isDirectory ? undefined : path.basename(target);

    const subscription: Subscription = {
      target,
      dir,
      base,
      refs: 1,
      watcher: undefined as unknown as FSWatcher,
      watchedIno: stats.ino,
      snapshot: snapshotOf(stats),
      pollTimer: undefined,
    };
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (this.disposed || this.subscriptions.get(target) !== subscription) {
        return;
      }
      // `filename` is null on some platforms for certain events; then the
      // bound path itself is the conservative best guess.
      const full =
        filename === null ? (base === undefined ? dir : target) : path.join(dir, filename);
      if (base !== undefined && full !== target) {
        return; // File subscription: ignore siblings in the shared directory.
      }
      this.schedule(full);
    });
    // An event stream error (e.g. the watched directory briefly vanishing)
    // must not crash the process; the next change re-triggers a refresh.
    watcher.on('error', () => {});
    watcher.unref();
    subscription.watcher = watcher;
    this.startPoll(target, subscription);
    return subscription;
  }

  /**
   * The backstop: stats the subscribed path on a fixed interval and reports
   * what the event stream may have missed — writes (mtime/size), a vanished
   * file, and a directory deleted and recreated under a dead watcher.
   */
  private startPoll(target: string, subscription: Subscription): void {
    if (this.options.pollMs <= 0) {
      return;
    }
    const poll = setInterval(() => this.pollOnce(target, subscription), this.options.pollMs);
    poll.unref();
    subscription.pollTimer = poll;
  }

  private pollOnce(target: string, subscription: Subscription): void {
    if (this.disposed || this.subscriptions.get(target) !== subscription) {
      this.cancelPoll(subscription);
      return;
    }
    let stats;
    try {
      stats = statSync(target);
    } catch {
      // Gone (or unreadable): report the disappearance exactly once — the
      // snapshot stays undefined until the path exists again.
      if (subscription.snapshot !== undefined) {
        subscription.snapshot = undefined;
        this.schedule(target);
      }
      return;
    }
    if (subscription.base === undefined && stats.ino !== subscription.watchedIno) {
      // Directory deleted and recreated under a dead watcher: re-attach the
      // event stream to the new inode, then report the recreation below.
      subscription.watcher.close();
      subscription.watcher = this.reattach(subscription);
      subscription.watchedIno = stats.ino;
    }
    const next = snapshotOf(stats);
    if (
      subscription.snapshot === undefined ||
      next.ino !== subscription.snapshot.ino ||
      next.mtimeMs !== subscription.snapshot.mtimeMs ||
      next.size !== subscription.snapshot.size
    ) {
      subscription.snapshot = next;
      this.schedule(target);
    }
  }

  /** Re-arms `fs.watch` for a directory subscription after its inode changed. */
  private reattach(subscription: Subscription): FSWatcher {
    const watcher = watch(subscription.dir, { persistent: false }, (_event, filename) => {
      if (this.disposed || this.subscriptions.get(subscription.target) !== subscription) {
        return;
      }
      const full =
        filename === null ? subscription.dir : path.join(subscription.dir, filename);
      this.schedule(full);
    });
    watcher.on('error', () => {});
    watcher.unref();
    return watcher;
  }

  private cancelPoll(subscription: Subscription): void {
    if (subscription.pollTimer !== undefined) {
      clearInterval(subscription.pollTimer);
      subscription.pollTimer = undefined;
    }
  }

  private schedule(resolved: string): void {
    this.cancelTimer(resolved);
    const timer = setTimeout(() => {
      this.timers.delete(resolved);
      this.options.onChange(resolved);
    }, this.options.debounceMs);
    timer.unref();
    this.timers.set(resolved, timer);
  }

  private cancelTimer(resolved: string): void {
    const timer = this.timers.get(resolved);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(resolved);
    }
  }
}

function snapshotOf(stats: { ino: number; mtimeMs: number; size: number }): StatSnapshot {
  return { ino: stats.ino, mtimeMs: stats.mtimeMs, size: stats.size };
}
