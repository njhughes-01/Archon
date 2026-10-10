import { describe, test, expect } from 'bun:test';
import {
  describeDenialForModel,
  readApplyPatch,
  translateCodexHookCall,
} from './tool-gate-request';

/** The fields Codex 0.159.3 sends a PreToolUse hook on stdin. */
function hookPayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: null,
    cwd: '/repo',
    hook_event_name: 'PreToolUse',
    model: 'gpt-test',
    permission_mode: 'bypassPermissions',
    tool_use_id: 'call-1',
    ...overrides,
  };
}

const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.ts',
  '+export const a = 1;',
  '*** Update File: src/old.ts',
  '*** Move to: src/renamed.ts',
  '@@',
  '-const a = 0;',
  '+const a = 1;',
  '*** Delete File: /abs/gone.ts',
  '*** End Patch',
].join('\n');

describe('translateCodexHookCall', () => {
  test('a Bash call becomes a shell request carrying the bare command', () => {
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } })
    );

    expect(result).toEqual({
      outcome: 'ask',
      category: 'command',
      request: {
        toolName: 'Bash',
        kind: 'shell',
        cwd: '/repo',
        command: 'git push origin main',
        input: { command: 'git push origin main' },
        toolCallId: 'call-1',
      },
    });
  });

  test('a read-only shell command is still sent to the gate', () => {
    // Codex has one shell tool for reads and writes alike; the gate's own allow
    // rules decide which commands are read-only.
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'Bash', tool_input: { command: 'git status' } })
    );

    expect(result.outcome).toBe('ask');
  });

  test('a patch piped to apply_patch in the shell names its targets too', () => {
    // Seen in a real run: Codex applies such a patch itself, as a file edit.
    const command =
      "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: ../.env\n+A=1\n*** End Patch\nEOF";
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'Bash', tool_input: { command } })
    );

    expect(result.outcome === 'ask' && result.request).toMatchObject({
      kind: 'shell',
      command,
      paths: ['/.env'],
    });
  });

  test('apply_patch becomes a file_write request with every target path', () => {
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'apply_patch', tool_input: { command: PATCH } })
    );

    expect(result).toEqual({
      outcome: 'ask',
      category: 'file_change',
      request: {
        toolName: 'apply_patch',
        kind: 'file_write',
        cwd: '/repo',
        paths: ['/repo/src/new.ts', '/repo/src/old.ts', '/repo/src/renamed.ts', '/abs/gone.ts'],
        input: { command: PATCH },
        toolCallId: 'call-1',
      },
    });
  });

  test('an apply_patch call with no readable target is denied without asking', () => {
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'apply_patch', tool_input: { command: 'not a patch' } })
    );

    expect(result.outcome).toBe('deny');
    expect(result.category).toBe('file_change');
  });

  test('an MCP tool becomes an mcp request carrying its arguments', () => {
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'mcp__github__create_issue', tool_input: { title: 'x' } })
    );

    expect(result).toEqual({
      outcome: 'ask',
      category: 'mcp',
      request: {
        toolName: 'mcp__github__create_issue',
        kind: 'mcp',
        cwd: '/repo',
        input: { title: 'x' },
        toolCallId: 'call-1',
      },
    });
  });

  // Codex 0.157.0 applied this patch and wrote `../out.txt`: its parser trims a
  // header line before matching it, so indentation does not hide a target.
  test('an indented header after another hunk is judged as a target', () => {
    const patch = [
      '*** Begin Patch',
      '*** Delete File: d.txt',
      '  *** Add File: ../out.txt',
      '+hi',
      '*** End Patch',
    ].join('\n');
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'apply_patch', tool_input: { command: patch } })
    );

    expect(result.outcome === 'ask' && result.request).toMatchObject({
      kind: 'file_write',
      paths: ['/repo/d.txt', '/out.txt'],
      input: { command: patch },
    });
  });

  test.each([
    ['a header with no path', '*** Add File:'],
    ['a header in another letter case', '*** update file: ../x'],
    ['an environment header', '*** Environment ID: other-machine'],
    ['a bare carriage return inside a path', '*** Add File: ok\r/../../out.txt'],
    // Codex CLI 0.157.0 drops the tab: these wrote `../out.txt` and `.env`.
    ['a tab inside a climbing path', '*** Add File: .\t./out.txt'],
    ['a tab inside a file name', '*** Add File: .e\tnv'],
  ])('apply_patch with %s is marked unreadable for the gate', (_label, line) => {
    const patch = ['*** Begin Patch', '*** Add File: ok.txt', '+x', line, '*** End Patch'].join(
      '\n'
    );
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'apply_patch', tool_input: { command: patch } })
    );

    expect(result).toEqual({
      outcome: 'ask',
      category: 'file_change',
      request: {
        toolName: 'apply_patch',
        kind: 'file_write',
        cwd: '/repo',
        paths: ['/repo/ok.txt'],
        input: { command: patch, unreadablePatch: true },
        toolCallId: 'call-1',
      },
    });
  });

  test('an unreadable patch with no readable target carries the mark and no path', () => {
    const patch = '*** Begin Patch\n*** add file: ../x\n+x\n*** End Patch';
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'apply_patch', tool_input: { command: patch } })
    );

    expect(result.outcome === 'ask' && result.request).toEqual({
      toolName: 'apply_patch',
      kind: 'file_write',
      cwd: '/repo',
      input: { command: patch, unreadablePatch: true },
      toolCallId: 'call-1',
    });
  });

  test('the mark is added to a copy, never to the payload Codex sent', () => {
    const toolInput = { command: '*** Begin Patch\n*** Add File:\n*** End Patch' };
    translateCodexHookCall(hookPayload({ tool_name: 'apply_patch', tool_input: toolInput }));

    expect(toolInput).toEqual({ command: '*** Begin Patch\n*** Add File:\n*** End Patch' });
  });

  // The gate's rules refuse the unreadable mark on a file write, not on a
  // shell command, so the shell form is refused before the gate is asked.
  test.each([
    ['an environment header', '*** Environment ID: e1\n*** Add File: a.txt'],
    // Codex CLI 0.157.0 drops the tab and writes `../out.txt`.
    ['a tab inside a climbing path', '*** Add File: .\t./out.txt'],
    ['a header in another letter case', '*** Add File: a.txt\n+x\n*** delete file: ../x'],
  ])('a patch with %s piped to apply_patch in the shell is denied', (_label, headers) => {
    const command = `apply_patch <<'EOF'\n*** Begin Patch\n${headers}\n+x\n*** End Patch\nEOF`;
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'Bash', tool_input: { command } })
    );

    expect(result.outcome).toBe('deny');
    expect(result.category).toBe('command');
  });

  test('shell text that only mentions patch headers is not read as a patch', () => {
    // Codex applies nothing without the `*** Begin Patch` line.
    const command = "cat > notes.md <<'EOF'\n*** Add File: /etc/hosts\n*** add file:\nEOF";
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'Bash', tool_input: { command } })
    );

    expect(result.outcome === 'ask' && result.request).toEqual({
      toolName: 'Bash',
      kind: 'shell',
      cwd: '/repo',
      command,
      input: { command },
      toolCallId: 'call-1',
    });
  });

  test.each([
    ['workdir', { command: 'touch x', workdir: 'packages/app' }, '/repo/packages/app'],
    ['an absolute workdir', { command: 'touch x', workdir: '/srv/other' }, '/srv/other'],
    ['a workdir that climbs out', { command: 'touch x', workdir: '../elsewhere' }, '/elsewhere'],
    ['cwd', { command: 'touch x', cwd: 'packages/app' }, '/repo/packages/app'],
    ['workdir ahead of cwd', { command: 'touch x', workdir: 'a', cwd: 'b' }, '/repo/a'],
    ['no directory of its own', { command: 'touch x' }, '/repo'],
    ['an empty workdir', { command: 'touch x', workdir: '' }, '/repo'],
    ['a null workdir', { command: 'touch x', workdir: null }, '/repo'],
  ])('a shell call with %s is judged in that directory', (_label, toolInput, expected) => {
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'Bash', tool_input: toolInput })
    );

    expect(result.outcome === 'ask' && result.request.cwd).toBe(expected);
    expect(result.outcome === 'ask' && result.request.input).toEqual(toolInput);
  });

  test("a patch piped in the shell is resolved against the call's own directory", () => {
    const command =
      "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: ../x.txt\n+x\n*** End Patch\nEOF";
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'Bash', tool_input: { command, workdir: '/repo/sub' } })
    );

    expect(result.outcome === 'ask' && result.request).toMatchObject({
      cwd: '/repo/sub',
      paths: ['/repo/x.txt'],
    });
  });

  test.each([
    ['a number', 7],
    ['a list', ['/repo']],
  ])('a shell call whose workdir is %s is denied without asking', (_label, workdir) => {
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'Bash', tool_input: { command: 'touch x', workdir } })
    );

    expect(result.outcome).toBe('deny');
    expect(result.category).toBe('command');
  });

  test('a tool this provider does not know has its path fields judged as write targets', () => {
    const toolInput = { file_path: '../outside.txt', files: ['a.ts', 'b.ts'], edits: [] };
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'multi_edit', tool_input: toolInput })
    );

    expect(result).toEqual({
      outcome: 'ask',
      category: 'other',
      request: {
        toolName: 'multi_edit',
        kind: 'other',
        cwd: '/repo',
        paths: ['../outside.txt', 'a.ts', 'b.ts'],
        input: toolInput,
        toolCallId: 'call-1',
      },
    });
  });

  test("an MCP tool's arguments are not read as write targets", () => {
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'mcp__files__read', tool_input: { path: '/etc/hosts' } })
    );

    expect(result.outcome === 'ask' && result.request.paths).toBeUndefined();
  });

  test.each(['update_plan', 'view_image'])('%s is read-only and never reaches the gate', name => {
    const result = translateCodexHookCall(hookPayload({ tool_name: name, tool_input: {} }));

    expect(result).toEqual({ outcome: 'allow', category: 'other' });
  });

  test('a tool this provider does not know is sent to the gate as kind other', () => {
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'spawn_agent', tool_input: { task: 'do it' } })
    );

    expect(result).toEqual({
      outcome: 'ask',
      category: 'other',
      request: {
        toolName: 'spawn_agent',
        kind: 'other',
        cwd: '/repo',
        input: { task: 'do it' },
        toolCallId: 'call-1',
      },
    });
  });

  test('a call made by a sub-agent is marked as such', () => {
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'agent-7' })
    );

    expect(result.outcome === 'ask' && result.request.fromSubagent).toBe(true);
  });

  test('a non-object tool input is wrapped rather than dropped', () => {
    const result = translateCodexHookCall(
      hookPayload({ tool_name: 'some_tool', tool_input: 'raw text' })
    );

    expect(result.outcome === 'ask' && result.request.input).toEqual({ value: 'raw text' });
  });

  test.each([
    ['a Bash call without a command', hookPayload({ tool_name: 'Bash', tool_input: {} })],
    ['a blank command', hookPayload({ tool_name: 'Bash', tool_input: { command: '  ' } })],
    ['a missing tool name', hookPayload({ tool_input: { command: 'ls' } })],
    ['a missing cwd', hookPayload({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: 7 })],
    ['a non-object payload', 'PreToolUse'],
    ['null', null],
  ])('%s is denied without asking', (_label, payload) => {
    const result = translateCodexHookCall(payload);

    expect(result.outcome).toBe('deny');
    expect(result.outcome === 'deny' && result.reason.length > 0).toBe(true);
  });

  test('a payload for another hook event is denied', () => {
    const result = translateCodexHookCall(
      hookPayload({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      })
    );

    expect(result.outcome).toBe('deny');
  });
});

