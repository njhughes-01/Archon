import { describe, expect, mock, test, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolActionDecision, ToolActionRequest } from '../../types';
import { resolvePiSkills, resolvePiThinkingLevel, resolvePiTools } from './options-translator';
import { gatePiBuiltinTools, gatePiNativeTools } from './tool-gate';

// ─── resolvePiThinkingLevel ─────────────────────────────────────────────

describe('resolvePiThinkingLevel', () => {
  test('returns undefined when no config provided', () => {
    expect(resolvePiThinkingLevel(undefined)).toEqual({ level: undefined });
  });

  test('returns undefined for empty config', () => {
    expect(resolvePiThinkingLevel({})).toEqual({ level: undefined });
  });

  test('maps valid effort string directly', () => {
    expect(resolvePiThinkingLevel({ effort: 'medium' })).toEqual({ level: 'medium' });
    expect(resolvePiThinkingLevel({ effort: 'low' })).toEqual({ level: 'low' });
  });

  // Pi's native `ThinkingLevel` matches Archon's ladder through `max`
  // (@earendil-works/pi-ai types.d.ts); Codex-only `ultra` clamps separately.
  // This previously asserted a downgrade to
  // `xhigh`, which was the bug: `effort: max` meant "as deep as this model goes"
  // everywhere except Pi, where a rung was quietly removed before Pi could apply
  // its own per-model handling.
  test("'max' reaches Pi natively rather than being downgraded", () => {
    expect(resolvePiThinkingLevel({ effort: 'max' })).toEqual({ level: 'max' });
  });

  test('every Pi-native rung passes through unclamped', () => {
    for (const rung of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(resolvePiThinkingLevel({ effort: rung })).toEqual({ level: rung });
    }
  });

  test("'ultra' clamps to Pi's strongest native rung", () => {
    expect(resolvePiThinkingLevel({ effort: 'ultra' })).toEqual({ level: 'max' });
    expect(resolvePiThinkingLevel({ effort: 'persistent' })).toEqual({ level: 'max' });
  });

  test('no warning when effort is absent', () => {
    expect(resolvePiThinkingLevel({})).toEqual({ level: undefined });
    expect(resolvePiThinkingLevel({ effort: undefined })).toEqual({
      level: undefined,
    });
  });
});

// ─── resolvePiTools ─────────────────────────────────────────────────────

