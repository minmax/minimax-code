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
// Subscriptions are reference-counted per resolved path: several `watch()`
// calls may cover the same path, and the underlying `FSWatcher` is closed
// only when the last disposer for that path detaches.

import { watch, type FSWatcher } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'node:path';

export interface PathWatcherOptions {
  /** Coalescing window in ms; events within the window collapse into one callback. */
  debounceMs: number;
  /** Called with the resolved path of the changed file once the burst settles. */
  onChange(resolvedPath: string): void;
}

interface Subscription {
  /** Directory that `fs.watch` is attached to. */
  dir: string;
  /** Basename filter for file subscriptions; `undefined` watches a directory. */
  base: string | undefined;
  refs: number;
  watcher: FSWatcher;
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
      }
    }
  }

  /** Stops all watchers and drops pending timers. Idempotent. */
  dispose(): void {
    this.disposed = true;
    for (const [target, subscription] of this.subscriptions) {
      subscription.watcher.close();
      this.cancelTimer(target);
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
      dir,
      base,
      refs: 1,
      watcher: undefined as unknown as FSWatcher,
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
    return subscription;
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
