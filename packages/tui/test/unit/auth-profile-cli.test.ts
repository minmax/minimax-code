import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveTuiStartupEnvironmentOption } from '../../src/cli/environment.js';
import { createTuiProgram } from '../../src/cli/program.js';
import {
  runMcodeProfileCommand,
  type McodeProfileCliRequest,
} from '../../src/cli/profile-command.js';
import { resolveRestartArguments } from '../../src/tui/launcher.js';
import { resolveProfileDataDirPaths } from '@mavis/config';

function buildProgram(overrides: Record<string, unknown> = {}) {
  return createTuiProgram({
    version: '0.0.0-test',
    launchTui: vi.fn(async () => undefined),
    runExec: vi.fn(async () => undefined),
    runLogin: vi.fn(async () => undefined),
    runLogout: vi.fn(async () => undefined),
    runUpdate: vi.fn(async () => undefined),
    // Every subcommand needs a runner, otherwise the command parses the flag
    // correctly and then fails when it tries to launch.
    runAcp: vi.fn(async () => undefined),
    runTelemetry: vi.fn(async () => undefined),
    runProvider: vi.fn(async () => undefined),
    runPlugin: vi.fn(async () => undefined),
    ...overrides,
  } as Parameters<typeof createTuiProgram>[0]);
}

/**
 * Commander calls `process.exit` on a parse error by default, and the override
 * is per-command. Apply it to the whole tree so an invalid option surfaces as a
 * rejected promise on a subcommand instead of killing the runner.
 */
function buildRejectingProgram(overrides: Record<string, unknown> = {}) {
  const program = buildProgram(overrides);
  const applyTo = (command: ReturnType<typeof buildProgram>): void => {
    command.exitOverride();
    command.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    for (const child of command.commands) applyTo(child);
  };
  applyTo(program);
  return program;
}

describe('--profile is accepted on every command', () => {
  // enablePositionalOptions() confines root options to positions before the
  // subcommand, and most leaves call allowExcessArguments(false). Registering
  // the flag on the root alone would therefore break every subcommand form.
  it.each([
    ['root', ['--profile', 'work']],
    ['root with prompt', ['--profile', 'work', 'fix the build']],
    ['init', ['init', '--profile', 'work']],
    ['exec', ['exec', '--profile', 'work', 'fix the build']],
    ['exec review', ['exec', 'review', '--profile', 'work']],
    ['acp', ['acp', '--profile', 'work']],
    ['acp login', ['acp', 'login', '--profile', 'work']],
    ['login', ['login', '--profile', 'work']],
    ['logout', ['logout', '--profile', 'work']],
    ['update', ['update', '--profile', 'work']],
    ['telemetry status', ['telemetry', 'status', '--profile', 'work']],
    ['telemetry preview', ['telemetry', 'preview', '--profile', 'work']],
    ['provider list', ['provider', 'list', '--profile', 'work']],
    ['plugin list', ['plugin', 'list', '--profile', 'work']],
  ])('parses on %s', async (_label, argv) => {
    const program = buildProgram();
    await expect(
      program.parseAsync(['node', 'mcode', ...argv], { from: 'node' }),
    ).resolves.toBeDefined();
  });

  it('supports the --profile=<name> spelling', async () => {
    const program = buildProgram();
    await expect(
      program.parseAsync(['node', 'mcode', '--profile=work'], { from: 'node' }),
    ).resolves.toBeDefined();
  });

  it('advertises the flag in root help', async () => {
    const program = buildProgram();
    const help = program.helpInformation();
    expect(help).toContain('--profile');
  });

  it('rejects a traversal name before any command action runs', async () => {
    const launchTui = vi.fn(async () => undefined);
    const program = buildRejectingProgram({ launchTui });
    await expect(
      program.parseAsync(['node', 'mcode', '--profile', '../../etc'], { from: 'node' }),
    ).rejects.toThrow(/Invalid profile name/);
    expect(launchTui).not.toHaveBeenCalled();
  });

  it('rejects a traversal name on a subcommand too', async () => {
    const runLogin = vi.fn(async () => undefined);
    const program = buildRejectingProgram({ runLogin });
    await expect(
      program.parseAsync(['node', 'mcode', 'login', '--profile', '../evil'], { from: 'node' }),
    ).rejects.toThrow(/Invalid profile name/);
    expect(runLogin).not.toHaveBeenCalled();
  });

  it('fails when the flag has no value', async () => {
    const program = buildRejectingProgram();
    await expect(
      program.parseAsync(['node', 'mcode', '--profile'], { from: 'node' }),
    ).rejects.toThrow();
  });
});

