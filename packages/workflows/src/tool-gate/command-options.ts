/**
 * How commands spell their options, in one place.
 *
 * A rule that asks "where does this command write?" or "is that word a file or
 * a pattern?" has to know which options take a value, and a value can be
 * attached to its option (`-ofile`), sit at the end of a cluster (`-sSLo file`)
 * or follow as the next word. Reading that three different ways in three rules
 * is how `curl -sSLo ~/.bashrc` once passed, so every rule and the wrapper
 * stripper read options through this one parser and one table.
 */

/** The least a word must offer to be read as an option. */
export interface OptionWord {
  text: string;
  /** Holds an expansion whose value is unknown; never read as an option. */
  dynamic: boolean;
}

export interface OptionSpec {
  /** Short option letters that take a value. */
  valueShort?: string;
  /** Long options that take the next word as their value (`--name=value` always works). */
  valueLong?: readonly string[];
  /**
   * Options are whole words after one dash (`find -name`, `openssl -in`), never
   * clusters of letters. Names that take a value are listed in `valueLong`.
   */
  wholeWord?: boolean;
}

export interface ParsedOptions<T extends OptionWord> {
  /** Every option seen: `-x` per short letter, the full name for a long one. */
  flags: Set<string>;
  /** Values by option name, in order. A value keeps its word, with only the text narrowed. */
  values: Map<string, T[]>;
  /** Everything that is not an option or an option's value. */
  positionals: T[];
}

const NO_OPTIONS: OptionSpec = {};

/** The value-taking long option an abbreviation stands for, when it names exactly one. */
function expandLong(name: string, spec: OptionSpec): string | undefined {
  const known = spec.valueLong ?? [];
  if (known.includes(name)) return name;
  // GNU and git accept any unambiguous prefix of a long option.
  const matches = name.length >= 4 ? known.filter(candidate => candidate.startsWith(name)) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

interface OptionRead<T extends OptionWord> {
  /** Whether the next word was taken as this option's value. */
  tookNext: boolean;
  flags: string[];
  value?: { name: string; word: T };
}

/** Reads one option word. `next` is the word after it, for a detached value. */
function readOption<T extends OptionWord>(
  word: T,
  next: T | undefined,
  spec: OptionSpec
): OptionRead<T> {
  const { text } = word;
  if (text.startsWith('--') || spec.wholeWord) {
    const equals = text.indexOf('=');
    const written = equals === -1 ? text : text.slice(0, equals);
    const name = expandLong(written, spec) ?? written;
    if (equals !== -1) {
      return {
        tookNext: false,
        flags: [name],
        value: { name, word: { ...word, text: text.slice(equals + 1) } },
      };
    }
    if (expandLong(written, spec) !== undefined && next !== undefined) {
      return { tookNext: true, flags: [name], value: { name, word: next } };
    }
    return { tookNext: false, flags: [name] };
  }
  const flags: string[] = [];
  const valueShort = spec.valueShort ?? '';
  for (let index = 1; index < text.length; index++) {
    const name = `-${text[index] ?? ''}`;
    flags.push(name);
    if (!valueShort.includes(text[index] ?? '')) continue;
    // A value letter ends the cluster: what follows it, or the next word, is its value.
    const attached = text.slice(index + 1);
    if (attached !== '')
      return { tookNext: false, flags, value: { name, word: { ...word, text: attached } } };
    if (next !== undefined) return { tookNext: true, flags, value: { name, word: next } };
    return { tookNext: false, flags };
  }
  return { tookNext: false, flags };
}

function isOption(word: OptionWord): boolean {
  return !word.dynamic && word.text.startsWith('-') && word.text !== '-';
}

function record<T extends OptionWord>(parsed: ParsedOptions<T>, read: OptionRead<T>): void {
  for (const flag of read.flags) parsed.flags.add(flag);
  if (read.value === undefined) return;
  parsed.values.set(read.value.name, [
    ...(parsed.values.get(read.value.name) ?? []),
    read.value.word,
  ]);
}

/** Splits arguments the way most commands do: options anywhere, `--` ends them. */
export function parseOptions<T extends OptionWord>(
  args: readonly T[],
  spec: OptionSpec = NO_OPTIONS
): ParsedOptions<T> {
  const parsed: ParsedOptions<T> = { flags: new Set(), values: new Map(), positionals: [] };
  let onlyPositionals = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === undefined) continue;
    if (onlyPositionals || !isOption(word)) {
      parsed.positionals.push(word);
    } else if (word.text === '--') {
      onlyPositionals = true;
    } else {
      const read = readOption(word, args[index + 1], spec);
      record(parsed, read);
      if (read.tookNext) index++;
    }
  }
  return parsed;
}

