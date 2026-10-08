/**
 * The deterministic part of the tool gate: one tool call in, one of three
 * outcomes out. `deny` is final. `allow` needs no second opinion. `escalate`
 * means a risk signal fired and the call belongs to the classifier, or to the
 * no-classifier fallback.
 *
 * Order matters and is fixed: deny rules, then risk signals, then the allow
 * rule, then the default. A script is judged command by command and the worst
 * verdict wins, so `git status && <something destructive>` is denied.
 *
 * Paths are judged where they really land (see `path-resolution.ts`) against
 * the repository root the caller supplied. The tool's own `cwd` only says where
 * a relative path starts; it never widens what counts as inside.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolActionRequest } from '@archon/providers/types';
import { isInside, resolveRealPath } from './path-resolution';
import { isSecretPath } from './secret-paths';
import {
  parseShell,
  resolveWord,
  SHELL_INTERPRETERS,
  type ParsedShell,
  type ResolvedWord,
  type ShellCommand,
} from './shell-tokens';

// ---------------------------------------------------------------------------
// Rule vocabulary
// ---------------------------------------------------------------------------

interface DenyRule {
  reason: string;
  alternatives: readonly string[];
}

const BLOCKED_ALTERNATIVE =
  'If the task cannot be done another way, say so in your output and name the exact command a human should run.';

/** Every deny rule, with what the agent is told. Reasons never quote the call. */
export const DENY_RULES = {
  'deny.pipe_to_shell': {
    reason: 'It downloads a script and runs it in the same step, so nothing can review what runs.',
    alternatives: [
      'Download the script to a file inside the repository, read it, then run that file.',
      BLOCKED_ALTERNATIVE,
    ],
  },
  'deny.secret_exfiltration': {
    reason: 'It sends the process environment, which holds credentials, to a network client.',
    alternatives: [
      'Send only the specific non-secret values the request needs.',
      BLOCKED_ALTERNATIVE,
    ],
  },
  'deny.git_force_push': {
    reason: 'It overwrites remote history with a forced push or a +refspec.',
    alternatives: [
      'Push without forcing; if the remote moved, fetch and rebase or merge first.',
      'For your own rebased feature branch, name it: git push --force-with-lease origin <branch>.',
    ],
  },
  'deny.git_force_push_protected': {
    reason:
      'A lease-protected forced push is only allowed onto a named branch that is not protected, and this one targets a protected branch or does not name its branch literally.',
    alternatives: [
      'Name a non-protected branch literally: git push --force-with-lease origin <branch>.',
      'Open a pull request into the protected branch instead of rewriting it.',
    ],
  },
  'deny.git_reset_hard': {
    reason: 'A hard reset discards uncommitted work with no way back.',
    alternatives: [
      'Use git stash to set changes aside, or git restore <path> for one file.',
      'Use git reset --soft or --mixed to move the branch and keep the files.',
    ],
  },
  'deny.git_clean_force': {
    reason: 'It deletes every untracked file and directory, which git cannot bring back.',
    alternatives: [
      'Run git clean -n to list what would go, then remove the specific paths you mean.',
    ],
  },
  'deny.rm_recursive_root': {
    reason:
      'It recursively removes the filesystem root, the home directory, the repository itself, its parent, or everything a bare glob matches.',
    alternatives: [
      'Remove the specific file or sub-directory you mean, by its path inside the repository.',
    ],
  },
  'deny.path_outside_root': {
    reason:
      'It writes to, moves or removes a path that resolves outside the repository, after following symlinks and "..".',
    alternatives: ['Use a path inside the repository.', BLOCKED_ALTERNATIVE],
  },
  'deny.path_unresolvable': {
    reason:
      'A target path could not be resolved (a symlink loop, a path through a file, or an unreadable directory), so the gate cannot tell where the write would land.',
    alternatives: ['Use a plain path inside the repository.'],
  },
  'deny.secret_write': {
    reason: 'It writes, moves or removes an env file, key or credential store.',
    alternatives: [
      'Write a template with placeholder values, such as an example file a human copies into place.',
      'Name the variable the operator must set in your output; do not write the secret file yourself.',
    ],
  },
  'deny.secret_read': {
    reason: 'It prints the contents of an env file, key or credential store.',
    alternatives: [
      'Read the code or the documented template that names the variables, not their values.',
      'Check that the file or a variable exists (test -f, ls) without printing it.',
    ],
  },
  'deny.unreadable_request': {
    reason:
      'The tool call reached the gate without the command text, write target or absolute working directory needed to judge it.',
    alternatives: [BLOCKED_ALTERNATIVE],
  },
} as const satisfies Record<string, DenyRule>;

export type DenyRuleId = keyof typeof DENY_RULES;

/** Risk signals, strongest first: the first one that fired names the escalation. */
export const RISK_RULE_IDS = [
  'risk.mutation_verb',
  'risk.network_request',
  'risk.kind_network',
  'risk.kind_mcp',
  'risk.secret_path_argument',
  'risk.cwd_outside_root',
  'risk.opaque_shell',
] as const;
export type RiskRuleId = (typeof RISK_RULE_IDS)[number];

export const ALLOW_RULE_IDS = [
  'allow.read_only',
  'allow.write_in_root',
  'default.no_signal',
] as const;
export type AllowRuleId = (typeof ALLOW_RULE_IDS)[number];

/** Whether the action could be undone, as far as the text alone shows. */
export type ReversibleHint = 'likely' | 'unlikely' | 'unknown';

export type RuleOutcome =
  | { outcome: 'allow'; ruleId: AllowRuleId }
  | { outcome: 'deny'; ruleId: DenyRuleId; reason: string; alternatives: string[] }
  | {
      outcome: 'escalate';
      /** The strongest signal that fired. */
      ruleId: RiskRuleId;
      /** Every signal that fired, strongest first. */
      signals: RiskRuleId[];
      /** Paths and URLs the call acts on; repository-relative when inside the root. */
      targets: string[];
      /** True when the working directory and every known target are inside the root. */
      repoRelative: boolean;
      reversibleHint: ReversibleHint;
    };

export interface RuleContext {
  /** Real path of the repository root, supplied by the caller. */
  repoRoot: string;
  /** Real path of the home directory `~` and `$HOME` stand for. */
  homeDir: string;
  /** Branches a lease-protected forced push may never target. */
  protectedBranches: readonly string[];
  /** Command prefixes known to only verify the repository, e.g. `bun run test`. */
  verificationCommands: readonly string[];
}

