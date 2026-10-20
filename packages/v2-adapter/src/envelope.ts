/**
 * Structural types and validation for one line of a legacy mcode v2
 * `messages.jsonl` canonical history file (the `CanonicalHistoryEnvelope`
 * wire format; see `hybrid-plans/facts/facts-mcode.md` section 5.2).
 *
 * The shapes mirror the writer in `packages/local-runtime-v2` but are declared
 * locally on purpose: this adapter is read-only and must not pull the heavy v2
 * runtime (SQLite, drizzle, HTTP) into its consumers.
 */

export interface V2ContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Inline base64 image block as stored by v2 sessions. */
export interface V2ImageContentBlock extends V2ContentBlock {
  readonly type: 'image';
  readonly data: string;
}

/** Replacement block produced when the import hook externalizes an image. */
export interface V2ImageRefContentBlock extends V2ContentBlock {
  readonly type: 'image_ref';
  readonly blob: string;
}

export interface V2Message {
  /**
   * Known roles are `user`, `assistant`, `toolResult`, `custom`, and
   * `compactionSummary`. Kept as `string` so the reader stays forward
   * compatible with roles this build does not know.
   */
  readonly role: string;
  readonly content?: readonly V2ContentBlock[];
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

/**
 * Opaque pass-through turn configuration (`{ system_prompt, model, tools? }`).
 * The writer emits it only on the first user message of a turn; the reader
 * does not interpret it.
 */
export type V2TurnConfig = Readonly<Record<string, unknown>>;

/** Opaque pass-through compaction marker written on the first record only. */
export type V2HistoryArtifact = Readonly<Record<string, unknown>>;

export interface V2Envelope {
  readonly message_id: string;
  readonly turn_id: string;
  readonly message: V2Message;
  readonly turn_config?: V2TurnConfig;
  readonly history_artifact?: V2HistoryArtifact;
}

/** One line of the v2 history file violated the canonical envelope format. */
export class V2SessionFormatError extends Error {
  readonly filePath: string;
  readonly lineNo: number;

  constructor(filePath: string, lineNo: number, reason: string) {
    super(`Malformed v2 history in ${filePath} at line ${lineNo}: ${reason}`);
    this.name = 'V2SessionFormatError';
    this.filePath = filePath;
    this.lineNo = lineNo;
  }
}

// Mirrors the envelope key set enforced by the v2 writer
// (`canonical-history-jsonl.ts` ENVELOPE_KEYS).
const ENVELOPE_KEYS = new Set([
  'message_id',
  'turn_id',
  'message',
  'turn_config',
  'history_artifact',
]);

// Same message_id shape the v2 writer validates.
const MESSAGE_ID_PATTERN = /^(?:msg-.+|\d+)$/u;

interface LineLocation {
  readonly filePath: string;
  readonly lineNo: number;
}

/**
 * Validates one parsed JSON value as a v2 envelope. Unknown envelope keys and
 * structural violations throw {@link V2SessionFormatError}; unknown keys
 * inside `message` and its content blocks pass through untouched.
 */
export function decodeV2Envelope(value: unknown, filePath: string, lineNo: number): V2Envelope {
  const at: LineLocation = { filePath, lineNo };
  const envelope = requirePlainObject(value, at, 'envelope');
  assertKnownKeys(envelope, ENVELOPE_KEYS, at, 'envelope');

  const messageId = envelope['message_id'];
  if (typeof messageId !== 'string' || !MESSAGE_ID_PATTERN.test(messageId)) {
    fail(at, 'message_id must match msg-.+ or contain only digits');
  }
  const turnId = envelope['turn_id'];
  if (typeof turnId !== 'string' || turnId.length === 0) {
    fail(at, 'turn_id must be a non-empty string');
  }

  const turnConfigValue = envelope['turn_config'];
  const artifactValue = envelope['history_artifact'];
  return {
    message_id: messageId,
    turn_id: turnId,
    message: decodeMessage(envelope['message'], at),
    // Placement rules (turn_config only on the first user message of a turn,
    // history_artifact only on record 1) are enforced by the writer; the
    // read-only adapter only checks the shapes and passes the values through.
    ...(turnConfigValue !== undefined
      ? { turn_config: requirePlainObject(turnConfigValue, at, 'turn_config') }
      : {}),
    ...(artifactValue !== undefined
      ? { history_artifact: requirePlainObject(artifactValue, at, 'history_artifact') }
      : {}),
  };
}

function decodeMessage(value: unknown, at: LineLocation): V2Message {
  const message = requirePlainObject(value, at, 'message');
  const role = message['role'];
  if (typeof role !== 'string' || role.length === 0) {
    fail(at, 'message.role must be a non-empty string');
  }
  const contentValue = message['content'];
  if (contentValue !== undefined) {
    if (!Array.isArray(contentValue)) fail(at, 'message.content must be an array');
    for (const block of contentValue) {
      if (!isPlainObject(block)) fail(at, 'message.content blocks must be plain objects');
      if (typeof block['type'] !== 'string') {
        fail(at, 'message.content blocks must have a string "type"');
      }
    }
  }
  // Pass-through: keep every unknown message key, but hand the caller a
  // normalized view where role/content are known to hold the checked values.
  return {
    ...message,
    role,
    ...(contentValue !== undefined ? { content: contentValue as readonly V2ContentBlock[] } : {}),
  };
}

/** Narrows a content block to an inline base64 image block. */
export function isV2ImageBlock(block: V2ContentBlock): block is V2ImageContentBlock {
  return block['type'] === 'image' && typeof block['data'] === 'string';
}

function requirePlainObject(
  value: unknown,
  at: LineLocation,
  context: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) fail(at, `${context} must be a plain object`);
  return value;
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  at: LineLocation,
  context: string,
): void {
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra !== undefined) fail(at, `${context} has an unknown key "${extra}"`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(at: LineLocation, reason: string): never {
  throw new V2SessionFormatError(at.filePath, at.lineNo, reason);
}
