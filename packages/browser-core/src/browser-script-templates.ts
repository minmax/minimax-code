/**
 * Isolated worker sources for the Browser `run_script` action.
 *
 * The user script never sees Node.js: it is compiled inside a `vm` context in
 * a worker thread whose only capabilities are the `page`, `assert` and
 * `console` bindings created by the bootstrap factory below. Everything the
 * facade needs from the host crosses the worker boundary as JSON RPC
 * (`{t:'call'}` / `{t:'ret'}`), so the worker stays free of filesystem,
 * network and process APIs by construction, not by policy.
 */

/**
 * Per-entry console.log slice. The remaining quotas (entry count, total
 * bytes) are interpolated into the worker source because they must be
 * enforced inside the worker: a runaway console.log loop must not flood the
 * host thread with messages the host would only discard.
 */
export const BROWSER_SCRIPT_LOG_ENTRY_MAX_CHARS = 4_000;
export const BROWSER_SCRIPT_LOG_MAX_ENTRIES = 200;
export const BROWSER_SCRIPT_LOG_MAX_BYTES = 256 * 1024;

/**
 * Bootstrap factory source. The host evaluates it inside the script context
 * and calls the exported factory with the RPC bridge; it returns `{ run }`,
 * which invokes the compiled user function as `fn(page, assert, console)`.
 */
