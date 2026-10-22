/**
 * Error family of the delegation supervisor. Every error carries a stable
 * machine-readable `code` (the `DELEGATION_*` codes of the steering contract)
 * so callers can branch on outcomes without string matching.
 *
 * @module
 */

/** Base class of every supervisor error. */
export class DelegationSupervisorError extends Error {
  /** Stable machine-readable code, e.g. `DELEGATION_KEY_CONFLICT`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DelegationSupervisorError';
    this.code = code;
  }
}

/** T_spawn replay with the same key but a different child spec. */
export class DelegationKeyConflictError extends DelegationSupervisorError {
  constructor(keyDescription: string) {
    super(
      'DELEGATION_KEY_CONFLICT',
      `delegation key ${keyDescription} is already spawned with a different child spec; ` +
        'the same key must replay the same payload (§6.5: same id + same payload replays, another payload conflicts)',
    );
    this.name = 'DelegationKeyConflictError';
  }
}

/** Unknown delegation id. */
export class DelegationNotFoundError extends DelegationSupervisorError {
  constructor(delegationId: string) {
    super('DELEGATION_NOT_FOUND', `delegation ${delegationId} is not known to this supervisor`);
    this.name = 'DelegationNotFoundError';
  }
}

/**
 * A completion arrived for an already-completed delegation under a DIFFERENT
 * child run id: the first completion is the identity of the delegation result;
 * a subsequent child run is new work (task_append) and needs its own task.
 */
export class DelegationAlreadyCompletedError extends DelegationSupervisorError {
  constructor(delegationId: string, existingChildRunId: string, incomingChildRunId: string) {
    super(
      'DELEGATION_ALREADY_COMPLETED',
      `delegation ${delegationId} is already completed by child run ${existingChildRunId}; ` +
        `completion of child run ${incomingChildRunId} is new work, not a duplicate of the first completion`,
    );
    this.name = 'DelegationAlreadyCompletedError';
  }
}

/** Optimistic-concurrency failure: the caller's stateVersion is stale. */
export class DelegationVersionConflictError extends DelegationSupervisorError {
  constructor(delegationId: string, expected: number, actual: number) {
    super(
      'DELEGATION_VERSION_CONFLICT',
      `delegation ${delegationId} is at stateVersion ${actual}, the caller expected ${expected}; ` +
        're-read the delegation and retry with the current version',
    );
    this.name = 'DelegationVersionConflictError';
  }
}

/**
 * A release/detach transition was requested for a wait that is no longer
 * foreground. A replay of the SAME operation id returns the recorded outcome
 * instead of this error.
 */
export class DelegationNotForegroundError extends DelegationSupervisorError {
  constructor(delegationId: string, waitState: string, operationId: string) {
    super(
      'DELEGATION_NOT_FOREGROUND',
      `delegation ${delegationId}: wait is ${waitState}, so operation ${operationId} cannot release it; ` +
        'the wait transition is irreversible for this waitId',
    );
    this.name = 'DelegationNotForegroundError';
  }
}

/** A terminal outcome contradicting the recorded one. */
export class DelegationTerminalConflictError extends DelegationSupervisorError {
  constructor(delegationId: string, recorded: string, incoming: string) {
    super(
      'DELEGATION_TERMINAL_CONFLICT',
      `delegation ${delegationId} already recorded terminal outcome ${recorded}; ${incoming} conflicts with it`,
    );
    this.name = 'DelegationTerminalConflictError';
  }
}

/** The referenced parent delegation does not exist or does not match the conversation. */
export class DelegationParentMismatchError extends DelegationSupervisorError {
  constructor(parentDelegationId: string, parentConversationId: string) {
    super(
      'DELEGATION_PARENT_MISMATCH',
      `parentDelegationId ${parentDelegationId} does not name an active delegation whose child conversation is ${parentConversationId}`,
    );
    this.name = 'DelegationParentMismatchError';
  }
}

/** The supervisor was closed; no further transitions are accepted. */
export class SupervisorClosedError extends DelegationSupervisorError {
  constructor() {
    super('SUPERVISOR_CLOSED', 'the delegation supervisor is closed; no further transitions are accepted');
    this.name = 'SupervisorClosedError';
  }
}

/** Recovery could not read the whole supervisor log (budget or torn tail). */
export class DelegationRecoveryTruncatedError extends DelegationSupervisorError {
  constructor(detail: string) {
    super('DELEGATION_RECOVERY_TRUNCATED', `recovery could not replay the supervisor log completely: ${detail}`);
    this.name = 'DelegationRecoveryTruncatedError';
  }
}