export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['main', 'master'];

const VERIFICATION_SCRIPTS = [
  'test',
  'lint',
  'type-check',
  'typecheck',
  'format:check',
  'validate',
];
/**
 * The usual package-runner spellings of test, lint and type-check. What such a
 * script runs is set by the repository's manifest, which this gate does not read.
 */
export const DEFAULT_VERIFICATION_COMMANDS: readonly string[] = [
  'bun',
  'npm',
  'pnpm',
  'yarn',
].flatMap(runner => [
  `${runner} test`,
  ...VERIFICATION_SCRIPTS.map(script => `${runner} run ${script}`),
]);

// ---------------------------------------------------------------------------
// Command vocabulary
// ---------------------------------------------------------------------------

const READ_ONLY_HEADS: ReadonlySet<string> = new Set([
  ...['ls', 'cat', 'rg', 'grep', 'egrep', 'fgrep', 'head', 'tail', 'wc', 'nl', 'cut', 'tr'],
  ...['pwd', 'echo', 'printf', 'which', 'file', 'stat', 'du', 'df', 'diff', 'jq', 'find'],
  ...['basename', 'dirname', 'realpath', 'true', 'false', 'test', '[', 'cd', 'whoami', 'uname'],
]);
const READ_ONLY_GIT: ReadonlySet<string> = new Set([
  ...['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'grep'],
  ...['branch', 'remote'],
]);
const GIT_BRANCH_LIST_FLAGS = /^(-a|-r|-v|-vv|--all|--remotes|--verbose|--list|--show-current)$/;
/** Flags that make a read-only command run another program. */
const GIT_EXEC_FLAGS = /^(--ext-diff|--textconv|-O.*|--open-files-in-pager.*)$/;
const RG_EXEC_FLAGS = /^--(pre|pre-glob|hostname-bin)(=|$)/;
const FIND_WRITE_FLAGS = /^-(delete|fprint|fprint0|fprintf|fls)$/;
/** Wrappers that change nothing about what the command may do. */
const BENIGN_WRAPPERS: ReadonlySet<string> = new Set(['timeout', 'nice', 'env', 'command', 'time']);

/** Commands whose file arguments are printed or copied out. */
const CONTENT_READERS: ReadonlySet<string> = new Set([
  ...['cat', 'tac', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'od', 'xxd', 'hexdump', 'strings'],
  ...['base64', 'base32', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'gawk', 'sed', 'cut'],
  ...['sort', 'uniq', 'diff', 'cmp', 'jq', 'yq'],
]);
/** Git subcommands that print file contents. */
const GIT_CONTENT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  ...['show', 'diff', 'log', 'cat-file', 'blame', 'grep', 'archive'],
]);
/** Commands whose first operand is a pattern, script or filter, not a file. */
const SCRIPT_FIRST: ReadonlySet<string> = new Set([
  ...['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk', 'jq', 'yq'],
]);
const SCRIPT_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '-f',
  '--regexp',
  '--file',
  '--expression',
]);
/** Commands whose arguments are text, never paths. */
const TEXT_ONLY: ReadonlySet<string> = new Set(['echo', 'printf']);
/** Commands that look at a path without showing what is in it. */
const METADATA_ONLY: ReadonlySet<string> = new Set([
  ...['ls', 'stat', 'test', '[', 'file', 'du', 'find', 'cd', 'pushd', 'which', 'realpath'],
  ...['basename', 'dirname'],
]);

const FETCHERS: ReadonlySet<string> = new Set(['curl', 'wget']);
const STDIN_INTERPRETERS: ReadonlySet<string> = new Set([
  ...['python', 'python2', 'python3', 'perl', 'ruby', 'node', 'nodejs', 'php'],
]);
const RUNS_ITS_ARGUMENT: ReadonlySet<string> = new Set([
  ...SHELL_INTERPRETERS,
  'eval',
  'source',
  '.',
]);
const REMOTE_CLIENTS: ReadonlySet<string> = new Set([
  ...['ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp'],
]);
const HTTP_CLIENTS: ReadonlySet<string> = new Set(['curl', 'wget', 'http', 'https', 'xh']);
const SAFE_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const CURL_BODY_FLAGS: ReadonlySet<string> = new Set([
  ...['--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json'],
  ...['--form', '--form-string', '--upload-file'],
]);
const WGET_BODY_FLAGS: ReadonlySet<string> = new Set([
  ...['--post-data', '--post-file', '--method', '--body-data', '--body-file'],
]);

const MUTATION_HEADS: Readonly<Record<string, ReversibleHint>> = {
  rm: 'unknown',
  mv: 'likely',
  dd: 'unlikely',
  shred: 'unlikely',
  docker: 'unlikely',
  podman: 'unlikely',
  kubectl: 'unlikely',
  psql: 'unlikely',
  mysql: 'unlikely',
  mongosh: 'unlikely',
};
const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'doas']);
const PUBLISHERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cargo']);
const GH_MUTATION_VERBS: ReadonlySet<string> = new Set([
  ...['create', 'merge', 'close', 'delete', 'comment', 'edit', 'review', 'reopen', 'set', 'upload'],
]);
const GH_API_BODY_FLAGS: ReadonlySet<string> = new Set([
  '-f',
  '-F',
  '--field',
  '--raw-field',
  '--input',
]);