describe('resolvePiTools', () => {
  const cwd = '/tmp/test-cwd';

  test('returns undefined tools when neither allowed_tools nor denied_tools set', () => {
    expect(resolvePiTools(cwd, undefined)).toEqual({ tools: undefined, unknownTools: [] });
    expect(resolvePiTools(cwd, {})).toEqual({ tools: undefined, unknownTools: [] });
  });

  test('allowed_tools: [] returns empty tools array (no-tools idiom)', () => {
    const result = resolvePiTools(cwd, { allowed_tools: [] });
    expect(result.tools).toEqual([]);
    expect(result.unknownTools).toEqual([]);
  });

  test('allowed_tools: [read, bash] returns exactly those two', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'bash'] });
    expect(result.tools).toHaveLength(2);
    expect(result.unknownTools).toEqual([]);
  });

  test('case-insensitive tool names', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['Read', 'BASH', 'Edit'] });
    expect(result.tools).toHaveLength(3);
    expect(result.unknownTools).toEqual([]);
  });

  test('unknown tool names (Claude-specific) collected in unknownTools', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'WebFetch', 'bash'] });
    expect(result.tools).toHaveLength(2);
    expect(result.unknownTools).toEqual(['WebFetch']);
  });

  test('denied_tools subtracts from allowed_tools', () => {
    const result = resolvePiTools(cwd, {
      allowed_tools: ['read', 'bash', 'edit'],
      denied_tools: ['bash'],
    });
    expect(result.tools).toHaveLength(2);
    expect(result.unknownTools).toEqual([]);
  });

  // ─── restrictFileWrites: the provider-neutral "no file writes" intent ────

  const toolNames = (result: ReturnType<typeof resolvePiTools>): string[] | undefined =>
    result.tools?.map(tool => tool.name);

  test('restrictFileWrites leaves Pi its default tools minus edit and write', () => {
    // Not `denied_tools`: that starts from all seven built-ins and would hand
    // the chat grep/find/ls it does not have today.
    const result = resolvePiTools(cwd, undefined, undefined, true);
    expect(toolNames(result)).toEqual(['read', 'bash']);
    expect(result.unknownTools).toEqual([]);
  });

  test('restrictFileWrites holds when env forces a custom bash tool', () => {
    const result = resolvePiTools(cwd, undefined, { DATABASE_URL: 'postgres://x' }, true);
    expect(toolNames(result)).toEqual(['read', 'bash']);
  });

  test('restrictFileWrites removes edit and write from an explicit allow list', () => {
    const result = resolvePiTools(
      cwd,
      { allowed_tools: ['read', 'edit', 'write'] },
      undefined,
      true
    );
    expect(toolNames(result)).toEqual(['read']);
  });

  test('restrictFileWrites removes edit and write from a deny-list selection', () => {
    const result = resolvePiTools(cwd, { denied_tools: ['bash'] }, undefined, true);
    expect(toolNames(result)).toEqual(['read', 'grep', 'find', 'ls']);
  });

  test('without restrictFileWrites edit and write stay available', () => {
    const result = resolvePiTools(cwd, undefined, { DATABASE_URL: 'postgres://x' });
    expect(toolNames(result)).toEqual(['read', 'bash', 'edit', 'write']);
  });

  test('denied_tools alone starts from full built-in set', () => {
    const result = resolvePiTools(cwd, { denied_tools: ['bash', 'write'] });
    // Pi has 7 built-in tools, 2 denied → 5 remain
    expect(result.tools).toHaveLength(5);
    expect(result.unknownTools).toEqual([]);
  });

  test('dedupes duplicate tool names', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'read', 'Read'] });
    expect(result.tools).toHaveLength(1);
  });

  test('allowed and denied both with unknowns flags each', () => {
    const result = resolvePiTools(cwd, {
      allowed_tools: ['read', 'UnknownA'],
      denied_tools: ['UnknownB'],
    });
    expect(result.tools).toHaveLength(1); // only 'read'
    expect(result.unknownTools).toEqual(['UnknownA', 'UnknownB']);
  });

  test('no allow/deny with non-empty env → returns Pi default 4-tool set with env-aware bash', () => {
    const result = resolvePiTools(cwd, undefined, { DATABASE_URL: 'postgres://x' });
    expect(result.tools).toHaveLength(4); // read/bash/edit/write
    expect(result.unknownTools).toEqual([]);
  });

  test('no allow/deny with empty env → still returns undefined (Pi defaults)', () => {
    expect(resolvePiTools(cwd, undefined, {})).toEqual({ tools: undefined, unknownTools: [] });
    expect(resolvePiTools(cwd, {}, {})).toEqual({ tools: undefined, unknownTools: [] });
  });

  test('env passthrough does not affect unknown tool reporting', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'WebFetch'] }, { FOO: 'bar' });
    expect(result.tools).toHaveLength(1);
    expect(result.unknownTools).toEqual(['WebFetch']);
  });
});

// ─── resolvePiSkills ───────────────────────────────────────────────────────
//
// Uses a temp directory to stage synthetic skill layouts — avoids relying on
// whatever the developer has in ~/.claude/skills/ or ~/.agents/skills/.

