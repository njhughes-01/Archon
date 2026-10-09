import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';

const mockDiscoverWorkflowsWithConfig = mock<typeof discoverWorkflowsWithConfig>(() =>
  Promise.resolve({ workflows: [], errors: [] })
);

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));

const mockLoadRepoConfig = mock(() => Promise.resolve(null));
const mockLoadConfig = mock(() =>
  Promise.resolve({
    assistant: 'claude',
    aliases: {},
    tiers: {},
    assistants: { claude: {} },
    envVars: undefined as Record<string, string> | undefined,
    modelRouter: undefined as { tiers: 'medium'[]; mode: 'shadow'; steps?: string[] } | undefined,
  })
);

mock.module('@archon/core', () => ({
  loadConfig: mockLoadConfig,
  loadRepoConfig: mockLoadRepoConfig,
}));

import { validateWorkflowsCommand } from './validate';

describe('validateWorkflowsCommand', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const mockConsoleLog = mock(() => {});
  const mockConsoleError = mock(() => {});
  let validationCwd: string;

  beforeEach(async () => {
    validationCwd = await mkdtemp(join(tmpdir(), 'archon-cli-validate-'));
    mockDiscoverWorkflowsWithConfig.mockClear();
    mockLoadRepoConfig.mockClear();
    mockLoadConfig.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    mockLoadRepoConfig.mockResolvedValue(null);
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
      assistants: { claude: {} },
      envVars: undefined,
      modelRouter: undefined,
    });
  });

  test('passes effective Claude config dir and user setting source into resource validation', async () => {
    const configDir = join(validationCwd, 'custom-claude');
    const skillDir = join(configDir, 'skills', 'custom-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# custom\n');
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
      assistants: { claude: { settingSources: ['user'] } },
      envVars: { CLAUDE_CONFIG_DIR: configDir },
      modelRouter: undefined,
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({
      workflows: [
        makeTestWorkflowWithSource(
          {
            name: 'custom-skill-workflow',
            provider: 'claude',
            nodes: [{ id: 'step1', prompt: 'hello', skills: ['custom-skill'] }],
          },
          'project'
        ),
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand(validationCwd);

    expect(exitCode).toBe(0);
    expect(JSON.stringify(mockConsoleLog.mock.calls)).toContain('1 valid, 0 with errors');
  });

  test('passes project-only Claude setting source so a custom user skill is rejected', async () => {
    const configDir = join(validationCwd, 'custom-claude');
    const skillDir = join(configDir, 'skills', 'user-only');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# user only\n');
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
      assistants: { claude: { settingSources: ['project'] } },
      envVars: { CLAUDE_CONFIG_DIR: configDir },
      modelRouter: undefined,
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({
      workflows: [
        makeTestWorkflowWithSource(
          {
            name: 'excluded-user-skill',
            provider: 'claude',
            nodes: [{ id: 'step1', prompt: 'hello', skills: ['user-only'] }],
          },
          'project'
        ),
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand(validationCwd);

    expect(exitCode).toBe(1);
    expect(JSON.stringify(mockConsoleLog.mock.calls)).toContain(
      "Claude skill 'user-only' not found"
    );
  });

  test('rejects bundled @custom model refs via discovered source', async () => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource(
          {
            name: 'bad-bundled',
            model: '@custom',
            nodes: [{ id: 'step1', prompt: 'hello' }],
          },
          'bundled'
        ),
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand('/tmp/repo');

    expect(exitCode).toBe(1);
    expect(JSON.stringify(mockConsoleLog.mock.calls)).toContain('@custom');
  });

  test('warns about a modelRouter.steps name that matches no step, without failing validation', async () => {
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
      assistants: { claude: {} },
      envVars: undefined,
      modelRouter: { tiers: ['medium'], mode: 'shadow', steps: ['summarise', 'sumarise'] },
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({
      workflows: [
        makeTestWorkflowWithSource(
          {
            name: 'listed-steps',
            provider: 'claude',
            nodes: [{ id: 'summarise', prompt: 'hello' }],
          },
          'project'
        ),
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand(validationCwd);

    expect(exitCode).toBe(0);
    const printed = JSON.stringify(mockConsoleLog.mock.calls);
    expect(printed).toContain('WARNING [modelRouter.steps]');
    expect(printed).toContain("is named 'sumarise'");
    expect(printed).toContain("Did you mean: 'summarise'?");
    expect(printed).not.toContain("is named 'summarise'");
  });

  test('says nothing about modelRouter.steps when every name matches or no list is set', async () => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({
      workflows: [
        makeTestWorkflowWithSource(
          {
            name: 'listed-steps',
            provider: 'claude',
            nodes: [{ id: 'summarise', prompt: 'hello' }],
          },
          'project'
        ),
      ],
      errors: [],
    });
    expect(await validateWorkflowsCommand(validationCwd)).toBe(0);
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
      assistants: { claude: {} },
      envVars: undefined,
      modelRouter: { tiers: ['medium'], mode: 'shadow', steps: ['summarise'] },
    });
    expect(await validateWorkflowsCommand(validationCwd)).toBe(0);
    expect(JSON.stringify(mockConsoleLog.mock.calls)).not.toContain('modelRouter.steps');
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    await rm(validationCwd, { recursive: true, force: true });
  });
});
