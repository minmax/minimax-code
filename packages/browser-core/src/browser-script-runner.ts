import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';

import {
  BROWSER_SCRIPT_BOOTSTRAP_SOURCE,
  BROWSER_SCRIPT_LOG_ENTRY_MAX_CHARS,
  BROWSER_SCRIPT_LOG_MAX_BYTES,
  BROWSER_SCRIPT_LOG_MAX_ENTRIES,
  BROWSER_SCRIPT_RUNTIME_FILENAME,
  browserScriptWorkerSource,
} from './browser-script-templates.js';
import {
  browserKeyDescriptor,
  browserPrintableKeyDescriptor,
  type BrowserKeyDescriptor,
} from './browser-keyboard.js';
import type {
  CDPConsoleDiagnosticLevelFilter,
  CDPConsoleDiagnosticsOptions,
  CDPConsoleDiagnosticsPage,
} from './cdp-helper-contracts.js';

/** Script operation error carrying the public `code:` prefix used by the tool envelope. */
export class BrowserScriptOperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BrowserScriptOperationError';
  }
}

export const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 30_000;
export const BROWSER_SCRIPT_MIN_TIMEOUT_MS = 1_000;
export const BROWSER_SCRIPT_MAX_TIMEOUT_MS = 120_000;
/** Action deadline = script budget + slack for teardown, matching the runner guarantees. */
export const BROWSER_SCRIPT_ACTION_DEADLINE_MS = 125_000;
export const BROWSER_SCRIPT_CODE_MAX_BYTES = 200 * 1024;
const MAX_WORKER_CALLS = 20_000;
const MAX_SCRIPT_SCREENSHOTS = 4;
const MAX_FAILURE_SCREENSHOTS = 1;
const VALUE_MAX_BYTES = 16 * 1024;
const EVALUATE_SOURCE_MAX_BYTES = 64 * 1024;
const EVALUATE_RESULT_MAX_BYTES = 256 * 1024;
const MAX_EVALUATE_SITES = 50;
const MAX_CONSOLE_ENTRIES = 100;
const MAX_STACK_FRAMES = 8;
const INSERT_TEXT_MAX_CHARS = 2_000;
const MAX_HELD_KEYS = 16;
const RELEASE_DEADLINE_MS = 2_000;
const PAGE_INFO_TIMEOUT_MS = 10_000;
const INTERRUPT_DEADLINE_MS = 2_000;

/** CDP modifier bitmask (Input.dispatchMouseEvent/DOM modifiers field). */
const MODIFIER_ALT = 1;
const MODIFIER_CTRL = 2;
const MODIFIER_META = 4;
const MODIFIER_SHIFT = 8;

type ScriptMouseButton = 'left' | 'right' | 'middle';

interface HeldKeyEntry {
  readonly descriptor: BrowserKeyDescriptor;
  readonly modifier: number;
}

export interface BrowserScriptScreenshot {
  label: string;
  data?: string;
  format: 'png' | 'jpeg';
  width?: number;
  height?: number;
  reason: 'script' | 'failure';
}

export interface BrowserScriptInputAutoRelease {
  released: string[];
  failed: boolean;
}

export interface BrowserScriptErrorInfo {
  name: string;
  message: string;
  code?: string;
  location?: { line: number; column: number };
  stack?: string[];
}

export interface BrowserScriptResult {
  success: boolean;
  code?: string;
  durationMs: number;
  filename?: string;
  value?: unknown;
  valueTruncated?: boolean;
  logs: { level: string; text: string }[];
  logsTruncated?: { omittedEntries: number };
  pageEvaluate: {
    calls: number;
    sites: { api: 'evaluate' | 'waitForFunction'; line: number; column: number; calls: number }[];
    sitesTruncated?: true;
    interrupted?: number;
  };
  input: { keyEvents: number; mouseEvents: number; autoReleased: BrowserScriptInputAutoRelease };
  pageErrors: { level: string; message: string }[];
  error?: BrowserScriptErrorInfo;
  screenshots: BrowserScriptScreenshot[];
  screenshotsSkipped?: number;
  recovery?: string;
}

interface WorkerLogMessage {
  readonly t: 'log';
  readonly level: string;
  readonly text: string;
}

interface WorkerDoneMessage {
  readonly t: 'done';
  readonly omittedLogs: number;
  readonly ok: boolean;
  readonly value?: string;
  readonly phase?: 'compile' | 'run';
  readonly error?: { name?: string; message?: string; stack?: string; code?: string };
}

interface WorkerCallMessage {
  readonly t: 'call';
  readonly id: number;
  readonly op: string;
  readonly args: string;
}

type WorkerMessage = WorkerLogMessage | WorkerDoneMessage | WorkerCallMessage;

type WorkerStatus = 'completed' | 'failed' | 'timeout' | 'call-limit' | 'crashed' | 'aborted';

interface WorkerOutcome {
  status: WorkerStatus;
  value?: string;
  phase?: 'compile' | 'run';
  error?: { name: string; message: string; stack?: string; code?: string };
}

interface WorkerHostRequest {
  readonly code: string;
  readonly filename: string;
  readonly timeoutMs: number;
  readonly maxCalls: number;
  readonly signal: AbortSignal;
  readonly handle: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly onLog: (level: string, text: string) => void;
  readonly onOmittedLogs: (count: number) => void;
  /** Invoked before the worker is terminated, win or lose. */
  readonly onSettle: () => void;
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  return typeof value === 'object' && value !== null && 't' in value;
}