describe('profile selection is not confused by adjacent options', () => {
  // resolveTuiStartupEnvironmentOption walks argv looking for --env. If it does
  // not know --profile consumes a value, it breaks on the profile name and
  // silently loses the --env that followed it.
  it('keeps --env discoverable after a profile flag', () => {
    expect(resolveTuiStartupEnvironmentOption(['--profile', 'work', '--env', 'test'], true)).toBe(
      'test',
    );
  });

  it('keeps --env discoverable before a profile flag', () => {
    expect(resolveTuiStartupEnvironmentOption(['--env', 'test', '--profile', 'work'], true)).toBe(
      'test',
    );
  });

  it('keeps --env discoverable after the --profile=<name> spelling', () => {
    expect(
      resolveTuiStartupEnvironmentOption(['--profile=work', '--env', 'test'], true),
    ).toBe('test');
  });

  it('still finds a bare prompt before options', () => {
    expect(resolveTuiStartupEnvironmentOption(['fix the build'], true)).toBeUndefined();
  });
});

describe('login restart preserves the profile', () => {
  // The restart rebuilds argv from scratch. Without replaying the profile, a
  // user who ran `mcode --profile work` lands in the default profile after
  // signing in, pointed at the wrong account.
  const executable = process.execPath;
  const entry = process.argv[1] ?? process.execPath;

  function restartArgs(userArgs: string[], sessionId?: string, prompt?: string): string[] {
    return resolveRestartArguments(executable, [executable, entry, ...userArgs], sessionId, prompt);
  }

  it('replays --profile <name> before the session and prompt', () => {
    const args = restartArgs(['--profile', 'work'], 'session-1', 'continue please');
    expect(args.slice(1)).toEqual([
      '--profile',
      'work',
      '--session',
      'session-1',
      'continue please',
    ]);
  });

  it('normalises the --profile=<name> spelling', () => {
    expect(restartArgs(['--profile=work']).slice(1)).toEqual(['--profile', 'work']);
  });

  it('adds nothing when no profile was requested', () => {
    expect(restartArgs(['--env', 'test']).slice(1)).toEqual(['--env', 'test']);
  });

  it('keeps the profile alongside a startup environment', () => {
    expect(restartArgs(['--env', 'test', '--profile', 'work']).slice(1)).toEqual([
      '--profile',
      'work',
      '--env',
      'test',
    ]);
  });

  it('does not treat a following flag as the profile name', () => {
    // Only --env, --profile, --session and the prompt are replayed, so the
    // dropped --model must not appear either; what matters is that `--model` was
    // not mistaken for a profile value.
    expect(restartArgs(['--profile', '--model', 'x']).slice(1)).toEqual([]);
  });

  it.each(['../../etc', '../evil', 'has space'])('drops an unusable name %j', (name) => {
    expect(restartArgs(['--profile', name]).slice(1)).toEqual([]);
    expect(restartArgs([`--profile=${name}`]).slice(1)).toEqual([]);
  });

  it('stops scanning at the -- terminator', () => {
    expect(restartArgs(['--', '--profile', 'work']).slice(1)).toEqual([]);
  });

  it('does not invent a profile from a bare prompt token', () => {
    // The prompt is supplied as a parameter, so a bare token left in argv is
    // not a profile and must not leak into the rebuilt command line.
    expect(restartArgs(['ship it']).slice(1)).toEqual([]);
    expect(restartArgs([], undefined, 'ship it').slice(1)).toEqual(['ship it']);
  });

  // The installed CLI is not launched through node, so argv has no entry-file
  // offset. Dropping the profile here would strand an installed user in the
  // default account after signing in.
  it('replays the profile when the executable is not node', () => {
    const installed = resolveRestartArguments(
      '/opt/homebrew/bin/mcode',
      ['/opt/homebrew/bin/mcode', '--profile', 'work'],
      'session-9',
    );
    expect(installed).toEqual(['--profile', 'work', '--session', 'session-9']);
  });

  it('replays the profile in the same order without node', () => {
    const installed = resolveRestartArguments(
      'mcode',
      ['mcode', '--env', 'test', '--profile=work'],
      undefined,
      'hello',
    );
    expect(installed).toEqual(['--profile', 'work', '--env', 'test', 'hello']);
  });
});