describe('resolvePiSkills', () => {
  let tmpRoot: string;
  let cwd: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'archon-pi-skills-'));
    cwd = join(tmpRoot, 'project');
    const home = join(tmpRoot, 'home');

    // Redirect os.homedir() by setting HOME before imports use it. Our
    // resolver calls homedir() at function-call time (not module load),
    // so setting HOME mid-test is safe.
    originalHome = process.env.HOME;
    process.env.HOME = home;

    // Staging:
    //   <cwd>/.agents/skills/alpha/SKILL.md
    //   <cwd>/.claude/skills/bravo/SKILL.md
    //   <home>/.agents/skills/charlie/SKILL.md
    //   <home>/.claude/skills/delta/SKILL.md
    //   <home>/.claude/skills/shared/SKILL.md  (also in <cwd>/.claude/skills/shared/)
    //   <cwd>/.claude/skills/shared/SKILL.md
    const stage = [
      [join(cwd, '.agents', 'skills', 'alpha'), 'SKILL.md'],
      [join(cwd, '.claude', 'skills', 'bravo'), 'SKILL.md'],
      [join(home, '.agents', 'skills', 'charlie'), 'SKILL.md'],
      [join(home, '.claude', 'skills', 'delta'), 'SKILL.md'],
      [join(cwd, '.claude', 'skills', 'shared'), 'SKILL.md'],
      [join(home, '.claude', 'skills', 'shared'), 'SKILL.md'],
      // A dir without SKILL.md — must not resolve
      [join(cwd, '.claude', 'skills', 'no-skill-md'), '.keep'],
    ];
    for (const [dir, file] of stage) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), '# skill content\n');
    }
  });

  afterAll(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('returns empty for undefined/empty input', () => {
    expect(resolvePiSkills(cwd, undefined)).toEqual({ paths: [], missing: [] });
    expect(resolvePiSkills(cwd, [])).toEqual({ paths: [], missing: [] });
  });

  test('resolves project-local .agents/skills', () => {
    const result = resolvePiSkills(cwd, ['alpha']);
    expect(result.missing).toEqual([]);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toContain(join('.agents', 'skills', 'alpha'));
  });

  test('resolves project-local .claude/skills', () => {
    const result = resolvePiSkills(cwd, ['bravo']);
    expect(result.missing).toEqual([]);
    expect(result.paths[0]).toContain(join('.claude', 'skills', 'bravo'));
  });

  test('resolves user-global .agents/skills', () => {
    const result = resolvePiSkills(cwd, ['charlie']);
    expect(result.missing).toEqual([]);
    expect(result.paths[0]).toContain(join('.agents', 'skills', 'charlie'));
  });

  test('resolves user-global .claude/skills', () => {
    const result = resolvePiSkills(cwd, ['delta']);
    expect(result.missing).toEqual([]);
    expect(result.paths[0]).toContain(join('.claude', 'skills', 'delta'));
  });

  test('project-local wins over user-global when both present', () => {
    const result = resolvePiSkills(cwd, ['shared']);
    expect(result.missing).toEqual([]);
    expect(result.paths[0]).toContain(join(cwd, '.claude', 'skills', 'shared'));
  });

  test('dir without SKILL.md does not resolve', () => {
    const result = resolvePiSkills(cwd, ['no-skill-md']);
    expect(result.paths).toEqual([]);
    expect(result.missing).toEqual(['no-skill-md']);
  });

  test('unknown skill name is reported in missing', () => {
    const result = resolvePiSkills(cwd, ['does-not-exist']);
    expect(result.paths).toEqual([]);
    expect(result.missing).toEqual(['does-not-exist']);
  });

  test('mixed resolvable + unresolvable returns both', () => {
    const result = resolvePiSkills(cwd, ['alpha', 'does-not-exist', 'bravo']);
    expect(result.paths).toHaveLength(2);
    expect(result.missing).toEqual(['does-not-exist']);
  });

  test('dedupes duplicate names', () => {
    const result = resolvePiSkills(cwd, ['alpha', 'alpha']);
    expect(result.paths).toHaveLength(1);
  });

  test('ignores empty-string and non-string names', () => {
    const result = resolvePiSkills(cwd, ['', 'alpha']);
    expect(result.paths).toHaveLength(1);
  });
});

// ─── toolGate: wrapping Pi tools with the Tool Action Gate ──────────────