/**
 * Drive one user script inside a dedicated worker. The worker is terminated
 * on every exit path; in-flight host operations are awaited so a cancelled
 * script never leaves a half-dispatched CDP command unobserved.
 */
export async function runBrowserScriptWorker(request: WorkerHostRequest): Promise<WorkerOutcome> {
  const worker = new Worker(browserScriptWorkerSource({
    logEntryMaxChars: BROWSER_SCRIPT_LOG_ENTRY_MAX_CHARS,
    logMaxEntries: BROWSER_SCRIPT_LOG_MAX_ENTRIES,
    logMaxBytes: BROWSER_SCRIPT_LOG_MAX_BYTES,
  }), {
    eval: true,
    env: {},
    argv: [],
    execArgv: [],
    stdout: true,
    stderr: true,
    workerData: {
      code: request.code,
      filename: request.filename,
      bootstrap: BROWSER_SCRIPT_BOOTSTRAP_SOURCE,
      runtimeFilename: BROWSER_SCRIPT_RUNTIME_FILENAME,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
  });
  // stdout/stderr are captured by the worker option; drain so a chatty script
  // cannot backpressure the worker pipe.
  worker.stdout.resume();
  worker.stderr.resume();

  let settled = false;
  let resolveSettle: (outcome: WorkerOutcome) => void = () => undefined;
  const settledPromise = new Promise<WorkerOutcome>((resolve) => {
    resolveSettle = resolve;
  });
  const settle = (outcome: WorkerOutcome): void => {
    if (settled) return;
    settled = true;
    resolveSettle(outcome);
  };

  const inFlight = new Set<Promise<void>>();
  let callCount = 0;

  worker.on('message', (raw: unknown) => {
    if (settled || !isWorkerMessage(raw)) return;
    if (raw.t === 'log') {
      request.onLog(String(raw.level), String(raw.text));
      return;
    }
    if (raw.t === 'done') {
      const omitted = typeof raw.omittedLogs === 'number' && raw.omittedLogs > 0
        ? raw.omittedLogs
        : 0;
      if (omitted > 0) request.onOmittedLogs(omitted);
      if (raw.ok === true) {
        settle({
          status: 'completed',
          ...(typeof raw.value === 'string' ? { value: raw.value } : {}),
        });
      } else {
        settle({
          status: 'failed',
          phase: raw.phase === 'compile' ? 'compile' : 'run',
          error: normalizeWorkerError(raw.error),
        });
      }
      return;
    }
    if (raw.t !== 'call' || typeof raw.id !== 'number') return;
    callCount += 1;
    if (callCount > request.maxCalls) {
      settle({ status: 'call-limit' });
      return;
    }
    const id = raw.id;
    const task = (async (): Promise<void> => {
      let reply: { t: 'ret'; id: number; ok: boolean; value?: string; error?: string };
      try {
        const args = JSON.parse(String(raw.args)) as Record<string, unknown>;
        const result = await request.handle(String(raw.op), args);
        reply = { t: 'ret', id, ok: true, value: result === undefined ? '' : JSON.stringify(result) };
      } catch (error) {
        reply = { t: 'ret', id, ok: false, error: JSON.stringify(serializeOperationError(error)) };
      }
      if (!settled) worker.postMessage(reply);
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  });
  worker.once('error', (error: Error) => {
    settle({ status: 'crashed', error: normalizeWorkerError(error) });
  });
  worker.once('exit', (exitCode: number) => {
    settle({
      status: 'crashed',
      error: { name: 'Error', message: `Browser script worker exited with code ${exitCode}` },
    });
  });

  const timer = setTimeout(() => settle({ status: 'timeout' }), request.timeoutMs);
  timer.unref?.();
  const onAbort = (): void => settle({ status: 'aborted' });
  if (request.signal.aborted) onAbort();
  else request.signal.addEventListener('abort', onAbort, { once: true });

  try {
    return await settledPromise;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    await worker.terminate().catch(() => undefined);
    request.onSettle();
    await Promise.allSettled([...inFlight]);
  }
}

function normalizeWorkerError(
  error: WorkerDoneMessage['error'] | Error | undefined,
): { name: string; message: string; stack?: string; code?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  if (typeof error === 'object' && error !== null) {
    return {
      name: typeof error.name === 'string' && error.name ? error.name : 'Error',
      message: typeof error.message === 'string' ? error.message : '',
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

function serializeOperationError(error: unknown): {
  name: string;
  message: string;
  code?: string;
} {
  if (error instanceof BrowserScriptOperationError) {
    return { name: 'BrowserScriptError', message: error.message, code: error.code };
  }
  const message = error instanceof Error ? error.message : String(error);
  const prefixed = /^([A-Z][A-Z0-9_]+):/u.exec(message);
  return { name: 'BrowserScriptError', message, ...(prefixed ? { code: prefixed[1] } : {}) };
}

/** Map modifier alias names to the CDP modifier bit and key descriptor. */
const RUN_SCRIPT_MODIFIERS: Readonly<
  Record<string, { modifier: number; descriptor: BrowserKeyDescriptor }>
> = {
  shift: { modifier: MODIFIER_SHIFT, descriptor: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 } },
  control: { modifier: MODIFIER_CTRL, descriptor: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 } },
  ctrl: { modifier: MODIFIER_CTRL, descriptor: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 } },
  alt: { modifier: MODIFIER_ALT, descriptor: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 } },
  meta: { modifier: MODIFIER_META, descriptor: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 } },
  command: { modifier: MODIFIER_META, descriptor: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 } },
};