describe('mcode profile command', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-profile-cli-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function run(request: McodeProfileCliRequest, resolveProfile: string | null = null) {
    return runMcodeProfileCommand({
      request,
      homeDir: home,
      resolveProfile: () => resolveProfile,
    });
  }

  function seedProfile(name: string | null, credential = true): string {
    const dataDir = resolveProfileDataDirPaths(name, home).dataDir;
    const namespace = path.join(dataDir, 'auth', 'prod', 'cn', 'mcode-public');
    fs.mkdirSync(namespace, { recursive: true });
    fs.writeFileSync(
      path.join(namespace, 'auth-state.json'),
      JSON.stringify({ status: 'authenticated', buildEnv: 'prod', region: 'cn' }),
    );
    if (credential) fs.writeFileSync(path.join(namespace, 'auth.json'), '{}');
    return dataDir;
  }

  it('lists the default profile even on an empty home', async () => {
    const output = await run({ action: 'list' });
    expect(output).toContain('default (default)');
    expect(output).toContain('not created');
  });

  it('marks the selected profile and reports sign-in state', async () => {
    seedProfile('work');
    const output = await run({ action: 'list' }, 'work');
    const workLine = output.split('\n').find((line) => line.includes('work')) ?? '';
    expect(workLine.startsWith('*')).toBe(true);
    expect(workLine).toContain('signed in');
  });

  it('marks the default profile when no profile is selected', async () => {
    seedProfile(null);
    const output = await run({ action: 'list' }, null);
    const defaultLine = output.split('\n').find((line) => line.includes('(default)')) ?? '';
    expect(defaultLine.startsWith('*')).toBe(true);
  });

  it('emits machine-readable JSON', async () => {
    seedProfile('work');
    const output = await run({ action: 'list', json: true });
    const parsed = JSON.parse(output) as Array<{ name: string; authenticated: boolean }>;
    expect(parsed.map((profile) => profile.name)).toEqual(['default', 'work']);
    expect(parsed[1]).toMatchObject({ authenticated: true });
  });

  it('reports the current profile and its data directory', async () => {
    const output = await run({ action: 'current' }, 'work');
    expect(output).toContain('Current profile: work');
    expect(output).toContain(path.join(home, '.minimax-work'));
  });

  it('reports the default profile name when nothing is selected', async () => {
    const output = await run({ action: 'current' }, null);
    expect(output).toContain('Current profile: default');
    expect(output).toContain(path.join(home, '.minimax'));
  });

  it('removes a named profile after confirmation', async () => {
    const dataDir = seedProfile('work');
    fs.writeFileSync(path.join(dataDir, 'marker.txt'), 'x');
    const output = await run({ action: 'remove', name: 'work', confirmed: true });
    expect(output).toContain('Profile removed: work');
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('removes the legacy compat directory alongside it', async () => {
    seedProfile('work');
    const legacy = path.join(home, '.mavis-work');
    fs.mkdirSync(legacy, { recursive: true });
    await run({ action: 'remove', name: 'work', confirmed: true });
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('refuses to remove the default profile', async () => {
    seedProfile(null);
    await expect(run({ action: 'remove', name: 'default', confirmed: true })).rejects.toThrow(
      /Refusing to remove the default profile/,
    );
    expect(fs.existsSync(path.join(home, '.minimax'))).toBe(true);
  });

  it('refuses to remove without explicit confirmation', async () => {
    const dataDir = seedProfile('work');
    await expect(run({ action: 'remove', name: 'work', confirmed: false })).rejects.toThrow(
      /without --yes/,
    );
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it('refuses an unusable profile name before touching the disk', async () => {
    const outside = path.join(os.tmpdir(), `mcode-profile-outside-${process.pid}`);
    fs.mkdirSync(outside, { recursive: true });
    try {
      await expect(
        run({
          action: 'remove',
          name: `../mcode-profile-outside-${process.pid}`,
          confirmed: true,
        }),
      ).rejects.toThrow(/Invalid profile name/);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports a profile that has no data directory', async () => {
    await expect(
      run({ action: 'remove', name: 'ghost', confirmed: true }),
    ).rejects.toThrow(/no data directory/);
  });

  it('unlinks a symlinked profile directory instead of following it', async () => {
    const target = seedProfile('work');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-profile-target-'));
    fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'keep');
    const link = path.join(home, '.minimax-work');
    fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(elsewhere, link, 'dir');
    try {
      await run({ action: 'remove', name: 'work', confirmed: true });
      expect(fs.existsSync(link)).toBe(false);
      // Following the link would have destroyed unrelated files.
      expect(fs.existsSync(path.join(elsewhere, 'keep.txt'))).toBe(true);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // After an upgrade from the `~/.mavis-<name>` layout the current directory may
  // be gone. Refusing here would strand the user's only remaining copy.
  it('removes a profile that survives only in the legacy directory', async () => {
    const legacy = path.join(home, '.mavis-old');
    fs.mkdirSync(legacy, { recursive: true });
    const output = await run({ action: 'remove', name: 'old', confirmed: true });
    expect(output).toContain('Profile removed: old');
    expect(fs.existsSync(legacy)).toBe(false);
  });
});

describe('the reported profile matches the directory the process is using', () => {
  // `profile current` used to read the environment directly, which put it out
  // of step with `getProfile()` (flag, then env). It could then announce an
  // account other than the one whose data directory was actually opened.
  const originalArgv = process.argv;
  const originalEnv = process.env.MINIMAX_PROFILE;

  afterEach(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.MINIMAX_PROFILE;
    else process.env.MINIMAX_PROFILE = originalEnv;
  });

  it('prefers the flag over the environment', async () => {
    process.env.MINIMAX_PROFILE = 'from-env';
    process.argv = ['node', 'mcode', '--profile', 'from-flag'];
    const output = await runMcodeProfileCommand({
      request: { action: 'current' },
      homeDir: os.tmpdir(),
    });
    expect(output).toContain('Current profile: from-flag');
  });

  it('falls back to the environment when the flag is absent', async () => {
    process.env.MINIMAX_PROFILE = 'from-env';
    process.argv = ['node', 'mcode'];
    const output = await runMcodeProfileCommand({
      request: { action: 'current' },
      homeDir: os.tmpdir(),
    });
    expect(output).toContain('Current profile: from-env');
  });

  it('reports the default profile when neither selector is set', async () => {
    delete process.env.MINIMAX_PROFILE;
    process.argv = ['node', 'mcode'];
    const output = await runMcodeProfileCommand({
      request: { action: 'current' },
      homeDir: os.tmpdir(),
    });
    expect(output).toContain('Current profile: default');
  });
});