export const BROWSER_SCRIPT_BOOTSTRAP_SOURCE = String.raw`(function (hostCall, hostLog, scriptFilename) {
  'use strict';
  const toJson = (value) => JSON.stringify(value === undefined ? null : value);
  const call = async (op, args) => {
    let raw;
    try {
      raw = await hostCall(op, toJson(args));
    } catch (failure) {
      let info;
      try { info = JSON.parse(String(failure)); } catch { info = { message: String(failure) }; }
      const error = new Error(String(info.message || 'Browser script operation failed'));
      error.name = String(info.name || 'BrowserScriptError');
      if (info.code) error.code = String(info.code);
      throw error;
    }
    return raw === '' ? undefined : JSON.parse(raw);
  };
  const callSite = () => {
    const stack = String(new Error().stack || '').split('\n');
    const marker = scriptFilename + ':';
    for (const frame of stack) {
      const index = frame.lastIndexOf(marker);
      if (index < 0) continue;
      const match = /:(\d+):(\d+)\)?\s*$/.exec(frame.slice(index + scriptFilename.length));
      if (match) return { line: Number(match[1]), column: Number(match[2]) };
    }
    return null;
  };
  const finite = (value, name) => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(name + ' must be a finite number');
    return number;
  };
  const sleep = (ms) => call('sleep', { ms: Math.max(0, finite(ms, 'timeout')) });
  const splitCombo = (key) => {
    const text = String(key);
    if (text.length <= 1 || text.indexOf('+') <= 0) return [text];
    const parts = text.split('+');
    if (parts[parts.length - 1] === '') { parts.pop(); parts[parts.length - 1] = '+'; }
    return parts.filter((part) => part.length > 0);
  };
  // A compound action (press, click) is several bridge calls. Chain whole
  // input actions here so concurrent calls under Promise.all run one after
  // another instead of interleaving into a different gesture.
  let inputTail = Promise.resolve();
  const inputAction = (run) => {
    const result = inputTail.then(run);
    inputTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const keyboard = Object.freeze({
    down: (key) => inputAction(() => call('key', { type: 'down', key: String(key) })),
    up: (key) => inputAction(() => call('key', { type: 'up', key: String(key) })),
    press: (key, options) => inputAction(async () => {
      const keys = splitCombo(key);
      const delay = options && options.delay !== undefined ? finite(options.delay, 'delay') : 0;
      for (const part of keys) await call('key', { type: 'down', key: part });
      if (delay > 0) await sleep(delay);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        await call('key', { type: 'up', key: keys[index] });
      }
    }),
    type: (text, options) => inputAction(() => call('type', {
      text: String(text),
      delay: options && options.delay !== undefined ? finite(options.delay, 'delay') : 0,
    })),
    insertText: (text) => inputAction(() => call('insertText', { text: String(text) })),
  });
  const button = (options) => (options && options.button) || 'left';
  const clickCount = (options) => (options && options.clickCount !== undefined
    ? Math.max(1, Math.floor(finite(options.clickCount, 'clickCount'))) : 1);
  const click = async (x, y, options) => {
    const count = clickCount(options);
    const delay = options && options.delay !== undefined ? finite(options.delay, 'delay') : 0;
    await call('mouseMove', { x: finite(x, 'x'), y: finite(y, 'y'), steps: 1 });
    for (let index = 1; index <= count; index += 1) {
      await call('mouseDown', { button: button(options), clickCount: index });
      if (delay > 0) await sleep(delay);
      await call('mouseUp', { button: button(options), clickCount: index });
    }
  };
  const mouse = Object.freeze({
    move: (x, y, options) => inputAction(async () => {
      const steps = options && options.steps !== undefined
        ? Math.max(1, Math.min(100, Math.floor(finite(options.steps, 'steps')))) : 1;
      await call('mouseMove', { x: finite(x, 'x'), y: finite(y, 'y'), steps });
    }),
    down: (options) => inputAction(() => call('mouseDown', { button: button(options), clickCount: clickCount(options) })),
    up: (options) => inputAction(() => call('mouseUp', { button: button(options), clickCount: clickCount(options) })),
    click: (x, y, options) => inputAction(() => click(x, y, options)),
    dblclick: (x, y, options) => inputAction(() => click(x, y, Object.assign({}, options, { clickCount: 2 }))),
    wheel: (deltaX, deltaY) => inputAction(() => call('wheel', {
      deltaX: finite(deltaX, 'deltaX'),
      deltaY: finite(deltaY, 'deltaY'),
    })),
  });
  const pageScript = (fn) => ({
    source: String(fn),
    isFunction: typeof fn === 'function',
  });
  const page = Object.freeze({
    keyboard,
    mouse,
    evaluate: (fn, arg) => call('evaluate', Object.assign(pageScript(fn), {
      arg: arg === undefined ? null : arg,
      api: 'evaluate',
      site: callSite(),
      record: true,
    })),
    waitForFunction: async (fn, arg, options) => {
      const timeout = options && options.timeout !== undefined ? finite(options.timeout, 'timeout') : 10000;
      const polling = options && options.polling !== undefined
        ? Math.max(16, finite(options.polling, 'polling')) : 100;
      const site = callSite();
      const deadline = Date.now() + Math.max(0, timeout);
      const timedOut = () => {
        const error = new Error('page.waitForFunction timed out after ' + timeout + 'ms');
        error.name = 'TimeoutError';
        return error;
      };
      let record = true;
      // One deadline covers every evaluation and every poll interval: a
      // condition only counts if it became truthy within the timeout. The
      // page itself bounds each evaluation to the remaining time, so a slow
      // condition times out as a condition, not as a transport failure.
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timedOut();
        const outcome = await call('evaluate', Object.assign(pageScript(fn), {
          arg: arg === undefined ? null : arg,
          api: 'waitForFunction',
          site,
          record,
          pageTimeoutMs: remaining,
        }));
        record = false;
        if (outcome && outcome.timedOut === true) throw timedOut();
        if (Date.now() > deadline) throw timedOut();
        if (outcome && outcome.value) return outcome.value;
        const wait = Math.min(polling, deadline - Date.now());
        if (wait > 0) await sleep(wait);
      }
    },
    waitForTimeout: sleep,
    screenshot: (options) => call('screenshot', {
      label: options && options.label !== undefined ? String(options.label) : null,
      clip: options && options.clip ? {
        x: finite(options.clip.x, 'clip.x'),
        y: finite(options.clip.y, 'clip.y'),
        width: finite(options.clip.width, 'clip.width'),
        height: finite(options.clip.height, 'clip.height'),
      } : null,
    }),
    consoleMessages: (options) => call('consoleMessages', {
      levels: options && Array.isArray(options.levels) ? options.levels.map(String) : null,
      filter: options && options.filter !== undefined ? String(options.filter) : null,
      limit: options && options.limit !== undefined ? finite(options.limit, 'limit') : null,
    }),
    url: async () => (await call('pageInfo', null)).url,
    title: async () => (await call('pageInfo', null)).title,
    viewportSize: async () => (await call('pageInfo', null)).viewport,
  });
  const format = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return String(value.stack || value.message);
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };
  const log = (level) => (...values) => { hostLog(level, values.map(format).join(' ')); };
  const scriptConsole = Object.freeze({
    log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug'),
  });
  class AssertionError extends Error {
    constructor(message) { super(message); this.name = 'AssertionError'; }
  }
  // deepEqual compares JSON data only (what page.evaluate returns). Other
  // objects (Set, Map, Date, class instances) have no enumerable state to
  // compare and would silently look equal, so they are rejected instead.
  const canonical = (value) => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        const kind = (value.constructor && value.constructor.name) || 'object';
        throw new TypeError('assert.deepEqual compares JSON data only; got ' + kind + '. Convert it first, for example [...set].sort() or date.getTime()');
      }
      return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    }
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new TypeError('assert.deepEqual compares JSON data only; got ' + typeof value);
    }
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  };
  const assert = (value, message) => {
    if (!value) throw new AssertionError(message === undefined ? 'Assertion failed' : String(message));
  };
  assert.ok = assert;
  assert.equal = (actual, expected, message) => {
    if (!Object.is(actual, expected)) {
      throw new AssertionError(message === undefined
        ? 'Expected ' + format(expected) + ', got ' + format(actual) : String(message));
    }
  };
  assert.notEqual = (actual, expected, message) => {
    if (Object.is(actual, expected)) {
      throw new AssertionError(message === undefined
        ? 'Expected a value different from ' + format(expected) : String(message));
    }
  };
  assert.deepEqual = (actual, expected, message) => {
    if (canonical(actual) !== canonical(expected)) {
      throw new AssertionError(message === undefined
        ? 'Expected ' + canonical(expected) + ', got ' + canonical(actual) : String(message));
    }
  };
  assert.fail = (message) => {
    throw new AssertionError(message === undefined ? 'Assertion failed' : String(message));
  };
  Object.freeze(assert);
  return Object.freeze({
    run: async (fn) => {
      const value = await fn(page, assert, scriptConsole);
      if (value === undefined) return undefined;
      const json = JSON.stringify(value);
      if (json === undefined) throw new TypeError('Script return value is not JSON-serializable');
      return json;
    },
  });
})`;

