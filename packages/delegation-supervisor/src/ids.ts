/**
 * Deterministic identity derivation for the delegation supervisor.
 *
 * Every id of a delegation (delegation, supervisor task, child conversation,
 * child submission, wait) is a pure function of the spawn key, and every
 * entry id is a pure function of the transition it records. A replayed
 * operation therefore computes the SAME entry ids, and the durable log's
 * entry-id uniqueness is the final backstop against double execution — no
 * counter, no clock, no randomness in the identity path.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { SpawnKey } from './types.js';

/** Length (in hex chars) of a derived id body: 96 bits of digest. */
const ID_BODY_HEX = 24;

/** SHA-256 of a UTF-8 string, hex-encoded. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable digest body used to build derived ids. */
function digestBody(input: string): string {
  return sha256Hex(input).slice(0, ID_BODY_HEX);
}

/**
 * Canonical JSON of a JSON-like value: object keys sorted recursively so
 * structurally equal specs produce byte-identical digests. Accepts `unknown`
 * so callers can hash freeform spec objects without casts; `undefined`
 * property values are skipped, mirroring `JSON.stringify` semantics.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',');
  return `{${body}}`;
}

/** Stable digest of a child spec: the replay-conflict discriminator of T_spawn. */
export function childSpecDigest(spec: unknown): string {
  return sha256Hex(canonicalJson(spec));
}

/** The canonical string form of a spawn key (diagnostics and digests). */
export function spawnKeyString(key: SpawnKey): string {
  return canonicalJson({ parentConversationId: key.parentConversationId, parentRunId: key.parentRunId, toolCallId: key.toolCallId });
}

/** Stable digest body of a spawn key. */
export function spawnKeyDigest(key: SpawnKey): string {
  return digestBody(spawnKeyString(key));
}

export interface SpawnIdentity {
  readonly delegationId: string;
  readonly supervisorTaskId: string;
  readonly childConversationId: string;
  readonly childSubmissionId: string;
  readonly waitId: string;
  readonly queues: { readonly inboxId: string; readonly deliveryIndexId: string; readonly delegationIndexId: string };
  readonly epochSeed: string;
}

/**
 * The full identity tuple of a fresh delegation, derived from its spawn key.
 * Replay under the same key recomputes exactly these values.
 */
export function deriveSpawnIdentity(key: SpawnKey): SpawnIdentity {
  const body = spawnKeyDigest(key);
  return {
    delegationId: `del-${body}`,
    supervisorTaskId: `dst-${body}`,
    childConversationId: `conv-child-${body}`,
    childSubmissionId: `childsub-${body}`,
    waitId: `wait-${body}`,
    queues: {
      inboxId: `inbox-${body}`,
      deliveryIndexId: `delivery-idx-${body}`,
      delegationIndexId: `delegation-idx-${body}`,
    },
    epochSeed: `epoch-${body}`,
  };
}

/**
 * Identity of a fork branch: derived from the source delegation plus the fork
 * index, so a fork gets its OWN conversation, queues, and epoch seed (R3)
 * while staying computable after a crash.
 */
export function deriveForkIdentity(fromDelegationId: string, forkIndex: number): {
  readonly forkDelegationId: string;
  readonly supervisorTaskId: string;
  readonly childConversationId: string;
  readonly queues: { readonly inboxId: string; readonly deliveryIndexId: string; readonly delegationIndexId: string };
  readonly epochSeed: string;
} {
  const body = digestBody(`fork:${fromDelegationId}#${forkIndex}`);
  return {
    forkDelegationId: `del-f-${body}`,
    supervisorTaskId: `dst-f-${body}`,
    childConversationId: `conv-child-f-${body}`,
    queues: {
      inboxId: `inbox-f-${body}`,
      deliveryIndexId: `delivery-idx-f-${body}`,
      delegationIndexId: `delegation-idx-f-${body}`,
    },
    epochSeed: `epoch-f-${body}`,
  };
}

// ---------------------------------------------------------------------------
// Entry ids (one per transition record)
// ---------------------------------------------------------------------------

export function supervisorTaskEntryId(supervisorTaskId: string): string {
  return `mcode.delegation.supervisor-task:${supervisorTaskId}`;
}

export function childConversationEntryId(childConversationId: string): string {
  return `mcode.delegation.child-conversation:${childConversationId}`;
}

export function spawnedEntryId(delegationId: string): string {
  return `mcode.delegation.spawned:${delegationId}`;
}

export function backgroundedEntryId(delegationId: string): string {
  return `mcode.delegation.backgrounded:${delegationId}`;
}

export function completedEntryId(delegationId: string, childRunId: string): string {
  return `mcode.delegation.completed:${delegationId}:${childRunId}`;
}

/**
 * The stable reporter requestId of a background completion (§3 T_complete):
 * `delegation:<id>:completion:<childRunId>`.
 */
export function completionRequestId(delegationId: string, childRunId: string): string {
  return `delegation:${delegationId}:completion:${childRunId}`;
}

/** The stable reporter submission id derived from the requestId. */
export function completionSubmissionId(requestId: string): string {
  return `submission:${requestId}`;
}

export function completionReportEntryId(requestId: string): string {
  return `mcode.delegation.completion-report:${requestId}`;
}

export function stopRequestedEntryId(delegationId: string, operationId: string): string {
  return `mcode.delegation.stop-requested:${delegationId}:${operationId}`;
}

export function childTerminalEntryId(delegationId: string): string {
  return `mcode.delegation.child-terminal:${delegationId}`;
}

export function forkedEntryId(forkDelegationId: string): string {
  return `mcode.delegation.forked:${forkDelegationId}`;
}

export function documentEntryId(revision: number): string {
  return `mcode.delegations.document:${revision}`;
}

// ---------------------------------------------------------------------------
// Operation ids (derived, replay-stable)
// ---------------------------------------------------------------------------

/** Detach (T_release) operation id: at most one committed detach per wait. */
export function detachOperationId(delegationId: string): string {
  return `background-${delegationId}`;
}

/**
 * Stop-cascade operation id: the k-th cascade rooted at `rootDelegationId`
 * (`k` = number of already-committed cascades rooted there). A crash before
 * the commit recomputes the same k, so the replay joins the same operation.
 */
export function stopOperationId(rootDelegationId: string, committedAsRoot: number): string {
  return `stop-${rootDelegationId}-${committedAsRoot}`;
}

/** Parent-abort cascade operation id, derived like {@link stopOperationId}. */
export function parentAbortOperationId(delegationId: string, committedAsRoot: number): string {
  return `parent-abort-${delegationId}-${committedAsRoot}`;
}
