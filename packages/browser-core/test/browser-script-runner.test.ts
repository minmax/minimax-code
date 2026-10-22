import { describe, expect, it } from 'vitest';

import {
  BrowserScriptController,
  BrowserScriptOperationError,
  resolveBrowserScriptTimeoutMs,
  runBrowserScriptWorker,
  type BrowserScriptDiagnostics,
  type BrowserScriptTransport,
} from '../src/browser-script-runner.js';
import { BROWSER_SCRIPT_BOOTSTRAP_SOURCE, BROWSER_SCRIPT_RUNTIME_FILENAME } from '../src/browser-script-templates.js';

function runScript(code: string, options: {
  timeoutMs?: number;
  maxCalls?: number;
  handle?: (op: string, args: Record<string, unknown>) => Promise<unknown>;
} = {}): Promise<Awaited<ReturnType<typeof runBrowserScriptWorker>>> {
  return runBrowserScriptWorker({
    code,
    filename: 'test-script.js',
    timeoutMs: options.timeoutMs ?? 5_000,
    maxCalls: options.maxCalls ?? 10_000,
    signal: new AbortController().signal,
    handle: options.handle ?? (async () => undefined),
    onLog: () => undefined,
    onOmittedLogs: () => undefined,
    onSettle: () => undefined,
  });
}

describe('browser script worker', () => {
  it('returns the JSON value of a completed script', async () => {
    const outcome = await runScript('return { answer: 42 };');
    expect(outcome.status).toBe('completed');
    expect(outcome.value).toBe('{"answer":42}');
  });

  it('reports a compile error with the script phase', async () => {
    const outcome = await runScript('return )( syntax error');
    expect(outcome.status).toBe('failed');
    expect(outcome.phase).toBe('compile');
    expect(outcome.error?.name).toBe('SyntaxError');
  });

  it('maps assertion failures to the AssertionError name', async () => {
    const outcome = await runScript('assert.equal(1, 2, "one is not two");');
    expect(outcome.status).toBe('failed');
    expect(outcome.phase).toBe('run');
    expect(outcome.error?.name).toBe('AssertionError');
    expect(outcome.error?.message).toContain('one is not two');
  });

  it('terminates a script that exceeds its timeout', async () => {
    const outcome = await runScript('await new Promise(() => {});', { timeoutMs: 200 });
    expect(outcome.status).toBe('timeout');
  }, 10_000);

  it('stops counting host calls past the limit', async () => {
    let calls = 0;
    const outcome = await runScript(
      'for (let i = 0; i < 10; i += 1) await page.waitForTimeout(1);',
      {
        maxCalls: 3,
        handle: (async () => {
          calls += 1;
          return undefined;
        }) as (op: string, args: Record<string, unknown>) => Promise<unknown>,
      },
    );
    expect(outcome.status).toBe('call-limit');
    expect(calls).toBe(3);
  }, 10_000);

  it('rejects non-JSON return values', async () => {
    const outcome = await runScript('return () => {};');
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.name).toBe('TypeError');
  });

  it('exposes page.evaluate through the facade and forwards the serialized arg', async () => {
    const seen: { op: string; args: Record<string, unknown> }[] = [];
    const outcome = await runScript(
      'const doubled = await page.evaluate((n) => n * 2, 21); return { doubled };',
      {
        handle: async (op, args) => {
          seen.push({ op, args });
          if (op === 'evaluate') {
            expect(args.isFunction).toBe(true);
            expect(args.arg).toBe(21);
            expect(args.record).toBe(true);
            return 42;
          }
          return undefined;
        },
      },
    );
    expect(outcome.status).toBe('completed');
    expect(JSON.parse(outcome.value ?? '{}')).toEqual({ doubled: 42 });
    expect(seen.some((call) => call.op === 'evaluate')).toBe(true);
  });

  it('surfaces host operation errors with their code', async () => {
    const outcome = await runScript(
      'await page.mouse.click(10, 10);',
      {
        handle: async (op) => {
          if (op === 'mouseMove') {
            throw new BrowserScriptOperationError('POINTER_POSITION_UNKNOWN', 'move first');
          }
          return undefined;
        },
      },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('POINTER_POSITION_UNKNOWN');
  });
});

describe('browser script worker source integrity', () => {
  it('ships the bootstrap factory and runtime filename', () => {
    expect(BROWSER_SCRIPT_BOOTSTRAP_SOURCE).toContain('assert.deepEqual compares JSON data only');
    expect(BROWSER_SCRIPT_RUNTIME_FILENAME).toContain('runtime');
  });
});

