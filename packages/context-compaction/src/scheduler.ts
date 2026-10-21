/**
 * BackgroundCompactionScheduler — the double-trigger compaction driver.
 *
 * Triggers (evaluated on every `notify()`):
 * - tokens: usage-anchored estimate of the projected window (last valid
 *   provider usage + `chars/4` of the trailing messages, images at 4800
 *   characters);
 * - bytes: the sum of serialized entry lengths of the session manifest.
 *
 * Either axis crossing 75% of its budget starts a BACKGROUND compaction: the
 * summarizer runs without any writer held, and only the final append of the
 * `mcode.compaction` entry passes through the writer gate — at priority P4,
 * behind every urgent commit. Either axis crossing 90% makes the compaction
 * BLOCKING: the turn loop must await it (`notify()` returns the job promise).
 * Only one compaction runs at a time; a second notification joins the
 * in-flight job instead of starting a duplicate.
 *
 * @module
 */

import { compact } from './compact.js';
import { createWriterGate, type WriterGate } from './gate.js';
import {
  DEFAULT_BACKGROUND_THRESHOLD_RATIO,
  DEFAULT_BLOCKING_THRESHOLD_RATIO,
  DEFAULT_KEEP_RECENT_TOKENS,
  estimateManifestBytes,
  estimateProjectedContextTokens,
  evaluateTriggers,
} from './estimate.js';
import { BACKGROUND_COMPACTION_PRIORITY, type ControlPlanePriority, type DurableEntryDraft, type LogEntry, type Summarizer } from './types.js';
import type {
  CompactionBudgets,
  CompactionOutcome,
  CompactionLevel,
  TriggerEvaluation,
} from './types.js';

/** Persistence seam the scheduler drives. */
export interface SchedulerSession {
  /** Current raw log entries, oldest first (the scheduler projects itself). */
  readonly entries: readonly LogEntry[];
  /**
   * Durably append drafts. Called under the writer gate — implementations
   * must persist the batch before resolving.
   */
  append: (drafts: readonly DurableEntryDraft[]) => Promise<void>;
}

export interface BackgroundCompactionSchedulerOptions {
  readonly budgets: CompactionBudgets;
  readonly session: SchedulerSession;
  readonly summarizer: Summarizer;
  /** Passed through to `compact`. Default {@link DEFAULT_KEEP_RECENT_TOKENS}. */
  readonly keepRecentTokens?: number;
  /** Writer gate to share with the rest of the control plane. Default: private. */
  readonly gate?: WriterGate;
  /** Priority of the checkpoint append. Default: {@link BACKGROUND_COMPACTION_PRIORITY} (P4). */
  readonly appendPriority?: ControlPlanePriority;
  /** Clock. Default `Date.now`. */
  readonly now?: () => number;
}

export interface SchedulerNotification {
  /** Trigger evaluation of the current usage. */
  readonly evaluation: TriggerEvaluation;
  /** Compaction level the triggers selected. */
  readonly level: CompactionLevel;
  /** The compaction job when one was started or is already in flight, else `null`. */
  readonly job: Promise<CompactionOutcome | null> | null;
  /** True when this notification started a NEW compaction job. */
  readonly started: boolean;
}

export interface BackgroundCompactionScheduler {
  readonly budgets: CompactionBudgets;
  /** The shared writer gate. */
  readonly gate: WriterGate;
  /** Current usage estimate behind the triggers. */
  usage(): { readonly tokens: number; readonly bytes: number };
  /** Current trigger evaluation (pure, no side effects). */
  evaluate(): TriggerEvaluation;
  /**
   * Evaluate the triggers and start the compaction job when either axis
   * crossed a threshold. At the background level the returned `job` may be
   * dropped (fire and forget); at the BLOCKING level the turn loop MUST
   * await it.
   */
  notify(): SchedulerNotification;
  /** Run a blocking compaction right now, regardless of the triggers. */
  runBlocking(): Promise<CompactionOutcome | null>;
  /** Resolves when no compaction job is running. */
  whenIdle(): Promise<void>;
}

export function createBackgroundCompactionScheduler(
  options: BackgroundCompactionSchedulerOptions,
): BackgroundCompactionScheduler {
  const { budgets, session, summarizer } = options;
  const gate = options.gate ?? createWriterGate();
  const appendPriority = options.appendPriority ?? BACKGROUND_COMPACTION_PRIORITY;
  const now = options.now ?? Date.now;

  let inFlight: Promise<CompactionOutcome | null> | null = null;

  function usage(): { tokens: number; bytes: number } {
    return {
      // Anchor-aware of checkpoints: a usage record behind a compaction or
      // omission is stale and falls back to the pure window estimate.
      tokens: estimateProjectedContextTokens(session.entries).tokens,
      bytes: estimateManifestBytes(session.entries),
    };
  }

  async function runCompaction(): Promise<CompactionOutcome | null> {
    // Phase 1 — summarize WITHOUT the writer: the whole summarizer call runs
    // while urgent commits keep flowing through the gate.
    const outcome = await compact({
      entries: session.entries,
      summarizer,
      keepRecentTokens: options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
      tokenBudget: budgets.tokenBudget,
      now,
    });
    if (outcome === null) return null;
    // Phase 2 — the append is the only writer-held section, at background
    // priority: every queued urgent commit (P0–P3) is granted first.
    await gate.withGate(appendPriority, () => session.append([outcome.draft]));
    return outcome;
  }

  function startJob(): Promise<CompactionOutcome | null> {
    if (inFlight !== null) return inFlight;
    const job: Promise<CompactionOutcome | null> = runCompaction().finally(() => {
      inFlight = null;
    });
    // Register an internal rejection handler so a dropped background job can
    // never surface as an unhandled rejection; callers that await `job` still
    // observe the error.
    job.catch(() => undefined);
    inFlight = job;
    return job;
  }

  function evaluate(): TriggerEvaluation {
    return evaluateTriggers(usage(), {
      ...budgets,
      backgroundThresholdRatio: budgets.backgroundThresholdRatio ?? DEFAULT_BACKGROUND_THRESHOLD_RATIO,
      blockingThresholdRatio: budgets.blockingThresholdRatio ?? DEFAULT_BLOCKING_THRESHOLD_RATIO,
    });
  }

  function notify(): SchedulerNotification {
    const evaluation = evaluate();
    if (evaluation.level === 'none') {
      return { evaluation, level: evaluation.level, job: inFlight, started: false };
    }
    const started = inFlight === null;
    const job = startJob();
    return { evaluation, level: evaluation.level, job, started };
  }

  async function runBlocking(): Promise<CompactionOutcome | null> {
    // Join an in-flight background job first — a duplicate checkpoint helps
    // nobody — then compact now; this is the 90% / overflow path.
    if (inFlight !== null) await inFlight.catch(() => undefined);
    return startJob();
  }

  async function whenIdle(): Promise<void> {
    while (inFlight !== null) {
      await inFlight.catch(() => undefined);
    }
  }

  return {
    budgets,
    gate,
    usage,
    evaluate,
    notify,
    runBlocking,
    whenIdle,
  };
}