function runScriptKeyDescriptor(key: string): { descriptor: BrowserKeyDescriptor; modifier: number } {
  const modifier = RUN_SCRIPT_MODIFIERS[key.toLowerCase()];
  if (modifier) return modifier;
  const letter = /^Key([A-Z])$/u.exec(key);
  if (letter?.[1]) {
    const char = letter[1].toLowerCase();
    return {
      descriptor: {
        key: char,
        code: `Key${letter[1]}`,
        windowsVirtualKeyCode: letter[1].charCodeAt(0),
        text: char,
      },
      modifier: 0,
    };
  }
  const digit = /^Digit([0-9])$/u.exec(key);
  if (digit?.[1]) {
    return {
      descriptor: {
        key: digit[1],
        code: `Digit${digit[1]}`,
        windowsVirtualKeyCode: digit[1].charCodeAt(0),
        text: digit[1],
      },
      modifier: 0,
    };
  }
  return { descriptor: browserKeyDescriptor(key), modifier: 0 };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Transport surface the controller needs, structural so tests can stub it. */
export interface BrowserScriptTransport {
  send<TResult = unknown>(
    method: string,
    params?: Record<string, unknown>,
    commandSessionId?: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<TResult>;
}

export interface BrowserScriptDiagnostics {
  ensureConsoleDiagnosticsReady(signal?: AbortSignal): Promise<boolean>;
  getConsoleDiagnostics(options?: CDPConsoleDiagnosticsOptions): CDPConsoleDiagnosticsPage;
}

export interface BrowserScriptControllerOptions {
  readonly transport: BrowserScriptTransport;
  readonly diagnostics: BrowserScriptDiagnostics;
  readonly coordinateScale?: () => number;
  /** Command budget inherited from the enclosing Browser Core action. */
  readonly commandTimeoutMs?: number;
  readonly commandSessionId?: string;
  readonly code: string;
  readonly filename: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Test seam: substitute the worker host while keeping the real CDP bridge. */
  readonly runWorker?: typeof runBrowserScriptWorker;
}

interface EvaluateRequest {
  source: string;
  isFunction: boolean;
  arg: unknown;
  api: string;
  site: { line: number; column: number } | null;
  record: boolean;
  pageTimeoutMs?: number;
}

/**
 * CDP bridge behind the worker facade. Tracks every real input event, the
 * keys and buttons still held when the script stops, and every page.evaluate
 * call site, then folds them into the tool-visible result envelope.
 */
export class BrowserScriptController {
  private readonly heldKeys = new Map<string, HeldKeyEntry>();
  private readonly heldButtons = new Set<ScriptMouseButton>();
  private modifiers = 0;
  private pointer: { x: number; y: number } | undefined;
  private keyEvents = 0;
  private mouseEvents = 0;
  private readonly logs: { level: string; text: string }[] = [];
  private omittedLogs = 0;
  private evaluateCalls = 0;
  private readonly evaluateSites = new Map<
    string,
    { api: 'evaluate' | 'waitForFunction'; line: number; column: number; calls: number }
  >();
  private evaluateSitesTruncated = false;
  private interruptedEvaluations = 0;
  private readonly screenshots: BrowserScriptScreenshot[] = [];
  private screenshotsSkipped = 0;
  private scriptScreenshotSlots = 0;
  private consoleBaseline = 0;
  private readonly operations = new AbortController();
  private inputQueue: Promise<unknown> = Promise.resolve();
  private transportInterruption: Error | undefined;
  private pageUnresponsive = false;

  constructor(private readonly options: BrowserScriptControllerOptions) {
    const abortOperations = (): void => this.operations.abort();
    if (options.signal.aborted) abortOperations();
    else options.signal.addEventListener('abort', abortOperations, { once: true });
  }

  private get operationSignal(): AbortSignal {
    return this.operations.signal;
  }

  /** Chain input operations so concurrent facade calls cannot interleave a gesture. */
  private serializeInput<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.inputQueue.then(operation) as Promise<T>;
    this.inputQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private send<TResult = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number | undefined = this.options.commandTimeoutMs,
    clampToCommandBudget = true,
  ): Promise<TResult> {
    const budget = this.options.commandTimeoutMs;
    const effective =
      timeoutMs !== undefined && clampToCommandBudget && budget !== undefined
        ? Math.min(timeoutMs, budget)
        : timeoutMs;
    return this.options.transport.send(
      method,
      params,
      method.startsWith('Input.') ? undefined : this.options.commandSessionId,
      { signal: this.operationSignal, ...(effective !== undefined ? { timeoutMs: effective } : {}) },
    );
  }

  async run(): Promise<BrowserScriptResult> {
    const startedAt = Date.now();
    this.consoleBaseline = await this.readConsoleSequence();
    const outcome = await (this.options.runWorker ?? runBrowserScriptWorker)({
      code: this.options.code,
      filename: this.options.filename,
      timeoutMs: this.options.timeoutMs,
      maxCalls: MAX_WORKER_CALLS,
      signal: this.options.signal,
      handle: (op, args) => this.handleTracked(op, args),
      onLog: (level, text) => this.appendLog(level, text),
      onOmittedLogs: (count) => {
        this.omittedLogs += count;
      },
      onSettle: () => this.operations.abort(),
    });
    const released = await this.releaseHeldInput();
    if (released.failed) {
      throw this.withInterruptedEvaluations(
        Object.assign(
          new Error(
            `BROWSER_OPERATION_TIMEOUT: run_script could not release held input (${released.released.join(', ')})`,
          ),
          { code: 'BROWSER_OPERATION_TIMEOUT' },
        ),
      );
    }
    if (outcome.status === 'aborted') {
      throw this.withInterruptedEvaluations(
        Object.assign(new Error('ABORTED: Browser script was cancelled'), { code: 'ABORTED' }),
      );
    }
    if (this.transportInterruption) {
      throw this.withInterruptedEvaluations(this.transportInterruption);
    }
    if (outcome.status === 'failed' || outcome.status === 'crashed') {
      await this.captureFailureScreenshot();
    }
    const pageErrors = await this.readPageErrors();
    return this.buildResult(outcome, released.released, pageErrors, Date.now() - startedAt);
  }

  private withInterruptedEvaluations(error: unknown): Error {
    if (
      this.interruptedEvaluations === 0 ||
      !(error instanceof Error)
    ) {
      return error instanceof Error ? error : new Error(String(error));
    }
    error.message = `${error.message}. ${this.interruptedEvaluations} page.evaluate call(s) did not finish and may still change the page; reload or re-inspect it before relying on its state.`;
    return error;
  }

  private async handleTracked(op: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.handle(op, args);
    } catch (error) {
      if (!this.operationSignal.aborted && !this.transportInterruption && isTransportInterruption(error)) {
        this.transportInterruption = error instanceof Error ? error : new Error(String(error));
      }
      throw error;
    }
  }

  private async handle(op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'sleep':
        await delay(Math.max(0, asFiniteNumber(args.ms)), undefined, {
          signal: this.operationSignal,
        });
        return;
      case 'key':
        return this.serializeInput(() => this.key(asString(args.type), asString(args.key)));
      case 'type':
        return this.serializeInput(() =>
          this.type(asString(args.text), clampInt(args.delay, 0, 0, Number.MAX_SAFE_INTEGER)),
        );
      case 'insertText':
        return this.serializeInput(async () => {
          const text = asString(args.text);
          if (text.length > INSERT_TEXT_MAX_CHARS) {
            throw new BrowserScriptOperationError(
              'TEXT_TOO_LONG',
              `Text input is limited to ${INSERT_TEXT_MAX_CHARS} characters per call`,
            );
          }
          await this.send('Input.insertText', { text });
        });
      case 'mouseMove':
        return this.serializeInput(() =>
          this.mouseMove(asFiniteNumber(args.x), asFiniteNumber(args.y), clampInt(args.steps, 1, 1, 100)),
        );
      case 'mouseDown':
        return this.serializeInput(() =>
          this.mouseButton('mousePressed', scriptMouseButton(args.button), clampInt(args.clickCount, 1, 1, 1_000_000)),
        );
      case 'mouseUp':
        return this.serializeInput(() =>
          this.mouseButton('mouseReleased', scriptMouseButton(args.button), clampInt(args.clickCount, 1, 1, 1_000_000)),
        );
      case 'wheel':
        return this.serializeInput(async () => {
          await this.dispatchMouse('mouseWheel', {
            deltaX: asFiniteNumber(args.deltaX),
            deltaY: asFiniteNumber(args.deltaY),
          });
        });
      case 'evaluate':
        return this.evaluate(args as unknown as EvaluateRequest);
      case 'screenshot':
        return this.scriptScreenshot(args);
      case 'consoleMessages':
        return this.consoleMessages(args);
      case 'pageInfo':
        return this.pageInfo();
      default:
        throw new BrowserScriptOperationError('UNSUPPORTED_OPERATION', `Unknown operation: ${op}`);
    }
  }

  private commandTimeoutBudget(): number | undefined {
    return this.options.commandTimeoutMs;
  }

  private async key(type: string, rawKey: string): Promise<void> {
    if (!rawKey) throw new BrowserScriptOperationError('INVALID_KEY', 'Key must be a non-empty string');
    const { descriptor, modifier } = runScriptKeyDescriptor(rawKey);
    if (type === 'down') {
      if (!this.heldKeys.has(descriptor.code) && this.heldKeys.size >= MAX_HELD_KEYS) {
        throw new BrowserScriptOperationError(
          'TOO_MANY_HELD_KEYS',
          `At most ${MAX_HELD_KEYS} keys can be held at once`,
        );
      }
      const alreadyHeld = this.heldKeys.has(descriptor.code);
      this.heldKeys.set(descriptor.code, { descriptor, modifier });
      this.modifiers |= modifier;
      await this.dispatchKey('keyDown', descriptor, alreadyHeld);
      return;
    }
    const held = this.heldKeys.get(descriptor.code);
    if (held?.modifier) this.modifiers &= ~held.modifier;
    await this.dispatchKey('keyUp', held?.descriptor ?? descriptor, false);
    this.heldKeys.delete(descriptor.code);
  }

  private async dispatchKey(
    type: 'keyDown' | 'keyUp',
    descriptor: BrowserKeyDescriptor,
    autoRepeat: boolean,
  ): Promise<void> {
    this.keyEvents += 1;
    await this.send('Input.dispatchKeyEvent', this.keyEventParams(type, descriptor, autoRepeat));
  }

  private keyEventParams(
    type: 'keyDown' | 'keyUp',
    descriptor: BrowserKeyDescriptor,
    autoRepeat: boolean,
  ): Record<string, unknown> {
    // With Shift held, CDP needs letter keys restated from the physical code
    // so the event carries the shifted character.
    const shiftedText =
      (this.modifiers & MODIFIER_SHIFT) !== 0 ? shiftedTextForCode(descriptor.code) : undefined;
    const key = shiftedText ?? descriptor.key;
    const text =
      type === 'keyDown' && descriptor.text !== undefined && (this.modifiers & ~MODIFIER_SHIFT) === 0
        ? shiftedText ?? descriptor.text
        : undefined;
    return {
      type,
      key,
      code: descriptor.code,
      modifiers: this.modifiers,
      ...(descriptor.windowsVirtualKeyCode === undefined
        ? {}
        : { windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode }),
      ...(text === undefined ? {} : { text, unmodifiedText: descriptor.text }),
      ...(autoRepeat ? { autoRepeat: true } : {}),
    };
  }

  private async type(text: string, delayMs: number): Promise<void> {
    if (text.length > INSERT_TEXT_MAX_CHARS) {
      throw new BrowserScriptOperationError(
        'TEXT_TOO_LONG',
        `Text input is limited to ${INSERT_TEXT_MAX_CHARS} characters per call`,
      );
    }
    const characters = Array.from(text).map((char) => printableOrText(char));
    const conflict = characters
      .flatMap((entry) => (entry.descriptor ? [entry.descriptor.code] : []))
      .find((code) => this.heldKeys.has(code));
    if (conflict) {
      throw new BrowserScriptOperationError(
        'KEY_ALREADY_HELD',
        `keyboard.type would release held key ${conflict}; call keyboard.up('${conflict}') first`,
      );
    }
    for (const entry of characters) {
      if (entry.descriptor) {
        this.heldKeys.set(entry.descriptor.code, { descriptor: entry.descriptor, modifier: 0 });
        await this.dispatchKey('keyDown', entry.descriptor, false);
        await this.dispatchKey('keyUp', entry.descriptor, false);
        this.heldKeys.delete(entry.descriptor.code);
      } else {
        await this.send('Input.insertText', { text: entry.text ?? '' });
      }
      if (delayMs > 0) await delay(delayMs, undefined, { signal: this.operationSignal });
    }
  }

  private async mouseMove(x: number, y: number, steps: number): Promise<void> {
    const from = this.pointer ?? { x, y };
    const resolvedSteps = this.pointer ? Math.max(1, Math.min(100, Math.floor(steps))) : 1;
    for (let step = 1; step <= resolvedSteps; step += 1) {
      this.pointer = {
        x: from.x + ((x - from.x) * step) / resolvedSteps,
        y: from.y + ((y - from.y) * step) / resolvedSteps,
      };
      await this.dispatchMouse('mouseMoved', {});
    }
  }

  private async mouseButton(
    type: 'mousePressed' | 'mouseReleased',
    button: ScriptMouseButton,
    clickCount: number,
  ): Promise<void> {
    this.requirePointer();
    if (type === 'mousePressed') this.heldButtons.add(button);
    await this.dispatchMouse(type, {
      button,
      clickCount: Math.max(1, Math.floor(clickCount)),
      ...(type === 'mouseReleased' ? { buttons: heldButtonsBitmask(this.heldButtons, button) } : {}),
    });
    if (type === 'mouseReleased') this.heldButtons.delete(button);
  }

  private requirePointer(): { x: number; y: number } {
    if (!this.pointer) {
      throw new BrowserScriptOperationError(
        'POINTER_POSITION_UNKNOWN',
        'Call page.mouse.move(x, y) or page.mouse.click(x, y) before mouse.down/up/wheel; the pointer position is not carried between actions',
      );
    }
    return this.pointer;
  }

  private async dispatchMouse(
    type: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const pointer = this.requirePointer();
    this.mouseEvents += 1;
    const scale = this.options.coordinateScale?.() ?? 1;
    await this.send('Input.dispatchMouseEvent', {
      type,
      x: pointer.x * scale,
      y: pointer.y * scale,
      modifiers: this.modifiers,
      buttons: heldButtonsBitmask(this.heldButtons),
      ...extra,
    });
  }

  private async evaluate(request: EvaluateRequest): Promise<unknown> {
    const source = asString(request.source);
    if (Buffer.byteLength(source, 'utf8') > EVALUATE_SOURCE_MAX_BYTES) {
      throw new BrowserScriptOperationError(
        'EVALUATE_SOURCE_TOO_LARGE',
        `page.evaluate source exceeds ${EVALUATE_SOURCE_MAX_BYTES} bytes`,
      );
    }
    if (request.record === true) this.recordEvaluate(request);
    const argJson = JSON.stringify(request.arg ?? null);
    const expression = request.isFunction === true
      ? `(${source})(${argJson})`
      : `(() => (${source}))()`;
    const pageTimeoutMs = Math.max(0, Math.floor(request.pageTimeoutMs ?? 0));
    const guarded = pageTimeoutMs > 0
      ? `Promise.race([Promise.resolve(${expression}).then((value) => ({ value })), new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ${Math.ceil(pageTimeoutMs)}))])`
      : expression;
    let response: {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    try {
      response = await this.send<{
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>(
        'Runtime.evaluate',
        { expression: guarded, awaitPromise: true, returnByValue: true, userGesture: true },
        pageTimeoutMs > 0 ? Math.ceil(pageTimeoutMs) + INTERRUPT_DEADLINE_MS : PAGE_INFO_TIMEOUT_MS,
        pageTimeoutMs <= 0,
      );
    } catch (error) {
      this.interruptedEvaluations += 1;
      await this.terminatePageExecution();
      throw error;
    }
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
      throw new BrowserScriptOperationError(
        'PAGE_EVALUATE_FAILED',
        firstLine(description ?? 'Page evaluation failed'),
      );
    }
    const value = response.result && 'value' in response.result ? response.result.value : undefined;
    if (pageTimeoutMs > 0 && isTimedOutSentinel(value)) {
      this.interruptedEvaluations += 1;
    }
    const bytes = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
    if (bytes > EVALUATE_RESULT_MAX_BYTES) {
      throw new BrowserScriptOperationError(
        'EVALUATE_RESULT_TOO_LARGE',
        `page.evaluate returned ${bytes} bytes; the limit is ${EVALUATE_RESULT_MAX_BYTES}`,
      );
    }
    return value;
  }

  private recordEvaluate(request: EvaluateRequest): void {
    this.evaluateCalls += 1;
    const api = request.api === 'waitForFunction' ? 'waitForFunction' : 'evaluate';
    const line = Math.max(0, Math.floor(request.site?.line ?? 0));
    const column = Math.max(0, Math.floor(request.site?.column ?? 0));
    const siteKey = `${api}:${line}:${column}`;
    const existing = this.evaluateSites.get(siteKey);
    if (existing) {
      existing.calls += 1;
      return;
    }
    if (this.evaluateSites.size < MAX_EVALUATE_SITES) {
      this.evaluateSites.set(siteKey, { api, line, column, calls: 1 });
      return;
    }
    this.evaluateSitesTruncated = true;
  }

  private async terminatePageExecution(): Promise<void> {
    const interrupted = await this.interruptPageExecution();
    if (!interrupted) {
      this.pageUnresponsive = true;
      this.transportInterruption ??= Object.assign(
        new Error(
          'BROWSER_OPERATION_TIMEOUT: page JavaScript started by run_script could not be stopped',
        ),
        { code: 'BROWSER_OPERATION_TIMEOUT' },
      );
    }
  }

  private async interruptPageExecution(): Promise<boolean> {
    await this.options.transport
      .send('Runtime.terminateExecution', {}, this.options.commandSessionId, {
        signal: this.operationSignal,
        timeoutMs: INTERRUPT_DEADLINE_MS,
      })
      .catch(() => undefined);
    try {
      await this.options.transport.send(
        'Runtime.evaluate',
        { expression: '0', returnByValue: true },
        this.options.commandSessionId,
        { signal: this.operationSignal, timeoutMs: INTERRUPT_DEADLINE_MS },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async scriptScreenshot(args: Record<string, unknown>): Promise<unknown> {
    const ordinal = this.screenshots.length + this.screenshotsSkipped + 1;
    const label = asString(args.label).slice(0, 80) || `screenshot-${ordinal}`;
    if (this.scriptScreenshotSlots >= MAX_SCRIPT_SCREENSHOTS) {
      this.screenshotsSkipped += 1;
      return { captured: false, label, reason: `At most ${MAX_SCRIPT_SCREENSHOTS} screenshots per script` };
    }
    this.scriptScreenshotSlots += 1;
    const rawClip = asRecord(args.clip);
    const clip = rawClip
      ? {
          x: clampInt(rawClip.x, 0, 0, Number.MAX_SAFE_INTEGER),
          y: clampInt(rawClip.y, 0, 0, Number.MAX_SAFE_INTEGER),
          width: clampInt(rawClip.width, 1, 1, 100_000),
          height: clampInt(rawClip.height, 1, 1, 100_000),
        }
      : undefined;
    let captured: { data?: string; format: 'png' | 'jpeg'; width?: number; height?: number };
    try {
      captured = await this.capture(label, 'script', clip);
    } catch (error) {
      this.scriptScreenshotSlots -= 1;
      throw error;
    }
    return {
      captured: true,
      label,
      ...(captured.width !== undefined ? { width: captured.width } : {}),
      ...(captured.height !== undefined ? { height: captured.height } : {}),
    };
  }

  private async capture(
    label: string,
    reason: BrowserScriptScreenshot['reason'],
    clip: { x: number; y: number; width: number; height: number } | undefined,
  ): Promise<BrowserScriptScreenshot> {
    const response = await this.send(
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: false,
        ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      },
      this.commandTimeoutBudget(),
      false,
    );
    const data = asRecord(response)?.data;
    const base64 = typeof data === 'string' ? data : '';
    if (!base64) throw new BrowserScriptOperationError('SCREENSHOT_EMPTY', 'Screenshot was empty');
    const width = asRecord(response)?.width;
    const height = asRecord(response)?.height;
    const screenshot: BrowserScriptScreenshot = {
      label,
      data: base64,
      format: 'png',
      ...(typeof width === 'number' ? { width } : {}),
      ...(typeof height === 'number' ? { height } : {}),
      reason,
    };
    this.screenshots.push(screenshot);
    return screenshot;
  }

  private async captureFailureScreenshot(): Promise<void> {
    if (this.screenshots.filter((shot) => shot.reason === 'failure').length >= MAX_FAILURE_SCREENSHOTS) {
      return;
    }
    await this.capture('failure', 'failure', undefined).catch(() => undefined);
  }

  private async consoleMessages(args: Record<string, unknown>): Promise<unknown> {
    const ready = await this.options.diagnostics
      .ensureConsoleDiagnosticsReady(this.operationSignal)
      .catch(() => false);
    if (!ready) {
      throw new BrowserScriptOperationError(
        'CONSOLE_DIAGNOSTICS_UNAVAILABLE',
        'Console diagnostics are unavailable for the current Browser tab',
      );
    }
    const limit = clampInt(args.limit, 50, 1, MAX_CONSOLE_ENTRIES);
    const levels = Array.isArray(args.levels)
      ? args.levels.map((level) => String(level)).filter(isConsoleLevelFilter)
      : undefined;
    const filter = typeof args.filter === 'string' ? args.filter : undefined;
    return this.options.diagnostics
      .getConsoleDiagnostics({
        ...(levels && levels.length > 0 ? { levels } : {}),
        ...(filter !== undefined ? { filter } : {}),
        limit,
      })
      .entries.map((entry) => ({
        level: entry.level,
        message: entry.message,
        source: entry.source,
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.lineNumber !== undefined ? { lineNumber: entry.lineNumber } : {}),
      }));
  }

  private async pageInfo(): Promise<unknown> {
    const response = await this.send<{
      result?: { value?: Record<string, unknown> };
    }>(
      'Runtime.evaluate',
      {
        expression: '({ url: location.href, title: document.title, width: innerWidth, height: innerHeight })',
        returnByValue: true,
      },
      PAGE_INFO_TIMEOUT_MS,
    );
    const value = response.result?.value ?? {};
    return {
      url: asString(value.url),
      title: asString(value.title).slice(0, 160),
      viewport: {
        width: clampInt(value.width, 0, 0, 1_000_000),
        height: clampInt(value.height, 0, 0, 1_000_000),
      },
    };
  }

  private async releaseHeldInput(): Promise<BrowserScriptInputAutoRelease> {
    const released: string[] = [];
    const commands: { method: string; params: Record<string, unknown> }[] = [];
    for (const button of [...this.heldButtons]) {
      this.heldButtons.delete(button);
      released.push(`mouse:${button}`);
      const pointer = this.pointer ?? { x: 0, y: 0 };
      const scale = this.options.coordinateScale?.() ?? 1;
      commands.push({
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseReleased',
          x: pointer.x * scale,
          y: pointer.y * scale,
          button,
          clickCount: 1,
          modifiers: this.modifiers,
          buttons: heldButtonsBitmask(this.heldButtons),
        },
      });
    }
    for (const [code, entry] of [...this.heldKeys].reverse()) {
      this.heldKeys.delete(code);
      if (entry.modifier) this.modifiers &= ~entry.modifier;
      released.push(entry.descriptor.code);
      commands.push({
        method: 'Input.dispatchKeyEvent',
        params: this.keyEventParams('keyUp', entry.descriptor, false),
      });
    }
    const deadline = Date.now() + RELEASE_DEADLINE_MS;
    const failed: unknown[] = [];
    for (const command of commands) {
      try {
        await this.options.transport.send(command.method, command.params, undefined, {
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
      } catch (error) {
        failed.push(error);
      }
    }
    return { released, failed: failed.length > 0 };
  }

  private async readConsoleSequence(): Promise<number> {
    const ready = await this.options.diagnostics
      .ensureConsoleDiagnosticsReady(this.options.signal)
      .catch(() => false);
    if (!ready) return Number.POSITIVE_INFINITY;
    const entries = this.options.diagnostics.getConsoleDiagnostics({ limit: 1 }).entries;
    const last = entries.at(-1)?.sequence;
    return typeof last === 'number' ? last : 0;
  }

  private async readPageErrors(): Promise<{ level: string; message: string }[]> {
    if (!Number.isFinite(this.consoleBaseline)) return [];
    return this.options.diagnostics
      .getConsoleDiagnostics({ levels: ['error'], limit: 20 })
      .entries.filter((entry) => entry.sequence > this.consoleBaseline)
      .map((entry) => ({ level: entry.level, message: entry.message.slice(0, 500) }));
  }

  private appendLog(level: string, text: string): void {
    if (this.logs.length >= BROWSER_SCRIPT_LOG_MAX_ENTRIES) {
      this.omittedLogs += 1;
      return;
    }
    this.logs.push({ level, text });
  }

  private buildResult(
    outcome: WorkerOutcome,
    autoReleased: string[],
    pageErrors: { level: string; message: string }[],
    durationMs: number,
  ): BrowserScriptResult {
    const shared = {
      durationMs,
      filename: this.options.filename,
      logs: this.logs,
      ...(this.omittedLogs > 0 ? { logsTruncated: { omittedEntries: this.omittedLogs } } : {}),
      pageEvaluate: {
        calls: this.evaluateCalls,
        sites: [...this.evaluateSites.values()],
        ...(this.evaluateSitesTruncated ? { sitesTruncated: true as const } : {}),
        ...(this.interruptedEvaluations > 0 ? { interrupted: this.interruptedEvaluations } : {}),
      },
      input: {
        keyEvents: this.keyEvents,
        mouseEvents: this.mouseEvents,
        autoReleased: { released: autoReleased, failed: false },
      },
      pageErrors,
      screenshots: this.screenshots,
      ...(this.screenshotsSkipped > 0 ? { screenshotsSkipped: this.screenshotsSkipped } : {}),
      ...(this.interruptedEvaluations > 0
        ? {
            recovery:
              'An interrupted page.evaluate may still finish in the page and change it. Reload or re-inspect the page before relying on its state.',
          }
        : {}),
    };
    if (outcome.status === 'completed') {
      const value = outcome.value === undefined ? {} : projectReturnValue(outcome.value);
      return { success: true, ...shared, ...value };
    }
    if (outcome.status === 'timeout') {
      return {
        success: false,
        code: 'SCRIPT_TIMEOUT',
        ...shared,
        error: { name: 'TimeoutError', message: `Script exceeded ${this.options.timeoutMs}ms` },
        recovery: this.interruptedEvaluations > 0
          ? `${shared.recovery} Then shorten waits or split the scenario.`
          : 'Shorten waits or split the scenario into several scripts, then retry.',
      };
    }
    if (outcome.status === 'call-limit') {
      return {
        success: false,
        code: 'SCRIPT_CALL_LIMIT',
        ...shared,
        error: {
          name: 'Error',
          message: `Script exceeded ${MAX_WORKER_CALLS} browser operations`,
        },
      };
    }
    const error = projectError(outcome.error, this.options.filename);
    return {
      success: false,
      code:
        outcome.status === 'crashed'
          ? 'SCRIPT_WORKER_CRASHED'
          : outcome.phase === 'compile'
            ? 'SCRIPT_SYNTAX_ERROR'
            : error.name === 'AssertionError'
              ? 'SCRIPT_ASSERTION_FAILED'
              : 'SCRIPT_ERROR',
      ...shared,
      error,
    };
  }
}

function isTransportInterruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^(BROWSER_OPERATION_TIMEOUT|ACTION_TIMEOUT|ABORTED):/u.test(message);
}

function scriptMouseButton(value: unknown): ScriptMouseButton {
  return value === 'right' || value === 'middle' ? value : 'left';
}

const CONSOLE_LEVEL_FILTERS: readonly CDPConsoleDiagnosticLevelFilter[] = [
  'debug',
  'info',
  'log',
  'warning',
  'error',
];

function isConsoleLevelFilter(value: string): value is CDPConsoleDiagnosticLevelFilter {
  return (CONSOLE_LEVEL_FILTERS as readonly string[]).includes(value);
}

function heldButtonsBitmask(held: ReadonlySet<ScriptMouseButton>, exclude?: ScriptMouseButton): number {
  let mask = 0;
  if (held.has('left') && exclude !== 'left') mask |= 1;
  if (held.has('right') && exclude !== 'right') mask |= 2;
  if (held.has('middle') && exclude !== 'middle') mask |= 4;
  return mask;
}

interface CharacterInput {
  descriptor?: BrowserKeyDescriptor;
  text?: string;
}

function printableOrText(char: string): CharacterInput {
  // Printable Latin/digit/symbol characters ride a physical key event;
  // everything else (IME, Unicode) goes through Input.insertText verbatim.
  const printable = browserPrintableKeyDescriptor(char);
  if (printable) {
    return {
      descriptor: {
        key: char,
        code: printable.code,
        windowsVirtualKeyCode: printable.windowsVirtualKeyCode,
        text: char,
      },
    };
  }
  return { text: char };
}

/**
 * The shifted character a physical code produces, when derivable without a
 * layout table. Letter codes cover the held-key game-input cases; symbol
 * shifts degrade to no text payload.
 */
function shiftedTextForCode(code: string): string | undefined {
  return /^Key([A-Z])$/u.exec(code)?.[1];
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isTimedOutSentinel(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { timedOut?: unknown }).timedOut === true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 1_000) ?? '';
}

