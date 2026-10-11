/**
 * What the rules know for certain about a flagged call, said in fixed words.
 *
 * A flagged call goes to a classifier that sees only its text. Some things
 * about it are not in the text and are known here: which branch is checked
 * out, where a path really lands, what a `gh` verb is. They travel with the
 * escalation as named facts, so the classifier judges the call and does not
 * have to guess its surroundings.
 *
 * A fact is only ever stated when it is certain. Anything else is left out,
 * and the classifier is told `unknown`.
 */

/** Values of each fact, least concerning first: a call that states one twice keeps the later one. */
export const ESCALATION_FACT_VALUES = {
  /** Where a `git push` lands. */
  gitPushTarget: [
    'checked_out_branch',
    'other_unprotected_branch',
    'unknown',
    'several_or_all_refs',
    'deletes_remote_ref',
    'protected_branch',
  ],
  /** What a `git checkout`/`restore` of paths throws away. The whole tree is denied by rule, never stated. */
  uncommittedWork: ['discarded_in_named_paths', 'unknown'],
  /** What an `rm` or `find -delete` removes. */
  removalTarget: ['build_or_cache_output', 'other_repository_path', 'unknown'],
  /** What a `gh` command does on GitHub. */
  githubAction: [
    'comment',
    'open_or_update',
    'ci_run_control',
    'other',
    'merge_or_close',
    'workflow_dispatch',
    'release',
    'delete',
    'settings_or_secrets',
  ],
  /** The host a database, HTTP or remote-shell client talks to. */
  targetHost: ['test_or_dev_named', 'loopback', 'unknown', 'production_named'],
} as const;

export type EscalationFactName = keyof typeof ESCALATION_FACT_VALUES;
export type EscalationFacts = {
  [Name in EscalationFactName]?: (typeof ESCALATION_FACT_VALUES)[Name][number];
};

/** States a fact. Stated twice in one call (two pushes, two removals), the more concerning value stands. */
export function noteFact<Name extends EscalationFactName>(
  facts: EscalationFacts,
  name: Name,
  value: (typeof ESCALATION_FACT_VALUES)[Name][number]
): void {
  const order: readonly string[] = ESCALATION_FACT_VALUES[name];
  // Every value of every fact is a string; widened here so one write serves all five.
  const stated: Partial<Record<EscalationFactName, string>> = facts;
  const current = stated[name];
  if (current === undefined || order.indexOf(value) > order.indexOf(current)) stated[name] = value;
}

/**
 * Directory names that hold only what a build, an install or a test run can
 * make again. Matched as whole path segments.
 */
const BUILD_OUTPUT_DIRECTORIES: ReadonlySet<string> = new Set([
  ...['node_modules', 'dist', 'build', 'target', '.cache', '__pycache__', 'coverage'],
]);

/** Whether a repository-relative path lies in (or is) a build, install or cache directory. */
export function isBuildOutputPath(repositoryRelative: string): boolean {
  return repositoryRelative.split(/[\\/]/).some(segment => BUILD_OUTPUT_DIRECTORIES.has(segment));
}

type GithubAction = NonNullable<EscalationFacts['githubAction']>;