/** Redirection and download targets that are not files. */
const DEVICE_SINKS: ReadonlySet<string> = new Set([
  ...['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '-'],
]);

// ---------------------------------------------------------------------------
// Judgement state
// ---------------------------------------------------------------------------

interface Judgement {
  deny: DenyRuleId | undefined;
  signals: Set<RiskRuleId>;
  hints: ReversibleHint[];
  targets: Set<string>;
  /** A target or working directory this gate could not place. */
  unplaced: boolean;
}

function newJudgement(): Judgement {
  return { deny: undefined, signals: new Set(), hints: [], targets: new Set(), unplaced: false };
}

function deny(judgement: Judgement, ruleId: DenyRuleId): void {
  judgement.deny ??= ruleId;
}

function signal(judgement: Judgement, ruleId: RiskRuleId, hint: ReversibleHint = 'unknown'): void {
  judgement.signals.add(ruleId);
  judgement.hints.push(hint);
}

function combineHints(hints: readonly ReversibleHint[]): ReversibleHint {
  if (hints.includes('unlikely')) return 'unlikely';
  return hints.length > 0 && hints.every(hint => hint === 'likely') ? 'likely' : 'unknown';
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface SplitArgs {
  /** Words starting with `-`, before any `--`. */
  options: ResolvedWord[];
  positionals: ResolvedWord[];
  /** Values of the options named in `valueFlags`, by option. */
  values: Map<string, ResolvedWord[]>;
}

/** Splits arguments the way most commands do. `valueFlags` take the next word as their value. */
function splitArgs(
  args: readonly ResolvedWord[],
  valueFlags: ReadonlySet<string> = new Set()
): SplitArgs {
  const split: SplitArgs = { options: [], positionals: [], values: new Map() };
  const addValue = (flag: string, value: ResolvedWord): void => {
    split.values.set(flag, [...(split.values.get(flag) ?? []), value]);
  };
  let onlyPositionals = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (onlyPositionals || arg.dynamic || !arg.text.startsWith('-') || arg.text === '-') {
      split.positionals.push(arg);
      continue;
    }
    if (arg.text === '--') {
      onlyPositionals = true;
      continue;
    }
    split.options.push(arg);
    const equals = arg.text.indexOf('=');
    if (arg.text.startsWith('--') && equals !== -1) {
      addValue(arg.text.slice(0, equals), { ...arg, text: arg.text.slice(equals + 1) });
    } else if (valueFlags.has(arg.text)) {
      const value = args[i + 1];
      if (value !== undefined) addValue(arg.text, value);
      i++;
    }
  }
  return split;
}

/** Whether a short flag is present, alone or in a cluster such as `-rf`. */
function hasShort(options: readonly ResolvedWord[], flag: string): boolean {
  return options.some(option => /^-[A-Za-z0-9]+$/.test(option.text) && option.text.includes(flag));
}

function hasLong(options: readonly ResolvedWord[], flag: string): boolean {
  return options.some(option => option.text === flag || option.text.startsWith(`${flag}=`));
}

/**
 * Whether a long flag is present, spelled out or cut short. Git and GNU tools
 * accept any unambiguous prefix (`git reset --har`), so an exact match would be
 * a way round a rule. `shortest` is the shortest prefix the tool accepts.
 */
function hasLongAbbreviated(
  options: readonly ResolvedWord[],
  flag: string,
  shortest: string
): boolean {
  return options.some(option => {
    const name = option.text.split('=')[0] ?? '';
    return name.startsWith(shortest) && flag.startsWith(name);
  });
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

type Where =
  | { kind: 'resolved'; real: string; exists: boolean; inside: boolean }
  | { kind: 'unknown' }
  | { kind: 'failed' };

async function locate(text: string, cwd: string | undefined, context: RuleContext): Promise<Where> {
  if (!isAbsolute(text) && cwd === undefined) return { kind: 'unknown' };
  const resolved = await resolveRealPath(text, cwd ?? context.repoRoot);
  if (!resolved.ok) return { kind: 'failed' };
  return {
    kind: 'resolved',
    real: resolved.path,
    exists: resolved.exists,
    inside: isInside(context.repoRoot, resolved.path),
  };
}

/** A path as the secret vocabulary should see it: relative to the root when it is inside. */
function rootView(path: string, context: RuleContext): string {
  return isInside(context.repoRoot, path) ? relative(context.repoRoot, path) : path;
}

function literalView(text: string, context: RuleContext): string {
  return isAbsolute(text) ? rootView(resolve(text), context) : text;
}

function isDeviceSink(word: ResolvedWord): boolean {
  return !word.dynamic && (DEVICE_SINKS.has(word.text) || word.text.startsWith('/dev/fd/'));
}

interface ShellScope {
  context: RuleContext;
  judgement: Judgement;
  /** Working directory of the command being judged; `undefined` when a `cd` went somewhere unknown. */
  cwd: string | undefined;
}

/** Judges one path a call writes, moves or removes. */
async function judgeWriteTarget(target: ResolvedWord, scope: ShellScope): Promise<void> {
  const { context, judgement } = scope;
  if (isDeviceSink(target)) return;
  if (target.dynamic) {
    // The value is unknown, but a secret-shaped name around it is still a secret.
    if (isSecretPath(target.text)) deny(judgement, 'deny.secret_write');
    signal(judgement, 'risk.opaque_shell');
    judgement.unplaced = true;
    judgement.targets.add(target.text);
    return;
  }
  let text = target.text;
  if (target.glob) {
    // What a glob matches is unknown; the directory it is anchored in is not.
    signal(judgement, 'risk.opaque_shell');
    if (isSecretPath(literalView(text, context))) deny(judgement, 'deny.secret_write');
    text = text.slice(0, text.search(/[*?[]/));
    text = text.slice(0, text.lastIndexOf('/') + 1) || '.';
  }
  const where = await locate(text, scope.cwd, context);
  if (where.kind === 'unknown') {
    signal(judgement, 'risk.opaque_shell');
    judgement.unplaced = true;
    judgement.targets.add(target.text);
    return;
  }
  if (where.kind === 'failed') {
    deny(judgement, 'deny.path_unresolvable');
    return;
  }
  if (!where.inside) {
    deny(judgement, 'deny.path_outside_root');
    return;
  }
  if (
    isSecretPath(literalView(target.text, context)) ||
    isSecretPath(rootView(where.real, context))
  ) {
    deny(judgement, 'deny.secret_write');
    return;
  }
  judgement.targets.add(rootView(where.real, context) || '.');
}

/** Whether an argument names an env file, key or credential store. */
async function isSecretArgument(arg: ResolvedWord, scope: ShellScope): Promise<boolean> {
  const { context } = scope;
  const text = arg.text.startsWith('@') ? arg.text.slice(1) : arg.text;
  // A URL is not a local file, whatever its path looks like.
  if (text === '' || text.includes('://')) return false;
  const pathLike = /[/.~]/.test(text);
  if (pathLike && isSecretPath(literalView(text, context))) return true;
  if (arg.dynamic || arg.glob) return false;
  // A bare word is only a path if it exists; a symlink is judged by where it points.
  const where = await locate(text, scope.cwd, context);
  return where.kind === 'resolved' && where.exists && isSecretPath(rootView(where.real, context));
}

// ---------------------------------------------------------------------------
// Per-command rules
// ---------------------------------------------------------------------------

interface CommandView {
  command: ShellCommand;
  args: ResolvedWord[];
}

interface GitInvocation {
  subcommand: string | undefined;
  args: ResolvedWord[];
  directories: ResolvedWord[];
  configOverride: boolean;
}

function parseGit(args: readonly ResolvedWord[]): GitInvocation {
  const git: GitInvocation = {
    subcommand: undefined,
    args: [],
    directories: [],
    configOverride: false,
  };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined || arg.dynamic) break;
    const text = arg.text;
    if (!text.startsWith('-')) {
      git.subcommand = text;
      git.args = args.slice(i + 1);
      break;
    }
    if (text === '-C') {
      const directory = args[i + 1];
      if (directory !== undefined) git.directories.push(directory);
      i += 2;
    } else if (text === '-c' || text === '--config-env') {
      git.configOverride = true;
      i += 2;
    } else if (text.startsWith('--config-env=') || text.startsWith('--exec-path=')) {
      git.configOverride = true;
      i++;
    } else if (['--git-dir', '--work-tree', '--namespace', '--super-prefix'].includes(text)) {
      i += 2;
    } else {
      i++;
    }
  }
  return git;
}

/** The branch a push refspec writes to. `undefined` when the refspec does not name one. */
function pushDestination(refspec: string): string | undefined {
  const destination = refspec.slice(refspec.lastIndexOf(':') + 1).replace(/^refs\/heads\//, '');
  return destination === '' || destination === 'HEAD' || destination === '@'
    ? undefined
    : destination;
}

const PUSH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...['-o', '--push-option', '--repo', '--receive-pack', '--exec'],
]);
const PUSH_EVERYTHING_FLAGS: ReadonlySet<string> = new Set(['--all', '--mirror', '--branches']);

