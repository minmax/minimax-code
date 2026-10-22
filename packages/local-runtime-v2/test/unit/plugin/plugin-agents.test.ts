import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readAgentPluginPackage } from '../../../src/service/plugin-system/plugin/package/agent-plugin-reader.js';

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

let root: string;
let dataDir: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'plugin-agents-'));
  dataDir = await mkdtemp(path.join(tmpdir(), 'plugin-agents-data-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

async function writePlugin(name: string, files: Record<string, string>): Promise<string> {
  const pluginRoot = path.join(root, name);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(pluginRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return pluginRoot;
}

const options = { get dataDir(): string {
  return dataDir;
} };

describe('local plugin agent definitions', () => {
  it('reads agents/<name>/AGENT.md into scoped definitions', async () => {
    const pluginRoot = await writePlugin('helper-tools', {
      'plugin.json': JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'helper-tools' }),
      'agents/code-reviewer/AGENT.md':
        '---\nname: code-reviewer\ndescription: Reviews patches for correctness\n---\nReview the diff carefully.\n',
    });
    const pkg = await readAgentPluginPackage(pluginRoot, options);
    expect(pkg.agents).toHaveLength(1);
    const agent = pkg.agents?.[0];
    expect(agent).toMatchObject({
      name: 'code-reviewer',
      scopedName: 'helper-tools:code-reviewer',
      description: 'Reviews patches for correctness',
      systemPrompt: 'Review the diff carefully.',
    });
    expect(agent?.content).toContain('Review the diff carefully.');
    expect(agent?.sourcePath).toBe('agents/code-reviewer/AGENT.md');
  });

  it('reads a flat agents/<name>.md file', async () => {
    const pluginRoot = await writePlugin('flat-agents', {
      'plugin.json': JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'flat-agents' }),
      'agents/doc-writer.md':
        '---\nname: doc-writer\ndescription: Writes docs\n---\nBody.\n',
    });
    const pkg = await readAgentPluginPackage(pluginRoot, options);
    expect(pkg.agents?.[0]).toMatchObject({
      name: 'doc-writer',
      scopedName: 'flat-agents:doc-writer',
    });
  });

  it('collects a diagnostic instead of failing on an invalid agent', async () => {
    const pluginRoot = await writePlugin('broken-agents', {
      'plugin.json': JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'broken-agents' }),
      'agents/Bad_Name/AGENT.md': '---\nname: Bad_Name\ndescription: x\n---\nBody.\n',
      'skills/real-skill/SKILL.md':
        '---\nname: real-skill\ndescription: A real skill\n---\nBody.\n',
    });
    const pkg = await readAgentPluginPackage(pluginRoot, options);
    expect(pkg.agents).toBeUndefined();
    expect(pkg.diagnostics).toContainEqual(
      expect.objectContaining({ capability: 'AGENT', name: 'Bad_Name' }),
    );
    expect(pkg.skills).toHaveLength(1);
  });

  it('parses optional capability fields from the frontmatter', async () => {
    const pluginRoot = await writePlugin('capable-agents', {
      'plugin.json': JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'capable-agents' }),
      'agents/scoped-runner/AGENT.md':
        '---\nname: scoped-runner\ndescription: Runs checks\nmodel: inherit\neffort: high\ntools:\n  - read\n  - bash\ndisallowedTools:\n  - write\nskills:\n  - code-review\n---\nRun the checks.\n',
    });
    const pkg = await readAgentPluginPackage(pluginRoot, options);
    expect(pkg.agents?.[0]).toMatchObject({
      name: 'scoped-runner',
      model: 'inherit',
      effort: 'high',
      tools: ['read', 'bash'],
      disallowedTools: ['write'],
      skills: ['code-review'],
      systemPrompt: 'Run the checks.',
    });
  });

  it('collects a diagnostic for a non-array tools field', async () => {
    const pluginRoot = await writePlugin('bad-tools', {
      'plugin.json': JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'bad-tools' }),
      'agents/checker/AGENT.md':
        '---\nname: checker\ndescription: x\ntools: read\n---\nBody.\n',
      'skills/real-skill/SKILL.md':
        '---\nname: real-skill\ndescription: A real skill\n---\nBody.\n',
    });
    const pkg = await readAgentPluginPackage(pluginRoot, options);
    expect(pkg.agents).toBeUndefined();
    expect(pkg.diagnostics).toContainEqual(
      expect.objectContaining({ capability: 'AGENT', name: 'checker' }),
    );
  });

  it('returns no agents field when the directory is absent', async () => {
    const pluginRoot = await writePlugin('no-agents', {
      'plugin.json': JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'no-agents' }),
    });
    const pkg = await readAgentPluginPackage(pluginRoot, options);
    expect(pkg.agents).toBeUndefined();
    expect(pkg.diagnostics).toHaveLength(0);
  });
});