/**
 * Worker entry source. Placeholders ({placeholders}) are interpolated with
 * the quota constants so the in-worker enforcement matches the host-side
 * accounting exactly.
 */
export function browserScriptWorkerSource(options: {
  readonly logEntryMaxChars: number;
  readonly logMaxEntries: number;
  readonly logMaxBytes: number;
}): string {
  return String.raw`'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const pending = new Map();
let nextId = 1;
parentPort.on('message', (message) => {
  if (!message || message.t !== 'ret') return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(String(message.value));
  else entry.reject(String(message.error));
});
const hostCall = (op, args) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  parentPort.postMessage({ t: 'call', id, op: String(op), args: String(args) });
});
// The log quota is enforced here, before posting: a runaway console.log loop
// must not flood the host thread with messages it would only discard.
let logEntries = 0;
let logBytes = 0;
let omittedLogs = 0;
const hostLog = (level, text) => {
  const entry = String(text).slice(0, ${options.logEntryMaxChars});
  const bytes = Buffer.byteLength(entry, 'utf8');
  if (logEntries >= ${options.logMaxEntries} || logBytes + bytes > ${options.logMaxBytes}) {
    omittedLogs += 1;
    return;
  }
  logEntries += 1;
  logBytes += bytes;
  parentPort.postMessage({ t: 'log', level: String(level), text: entry });
};
const describe = (error) => {
  const read = (key) => {
    try {
      const value = error !== null && typeof error === 'object' ? error[key] : undefined;
      return value === undefined ? undefined : String(value);
    } catch {
      return undefined;
    }
  };
  if (error === null || typeof error !== 'object') {
    return { name: 'Error', message: String(error) };
  }
  return {
    name: read('name') || 'Error',
    message: read('message') || '',
    stack: read('stack'),
    code: read('code'),
  };
};
const finish = (payload) => parentPort.postMessage(Object.assign({ t: 'done', omittedLogs }, payload));
const context = vm.createContext(Object.create(null), {
  name: 'browser-script',
  codeGeneration: { strings: false, wasm: false },
});
const factory = new vm.Script(workerData.bootstrap, { filename: workerData.runtimeFilename })
  .runInContext(context);
const api = factory(hostCall, hostLog, workerData.filename);
let userFunction;
try {
  userFunction = new vm.Script(
    '(async function (page, assert, console) {\n' + workerData.code + '\n})',
    { filename: workerData.filename, lineOffset: -1 },
  ).runInContext(context);
} catch (error) {
  finish({ ok: false, phase: 'compile', error: describe(error) });
}
if (userFunction) {
  api.run(userFunction).then(
    (value) => finish({ ok: true, value: value === undefined ? undefined : String(value) }),
    (error) => finish({ ok: false, phase: 'run', error: describe(error) }),
  );
}
`;
}

/** Filename given to the bootstrap factory; stack frames from it are helper frames. */
export const BROWSER_SCRIPT_RUNTIME_FILENAME = 'browser-run-script-runtime.js';