/**
 * Reads only the options a command line starts with, as a wrapper does before
 * the command it runs. `count` is how many words they took, `--` included.
 */
export function leadingOptions<T extends OptionWord>(
  args: readonly T[],
  spec: OptionSpec = NO_OPTIONS
): ParsedOptions<T> & { count: number } {
  const parsed: ParsedOptions<T> = { flags: new Set(), values: new Map(), positionals: [] };
  let index = 0;
  while (index < args.length) {
    const word = args[index];
    if (word === undefined || !isOption(word)) break;
    index++;
    if (word.text === '--') break;
    const read = readOption(word, args[index], spec);
    record(parsed, read);
    if (read.tookNext) index++;
  }
  return { ...parsed, count: index };
}

/** Every value given for any of `names`. */
export function valuesOf<T extends OptionWord>(
  parsed: ParsedOptions<T>,
  ...names: readonly string[]
): T[] {
  return names.flatMap(name => parsed.values.get(name) ?? []);
}

/** Whether any of `names` was given, as a flag or with a value. */
export function hasOption(parsed: ParsedOptions<OptionWord>, ...names: readonly string[]): boolean {
  return names.some(name => parsed.flags.has(name));
}

/**
 * Whether a long flag is present, spelled out or cut short. Git and GNU tools
 * accept any unambiguous prefix (`git reset --har`), so an exact match would be
 * a way round a rule. `shortest` is the shortest prefix the tool accepts.
 */
export function hasAbbreviated(
  parsed: ParsedOptions<OptionWord>,
  flag: string,
  shortest: string
): boolean {
  return [...parsed.flags].some(name => name.startsWith(shortest) && flag.startsWith(name));
}

/**
 * Value-taking options of the commands the rules read arguments of. A command
 * missing here is parsed with no value options, which errs toward calling a
 * value a positional — and positionals are what the path rules judge.
 */