function projectReturnValue(json: string): { value: unknown } | { value: string; valueTruncated: true } {
  if (Buffer.byteLength(json, 'utf8') <= VALUE_MAX_BYTES) {
    return { value: JSON.parse(json) as unknown };
  }
  return { value: `${json.slice(0, VALUE_MAX_BYTES)}…`, valueTruncated: true };
}

function projectError(
  error: { name: string; message: string; stack?: string; code?: string } | undefined,
  filename: string,
): BrowserScriptErrorInfo {
  const name = error?.name ?? 'Error';
  const message = (error?.message ?? '').slice(0, 2_000);
  const stackFrames = (error?.stack ?? '')
    .split('\n')
    .slice(1)
    .map((frame) => frame.trim())
    .filter((frame) => frame.includes(`${filename}:`) && !frame.includes(BROWSER_SCRIPT_RUNTIME_FILENAME));
  const inlineMatch = /^[^\n]*?:(\d+)\n/u.exec(error?.stack ?? '');
  const location =
    stackFrameLocation(stackFrames[0], filename) ??
    (inlineMatch && (error?.stack ?? '').startsWith(`${filename}:`)
      ? { line: Number(inlineMatch[1]), column: 0 }
      : undefined);
  return {
    name,
    message,
    ...(error?.code ? { code: error.code } : {}),
    ...(location ? { location } : {}),
    ...(stackFrames.length > 0 ? { stack: stackFrames.slice(0, MAX_STACK_FRAMES) } : {}),
  };
}

function stackFrameLocation(frame: string | undefined, filename: string): { line: number; column: number } | undefined {
  if (!frame) return undefined;
  const at = frame.lastIndexOf(`${filename}:`);
  if (at < 0) return undefined;
  const match = /^:(\d+):(\d+)/u.exec(frame.slice(at + filename.length));
  return match ? { line: Number(match[1]), column: Number(match[2]) } : undefined;
}

/** Validate run_script input and drive one controller run against the session state. */
export function resolveBrowserScriptTimeoutMs(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const clamped = Math.max(
    BROWSER_SCRIPT_MIN_TIMEOUT_MS,
    Math.min(BROWSER_SCRIPT_MAX_TIMEOUT_MS, Math.floor(numeric ?? BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS)),
  );
  return clamped;
}