function judgeGitPush(args: readonly ResolvedWord[], scope: ShellScope): void {
  const { context, judgement } = scope;
  const { options, positionals } = splitArgs(args, PUSH_VALUE_FLAGS);
  const refspecs = positionals.slice(1);
  const forced = hasShort(options, 'f') || options.some(option => option.text === '--force');
  const lease = options.some(option => option.text.startsWith('--force-with-lease'));

  if (forced || refspecs.some(refspec => refspec.text.startsWith('+'))) {
    deny(judgement, 'deny.git_force_push');
  } else if (lease) {
    const unnamed =
      refspecs.length === 0 ||
      options.some(option => PUSH_EVERYTHING_FLAGS.has(option.text)) ||
      refspecs.some(refspec => refspec.dynamic || refspec.glob);
    const destinations = refspecs.map(refspec => pushDestination(refspec.text));
    const protectedOrUnknown = destinations.some(
      destination => destination === undefined || context.protectedBranches.includes(destination)
    );
    if (unnamed || protectedOrUnknown) deny(judgement, 'deny.git_force_push_protected');
  } else if (options.some(option => option.text === '--mirror')) {
    // A mirror push force-updates every remote ref and deletes the ones missing locally.
    deny(judgement, 'deny.git_force_push');
  }
  signal(judgement, 'risk.mutation_verb', 'unlikely');
}

/** Returns whether this git call is a known read-only one. */
async function judgeGit(view: CommandView, scope: ShellScope): Promise<boolean> {
  const { context, judgement } = scope;
  const git = parseGit(view.args);
  if (git.configOverride) signal(judgement, 'risk.opaque_shell');

  for (const directory of git.directories) {
    if (directory.dynamic) {
      signal(judgement, 'risk.opaque_shell');
      continue;
    }
    const where = await locate(directory.text, scope.cwd, context);
    if (where.kind !== 'resolved' || !where.inside) {
      signal(judgement, 'risk.cwd_outside_root');
      judgement.unplaced = true;
    }
  }

  const { options, positionals, values } = splitArgs(git.args, new Set(['--output']));
  for (const output of values.get('--output') ?? []) await judgeWriteTarget(output, scope);
  const runsProgram = options.some(option => GIT_EXEC_FLAGS.test(option.text));
  if (runsProgram) signal(judgement, 'risk.opaque_shell');

  // A deny rule that turns on a flag cannot be settled when the flag, or the
  // subcommand itself, sits in a variable: `git reset "$MODE"`, `git $SUB --hard`.
  const hidden = git.args.some(arg => arg.dynamic);
  if (git.subcommand === undefined && view.args.some(arg => arg.dynamic)) {
    signal(judgement, 'risk.opaque_shell');
  }

  switch (git.subcommand) {
    case 'push':
      judgeGitPush(git.args, scope);
      return false;
    case 'reset':
      if (hasLongAbbreviated(options, '--hard', '--ha')) deny(judgement, 'deny.git_reset_hard');
      else if (hidden) signal(judgement, 'risk.opaque_shell');
      return false;
    case 'clean':
      if (hidden) signal(judgement, 'risk.opaque_shell');
      if (hasShort(options, 'n') || hasLongAbbreviated(options, '--dry-run', '--d')) return false;
      // With -d, untracked directories go too. The force flag is not required
      // here: `clean.requireForce=false` makes git run without it.
      if (hasShort(options, 'd')) deny(judgement, 'deny.git_clean_force');
      else signal(judgement, 'risk.mutation_verb');
      return false;
    case 'rebase':
      signal(judgement, 'risk.mutation_verb', 'likely');
      return false;
    case 'branch':
      if (hasShort(options, 'D') || (hasLong(options, '--delete') && hasLong(options, '--force'))) {
        signal(judgement, 'risk.mutation_verb', 'likely');
        return false;
      }
      break;
    case 'tag':
      if (hasShort(options, 'd') || hasLong(options, '--delete')) {
        signal(judgement, 'risk.mutation_verb', 'likely');
      }
      return false;
    default:
      break;
  }

  if (git.subcommand === undefined || !READ_ONLY_GIT.has(git.subcommand)) return false;
  if (git.configOverride || runsProgram || values.has('--output')) return false;
  if (git.subcommand === 'branch') {
    return positionals.length === 0 && options.every(o => GIT_BRANCH_LIST_FLAGS.test(o.text));
  }
  if (git.subcommand === 'remote') {
    const [verb] = positionals;
    return verb === undefined || verb.text === 'show' || verb.text === 'get-url';
  }
  return true;
}

function stripTrailingSlashes(text: string): string {
  const stripped = text.replace(/\/+$/, '');
  return stripped === '' && text !== '' ? '/' : stripped;
}

/** Whether a directory is one whose recursive removal is never acceptable. */
async function isRootLikeDirectory(text: string, scope: ShellScope): Promise<boolean> {
  const { context } = scope;
  const trimmed = stripTrailingSlashes(text);
  if (trimmed === '.' || trimmed === '..') return true;
  const where = await locate(trimmed, scope.cwd, context);
  if (where.kind !== 'resolved') return false;
  // The root itself, the home directory, or anything that contains the root ("/" included).
  return where.real === context.homeDir || isInside(where.real, context.repoRoot);
}