describe('readApplyPatch', () => {
  test('reads add, update, move and delete targets', () => {
    expect(readApplyPatch(PATCH, '/repo')).toEqual({
      paths: ['/repo/src/new.ts', '/repo/src/old.ts', '/repo/src/renamed.ts', '/abs/gone.ts'],
      unreadable: false,
    });
  });

  test('keeps a path that climbs out of the working directory visible to the gate', () => {
    const patch = '*** Begin Patch\n*** Add File: ../../.ssh/authorized_keys\n+key\n*** End Patch';

    expect(readApplyPatch(patch, '/home/u/repo').paths).toEqual(['/home/.ssh/authorized_keys']);
  });

  test('ignores header-looking text inside added content', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: notes.md',
      '+*** Add File: decoy.md',
      '*** End Patch',
    ].join('\n');

    expect(readApplyPatch(patch, '/repo')).toEqual({
      paths: ['/repo/notes.md'],
      unreadable: false,
    });
  });

  test('handles CRLF line endings and repeated targets', () => {
    const patch =
      '*** Begin Patch\r\n*** Update File: a.ts\r\n@@\r\n-x\r\n+y\r\n*** Update File: a.ts\r\n*** End Patch';

    expect(readApplyPatch(patch, '/repo')).toEqual({ paths: ['/repo/a.ts'], unreadable: false });
  });

  // Codex 0.157.0 wrote a file named `   a.txt` for this header: it keeps the
  // space after the marker. A newer CLI may trim it, so both spellings are named.
  test('names a path with leading space both as Codex 0.157.0 writes it and trimmed', () => {
    const patch = '*** Begin Patch\n*** Add File:    /abs/a.txt\n+x\n*** End Patch';

    expect(readApplyPatch(patch, '/repo').paths).toEqual(['/repo/   /abs/a.txt', '/abs/a.txt']);
  });

  test('returns nothing for text that is not a patch', () => {
    expect(readApplyPatch('echo hi', '/repo')).toEqual({ paths: [], unreadable: false });
  });
});

describe('describeDenialForModel', () => {
  test('puts the reason first and lists the alternatives', () => {
    const text = describeDenialForModel({
      action: 'deny',
      needsApproval: true,
      reason: 'Force-pushing main needs approval.',
      alternatives: ['Push to a feature branch', 'Report the work as blocked'],
    });

    expect(text).toBe(
      'Force-pushing main needs approval.\nSafer alternatives:\n- Push to a feature branch\n- Report the work as blocked'
    );
  });

  test('leaves out the list when there are no alternatives', () => {
    const text = describeDenialForModel({
      action: 'deny',
      needsApproval: false,
      reason: 'Not allowed.',
      alternatives: [],
    });

    expect(text).toBe('Not allowed.');
  });

  test('never returns an empty reason', () => {
    // Codex treats a denial with an empty reason as a failed hook and runs the tool.
    const text = describeDenialForModel({
      action: 'deny',
      needsApproval: false,
      reason: '   ',
      alternatives: [],
    });

    expect(text.trim().length).toBeGreaterThan(0);
  });
});
