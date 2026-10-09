/**
 * Archon-owned env loader — runs at every entry point AFTER stripCwdEnv().
 *
 * Loads env vars from two archon-owned locations and emits operator-facing log
 * lines naming the exact paths and key counts. Replaces the misleading
 * `[dotenv@17.3.1] injecting env (N) from .env` preamble (see #1302).
 *
 * Load order (later sources win because `override: true`):
 *   1. ~/.archon/.env         — user-scope defaults, apply everywhere
 *   2. <cwd>/.archon/.env     — repo-scope overrides for this project
 *
 * `<cwd>/.env` is intentionally NOT loaded — it belongs to the user's target
 * repo and is stripped by stripCwdEnv() (see #1302 / #1303 three-path model).
 * Directory ownership (`.archon/`) is the security boundary, not the filename.
 *
 * Logging rules:
 *   - Each `[archon] loaded N keys from …` line prints only when N > 0 AND
 *     the operator has opted into verbose boot output via `ARCHON_VERBOSE_BOOT=1`
 *     or `LOG_LEVEL=debug`/`trace`. Silent by default — these run before
 *     parseArgs() so they would otherwise leak into interactive command output.
 *   - Silent in the common case (no archon-owned env files present).
 *   - Emits to stderr (operator signal) — Pino logger is not yet initialized
 *     at this point in boot.
 *   - Passes `{ quiet: true }` to suppress dotenv's own `[dotenv@17.3.1] …`
 *     output.
 */
import { config } from 'dotenv';
import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getArchonEnvPath, getArchonHome, getRepoArchonEnvPath } from './archon-paths';

/**
 * Shorten a path with `~` when it lives under the current user's home directory.
 * Used only for log rendering — never for filesystem operations.
 */
function displayPath(p: string): string {
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + '/') || p.startsWith(home + '\\')) {
    return '~' + p.slice(home.length);
  }
  return p;
}

// Verbosity is signaled via env vars because this runs before parseArgs() and Pino.
export function isVerboseBoot(): boolean {
  if (process.env.ARCHON_VERBOSE_BOOT === '1') return true;
  const level = process.env.LOG_LEVEL?.toLowerCase();
  return level === 'debug' || level === 'trace';
}

/**
 * `<ARCHON_HOME>/plugins`: where every plugin kind installs, and where forge discovery
 * and workflow-pack discovery read them. A repository's `.archon/.env` cannot move
 * ARCHON_HOME (see {@link REPO_SCOPE_REFUSED_KEYS}), so install and every reader agree.
 */
export function getPluginsPath(archonHome: string = getArchonHome()): string {
  return join(archonHome, 'plugins');
}

/**
 * Keys a repository's `.archon/.env` may not set. Each can move the Archon home or the
 * executables Archon runs, so letting the repo scope set them would let a repository
 * choose which plugins run: ARCHON_HOME directly, HOME and USERPROFILE (Windows)
 * through the default `~/.archon`, ARCHON_DOCKER and WORKSPACE_PATH through the
 * Docker home `/.archon` (see `isDocker`), and PATH through executable lookup. A
 * deployment sets the Docker markers in its image or process environment. The process
 * environment and the user-scope `~/.archon/.env` may still set all of them.
 */
const REPO_SCOPE_REFUSED_KEYS = [
  'ARCHON_HOME',
  'HOME',
  'USERPROFILE',
  'ARCHON_DOCKER',
  'WORKSPACE_PATH',
  'PATH',
];

/**
 * Key prefixes a repository's `.archon/.env` may not set. `JEV_*` connects and tunes the
 * classifier behind the model router and the other Jev features: its endpoint, its key,
 * its switches and its thresholds. A repository that could set them could send the
 * operator's task text to an endpoint of its own choosing, or loosen the thresholds that
 * keep a step on its authored model. The operator sets them in the environment or in the
 * user-scope `~/.archon/.env`.
 */
const REPO_SCOPE_REFUSED_PREFIXES = ['JEV_'];

function isRefusedInRepoScope(key: string): boolean {
  // Windows env names are case-insensitive, so `Path=` there is PATH.
  const name = process.platform === 'win32' ? key.toUpperCase() : key;
  return (
    REPO_SCOPE_REFUSED_KEYS.includes(name) ||
    REPO_SCOPE_REFUSED_PREFIXES.some(prefix => name.startsWith(prefix))
  );
}

/**
 * Whether two existing paths are one file, through any symlinks. A path that cannot be
 * resolved is treated as a different file, which leaves the repo-scope checks in force.
 */
function isSameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Load archon-owned env files. Call once, immediately after
 * `@archon/paths/strip-cwd-env-boot` at each entry point.
 *
 * Both loads use `override: true` so:
 *   - `~/.archon/.env` wins over shell-inherited vars (archon intent wins).
 *   - `<cwd>/.archon/.env` wins over `~/.archon/.env` (repo scope wins).
 *
 * A repo-scope file that sets any of {@link REPO_SCOPE_REFUSED_KEYS}, or a key under any of
 * {@link REPO_SCOPE_REFUSED_PREFIXES}, is refused before any of its keys apply.
 *
 * Run from the directory that holds the Archon home (`cd ~ && archon ...`), the repo-scope
 * path is the user-scope file itself. It is the operator's file and is already loaded, so
 * it is not read a second time as a repository's and none of the refusals apply to it.
 *
 * A malformed env file is fatal — matches the pre-existing CLI behavior at
 * packages/cli/src/cli.ts:24-30.
 */
export function loadArchonEnv(
  cwd: string = process.cwd(),
  options: { afterUserLoad?: () => void } = {}
): void {
  const homePath = getArchonEnvPath();
  if (existsSync(homePath)) {
    const result = config({ path: homePath, override: true, quiet: true });
    if (result.error) {
      console.error(`Error loading .env from ${homePath}: ${result.error.message}`);
      console.error('Hint: Check for syntax errors in your .env file.');
      process.exit(1);
    }
    const count = Object.keys(result.parsed ?? {}).length;
    if (count > 0 && isVerboseBoot()) {
      process.stderr.write(`[archon] loaded ${count} keys from ${displayPath(homePath)}\n`);
    }
  }

  options.afterUserLoad?.();

  const repoPath = getRepoArchonEnvPath(cwd);
  if (existsSync(repoPath) && !isSameFile(repoPath, homePath)) {
    // Parse without applying, so a refused file changes nothing.
    const result = config({ path: repoPath, processEnv: {}, quiet: true });
    if (result.error) {
      console.error(`Error loading .env from ${repoPath}: ${result.error.message}`);
      console.error('Hint: Check for syntax errors in your .env file.');
      process.exit(1);
    }
    const parsed = result.parsed ?? {};
    const refused = Object.keys(parsed).filter(isRefusedInRepoScope);
    if (refused.length > 0) {
      console.error(
        `${repoPath} sets ${refused.join(', ')}. A repository's .archon/.env cannot set ` +
          `${REPO_SCOPE_REFUSED_KEYS.join(', ')} or any ` +
          `${REPO_SCOPE_REFUSED_PREFIXES.map(prefix => `${prefix}*`).join(', ')} key; set ` +
          `them in the environment or in ${displayPath(homePath)} instead.`
      );
      process.exit(1);
    }
    Object.assign(process.env, parsed);
    const count = Object.keys(parsed).length;
    if (count > 0 && isVerboseBoot()) {
      process.stderr.write(
        `[archon] loaded ${count} keys from ${displayPath(repoPath)} (repo scope, overrides user scope)\n`
      );
    }
  }
}
