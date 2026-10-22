import type { TuiConfigurationPort } from '../../../runtime/port.js';
import {
  formatTuiSandboxModeLabel,
  type TuiSandboxFilesystemMode,
} from '../../../application/sandbox-mode.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

export interface TuiSandboxPolicySnapshot {
  /**
   * `undefined` until the first read completes, and permanently `undefined`
   * when the host runs no sandbox. The UI reports that instead of naming a
   * level nothing is enforcing.
   */
  readonly mode: TuiSandboxFilesystemMode | undefined;
  readonly updating: boolean;
}

export interface TuiSandboxPolicyFlowOptions {
  readonly runtime: TuiConfigurationPort;
  readonly append: (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;
  readonly setHint: (message: string | undefined) => void;
  readonly onChanged: () => void;
  readonly isStopped?: () => boolean;
}

/**
 * Owns the sandbox filesystem level shown by `/sandbox`.
 *
 * Separate from the permission-mode flow on purpose: the sandbox is enforced
 * by the platform layer rather than by permission checks, so a mode switch and
 * a sandbox switch are different decisions with different failure modes, and
 * one must never imply the other.
 */
export class TuiSandboxPolicyFlow {
  private modeValue: TuiSandboxFilesystemMode | undefined;
  private updatingValue = false;
  private refreshSequence = 0;
  private mutationSequence = 0;
  private stopped = false;

  constructor(private readonly options: TuiSandboxPolicyFlowOptions) {}

  snapshot(): TuiSandboxPolicySnapshot {
    return { mode: this.modeValue, updating: this.updatingValue };
  }

  async refresh(): Promise<void> {
    const refreshSequence = ++this.refreshSequence;
    const mutationSequence = this.mutationSequence;
    const mode = await readSandboxFilesystemMode(this.options.runtime);
    if (
      this.isStopped() ||
      refreshSequence !== this.refreshSequence ||
      mutationSequence !== this.mutationSequence ||
      this.updatingValue
    ) {
      return;
    }
    this.modeValue = mode;
    this.options.onChanged();
  }

  async set(nextMode: TuiSandboxFilesystemMode): Promise<void> {
    if (this.isStopped() || this.updatingValue) return;
    const runtime = this.options.runtime;
    if (this.modeValue === undefined || typeof runtime.setSandboxFilesystemMode !== 'function') {
      this.options.setHint('Sandbox is managed by host');
      this.options.onChanged();
      return;
    }
    if (this.modeValue === nextMode) {
      this.options.setHint(`Sandbox · ${formatTuiSandboxModeLabel(nextMode)}`);
      this.options.onChanged();
      return;
    }
    this.updatingValue = true;
    const mutationSequence = ++this.mutationSequence;
    this.refreshSequence += 1;
    this.options.setHint(`Sandbox · ${formatTuiSandboxModeLabel(nextMode)}…`);
    this.options.onChanged();
    try {
      const applied = await runtime.setSandboxFilesystemMode(nextMode);
      if (this.isStopped() || mutationSequence !== this.mutationSequence) return;
      this.modeValue = applied;
      this.options.setHint(`Sandbox · ${formatTuiSandboxModeLabel(applied)}`);
    } catch (error) {
      if (this.isStopped() || mutationSequence !== this.mutationSequence) return;
      this.options.append(
        formatTuiActionFailure(error, {
          summary: 'Sandbox was not changed.',
          nextStep: 'Retry /sandbox.',
        }),
        'warning',
      );
      this.options.setHint('Sandbox unchanged');
    } finally {
      if (!this.isStopped() && mutationSequence === this.mutationSequence) {
        this.updatingValue = false;
        this.options.onChanged();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.refreshSequence += 1;
    this.mutationSequence += 1;
    this.updatingValue = false;
  }

  private isStopped(): boolean {
    return this.stopped || Boolean(this.options.isStopped?.());
  }
}

/**
 * Read the sandbox level without assuming the host implements it. A host that
 * predates the surface and a failed read mean the same thing to the UI — this
 * host does not manage the sandbox — so both resolve to `undefined` rather
 * than surfacing an error the user cannot act on.
 */
async function readSandboxFilesystemMode(
  runtime: TuiConfigurationPort,
): Promise<TuiSandboxFilesystemMode | undefined> {
  if (typeof runtime.getSandboxFilesystemMode !== 'function') return undefined;
  return runtime.getSandboxFilesystemMode().catch(() => undefined);
}