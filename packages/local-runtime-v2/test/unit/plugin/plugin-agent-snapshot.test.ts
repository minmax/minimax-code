import { describe, expect, it } from 'vitest';

import type {
  PluginAgentDefinition,
  ReadPluginPackage,
} from '../../../src/service/plugin-system/plugin/package/types.js';
import { PluginSnapshotBuilder } from '../../../src/service/plugin-system/plugin/runtime/snapshot-builder.js';

function agentDeclaration(overrides: Partial<PluginAgentDefinition> = {}): PluginAgentDefinition {
  return {
    name: 'reviewer',
    scopedName: 'team-tools:reviewer',
    description: 'Reviews patches',
    content: '---\nname: reviewer\ndescription: Reviews patches\n---\nBody.',
    sourcePath: 'agents/reviewer/AGENT.md',
    systemPrompt: 'Review carefully.',
    ...overrides,
  };
}

function pluginPackage(overrides: {
  readonly name?: string;
  readonly agents?: readonly PluginAgentDefinition[];
  readonly skills?: ReadPluginPackage['skills'];
}): ReadPluginPackage {
  return {
    source: 'LOCAL_AGENT_PLUGIN',
    manifestKind: 'AGENT_PLUGINS_V1',
    rootPath: `/tmp/plugins/${overrides.name ?? 'team-tools'}`,
    manifestPath: 'plugin.json',
    name: overrides.name ?? 'team-tools',
    category: 'Other',
    exampleQueries: [],
    apps: [],
    mcpServers: [],
    skills: overrides.skills ?? [],
    ...(overrides.agents ? { agents: overrides.agents } : {}),
    hooks: [],
    diagnostics: [],
  };
}

function build(input: Parameters<PluginSnapshotBuilder['build']>[0]) {
  return new PluginSnapshotBuilder().build(input);
}

const emptyReservations = { skillNames: [], mcpServerNames: [], toolNames: [] };

describe('plugin snapshot: declared agents', () => {
  it('projects enabled local plugin agents into turn capabilities, sorted by scoped name', () => {
    const snapshot = build({
      revision: 'r1',
      officialPackages: [],
      localPackages: [
        {
          plugin: pluginPackage({
            agents: [
              agentDeclaration({ name: 'writer', scopedName: 'team-tools:writer', systemPrompt: 'Write.' }),
              agentDeclaration(),
            ],
          }),
          contentDigest: 'digest-1',
        },
      ],
      isLocalEnabled: () => true,
      reservations: emptyReservations,
    });
    expect(snapshot.turnCapabilities.agents?.map((agent) => agent.name)).toEqual([
      'team-tools:reviewer',
      'team-tools:writer',
    ]);
    const reviewer = snapshot.turnCapabilities.agents?.[0];
    expect(reviewer).toMatchObject({
      pluginName: 'team-tools',
      agentName: 'reviewer',
      description: 'Reviews patches',
      systemPrompt: 'Review carefully.',
      pluginRoot: '/tmp/plugins/team-tools',
      packageDigest: 'digest-1',
      sourceKind: 'local',
    });
    expect(snapshot.agents).toHaveLength(2);
  });

  it('drops agents from a disabled local plugin', () => {
    const snapshot = build({
      revision: 'r1',
      officialPackages: [],
      localPackages: [
        { plugin: pluginPackage({ agents: [agentDeclaration()] }), contentDigest: 'digest-1' },
      ],
      isLocalEnabled: () => false,
      reservations: emptyReservations,
    });
    expect(snapshot.turnCapabilities.agents ?? []).toEqual([]);
  });

  it('reports a conflict for a duplicated scoped name and keeps the first', () => {
    const snapshot = build({
      revision: 'r1',
      officialPackages: [],
      localPackages: [
        {
          plugin: pluginPackage({ name: 'alpha', agents: [agentDeclaration({ scopedName: 'shared:agent' })] }),
          contentDigest: 'digest-a',
        },
        {
          plugin: pluginPackage({ name: 'beta', agents: [agentDeclaration({ scopedName: 'shared:agent' })] }),
          contentDigest: 'digest-b',
        },
      ],
      isLocalEnabled: () => true,
      reservations: emptyReservations,
    });
    expect(snapshot.turnCapabilities.agents).toHaveLength(1);
    expect(snapshot.turnCapabilities.agents?.[0]?.pluginName).toBe('alpha');
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'LOCAL_AGENT_NAME_CONFLICT',
        pluginName: 'beta',
        capabilityName: 'shared:agent',
      }),
    );
  });
});
