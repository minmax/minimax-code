import type { PluginAgentRuntimeDefinition, PluginAgentsRegistry } from '@mavis/agent-tools/desktop';
import type { AgentHostTurnAgentCapability } from './turn-capability-lifecycle.js';

/**
 * Immutable per-turn lookup of plugin-declared subagents — the counterpart of
 * the upstream registry built from `desktopCapabilities.agents`. Names are
 * matched NFKC/lowercase so "`Plugin`: `Agent`" in prose resolves like the
 * declaration; a bare agent name resolves only when exactly one plugin
 * declares it.
 */
export function createPluginAgentsRegistry(capabilities: {
  readonly agents?: readonly AgentHostTurnAgentCapability[];
}): PluginAgentsRegistry {
  const byScopedName = new Map<string, PluginAgentRuntimeDefinition>();
  const byBareName = new Map<string, PluginAgentRuntimeDefinition[]>();
  for (const capability of capabilities.agents ?? []) {
    const definition: PluginAgentRuntimeDefinition = capability;
    byScopedName.set(normalizeKey(capability.name), definition);
    const bare = normalizeKey(capability.agentName);
    const bucket = byBareName.get(bare);
    if (bucket) bucket.push(definition);
    else byBareName.set(bare, [definition]);
  }
  return {
    list: () => [...byScopedName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    resolve: (name) => byScopedName.get(normalizeKey(name)),
    resolveByBareName: (name) => {
      const bucket = byBareName.get(normalizeKey(name));
      return bucket?.length === 1 ? bucket[0] : undefined;
    },
  };
}

function normalizeKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
