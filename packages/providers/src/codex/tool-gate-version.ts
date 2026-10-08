/**
 * Version floor for gated Codex runs.
 *
 * The gate depends on three things a Codex CLI may be too old to have: the
 * PreToolUse hook, the exec flag that runs it without persisted trust, and the
 * `unified_exec_tty` feature key that closes the unhooked `write_stdin` path.
 * A CLI without the flag fails loudly on its own, but one without the feature
 * key would accept the setting as an unknown key and keep the bypass open.
 * So the CLI's version is read before a gated run and an older one is refused.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CodexVersion = readonly [major: number, minor: number, patch: number];

/**
 * The oldest Codex CLI a gated run accepts. This is the oldest version the
 * gate was proven on (real runs on 0.157.0 and 0.159.3), not the release that
 * introduced the pieces: an earlier CLI may well work, but nothing shows it.
 */
export const MIN_GATED_CODEX_VERSION: CodexVersion = [0, 157, 0];

const VERSION_TIMEOUT_MS = 15_000;

/** Reads `x.y.z` out of `codex --version` output such as `codex-cli 0.159.3`. */
export function parseCodexVersion(output: string): CodexVersion | undefined {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[\s+-]|$)/.exec(output.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isAtLeast(version: CodexVersion, floor: CodexVersion): boolean {
  for (let index = 0; index < floor.length; index++) {
    if (version[index] !== floor[index]) return version[index] > floor[index];
  }
  return true;
}

function formatVersion(version: CodexVersion): string {
  return version.join('.');
}

// One read per Codex command line for the life of the process: the answer only
// changes when the CLI is replaced, and a gated run should not pay a process
// start per request. A failed read is not kept, so a fixed install is retried.
const versionReads = new Map<string, Promise<string>>();

/** Clears the cached version reads. Exported for tests only. */
export function resetCodexVersionCache(): void {
  versionReads.clear();
}

async function readVersionOutput(codexCommand: readonly string[]): Promise<string> {
  const key = codexCommand.join('\0');
  let read = versionReads.get(key);
  if (!read) {
    const [file, ...args] = codexCommand;
    read = execFileAsync(file, [...args, '--version'], { timeout: VERSION_TIMEOUT_MS }).then(
      result => result.stdout
    );
    versionReads.set(key, read);
    read.catch(() => {
      versionReads.delete(key);
    });
  }
  return read;
}

/**
 * Refuses a gated run on a Codex CLI older than {@link MIN_GATED_CODEX_VERSION},
 * and on one whose version cannot be read: an unknown CLI is not a safe one.
 */
export async function assertCodexSupportsToolGate(codexCommand: readonly string[]): Promise<void> {
  const shown = codexCommand.join(' ');
  const floor = formatVersion(MIN_GATED_CODEX_VERSION);
  let output: string;
  try {
    output = await readVersionOutput(codexCommand);
  } catch (error) {
    const err = new Error(
      `Codex query failed: the tool gate needs Codex CLI ${floor} or newer, and the version of ${shown} could not be read (\`--version\` failed). Fix the Codex CLI install, or turn the tool gate off for Codex.`
    );
    err.cause = error;
    throw err;
  }
  const version = parseCodexVersion(output);
  if (version === undefined) {
    throw new Error(
      `Codex query failed: the tool gate needs Codex CLI ${floor} or newer, and ${shown} reported a version Archon could not read: "${output.trim().slice(0, 80)}". Update the Codex CLI, or turn the tool gate off for Codex.`
    );
  }
  if (!isAtLeast(version, MIN_GATED_CODEX_VERSION)) {
    throw new Error(
      `Codex query failed: the tool gate needs Codex CLI ${floor} or newer, and ${shown} is ${formatVersion(version)}. Update the Codex CLI, or turn the tool gate off for Codex.`
    );
  }
}