export const OPTION_SPECS: Readonly<Record<string, OptionSpec>> = {
  cp: { valueShort: 'tS', valueLong: ['--target-directory', '--suffix'] },
  mv: { valueShort: 'tS', valueLong: ['--target-directory', '--suffix'] },
  ln: { valueShort: 'tS', valueLong: ['--target-directory', '--suffix'] },
  install: {
    valueShort: 'tSmog',
    valueLong: ['--target-directory', '--suffix', '--mode', '--owner', '--group'],
  },
  touch: { valueShort: 'drt', valueLong: ['--date', '--reference'] },
  mkdir: { valueShort: 'm', valueLong: ['--mode'] },
  truncate: { valueShort: 'sr', valueLong: ['--size', '--reference'] },
  shred: { valueShort: 'ns', valueLong: ['--iterations', '--size'] },
  head: { valueShort: 'nc', valueLong: ['--lines', '--bytes'] },
  tail: { valueShort: 'ncs', valueLong: ['--lines', '--bytes', '--pid', '--sleep-interval'] },
  cut: { valueShort: 'bcdf', valueLong: ['--bytes', '--characters', '--delimiter', '--fields'] },
  fold: { valueShort: 'w', valueLong: ['--width'] },
  sort: {
    valueShort: 'okStT',
    valueLong: ['--output', '--key', '--buffer-size', '--field-separator', '--temporary-directory'],
  },
  grep: {
    valueShort: 'efmABCD',
    valueLong: [
      ...['--regexp', '--file', '--max-count', '--after-context', '--before-context'],
      ...['--context', '--exclude', '--include', '--exclude-dir', '--exclude-from', '--label'],
    ],
  },
  rg: {
    valueShort: 'efgtTmABCMjEr',
    valueLong: [
      ...['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count'],
      ...['--after-context', '--before-context', '--context', '--max-columns', '--threads'],
      ...['--encoding', '--replace', '--pre', '--pre-glob', '--hostname-bin', '--max-depth'],
      ...['--sort', '--sortr', '--color', '--colors', '--type-add', '--ignore-file'],
    ],
  },
  sed: { valueShort: 'efl', valueLong: ['--expression', '--file', '--line-length'] },
  awk: { valueShort: 'fFv', valueLong: ['--file', '--field-separator', '--assign'] },
  jq: {
    wholeWord: true,
    valueLong: ['-f', '--from-file', '-L', '--indent', '--tab'],
  },
  curl: {
    valueShort: 'odHXuAebcDFTxKwmrtyYzCEQPU',
    valueLong: [
      ...['--output', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii'],
      ...['--json', '--form', '--form-string', '--upload-file', '--header', '--request', '--user'],
      ...['--user-agent', '--referer', '--cookie', '--cookie-jar', '--dump-header', '--proxy'],
      ...['--config', '--write-out', '--max-time', '--connect-timeout', '--retry', '--range'],
      ...['--output-dir', '--trace', '--trace-ascii', '--stderr', '--etag-save', '--etag-compare'],
      ...['--cert', '--key', '--cacert', '--capath', '--netrc-file', '--url', '--resolve'],
      ...['--hsts', '--alt-svc', '--unix-socket', '--interface', '--max-redirs', '--limit-rate'],
    ],
  },
  wget: {
    valueShort: 'OoaPitTwQUeBDARIXl',
    valueLong: [
      ...['--output-document', '--output-file', '--append-output', '--directory-prefix'],
      ...['--input-file', '--tries', '--timeout', '--wait', '--user-agent', '--header'],
      ...['--post-data', '--post-file', '--method', '--body-data', '--body-file', '--user'],
      ...['--password', '--save-cookies', '--load-cookies', '--warc-file', '--execute'],
    ],
  },
  ssh: { valueShort: 'iFoplLRDJbcEemSwBIQW' },
  scp: { valueShort: 'iFoPlcJSD' },
  sftp: { valueShort: 'iFoPbcBDlRsS' },
  rsync: {
    valueShort: 'efBTM',
    valueLong: [
      ...['--rsh', '--exclude', '--include', '--filter', '--files-from', '--exclude-from'],
      ...['--include-from', '--log-file', '--password-file', '--port', '--bwlimit', '--chmod'],
      ...['--chown', '--temp-dir', '--partial-dir', '--backup-dir', '--suffix', '--compare-dest'],
      ...['--copy-dest', '--link-dest', '--out-format', '--rsync-path', '--max-size'],
    ],
  },
  unzip: { valueShort: 'dxP' },
  patch: {
    valueShort: 'dioprBDFVYzg',
    valueLong: ['--directory', '--input', '--output', '--strip', '--reject-file', '--fuzz'],
  },
  gpg: {
    valueShort: 'ourN',
    valueLong: [
      ...['--output', '--local-user', '--recipient', '--homedir', '--passphrase', '--keyring'],
      ...['--passphrase-file', '--recv-keys', '--keyserver', '--export', '--import'],
    ],
  },
  xxd: { valueShort: 'clgos' },
  openssl: {
    wholeWord: true,
    valueLong: [
      ...['-in', '-out', '-inkey', '-key', '-keyout', '-pass', '-passin', '-passout', '-CAfile'],
      ...['-cert', '-certfile', '-config', '-days', '-subj', '-newkey', '-k', '-kfile'],
    ],
  },
  find: { wholeWord: true },
  gcc: { valueShort: 'oIDLlxU', wholeWord: false },
  'g++': { valueShort: 'oIDLlxU' },
  cc: { valueShort: 'oIDLlxU' },
  clang: { valueShort: 'oIDLlxU' },
  'clang++': { valueShort: 'oIDLlxU' },
  rustc: { valueShort: 'oLlCA', valueLong: ['--out-dir', '--crate-name', '--edition'] },
  ld: { valueShort: 'oLlT' },
  docker: { valueLong: ['--env-file', '--config', '--context', '--host'] },
  gh: {
    valueShort: 'XfFHRqtbBaAlmLjS',
    valueLong: [
      '--method',
      '--field',
      '--raw-field',
      '--input',
      '--header',
      '--repo',
      '--jq',
      '--template',
      '--body',
      '--title',
      '--body-file',
      '--base',
      '--head',
      '--label',
      '--assignee',
      '--reviewer',
      '--limit',
      '--json',
      '--search',
      '--hostname',
    ],
  },
  sh: { valueShort: 'oO', valueLong: ['--rcfile', '--init-file'] },
  python: { valueShort: 'cmWXQ' },
  node: {
    valueShort: 'epr',
    valueLong: ['--eval', '--print', '--require', '--import', '--loader', '--env-file'],
  },
  perl: { valueShort: 'eEIMmx' },
  ruby: { valueShort: 'eIrECFKx' },
  php: { valueShort: 'rcdfzBRFE' },
};

/** Options of git subcommands, by subcommand. */
export const GIT_OPTION_SPECS: Readonly<Record<string, OptionSpec>> = {
  push: {
    valueShort: 'o',
    valueLong: ['--push-option', '--repo', '--receive-pack', '--exec'],
  },
  clean: { valueShort: 'e', valueLong: ['--exclude'] },
  grep: {
    valueShort: 'efABCmO',
    valueLong: [
      '--max-depth',
      '--max-count',
      '--context',
      '--after-context',
      '--before-context',
      '--threads',
      '--open-files-in-pager',
    ],
  },
  log: {
    valueShort: 'SGnLO',
    valueLong: [
      '--grep',
      '--author',
      '--committer',
      '--since',
      '--until',
      '--after',
      '--before',
      '--format',
      '--pretty',
      '--max-count',
      '--skip',
      '--output',
      '--date',
      '--diff-filter',
    ],
  },
  diff: {
    valueShort: 'SGOU',
    valueLong: ['--output', '--diff-filter', '--stat-width', '--word-diff-regex'],
  },
  show: { valueShort: 'SGO', valueLong: ['--format', '--pretty', '--output'] },
  commit: {
    valueShort: 'mFCct',
    valueLong: [
      '--message',
      '--file',
      '--author',
      '--date',
      '--reuse-message',
      '--reedit-message',
      '--fixup',
      '--squash',
      '--template',
      '--cleanup',
    ],
  },
  checkout: { valueShort: 'bB', valueLong: ['--orphan', '--conflict', '--pathspec-from-file'] },
  switch: { valueShort: 'cC', valueLong: ['--create', '--force-create', '--orphan', '--conflict'] },
  restore: { valueShort: 's', valueLong: ['--source', '--conflict', '--pathspec-from-file'] },
  clone: {
    valueShort: 'bojcu',
    valueLong: [
      '--branch',
      '--origin',
      '--depth',
      '--reference',
      '--separate-git-dir',
      '--template',
      '--config',
      '--jobs',
      '--upload-pack',
      '--shallow-since',
      '--filter',
    ],
  },
  worktree: { valueShort: 'bB', valueLong: ['--reason', '--expire'] },
  config: { valueShort: 'f', valueLong: ['--file', '--blob', '--type', '--default'] },
  apply: {
    valueShort: 'pC',
    valueLong: ['--directory', '--exclude', '--include', '--whitespace', '--build-fake-ancestor'],
  },
  archive: {
    valueShort: 'o',
    valueLong: ['--output', '--format', '--prefix', '--remote', '--exec'],
  },
  'format-patch': {
    valueShort: 'o',
    valueLong: ['--output-directory', '--subject-prefix', '--start-number'],
  },
  branch: {
    valueShort: 'u',
    valueLong: [
      '--set-upstream-to',
      '--sort',
      '--format',
      '--contains',
      '--no-contains',
      '--merged',
      '--no-merged',
      '--points-at',
      '--color',
    ],
  },
  tag: {
    valueShort: 'mFuln',
    valueLong: [
      '--message',
      '--file',
      '--local-user',
      '--sort',
      '--format',
      '--contains',
      '--points-at',
    ],
  },
  stash: { valueShort: 'm', valueLong: ['--message'] },
  rebase: {
    valueShort: 'sXxC',
    valueLong: ['--onto', '--strategy', '--strategy-option', '--exec', '--empty'],
  },
  blame: {
    valueShort: 'LSC',
    valueLong: ['--since', '--contents', '--ignore-rev', '--ignore-revs-file'],
  },
};
