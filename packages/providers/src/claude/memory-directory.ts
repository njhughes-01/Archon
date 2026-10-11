import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code's auto-memory directory for a working directory:
 * `<config dir>/projects/<sanitized cwd>/memory`, where every character of the
 * path that is not a letter or a digit becomes `-`. The rule is Claude Code's,
 * not Archon's; the test pins it to a path Claude Code really wrote to. A user
 * who moved it with the `autoMemoryDirectory` setting is not followed here, so
 * a write there stays denied by the tool gate.
 */
export function claudeMemoryDirectory(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  return join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
}
