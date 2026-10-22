import type { TuiConfigurationPort } from '../../../runtime/port.js';
import {
  formatTuiDeleteGuardLabel,
  formatTuiPermissionMode,
  nextTuiPermissionMode,
  type TuiPermissionMode,
} from '../../../application/permission-mode.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

export interface TuiPermissionModeSnapshot {
  readonly mode: TuiPermissionMode | undefined;
  readonly updating: boolean;
  /**
   * `undefined` until the first read completes, and permanently `undefined`
   * when the host does not manage the delete guard.
   */
  readonly deleteGuardEnabled: boolean | undefined;
}

export interface TuiPermissionModeFlowOptions {
  readonly runtime: TuiConfigurationPort;
  readonly append: (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;
  readonly setHint: (message: string | undefined) => void;
  readonly onChanged: () => void;
  readonly isStopped?: () => boolean;
}

export class TuiPermissionModeFlow {
  private modeValue: TuiPermissionMode | undefined;
  private deleteGuardEnabledValue: boolean | undefined;
  private updatingValue = false;
  private refreshSequence = 0;
  private mutationSequence = 0;
  private stopped = false;

  constructor(private readonly options: TuiPermissionModeFlowOptions) {}

  snapshot(): TuiPermissionModeSnapshot {
    return {
      mode: this.modeValue,
      updating: this.updatingValue,
      deleteGuardEnabled: this.deleteGuardEnabledValue,
    };
  }

  async refresh(): Promise<void> {
    const refreshSequence = ++this.refreshSequence;
    const mutationSequence = this.mutationSequence;
    const [mode, deleteGuardEnabled] = await Promise.all([
      this.options.runtime.getPermissionMode(),
      // A host that does not own the setting must not break the mode picker,
      // so a missing method or a failed read degrades to "unmanaged".
      readDeleteGuardEnabled(this.options.runtime),
    ]);
    if (
      this.isStopped() ||
      refreshSequence !== this.refreshSequence ||
      mutationSequence !== this.mutationSequence ||
      this.updatingValue
    ) {
      return;
    }
    this.modeValue = mode;
    this.deleteGuardEnabledValue = deleteGuardEnabled;
    this.options.onChanged();
  }

  async cycle(): Promise<void> {
    if (this.isStopped() || this.updatingValue) return;
    if (!this.modeValue) {
      this.options.setHint('Permission mode is managed by Desktop');
      this.options.onChanged();
      return;
    }

    await this.set(nextTuiPermissionMode(this.modeValue));
  }

  async set(nextMode: TuiPermissionMode): Promise<void> {
    if (this.isStopped() || this.updatingValue) return;
    if (!this.modeValue) {
      this.options.setHint('Permission mode is managed by Desktop');
      this.options.onChanged();
      return;
    }
    if (nextMode === this.modeValue) {
      this.options.setHint(`Permission mode · ${formatTuiPermissionMode(nextMode)}`);
      this.options.onChanged();
      return;
    }
    this.updatingValue = true;
    const mutationSequence = ++this.mutationSequence;
    this.refreshSequence += 1;
    this.options.setHint(`Switching to ${formatTuiPermissionMode(nextMode)}…`);
    this.options.onChanged();
    try {
      const mode = await this.options.runtime.setPermissionMode(nextMode);
      if (this.isStopped() || mutationSequence !== this.mutationSequence) return;
      this.modeValue = mode;
      this.options.setHint(undefined);
    } catch (error) {
      if (this.isStopped() || mutationSequence !== this.mutationSequence) return;
      this.options.append(
        formatTuiActionFailure(error, {
          summary: 'Permission mode was not changed.',
          nextStep: 'Retry /permission or Alt+M.',
        }),
        'warning',
      );
      this.options.setHint('Permission mode unchanged');
    } finally {
      if (!this.isStopped() && mutationSequence === this.mutationSequence) {
        this.updatingValue = false;
        this.options.onChanged();
      }
    }
  }

  /**
   * Set the destructive-delete guard.
   *
   * This is deliberately a separate control from the permission mode: the mode
   * answers "when do I get asked", this answers "are deletes recoverable at
   * all". Turning the guard off makes deletes permanent, so it is never implied
   * by cycling to Full access.
   */
  async setDeleteGuardEnabled(enabled: boolean): Promise<void> {
    if (this.isStopped() || this.updatingValue) return;
    const runtime = this.options.runtime;
    if (
      this.deleteGuardEnabledValue === undefined ||
      typeof runtime.setDangerousCommandGateEnabled !== 'function'
    ) {
      this.options.setHint('Delete guard is managed by host');
      this.options.onChanged();
      return;
    }
    if (this.deleteGuardEnabledValue === enabled) {
      this.options.setHint(`Delete guard · ${formatTuiDeleteGuardLabel(enabled)}`);
      this.options.onChanged();
      return;
    }
    this.updatingValue = true;
    const mutationSequence = ++this.mutationSequence;
    this.refreshSequence += 1;
    this.options.setHint(`Delete guard · ${formatTuiDeleteGuardLabel(enabled)}…`);
    this.options.onChanged();
    try {
      const applied = await runtime.setDangerousCommandGateEnabled(enabled);
      if (this.isStopped() || mutationSequence !== this.mutationSequence) return;
      this.deleteGuardEnabledValue = applied;
      this.options.setHint(`Delete guard · ${formatTuiDeleteGuardLabel(applied)}`);
    } catch (error) {
      if (this.isStopped() || mutationSequence !== this.mutationSequence) return;
      this.options.append(
        formatTuiActionFailure(error, {
          summary: 'Delete guard was not changed.',
          nextStep: 'Retry /delete-guard.',
        }),
        'warning',
      );
      this.options.setHint('Delete guard unchanged');
    } finally {
      if (!this.isStopped() && mutationSequence === this.mutationSequence) {
        this.updatingValue = false;
        this.options.onChanged();
      }
    }
  }

  showStatus(): void {
    this.options.append(
      this.modeValue
        ? `Permission mode: ${formatTuiPermissionMode(this.modeValue)}.`
        : 'Permission mode is managed by Desktop.',
    );
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
 * Read the delete guard without assuming the host implements it. Both a host
 * that predates the setting and a failed call mean the same thing to the UI —
 * "this host does not manage the guard" — so both resolve to `undefined`
 * rather than surfacing an error the user cannot act on.
 */
async function readDeleteGuardEnabled(runtime: TuiConfigurationPort): Promise<boolean | undefined> {
  if (typeof runtime.getDangerousCommandGateEnabled !== 'function') return undefined;
  return runtime.getDangerousCommandGateEnabled().catch(() => undefined);
}
