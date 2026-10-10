import { describe, expect, test } from 'bun:test';
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import { toClaudeToolAction } from './tool-gate';

function hookInput(toolName: string, toolInput: unknown): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/workspace/repo',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'toolu_1',
  };
}

describe('toClaudeToolAction: shell tools', () => {
  // The gate's rules never take PowerShell text as understood; they tell the
  // shell apart by this name.
  test('a PowerShell call reaches the gate under its own name', () => {
    expect(
      toClaudeToolAction(hookInput('PowerShell', { command: 'Remove-Item -Recurse x' }), false)
    ).toEqual({
      toolName: 'PowerShell',
      kind: 'shell',
      cwd: '/workspace/repo',
      command: 'Remove-Item -Recurse x',
      input: { command: 'Remove-Item -Recurse x' },
      toolCallId: 'toolu_1',
    });
  });
});

/**
 * Claude Code expands a write path itself (`expandPath`: trim, then a leading
 * `~` is the home directory) and hands hooks the expanded path. A path that
 * still starts with `~` therefore did not come through that step: it is left
 * for the gate's rules to refuse, never expanded here.
 */
describe('toClaudeToolAction: the path the gate judges', () => {
  test.each([
    ['Write', { file_path: '/workspace/repo/a.ts', content: 'x' }, '/workspace/repo/a.ts'],
    ['Edit', { file_path: '/home/user/.bashrc' }, '/home/user/.bashrc'],
    ['NotebookEdit', { notebook_path: '/workspace/repo/n.ipynb' }, '/workspace/repo/n.ipynb'],
  ])('%s: an expanded path is judged as it is', (toolName, toolInput, expected) => {
    expect(toClaudeToolAction(hookInput(toolName, toolInput), false)).toEqual({
      toolName,
      kind: 'file_write',
      cwd: '/workspace/repo',
      paths: [expected],
      input: toolInput,
      toolCallId: 'toolu_1',
    });
  });

  test.each([
    ['Write', { file_path: '~/.bashrc' }, '~/.bashrc'],
    ['Edit', { file_path: '~' }, '~'],
    ['NotebookEdit', { notebook_path: '~/n.ipynb' }, '~/n.ipynb'],
    ['Write', { file_path: '@src/a.ts' }, '@src/a.ts'],
    ['Write', { file_path: 'file:///home/user/.bashrc' }, 'file:///home/user/.bashrc'],
  ])('%s: %p is left in the form the rules refuse', (toolName, toolInput, expected) => {
    expect(toClaudeToolAction(hookInput(toolName, toolInput), false)?.paths).toEqual([expected]);
  });

  // Claude Code trims the path before it looks for `~`, so space in front must
  // not hide the home directory from the gate's rules.
  test.each([
    ['Write', { file_path: '  ~/.bashrc' }, '~/.bashrc'],
    ['Write', { file_path: '\t~/.ssh/authorized_keys\n' }, '~/.ssh/authorized_keys'],
    ['Edit', { file_path: '\u00A0~' }, '~'],
    ['NotebookEdit', { notebook_path: ' ~/n.ipynb ' }, '~/n.ipynb'],
    ['Write', { file_path: ' /workspace/repo/a.ts ' }, '/workspace/repo/a.ts'],
  ])('%s: %p is judged without the space Claude trims', (toolName, toolInput, expected) => {
    const request = toClaudeToolAction(hookInput(toolName, toolInput), false);

    expect(request?.paths).toEqual([expected]);
    // The input is what the model sent.
    expect(request?.input).toEqual(toolInput);
  });

  test('a write with no path names no target, so the gate refuses it', () => {
    expect(toClaudeToolAction(hookInput('Write', { content: 'x' }), false)).toEqual({
      toolName: 'Write',
      kind: 'file_write',
      cwd: '/workspace/repo',
      input: { content: 'x' },
      toolCallId: 'toolu_1',
    });
  });

  test('a tool this table does not know keeps its input for the rules to read', () => {
    expect(
      toClaudeToolAction(hookInput('MultiEdit', { file_path: '~/.bashrc', edits: [] }), false)
    ).toEqual({
      toolName: 'MultiEdit',
      kind: 'other',
      cwd: '/workspace/repo',
      input: { file_path: '~/.bashrc', edits: [] },
      toolCallId: 'toolu_1',
    });
  });
});
