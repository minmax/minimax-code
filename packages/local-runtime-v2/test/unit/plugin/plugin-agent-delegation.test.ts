import { describe, expect, it } from 'vitest';

import type { PluginAgentRuntimeDefinition } from '@mavis/agent-tools/desktop';
import { createPluginAgentsRegistry } from '../../../src/service/turn-system/agent-host/assembly/plugin-agents-registry.js';
import { resolveLocalTaskAgentTarget } from '../../../../local-runtime/src/api/local-task-subagents.js';
import { substitutePluginTokens } from '../../../src/application/session/task-agent-binding-capture.js';

function declaration(overrides: Partial<PluginAgentRuntimeDefinition> = {}): PluginAgentRuntimeDefinition {
  return {
    pluginName: 'team-tools',
    name: 'team-tools:reviewer',
    agentName: 'reviewer',
    description: 'Reviews patches',
    systemPrompt: 'Review carefully.',
    pluginRoot: '/tmp/plugins/team-tools',
    packageDigest: 'digest-1',
    sourceKind: 'local',
    ...overrides,
  };
}

describe('plugin agents registry', () => {
  it('resolves a scoped name case- and whitespace-insensitively', () => {
    const registry = createPluginAgentsRegistry({
      agents: [declaration()],
    });
    expect(registry.resolve('team-tools:reviewer')?.agentName).toBe('reviewer');
    expect(registry.resolve('  Team-Tools:Reviewer ')?.pluginName).toBe('team-tools');
    expect(registry.resolve('team-tools:missing')).toBeUndefined();
  });

  it('resolves a bare name only when exactly one declaration matches', () => {
    const registry = createPluginAgentsRegistry({
      agents: [declaration(), declaration({ pluginName: 'other', name: 'other:writer', agentName: 'writer' })],
    });
    expect(registry.resolveByBareName('writer')?.name).toBe('other:writer');
    expect(registry.resolveByBareName('missing')).toBeUndefined();

    const ambiguous = createPluginAgentsRegistry({
      agents: [declaration(), declaration({ pluginName: 'dup', name: 'dup:reviewer' })],
    });
    expect(ambiguous.resolveByBareName('reviewer')).toBeUndefined();
  });

  it('lists entries sorted by scoped name', () => {
    const registry = createPluginAgentsRegistry({
      agents: [declaration({ name: 'b:x', agentName: 'x' }), declaration({ name: 'a:y', agentName: 'y' })],
    });
    expect(registry.list().map((entry) => entry.name)).toEqual(['a:y', 'b:x']);
  });
});

describe('local task agent target: plugin branch', () => {
  const notFoundError = Object.assign(new Error('Unknown agent'), { code: 'UNKNOWN_AGENT_NAME' });
  function hostWithResolver() {
    const calls: string[] = [];
    return {
      calls,
      host: {
        agentResolver: {
          async resolveAgentReadScope(name: string) {
            calls.push(`scope:${name}`);
            throw notFoundError;
          },
          async resolveAgentWriteTarget(name: string) {
            calls.push(`write:${name}`);
            throw notFoundError;
          },
          async requireExactAgentKey(name: string) {
            calls.push(`key:${name}`);
            throw notFoundError;
          },
          async resolveAgentExecutionTarget(name: string) {
            calls.push(`exec:${name}`);
            throw notFoundError;
          },
        },
      },
    };
  }

  it('resolves a scoped plugin name without touching the persisted roster', async () => {
    const { host, calls } = hostWithResolver();
    const registry = createPluginAgentsRegistry({ agents: [declaration()] });
    const target = await resolveLocalTaskAgentTarget(host, 'team-tools:reviewer', registry);
    expect(target?.source).toBe('plugin');
    expect(target?.resolvedAgentName).toBe('team-tools:reviewer');
    expect(target?.pluginAgent?.systemPrompt).toBe('Review carefully.');
    expect(calls).toEqual([]);
  });

  it('falls back to the registry by bare name after the roster misses', async () => {
    const { host, calls } = hostWithResolver();
    const registry = createPluginAgentsRegistry({ agents: [declaration()] });
    const target = await resolveLocalTaskAgentTarget(host, 'reviewer', registry);
    expect(target?.source).toBe('plugin');
    expect(target?.pluginAgent?.name).toBe('team-tools:reviewer');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('never routes the reserved agent: prefix into the plugin branch', async () => {
    const { host, calls } = hostWithResolver();
    const registry = createPluginAgentsRegistry({ agents: [declaration()] });
    const target = await resolveLocalTaskAgentTarget(host, 'agent:something', registry);
    expect(target).toBeUndefined();
    expect(calls.some((call) => call.startsWith('scope:agent:'))).toBe(true);
  });

  it('returns undefined when nothing matches', async () => {
    const { host } = hostWithResolver();
    const registry = createPluginAgentsRegistry({ agents: [declaration()] });
    expect(await resolveLocalTaskAgentTarget(host, 'nobody', registry)).toBeUndefined();
  });
});

describe('plugin agent prompt tokens', () => {
  it('substitutes the root and data placeholder family', () => {
    const prompt = substitutePluginTokens(
      [
        `root=\u0024{PLUGIN_ROOT}`,
        `claude=\u0024{CLAUDE_PLUGIN_ROOT}`,
        `data=\u0024{PLUGIN_DATA}`,
        `named=\u0024{TEAM_TOOLS_PLUGIN_ROOT}`,
      ].join('\n'),
      { pluginRoot: '/plugins/team-tools', pluginDataDir: '/data/plugins/team-tools' },
    );
    expect(prompt).toContain('root=/plugins/team-tools');
    expect(prompt).toContain('claude=/plugins/team-tools');
    expect(prompt).toContain('data=/data/plugins/team-tools');
    expect(prompt).toContain('named=/plugins/team-tools');
  });
});