/** `gh <group> <verb>` pairs, by what they do. A pair not listed is `other`. */
const GITHUB_ACTIONS: Readonly<Record<string, GithubAction>> = {
  'pr comment': 'comment',
  'pr review': 'comment',
  'issue comment': 'comment',
  'pr create': 'open_or_update',
  'pr edit': 'open_or_update',
  'pr ready': 'open_or_update',
  'issue create': 'open_or_update',
  'issue edit': 'open_or_update',
  'run rerun': 'ci_run_control',
  'run cancel': 'ci_run_control',
  'workflow run': 'workflow_dispatch',
  'pr merge': 'merge_or_close',
  'pr close': 'merge_or_close',
  'pr reopen': 'merge_or_close',
  'issue close': 'merge_or_close',
  'issue reopen': 'merge_or_close',
  'release create': 'release',
  'release edit': 'release',
  'release upload': 'release',
  'release delete': 'delete',
  'repo delete': 'delete',
  'issue delete': 'delete',
  'run delete': 'delete',
  'cache delete': 'delete',
  'gist delete': 'delete',
  'repo edit': 'settings_or_secrets',
  'repo archive': 'settings_or_secrets',
  'repo unarchive': 'settings_or_secrets',
  'repo rename': 'settings_or_secrets',
  'repo transfer': 'settings_or_secrets',
  'secret set': 'settings_or_secrets',
  'secret delete': 'settings_or_secrets',
  'variable set': 'settings_or_secrets',
  'variable delete': 'settings_or_secrets',
  'workflow enable': 'settings_or_secrets',
  'workflow disable': 'settings_or_secrets',
  'ruleset create': 'settings_or_secrets',
  'ruleset edit': 'settings_or_secrets',
  'ruleset delete': 'settings_or_secrets',
};

export function githubAction(group: string, verb: string): GithubAction {
  return GITHUB_ACTIONS[`${group} ${verb}`] ?? 'other';
}

type TargetHost = NonNullable<EscalationFacts['targetHost']>;

const LOOPBACK_HOST =
  /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)$/i;
/** A name segment that marks a host or database as production, or as a test or development one. */
const PRODUCTION_WORD = /(^|[^a-z])(prod|production|live)([^a-z]|$)/i;
const TEST_WORD = /(^|[^a-z])(test|tests|testing|dev|development|local|sandbox)([^a-z]|$)/i;

/** The host of a URL and what follows it, or of `user@host` and `user@host:path` as ssh and scp take them. */
function hostOf(word: string): { host: string; path: string } | undefined {
  const url =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^/:?#\s]+)(?::\d+)?([^?#\s]*)/i.exec(word);
  if (url?.[1] !== undefined) return { host: url[1], path: url[2] ?? '' };
  const remote = /^[^@/\s]+@([^:/\s]+)/.exec(word)?.[1];
  return remote === undefined ? undefined : { host: remote, path: '' };
}

/** Options whose value names the host or the database a database client connects to. */
const HOST_OPTIONS: ReadonlySet<string> = new Set(['-h', '--host', '--hostname']);
const DATABASE_OPTIONS: ReadonlySet<string> = new Set(['-d', '--dbname', '--database', '-D']);

/**
 * Where a database, HTTP or remote-shell client connects, read from its
 * arguments: a URL, a `user@host`, and for a database client its host and
 * database options and the database a URL names. `undefined` when the
 * arguments name none of these.
 *
 * Loopback is certain about the address and nothing more: a port-forward or a
 * tunnel puts a production database there too. The other two go by the name
 * alone, which is how an operator tells them apart: a host or database called
 * `prod` or `test`. A name wins over the address. Only the host and the
 * database are read as names, never a user, a path or a request body.
 */
export function targetHost(
  args: readonly string[],
  databaseClient: boolean
): TargetHost | undefined {
  const names: string[] = [];
  let host: string | undefined;
  args.forEach((arg, index) => {
    const next = args[index + 1];
    const named = hostOf(arg);
    if (named !== undefined) {
      host ??= named.host;
      if (databaseClient) names.push(named.path);
    }
    if (!databaseClient) return;
    const [flag, attached] = arg.startsWith('--') ? arg.split('=', 2) : [arg, undefined];
    if (flag !== undefined && HOST_OPTIONS.has(flag)) host ??= attached ?? next;
    if (flag !== undefined && DATABASE_OPTIONS.has(flag)) names.push(attached ?? next ?? '');
  });
  if (host === undefined && names.length === 0) return undefined;
  if (host !== undefined) names.push(host);
  if (names.some(name => PRODUCTION_WORD.test(name))) return 'production_named';
  // A name says more than an address: a tunnel puts any database on loopback.
  if (names.some(name => TEST_WORD.test(name))) return 'test_or_dev_named';
  if (host !== undefined && LOOPBACK_HOST.test(host)) return 'loopback';
  return 'unknown';
}