async function isRootLikeRemoval(target: ResolvedWord, scope: ShellScope): Promise<boolean> {
  if (target.dynamic) return false;
  if (!target.glob) return isRootLikeDirectory(target.text, scope);
  // A bare glob: nothing but wildcards, dots and bracket syntax in the last
  // segment (`*`, `.*`, `.[!.]*`), so it names no particular file.
  const lastSlash = target.text.lastIndexOf('/');
  const name = target.text.slice(lastSlash + 1);
  if (!/^[*?.[\]!^]+$/.test(name)) return false;
  const directory = target.text.slice(0, lastSlash + 1);
  return directory === '' || isRootLikeDirectory(directory, scope);
}

async function judgeRm(view: CommandView, scope: ShellScope): Promise<void> {
  const { options, positionals } = splitArgs(view.args);
  const recursive =
    hasShort(options, 'r') ||
    hasShort(options, 'R') ||
    hasLongAbbreviated(options, '--recursive', '--r');
  await judgeRemoval(positionals, recursive, scope);
}

/** Judges paths a command removes; `recursive` adds the never-acceptable directories. */
async function judgeRemoval(
  targets: readonly ResolvedWord[],
  recursive: boolean,
  scope: ShellScope
): Promise<void> {
  for (const target of targets) {
    if (recursive && (await isRootLikeRemoval(target, scope))) {
      deny(scope.judgement, 'deny.rm_recursive_root');
    }
    await judgeWriteTarget(target, scope);
  }
}

