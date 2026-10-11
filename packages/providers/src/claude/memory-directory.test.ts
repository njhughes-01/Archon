import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { claudeMemoryDirectory } from './memory-directory';

// Expected paths are joined, not written out: the separator is the platform's.

describe('claudeMemoryDirectory', () => {
  test('matches the path Claude Code wrote its auto-memory to for a workspace checkout', () => {
    expect(
      claudeMemoryDirectory(
        '/home/killerherts/.archon/workspaces/njhughes-01/denbjj-members/source',
        { HOME: '/home/killerherts' }
      )
    ).toBe(
      join(
        '/home/killerherts',
        '.claude',
        'projects',
        '-home-killerherts--archon-workspaces-njhughes-01-denbjj-members-source',
        'memory'
      )
    );
  });

  test('CLAUDE_CONFIG_DIR replaces ~/.claude', () => {
    expect(
      claudeMemoryDirectory('/work/app', { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg/claude' })
    ).toBe(join('/cfg/claude', 'projects', '-work-app', 'memory'));
  });

  test('an empty CLAUDE_CONFIG_DIR is ignored', () => {
    expect(claudeMemoryDirectory('/work/app', { HOME: '/home/u', CLAUDE_CONFIG_DIR: '' })).toBe(
      join('/home/u', '.claude', 'projects', '-work-app', 'memory')
    );
  });
});
