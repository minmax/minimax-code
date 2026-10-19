import type { PluginAgentsRegistry } from '@mavis/agent-tools/desktop';
import {
  resolveTaskTarget,
  type AgentReferenceResolver,
  type LocalTaskTargetFacts,
} from '../agent/port.js';
import {
  SUBAGENT_TELEMETRY_EVENT,
  emitSubagentTelemetry,
  inferNameResolutionSource,
  telemetryErrorCode,
} from '../agent/subagent-telemetry.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';

export interface LocalTaskAgentResolverHost {
  agentResolver: AgentReferenceResolver;
  metrics?: ModuleMetricsReporter;
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void;
}

export async function resolveLocalTaskAgentTarget(
  host: LocalTaskAgentResolverHost,
  agentName: string | undefined,
  pluginAgents?: PluginAgentsRegistry,
): Promise<LocalTaskTargetFacts | undefined> {
  if (!agentName) return undefined;
  const requested = agentName.trim();
  if (!requested) return undefined;

  // Upstream resolution order: a scoped "<plugin>:<agent>" name resolves from
  // the plugin registry without consulting the persisted roster; the persisted
  // resolver runs next; a bare name falls back to the plugin registry only when
  // exactly one declaration matches.
  if (isPluginScopedName(requested)) {
    const pluginAgent = pluginAgents?.resolve(requested);
    if (pluginAgent) {
      emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, {
        source: 'plugin',
        success: true,
      });
      return pluginTargetFacts(requested, pluginAgent);
    }
  }

  let source = inferNameResolutionSource(requested);
  try {
    const resolved = await resolveTaskTarget(host.agentResolver, requested);
    source = inferNameResolutionSource(requested, resolved.resolvedAgentName);
    emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, { source, success: true });
    return resolved;
  } catch (error) {
    const notFound =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as { code?: unknown }).code === 'UNKNOWN_AGENT_NAME' ||
        (error as { code?: unknown }).code === 'AGENT_NOT_FOUND');
    if (notFound && !requested.toLowerCase().startsWith('agent:')) {
      const pluginAgent = pluginAgents?.resolveByBareName(requested);
      if (pluginAgent) {
        emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, {
          source: 'plugin',
          success: true,
        });
        return pluginTargetFacts(requested, pluginAgent);
      }
    }
    emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, {
      source,
      success: false,
      ...(telemetryErrorCode(error) ? { error_code: telemetryErrorCode(error)! } : {}),
    });
    if (notFound) return undefined;
    throw error;
  }
}

function isPluginScopedName(name: string): boolean {
  const lowered = name.toLowerCase();
  return name.includes(':') && !lowered.startsWith('agent:');
}

function pluginTargetFacts(
  requested: string,
  pluginAgent: NonNullable<ReturnType<PluginAgentsRegistry['resolve']>>,
): LocalTaskTargetFacts {
  return {
    requestedName: requested,
    exactOwnerName: pluginAgent.name,
    resolvedAgentName: pluginAgent.name,
    canonicalViewName: pluginAgent.name,
    trustedBuiltin: false,
    source: 'plugin',
    pluginAgent,
  };
}

export async function resolveLocalTaskAgentName(
  host: LocalTaskAgentResolverHost,
  agentName: string | undefined,
): Promise<string | undefined> {
  return (await resolveLocalTaskAgentTarget(host, agentName))?.resolvedAgentName;
}