describe('gatePiBuiltinTools / gatePiNativeTools', () => {
  const cwd = '/tmp/pi-gate-cwd';
  const DENIAL: ToolActionDecision = {
    action: 'deny',
    needsApproval: true,
    reason: 'It deletes every file under the home directory.',
    alternatives: [
      'Remove one named directory inside the repository.',
      'Report the work as blocked.',
    ],
    ruleId: 'recursive-rm',
  };
  type GateStub = (request: ToolActionRequest) => Promise<ToolActionDecision>;

  function fakeTool(name: string): {
    name: string;
    label: string;
    execute: ReturnType<typeof mock<(...args: unknown[]) => Promise<string>>>;
  } {
    return {
      name,
      label: name,
      execute: mock(async (..._args: unknown[]) => `${name} ran`),
    };
  }

  test('a denied call never runs the tool and throws the reason and every alternative', async () => {
    const gate = mock<GateStub>(async () => DENIAL);
    const bash = fakeTool('bash');
    const [gated] = gatePiBuiltinTools([bash], gate, cwd);

    let thrown: Error | undefined;
    try {
      await gated.execute('call-1', { command: 'rm -rf ~' });
    } catch (err) {
      thrown = err as Error;
    }

    expect(bash.execute).not.toHaveBeenCalled();
    // Pi turns a thrown execute into an error tool result carrying the message.
    expect(thrown?.message).toContain('It deletes every file under the home directory.');
    expect(thrown?.message).toContain('Remove one named directory inside the repository.');
    expect(thrown?.message).toContain('Report the work as blocked.');
  });

  test('an allowed call runs the tool with every argument and returns its result', async () => {
    const gate = mock<GateStub>(async () => ({ action: 'allow' }));
    const bash = fakeTool('bash');
    const [gated] = gatePiBuiltinTools([bash], gate, cwd);
    const signal = new AbortController().signal;
    const onUpdate = (): void => undefined;
    const ctx = { ui: 'ctx' };

    const result = await gated.execute('call-1', { command: 'git status' }, signal, onUpdate, ctx);

    expect(result).toBe('bash ran');
    expect(bash.execute.mock.calls[0]).toEqual([
      'call-1',
      { command: 'git status' },
      signal,
      onUpdate,
      ctx,
    ]);
  });

  test('read-only tools are handed back unwrapped and never reach the gate', async () => {
    const gate = mock<GateStub>(async () => DENIAL);
    const readOnly = ['read', 'grep', 'find', 'ls'].map(fakeTool);
    const gated = gatePiBuiltinTools(readOnly, gate, cwd);

    for (const [index, tool] of gated.entries()) {
      expect(tool).toBe(readOnly[index]);
      await tool.execute('call', { path: '.env' });
    }
    expect(gate).not.toHaveBeenCalled();
  });

  test('maps each tool to its kind, command and paths', async () => {
    const seen: ToolActionRequest[] = [];
    const gate = mock<GateStub>(async request => {
      seen.push(request);
      return { action: 'allow' };
    });
    const [bash, powershell, edit, write, unknown] = gatePiBuiltinTools(
      ['bash', 'powershell', 'edit', 'write', 'toString'].map(fakeTool),
      gate,
      cwd
    );
    const [native] = gatePiNativeTools([fakeTool('manage_run')], gate, cwd);

    await bash.execute('c1', { command: 'git push', timeout: 5 });
    await powershell.execute('c2', { command: 'Remove-Item x' });
    await edit.execute('c3', { path: 'src/a.ts', edits: [] });
    await write.execute('c4', { path: '/etc/hosts', content: 'x' });
    await unknown.execute('c5', { anything: true });
    await native.execute('c6', { action: 'start' });

    expect(seen).toEqual([
      {
        toolName: 'bash',
        kind: 'shell',
        cwd,
        command: 'git push',
        input: { command: 'git push', timeout: 5 },
        toolCallId: 'c1',
      },
      {
        toolName: 'powershell',
        kind: 'shell',
        cwd,
        command: 'Remove-Item x',
        input: { command: 'Remove-Item x' },
        toolCallId: 'c2',
      },
      {
        toolName: 'edit',
        kind: 'file_write',
        cwd,
        paths: ['src/a.ts'],
        input: { path: 'src/a.ts', edits: [] },
        toolCallId: 'c3',
      },
      {
        toolName: 'write',
        kind: 'file_write',
        cwd,
        paths: ['/etc/hosts'],
        input: { path: '/etc/hosts', content: 'x' },
        toolCallId: 'c4',
      },
      // A built-in this table has never seen is gated, never assumed read-only.
      { toolName: 'toString', kind: 'other', cwd, input: { anything: true }, toolCallId: 'c5' },
      { toolName: 'manage_run', kind: 'other', cwd, input: { action: 'start' }, toolCallId: 'c6' },
    ]);
  });

  test('a gate that throws, or answers with neither allow nor deny, is a denial', async () => {
    const bash = fakeTool('bash');
    const throwing = mock<GateStub>(async () => {
      throw new Error('classifier unreachable');
    });
    const malformed = mock<GateStub>(async () => ({ action: 'maybe' }) as never);

    for (const gate of [throwing, malformed]) {
      const [gated] = gatePiBuiltinTools([bash], gate, cwd);
      await expect(gated.execute('call-1', { command: 'rm -rf ~' })).rejects.toThrow('tool gate');
    }
    expect(bash.execute).not.toHaveBeenCalled();
  });

  describe("against Pi's real write tool", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'pi-gate-'));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const writeTool = (
      gate: GateStub
    ): NonNullable<ReturnType<typeof resolvePiTools>['tools']>[number] => {
      const { tools } = resolvePiTools(dir, { allowed_tools: ['write'] });
      return gatePiBuiltinTools(tools ?? [], gate, dir)[0];
    };

    test('a denied write leaves no file behind', async () => {
      const gate = mock<GateStub>(async () => DENIAL);
      await expect(
        writeTool(gate).execute('call-1', { path: 'denied.txt', content: 'x' })
      ).rejects.toThrow('It deletes every file under the home directory.');
      expect(existsSync(join(dir, 'denied.txt'))).toBe(false);
      expect(gate.mock.calls[0][0]).toMatchObject({
        toolName: 'write',
        kind: 'file_write',
        cwd: dir,
        paths: ['denied.txt'],
      });
    });

    test('an allowed write creates the file', async () => {
      const gate = mock<GateStub>(async () => ({ action: 'allow' }));
      await writeTool(gate).execute('call-2', { path: 'allowed.txt', content: 'x' });
      expect(existsSync(join(dir, 'allowed.txt'))).toBe(true);
    });
  });
});