/** `find <paths> ... -delete` removes everything under its start paths. */
async function judgeFindDelete(view: CommandView, scope: ShellScope): Promise<void> {
  if (!view.args.some(arg => arg.text === '-delete')) return;
  const expression = view.args.findIndex(arg => /^(-|\(|!)/.test(arg.text) && !arg.dynamic);
  const starts = view.args.slice(0, expression === -1 ? view.args.length : expression);
  await judgeRemoval(starts.length > 0 ? starts : [plainPath('.')], true, scope);
}

type TargetChoice = 'all' | 'last' | 'after_first' | 'none';

interface Writer {
  targets: TargetChoice;
  valueFlags?: readonly string[];
  /** Flags whose value is a directory written into. */
  directoryFlags?: readonly string[];
}

const TARGET_DIRECTORY_FLAGS = ['-t', '--target-directory'] as const;

/** Commands that write, move or remove the files they are given, and which operands those are. */
const WRITERS: Readonly<Record<string, Writer>> = {
  tee: { targets: 'all' },
  touch: { targets: 'all', valueFlags: ['-d', '-r', '-t', '--date', '--reference'] },
  mkdir: { targets: 'all', valueFlags: ['-m', '--mode'] },
  rmdir: { targets: 'all' },
  truncate: { targets: 'all', valueFlags: ['-s', '--size', '-r', '--reference'] },
  shred: { targets: 'all', valueFlags: ['-n', '--iterations', '-s', '--size'] },
  mv: { targets: 'all', valueFlags: ['-S', '--suffix'], directoryFlags: TARGET_DIRECTORY_FLAGS },
  cp: { targets: 'last', valueFlags: ['-S', '--suffix'], directoryFlags: TARGET_DIRECTORY_FLAGS },
  install: {
    targets: 'last',
    valueFlags: ['-m', '--mode', '-o', '--owner', '-g', '--group', '-S', '--suffix'],
    directoryFlags: TARGET_DIRECTORY_FLAGS,
  },
  ln: { targets: 'last', valueFlags: ['-S', '--suffix'], directoryFlags: TARGET_DIRECTORY_FLAGS },
  rsync: {
    targets: 'last',
    valueFlags: ['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--files-from'],
  },
  unzip: { targets: 'none', directoryFlags: ['-d'] },
  chmod: { targets: 'after_first' },
  chown: { targets: 'after_first' },
  chgrp: { targets: 'after_first' },
};

/** `host:path` and `user@host:path`: the far end of an rsync or scp, not a local file. */
const REMOTE_PATH = /^[^/]+:/;

function chooseTargets(positionals: ResolvedWord[], choice: TargetChoice): ResolvedWord[] {
  if (choice === 'none') return [];
  if (choice === 'all') return positionals;
  if (choice === 'after_first') return positionals.slice(1);
  const last = positionals.length >= 2 ? positionals.slice(-1) : [];
  return last.filter(target => !REMOTE_PATH.test(target.text));
}

/** Collects the files a command writes through its own arguments. */
function writeTargets(view: CommandView): ResolvedWord[] {
  const { command, args } = view;
  const writer = WRITERS[command.head];
  if (writer !== undefined) {
    const directoryFlags = writer.directoryFlags ?? [];
    const split = splitArgs(args, new Set([...(writer.valueFlags ?? []), ...directoryFlags]));
    const directories = directoryFlags.flatMap(flag => split.values.get(flag) ?? []);
    // With a target directory given, every operand is a source except for mv, which removes them.
    if (directories.length > 0 && writer.targets === 'last') return directories;
    return [...directories, ...chooseTargets(split.positionals, writer.targets)];
  }

  switch (command.head) {
    case 'dd':
      return args
        .filter(arg => arg.text.startsWith('of='))
        .map(arg => ({ ...arg, text: arg.text.slice('of='.length) }));
    case 'sed': {
      const split = splitArgs(args, SCRIPT_FLAGS);
      const inPlace = split.options.some(o => /^-[A-Za-z]*i|^--in-place/.test(o.text));
      if (!inPlace) return [];
      const scripted = split.options.some(option => SCRIPT_FLAGS.has(option.text));
      return scripted ? split.positionals : split.positionals.slice(1);
    }
    case 'perl': {
      // `-pi -e 's/a/b/' file`: a cluster ending in e takes the program as its value.
      const programFlags = args.filter(a => /^-[A-Za-z0-9.]*[eE]$/.test(a.text)).map(a => a.text);
      const split = splitArgs(args, new Set(programFlags));
      const inPlace = split.options.some(o => /^-[A-Za-z0-9]*i/.test(o.text));
      return inPlace ? split.positionals : [];
    }
    case 'curl': {
      const split = splitArgs(args, new Set(['-o', '--output']));
      const named = [...(split.values.get('-o') ?? []), ...(split.values.get('--output') ?? [])];
      const remoteName = hasShort(split.options, 'O') || hasLong(split.options, '--remote-name');
      return remoteName ? [...named, { text: '.', dynamic: false, glob: false }] : named;
    }
    case 'wget': {
      const split = splitArgs(
        args,
        new Set(['-O', '--output-document', '-P', '--directory-prefix'])
      );
      const attached = split.options.flatMap(option => {
        const match = /^-[A-Za-z]*O(.+)$/.exec(option.text);
        return match?.[1] === undefined ? [] : [{ ...option, text: match[1] }];
      });
      const documents = [
        ...(split.values.get('-O') ?? []),
        ...(split.values.get('--output-document') ?? []),
        ...attached,
      ];
      if (documents.length > 0) return documents;
      const prefixes = [
        ...(split.values.get('-P') ?? []),
        ...(split.values.get('--directory-prefix') ?? []),
      ];
      return prefixes.length > 0 ? prefixes : [{ text: '.', dynamic: false, glob: false }];
    }
    default:
      return [];
  }
}

/** Raises the signal for a call that reaches out over the network with a method or a body. */
function judgeNetworkClient(view: CommandView, judgement: Judgement): void {
  const { command, args } = view;
  const remoteRsync = command.head === 'rsync' && args.some(arg => REMOTE_PATH.test(arg.text));
  if (REMOTE_CLIENTS.has(command.head) || remoteRsync) {
    signal(judgement, 'risk.network_request', 'unlikely');
    return;
  }
  if (command.head === 'gh') {
    const split = splitArgs(args, new Set(['-X', '--method']));
    if (split.positionals[0]?.text !== 'api') return;
    const methods = [...(split.values.get('-X') ?? []), ...(split.values.get('--method') ?? [])];
    const unsafeMethod = methods.some(m => !SAFE_HTTP_METHODS.has(m.text.toUpperCase()));
    const body = split.options.some(o => GH_API_BODY_FLAGS.has(o.text.split('=')[0] ?? ''));
    if (unsafeMethod || body) signal(judgement, 'risk.network_request', 'unlikely');
    return;
  }
  if (!HTTP_CLIENTS.has(command.head)) return;

  let risky = false;
  if (command.head === 'curl') {
    args.forEach((arg, index) => {
      if (arg.dynamic || !arg.text.startsWith('-')) return;
      const name = arg.text.split('=')[0] ?? '';
      if (CURL_BODY_FLAGS.has(name)) risky = true;
      let method: string | undefined;
      if (name === '--request') {
        method = arg.text.includes('=') ? arg.text.slice(name.length + 1) : args[index + 1]?.text;
      } else if (!arg.text.startsWith('--')) {
        // `-sXDELETE`: what follows X is the method, not more flags.
        const cluster = arg.text.slice(1);
        const at = cluster.indexOf('X');
        if (/[dFT]/.test(at === -1 ? cluster : cluster.slice(0, at))) risky = true;
        if (at !== -1) method = cluster.slice(at + 1) || args[index + 1]?.text;
      }
      if (method !== undefined && !SAFE_HTTP_METHODS.has(method.toUpperCase())) risky = true;
    });
  } else if (command.head === 'wget') {
    risky = args.some(arg => WGET_BODY_FLAGS.has(arg.text.split('=')[0] ?? ''));
  } else {
    // httpie-style: an explicit method, or request items after the URL.
    const { positionals } = splitArgs(args);
    risky = positionals.some(
      (arg, index) =>
        (index === 0 && /^(POST|PUT|PATCH|DELETE)$/i.test(arg.text)) ||
        (!arg.text.includes('://') && /[=@]/.test(arg.text))
    );
  }
  if (risky) signal(judgement, 'risk.network_request', 'unlikely');
}

/** Raises the mutation signal for the verbs that change state outside what git can undo. */
function judgeMutation(view: CommandView, judgement: Judgement): void {
  const { command, args } = view;
  const { options, positionals } = splitArgs(args);
  if (command.wrappers.some(wrapper => PRIVILEGE_WRAPPERS.has(wrapper))) {
    signal(judgement, 'risk.mutation_verb', 'unlikely');
  }
  const hint = MUTATION_HEADS[command.head];
  if (hint !== undefined) signal(judgement, 'risk.mutation_verb', hint);
  if (command.head.startsWith('mkfs')) signal(judgement, 'risk.mutation_verb', 'unlikely');
  if (PRIVILEGE_WRAPPERS.has(command.head)) signal(judgement, 'risk.mutation_verb', 'unlikely');

  const recursive = hasShort(options, 'R') || hasLong(options, '--recursive');
  if (['chmod', 'chown', 'chgrp'].includes(command.head) && recursive) {
    signal(judgement, 'risk.mutation_verb');
  }
  if (PUBLISHERS.has(command.head) && positionals[0]?.text === 'publish') {
    signal(judgement, 'risk.mutation_verb', 'unlikely');
  }
  // `gh <noun> <verb>`; a global flag's value can push the verb one place right.
  const ghVerbs = positionals.slice(1, 3);
  if (command.head === 'gh' && positionals[0]?.text !== 'api') {
    if (ghVerbs.some(arg => GH_MUTATION_VERBS.has(arg.text))) {
      signal(judgement, 'risk.mutation_verb', 'unlikely');
    }
  }
  if (command.head === 'find' && args.some(arg => arg.text === '-delete')) {
    signal(judgement, 'risk.mutation_verb');
  }
}

/** Judges the paths a command reads: secrets it would print, and files it cannot be seen to name. */
async function judgeReads(view: CommandView, scope: ShellScope): Promise<void> {
  const { command } = view;
  const { judgement } = scope;
  if (TEXT_ONLY.has(command.head)) return;

  // For git the operands follow the subcommand, and only some subcommands print files.
  const git = command.head === 'git' ? parseGit(view.args) : undefined;
  const args = git?.args ?? view.args;
  const printsFiles =
    git === undefined
      ? CONTENT_READERS.has(command.head)
      : GIT_CONTENT_SUBCOMMANDS.has(git.subcommand ?? '');
  const sendsFiles = isNetworkClient(command.head) || command.head === 'rsync';
  const split = splitArgs(args);
  const scripted = split.options.some(option => SCRIPT_FLAGS.has(option.text));
  const operands =
    SCRIPT_FIRST.has(command.head) && !scripted ? split.positionals.slice(1) : split.positionals;
  const optionValues = [...split.values.values()].flat();
  // `done < file` and `< file` alone: whatever reads stdin there prints it.
  const sources = command.redirections
    .filter(redirection => redirection.operator === '<')
    .map(redirection => ({
      arg: resolveWord(redirection.target, scope.context.homeDir),
      isReader: printsFiles || command.head === '',
    }));
  const named = [...operands, ...optionValues].map(arg => ({ arg, isReader: printsFiles }));

  for (const { arg, isReader } of [...named, ...sources]) {
    // Prose passed to an unknown command is not a path: skip it unless a reader would open it.
    if (!isReader && /\s/.test(arg.text)) continue;
    if (await isSecretArgument(arg, scope)) {
      if (sendsFiles) deny(judgement, 'deny.secret_exfiltration');
      else if (isReader) deny(judgement, 'deny.secret_read');
      else if (!METADATA_ONLY.has(command.head)) signal(judgement, 'risk.secret_path_argument');
      continue;
    }
    // A reader whose file is a variable, or a glob over hidden files, may be opening a
    // secret. Git is left out: its variable arguments are refs far more often than files.
    if (!isReader || git !== undefined) continue;
    const name = arg.text.slice(arg.text.lastIndexOf('/') + 1);
    if (arg.dynamic || (arg.glob && name.startsWith('.'))) signal(judgement, 'risk.opaque_shell');
  }
}

function isVerificationCommand(view: CommandView, context: RuleContext): boolean {
  if (view.args.some(arg => arg.dynamic)) return false;
  const argv = [view.command.head, ...view.args.map(arg => arg.text)];
  return context.verificationCommands.some(entry => {
    const prefix = entry.trim().split(/\s+/);
    return prefix.every((token, index) => argv[index] === token);
  });
}

/** Whether a command is a known read-only one. Git is decided by `judgeGit`. */
function isReadOnly(view: CommandView, scope: ShellScope, gitReadOnly: boolean): boolean {
  const { command, args } = view;
  if (command.head === '' || command.opaque.length > 0 || command.assignments.length > 0) {
    return false;
  }
  if (command.wrappers.some(wrapper => !BENIGN_WRAPPERS.has(wrapper))) return false;
  const writesFile = command.redirections.some(
    redirection =>
      redirection.write && !isDeviceSink(resolveWord(redirection.target, scope.context.homeDir))
  );
  if (writesFile) return false;
  if (isVerificationCommand(view, scope.context)) return true;
  if (command.head === 'git') return gitReadOnly;
  if (command.head === 'find' && args.some(arg => FIND_WRITE_FLAGS.test(arg.text))) return false;
  return READ_ONLY_HEADS.has(command.head);
}

async function changeDirectory(view: CommandView, scope: ShellScope): Promise<string | undefined> {
  const { context, judgement } = scope;
  const [target] = splitArgs(view.args).positionals;
  if (target === undefined) return context.homeDir;
  if (target.dynamic || target.glob || target.text === '-') {
    judgement.unplaced = true;
    return undefined;
  }
  const where = await locate(target.text, scope.cwd, context);
  if (where.kind !== 'resolved') {
    judgement.unplaced = true;
    return undefined;
  }
  if (!where.inside) signal(judgement, 'risk.cwd_outside_root');
  return where.real;
}

/** Judges one command. Returns whether it matched the read-only allow rule. */
async function judgeCommand(view: CommandView, scope: ShellScope): Promise<boolean> {
  const { command, args } = view;
  const { judgement, context } = scope;

  if (command.opaque.length > 0) signal(judgement, 'risk.opaque_shell');

  let gitReadOnly = false;
  if (command.head === 'git') gitReadOnly = await judgeGit(view, scope);
  if (command.head === 'rm') await judgeRm(view, scope);
  if (command.head === 'find') await judgeFindDelete(view, scope);
  if (command.head === 'rg' && args.some(arg => RG_EXEC_FLAGS.test(arg.text))) {
    signal(judgement, 'risk.opaque_shell');
  }

  for (const target of writeTargets(view)) await judgeWriteTarget(target, scope);
  for (const redirection of command.redirections) {
    if (redirection.write) {
      await judgeWriteTarget(resolveWord(redirection.target, context.homeDir), scope);
    }
  }

  await judgeReads(view, scope);
  judgeMutation(view, judgement);
  judgeNetworkClient(view, judgement);

  return isReadOnly(view, scope, gitReadOnly);
}

// ---------------------------------------------------------------------------
// Rules that span commands
// ---------------------------------------------------------------------------

function readsProgramFromStdin(view: CommandView): boolean {
  const { command, args } = view;
  if (SHELL_INTERPRETERS.has(command.head)) {
    const { options, positionals } = splitArgs(
      args,
      new Set(['-o', '-O', '--rcfile', '--init-file'])
    );
    if (options.some(option => /^-[A-Za-z]*c[A-Za-z]*$/.test(option.text))) return false;
    return positionals.length === 0 || positionals[0]?.text === '-' || hasShort(options, 's');
  }
  if (command.head === 'source' || command.head === '.') {
    return args.some(arg => arg.text === '/dev/stdin' || arg.text === '/proc/self/fd/0');
  }
  if (STDIN_INTERPRETERS.has(command.head)) {
    const { positionals } = splitArgs(args);
    return positionals.length === 0 || positionals[0]?.text === '-';
  }
  return false;
}

function dumpsEnvironment(view: CommandView): boolean {
  const { command, args } = view;
  const { options, positionals } = splitArgs(args);
  switch (command.head) {
    case 'printenv':
      return true;
    case 'env':
    case 'set':
      return positionals.length === 0;
    case 'export':
    case 'declare':
    case 'typeset':
      return positionals.length === 0 || hasShort(options, 'p');
    default:
      return args.some(arg => /^\/proc\/[^/]+\/environ$/.test(arg.text));
  }
}

function isNetworkClient(head: string): boolean {
  return HTTP_CLIENTS.has(head) || REMOTE_CLIENTS.has(head);
}

function judgeAcrossCommands(views: readonly CommandView[], judgement: Judgement): void {
  views.forEach((later, index) => {
    for (const earlier of views.slice(0, index)) {
      if (earlier.command.pipeline !== later.command.pipeline) continue;
      if (FETCHERS.has(earlier.command.head) && readsProgramFromStdin(later)) {
        deny(judgement, 'deny.pipe_to_shell');
      }
      if (dumpsEnvironment(earlier) && isNetworkClient(later.command.head)) {
        deny(judgement, 'deny.secret_exfiltration');
      }
    }
    // The same two attacks written as a substitution: `bash <(curl …)`, `curl -d "$(printenv)"`.
    const { parent, via } = later.command;
    const holder = parent === undefined ? undefined : views[parent];
    if (holder === undefined || via !== 'substitution') return;
    if (FETCHERS.has(later.command.head) && RUNS_ITS_ARGUMENT.has(holder.command.head)) {
      deny(judgement, 'deny.pipe_to_shell');
    }
    if (dumpsEnvironment(later) && isNetworkClient(holder.command.head)) {
      deny(judgement, 'deny.secret_exfiltration');
    }
  });
}

/** How many `echo ... | sh` layers are read before the rest is left as opaque. */
const MAX_PIPED_SCRIPT_NESTING = 3;

/** Judges one script. Returns whether every command in it matched the read-only allow rule. */
async function judgeScript(
  parsed: ParsedShell,
  startCwd: string | undefined,
  context: RuleContext,
  judgement: Judgement,
  nesting = 0
): Promise<boolean> {
  if (parsed.opaque.length > 0) signal(judgement, 'risk.opaque_shell');

  const views: CommandView[] = parsed.commands.map(command => ({
    command,
    args: command.args.map(word => resolveWord(word, context.homeDir)),
  }));
  judgeAcrossCommands(views, judgement);

  // One working directory per subshell: a `cd` inside `( ... )` or `$(...)` ends
  // with it. A subshell starts where its enclosing one stands when it is first used.
  const cwdByScope = new Map<number, string | undefined>();
  const cwdOf = (id: number): string | undefined => {
    if (cwdByScope.has(id)) return cwdByScope.get(id);
    const enclosing = parsed.scopeParents[id];
    const inherited = enclosing === undefined ? startCwd : cwdOf(enclosing);
    cwdByScope.set(id, inherited);
    return inherited;
  };

  let allReadOnly = views.length > 0 && parsed.opaque.length === 0;
  for (const [index, view] of views.entries()) {
    const scope: ShellScope = { context, judgement, cwd: cwdOf(view.command.scope) };
    if (!(await judgeCommand(view, scope))) allReadOnly = false;

    // `... | sh`: the shell runs whatever the pipe carries. That text is unknown
    // unless the stage before it is an echo of literals, which is read as a script.
    const feeder = views
      .slice(0, index)
      .filter(earlier => earlier.command.pipeline === view.command.pipeline)
      .at(-1);
    if (feeder !== undefined && readsProgramFromStdin(view)) {
      signal(judgement, 'risk.opaque_shell');
      const literal = TEXT_ONLY.has(feeder.command.head) && feeder.args.every(arg => !arg.dynamic);
      if (literal && nesting < MAX_PIPED_SCRIPT_NESTING) {
        // printf's first argument is the format, not part of what it prints.
        const printed = feeder.command.head === 'printf' ? feeder.args.slice(1) : feeder.args;
        const piped = parseShell(printed.map(arg => arg.text).join(' '));
        await judgeScript(piped, scope.cwd, context, judgement, nesting + 1);
      }
    }
    if (view.command.head === 'cd' || view.command.head === 'pushd') {
      cwdByScope.set(view.command.scope, await changeDirectory(view, scope));
    }
  }
  return allReadOnly;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function denied(ruleId: DenyRuleId): RuleOutcome {
  const rule = DENY_RULES[ruleId];
  return { outcome: 'deny', ruleId, reason: rule.reason, alternatives: [...rule.alternatives] };
}

function conclude(judgement: Judgement, allowRule: AllowRuleId, cwdInside: boolean): RuleOutcome {
  if (judgement.deny !== undefined) return denied(judgement.deny);
  const signals = RISK_RULE_IDS.filter(ruleId => judgement.signals.has(ruleId));
  const [strongest] = signals;
  if (strongest === undefined) return { outcome: 'allow', ruleId: allowRule };
  return {
    outcome: 'escalate',
    ruleId: strongest,
    signals,
    targets: [...judgement.targets],
    repoRelative:
      cwdInside && !judgement.unplaced && !judgement.signals.has('risk.cwd_outside_root'),
    reversibleHint: combineHints(judgement.hints),
  };
}

function plainPath(text: string): ResolvedWord {
  return { text, dynamic: false, glob: false };
}

/** Judges one tool call by the fixed rules. No shell is run and nothing is written. */
export async function evaluateRules(
  request: ToolActionRequest,
  context: RuleContext
): Promise<RuleOutcome> {
  const judgement = newJudgement();
  const paths = request.paths ?? [];

  if (request.kind === 'mcp') {
    signal(judgement, 'risk.kind_mcp');
    return conclude(judgement, 'default.no_signal', false);
  }

  // Everything below places paths, which needs a working directory it can trust.
  const needsCwd = request.kind === 'shell' || paths.length > 0;
  let cwd: string | undefined;
  let cwdInside = false;
  if (isAbsolute(request.cwd)) {
    const where = await locate(request.cwd, request.cwd, context);
    if (where.kind === 'resolved') {
      cwd = where.real;
      cwdInside = where.inside;
    } else if (needsCwd) {
      return denied('deny.path_unresolvable');
    }
  } else if (needsCwd) {
    return denied('deny.unreadable_request');
  }

  const scope: ShellScope = { context, judgement, cwd };
  for (const path of paths) await judgeWriteTarget(plainPath(path), scope);

  switch (request.kind) {
    case 'file_write':
      if (paths.length === 0) return denied('deny.unreadable_request');
      return conclude(judgement, 'allow.write_in_root', cwdInside);
    case 'network':
      signal(judgement, 'risk.kind_network');
      if (request.url !== undefined) judgement.targets.add(request.url);
      return conclude(judgement, 'default.no_signal', false);
    case 'other':
      return conclude(judgement, 'default.no_signal', cwdInside);
    case 'shell': {
      const texts = [request.command, ...(request.parsedCommands ?? [])].filter(
        (text): text is string => typeof text === 'string' && text.trim() !== ''
      );
      if (texts.length === 0) return denied('deny.unreadable_request');
      if (!cwdInside) signal(judgement, 'risk.cwd_outside_root');
      let allReadOnly = true;
      for (const text of texts) {
        if (!(await judgeScript(parseShell(text), cwd, context, judgement))) allReadOnly = false;
      }
      return conclude(judgement, allReadOnly ? 'allow.read_only' : 'default.no_signal', cwdInside);
    }
  }
}