describe('browser script controller', () => {
  function fakeTransport(responses: Record<string, unknown> = {}): {
    transport: BrowserScriptTransport;
    sent: { method: string; params?: Record<string, unknown>; sessionId?: string }[];
  } {
    const sent: { method: string; params?: Record<string, unknown>; sessionId?: string }[] = [];
    const transport: BrowserScriptTransport = {
      async send<TResult = unknown>(
        method: string,
        params?: Record<string, unknown>,
        sessionId?: string,
      ): Promise<TResult> {
        sent.push({ method, params, sessionId });
        return (responses[method] ?? {}) as TResult;
      },
    };
    return { transport, sent };
  }

  const diagnostics: BrowserScriptDiagnostics = {
    async ensureConsoleDiagnosticsReady() {
      return false;
    },
    getConsoleDiagnostics() {
      return { entries: [], totalEntries: 0 };
    },
  };

  async function runController(
    handleScript: (
      handle: (op: string, args: Record<string, unknown>) => Promise<unknown>,
    ) => Promise<{ status: 'completed' }>,
  ): Promise<{
    result: Awaited<ReturnType<BrowserScriptController['run']>>;
    sent: { method: string; params?: Record<string, unknown>; sessionId?: string }[];
  }> {
    const { transport, sent } = fakeTransport();
    const controller = new BrowserScriptController({
      transport,
      diagnostics,
      code: 'return;',
      filename: 'test-script.js',
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      runWorker: (request) => handleScript(request.handle),
    });
    const result = await controller.run();
    return { result, sent };
  }

  it('auto-releases a key left held and reports it', async () => {
    const dispatched: Record<string, unknown>[] = [];
    const { result, sent } = await runController(async (handle) => {
      await handle('key', { type: 'down', key: 'Shift' });
      await handle('key', { type: 'down', key: 'KeyD' });
      return { status: 'completed' as const };
    });
    expect(result.success).toBe(true);
    expect(result.input.autoReleased.released).toEqual(['KeyD', 'ShiftLeft']);
    expect(dispatched.length).toBe(0);
    const keyUps = sent.filter(
      (call) =>
        call.method === 'Input.dispatchKeyEvent' &&
        (call.params as { type?: string } | undefined)?.type === 'keyUp',
    );
    expect(keyUps.length).toBe(2);
  });

  it('records page.evaluate call sites', async () => {
    const { result } = await runController(async (handle) => {
      await handle('evaluate', {
        source: '() => 1',
        isFunction: true,
        arg: null,
        api: 'evaluate',
        site: { line: 3, column: 7 },
        record: true,
      });
      await handle('evaluate', {
        source: '() => 2',
        isFunction: true,
        arg: null,
        api: 'evaluate',
        site: { line: 4, column: 7 },
        record: true,
      });
      return { status: 'completed' as const };
    });
    expect(result.success).toBe(true);
    expect(result.pageEvaluate.calls).toBe(2);
    expect(result.pageEvaluate.sites.length).toBe(2);
    expect(result.pageEvaluate.sites[0]).toMatchObject({ api: 'evaluate', line: 3, column: 7 });
    expect(result.pageEvaluate.sites[1]).toMatchObject({ api: 'evaluate', line: 4, column: 7 });
  });

  it('folds console errors after the baseline into pageErrors', async () => {
    const consoleDiagnostics: BrowserScriptDiagnostics = {
      async ensureConsoleDiagnosticsReady() {
        return true;
      },
      getConsoleDiagnostics(options) {
        if ((options?.limit ?? 0) === 1) return { entries: [], totalEntries: 0 };
        return {
          entries: [
            { sequence: 1, level: 'error', source: 'console', message: 'boom after script started' },
          ],
          totalEntries: 1,
        };
      },
    };
    const { transport } = fakeTransport();
    const controller = new BrowserScriptController({
      transport,
      diagnostics: consoleDiagnostics,
      code: 'return;',
      filename: 'test-script.js',
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      runWorker: async (request) => {
        await request.handle('sleep', { ms: 1 });
        return { status: 'completed' as const };
      },
    });
    const result = await controller.run();
    expect(result.pageErrors).toEqual([
      { level: 'error', message: 'boom after script started' },
    ]);
  });
});

describe('run_script timeout resolution', () => {
  it('clamps to the documented budget window', () => {
    expect(resolveBrowserScriptTimeoutMs(undefined)).toBe(30_000);
    expect(resolveBrowserScriptTimeoutMs(100)).toBe(1_000);
    expect(resolveBrowserScriptTimeoutMs(1_000_000)).toBe(120_000);
    expect(resolveBrowserScriptTimeoutMs(45_000)).toBe(45_000);
  });
});
