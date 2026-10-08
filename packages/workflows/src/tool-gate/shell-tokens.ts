/**
 * Reads shell text into commands without evaluating any of it.
 *
 * The reader is quote-aware: a word is a list of parts, so `"git"`, `g''it`,
 * `\git` and `/usr/bin/git` all end up with the head `git`. It splits on `;`,
 * `&&`, `||`, `|`, `&`, newlines and parentheses, tracks groups (`( )`, `{ }`,
 * `if`, loops) so a pipe into or out of a group is still seen as a pipe, strips
 * leading env assignments and wrappers (`sudo`, `env`, `timeout`, `nice`,
 * `xargs` and others, any number deep), and records redirections. The only
 * expansions it resolves are `~`, `$HOME`, a leading `$PWD` and plain `$'...'`
 * escapes; every other expansion makes a word dynamic.
 *
 * What it cannot read it marks opaque, so the rules never allow it outright:
 * command and process substitution, `eval`, `sh -c` strings, heredocs fed to an
 * interpreter, `find -exec`, aliases and functions, `xargs`-fed arguments, a
 * variable as the command name, an unterminated quote. Hidden text is read as
 * commands too wherever it can be found — a `-c` string (expansions kept as
 * written), the body of `$(...)`, a heredoc fed to a shell, an alias value — so
 * a destructive command inside still shows.
 *
 * Limits. This is a reader, not a shell, and these stay invisible to it:
 *  - a script written to disk and then executed (`./run.sh`, `bash run.sh`,
 *    `source x`, `curl -o x.sh ... && sh x.sh`);
 *  - interpreter programs: the rules look for shell strings and secret paths
 *    quoted inside `python -c` / `node -e` code, and see nothing else in it;
 *  - indirection through `make`, package scripts, git hooks, and aliases or
 *    functions defined in the user's shell or git config;
 *  - what a variable, a glob, brace expansion or an `xargs` input becomes at run
 *    time: a destructive flag kept in a variable is at best escalated, never
 *    denied, because its value is not known here;
 *  - shell syntax it does not model (`case` patterns, extended globs, `[[ ]]`
 *    internals) and every non-POSIX shell: PowerShell and cmd text is read as
 *    if it were POSIX and mostly matches nothing;
 *  - anything a tool does that is not shell text at all, such as an MCP tool.
 */
import { leadingOptions, type OptionSpec, type OptionWord } from './command-options';

/** One piece of a word. Quotes are already removed; `variable` text is as written. */
export type WordPart =
  | { kind: 'literal'; text: string }
  /** An unquoted `~` where the shell expands it, `$HOME` or `${HOME}`. */
  | { kind: 'home' }
  /** `$PWD` or `${PWD}`: the working directory, which only the caller can place. */
  | { kind: 'cwd' }
  /** Any other expansion: its value is unknown here. */
  | { kind: 'variable'; text: string }
  /** An unquoted `*`, `?` or `[...]`. */
  | { kind: 'glob'; text: string };

/**
 * Shell text hidden inside a word: the body of `$(...)` or backticks, of
 * `<(...)`, or of `>(...)`, which reads what the command holding it writes.
 */
export interface NestedScript {
  text: string;
  via: 'command_substitution' | 'process_substitution' | 'output_substitution';
}

export interface ShellWord {
  parts: WordPart[];
  nested: NestedScript[];
}

/**
 * How a command is held by its `parent`: inside one of its words (`$(...)`,
 * backticks, `<(...)`), as the reader of its output (`>(...)`), as the script
 * it runs (`-c`, `eval`, a heredoc), or as the command `find -exec` runs.
 */
export type NestedVia = 'substitution' | 'sink' | 'script' | 'exec';

export type OpaqueKind =
  | 'command_substitution'
  | 'process_substitution'
  | 'eval'
  | 'shell_dash_c'
  | 'heredoc'
  | 'find_exec'
  | 'alias_or_function'
  | 'xargs'
  | 'variable_head'
  | 'wrapper_option'
  | 'unterminated_quote'
  | 'nesting_limit';

export type RedirectOperator =
  | '>'
  | '>>'
  | '&>'
  | '&>>'
  | '>|'
  | '>&'
  | '<'
  | '<&'
  | '<>'
  | '<<'
  | '<<<';

export interface ShellRedirection {
  operator: RedirectOperator;
  /** The file, the fd for `>&`/`<&`, or the delimiter of a heredoc. */
  target: ShellWord;
  /** Whether the redirection writes a file (an fd duplication does not). */
  write: boolean;
}

/** One level of pipeline a command sits in, and its position along that pipe. */
export interface PipelineStage {
  id: number;
  stage: number;
}

export interface ShellCommand {
  /** Base name of the command after assignments and wrappers; `''` when unknown or absent. */
  head: string;
  args: ShellWord[];
  /** Names of the env assignments stripped from the front. */
  assignments: string[];
  /** Wrappers stripped from the front, outermost first. */
  wrappers: string[];
  /** Every option and operand the wrappers consumed, for rules that read file arguments. */
  wrapperWords: ShellWord[];
  /** Files the wrappers themselves write (`time -o`, `strace -o`). */
  wrapperTargets: ShellWord[];
  /** The directory a wrapper runs the command in (`env -C`, `sudo -D`). */
  chdir?: ShellWord;
  redirections: ShellRedirection[];
  /** Literal text on stdin: heredoc bodies and here-strings. */
  stdin: string[];
  /** The innermost pipeline: commands joined by `|` share it. */
  pipeline: number;
  /**
   * Every pipeline this command is part of, outermost first. A command inside a
   * group is a member of each pipeline the group is a stage of, which is how
   * `(curl x) | sh` is seen as curl piped into sh.
   */
  pipelinePath: PipelineStage[];
  /**
   * The subshell this command runs in: `( ... )`, a substitution body and a `-c`
   * script each get their own, so a `cd` inside one ends with it. Index into
   * `ParsedShell.scopeParents`.
   */
  scope: number;
  /** Index of the command whose substitution, `-c` string or heredoc held this one. */
  parent?: number;
  via?: NestedVia;
  opaque: OpaqueKind[];
}

export interface ParsedShell {
  commands: ShellCommand[];
  /** Opaque constructs that belong to no single command. */
  opaque: OpaqueKind[];
  /** For each scope, the scope that encloses it; `undefined` for the outermost. */
  scopeParents: (number | undefined)[];
}

/** A word's text with `~` and `$HOME` resolved, and whether the rest of it is knowable. */
export interface ResolvedWord {
  text: string;
  /** Holds an expansion whose value is unknown. */
  dynamic: boolean;
  /** Holds an unquoted glob. */
  glob: boolean;
}

export const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
]);

/** Variables that name the user's shell: `curl x | $SHELL` runs a shell. */
const SHELL_VARIABLES: ReadonlySet<string> = new Set(['$SHELL', '${SHELL}', '$BASH', '${BASH}']);

/** Commands that only read a heredoc as data. Fed to anything else, a heredoc is opaque. */
const HEREDOC_DATA_SINKS: ReadonlySet<string> = new Set(['cat', 'tee', 'wc', 'grep', 'jq']);

/** How deep `-c` strings and substitution bodies are followed. */
const MAX_NESTING = 5;

const FIND_EXEC_FLAGS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

export function resolveWord(word: ShellWord, homeDir: string): ResolvedWord {
  let text = '';
  let dynamic = false;
  let glob = false;
  for (const [index, part] of word.parts.entries()) {
    if (part.kind === 'home') {
      text += homeDir;
    } else if (part.kind === 'cwd') {
      // `$PWD` and `$PWD/x` are `.` and `./x`. Anywhere else (`a/$PWD`, `${PWD}x`)
      // the result is not relative to the working directory, so it stays unknown.
      const next = word.parts[index + 1];
      const startsPath =
        next === undefined || (next.kind === 'literal' && next.text.startsWith('/'));
      if (index === 0 && startsPath) {
        text += '.';
      } else {
        text += '$PWD';
        dynamic = true;
      }
    } else {
      text += part.text;
      if (part.kind === 'variable') dynamic = true;
      if (part.kind === 'glob') glob = true;
    }
  }
  return { text, dynamic, glob };
}

/** The word's text when every part is literal, otherwise `undefined`. */
export function literalText(word: ShellWord): string | undefined {
  let text = '';
  for (const part of word.parts) {
    if (part.kind !== 'literal') return undefined;
    text += part.text;
  }
  return text;
}

/**
 * A word as shell text again, expansions kept as written. This is what a shell
 * given the word as a script (`bash -c "rm -rf $DIR"`) would go on to parse.
 */
export function renderWord(word: ShellWord): string {
  return word.parts
    .map(part => {
      if (part.kind === 'home') return '$HOME';
      if (part.kind === 'cwd') return '$PWD';
      return part.text;
    })
    .join('');
}

function literalWord(text: string): ShellWord {
  return { parts: [{ kind: 'literal', text }], nested: [] };
}

// ---------------------------------------------------------------------------
// Scanner: text → words, operators and redirections
// ---------------------------------------------------------------------------

const ANSI_C_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['a', '\x07'],
  ['b', '\b'],
  ['e', '\x1b'],
  ['E', '\x1b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
  ['?', '?'],
]);

/**
 * The value of a `$'...'` body, or `undefined` when it uses an escape this
 * reader does not decode. Decoding matters: `$'\x2d\x2dforce'` is a flag.
 */
function decodeAnsiC(body: string): string | undefined {
  let decoded = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? '';
    if (ch !== '\\') {
      decoded += ch;
      i++;
      continue;
    }
    const rest = body.slice(i + 1);
    const simple = ANSI_C_ESCAPES.get(rest[0] ?? '');
    if (simple !== undefined) {
      decoded += simple;
      i += 2;
      continue;
    }
    const hex =
      /^x([0-9A-Fa-f]{1,2})/.exec(rest) ??
      /^u([0-9A-Fa-f]{1,4})/.exec(rest) ??
      /^U([0-9A-Fa-f]{1,8})/.exec(rest);
    const octal = /^[0-7]{1,3}/.exec(rest);
    const codePoint =
      hex?.[1] !== undefined ? parseInt(hex[1], 16) : octal ? parseInt(octal[0], 8) : undefined;
    // NUL ends the string in bash; anything else unknown is left to the shell.
    if (codePoint === undefined || codePoint === 0 || codePoint > 0x10ffff) return undefined;
    decoded += String.fromCodePoint(codePoint);
    i += 1 + (hex ?? octal ?? [''])[0].length;
  }
  return decoded;
}

/**
 * The substitutions that still run inside text the shell expands but does not
 * split into commands: an unquoted heredoc body, an arithmetic expression.
 */
function embeddedSubstitutions(body: string): NestedScript[] {
  const found: NestedScript[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '$' && body[i + 1] === '(') {
      const close = findClosing(body, i + 2, '(', ')');
      const end = close === -1 ? body.length : close;
      found.push({ text: body.slice(i + 2, end), via: 'command_substitution' });
      i = end + 1;
    } else if (ch === '`') {
      const close = body.indexOf('`', i + 1);
      const end = close === -1 ? body.length : close;
      found.push({ text: body.slice(i + 1, end), via: 'command_substitution' });
      i = end + 1;
    } else {
      i++;
    }
  }
  return found;
}

type ControlOperator = ';' | '&&' | '||' | '|' | '&' | '\n' | '(' | ')';

interface WordItem {
  type: 'word';
  word: ShellWord;
  /** No quoting anywhere in the word, so it can be a shell keyword. */
  bare: boolean;
}
interface OperatorItem {
  type: 'operator';
  operator: ControlOperator;
}
interface RedirectItem {
  type: 'redirect';
  operator: RedirectOperator;
  /** Heredoc body, filled in once the scanner reaches it. */
  body?: string;
  /** False when the heredoc delimiter was quoted, which turns the body into plain text. */
  expands?: boolean;
}
type Item = WordItem | OperatorItem | RedirectItem;

interface WordBuilder {
  parts: WordPart[];
  nested: NestedScript[];
  quoted: boolean;
}

interface PendingHeredoc {
  item: RedirectItem;
  stripTabs: boolean;
  delimiter: string;
}

function isBlank(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

function isWordBreak(ch: string | undefined): boolean {
  return (
    ch === undefined ||
    isBlank(ch) ||
    ch === '\n' ||
    ch === ';' ||
    ch === '&' ||
    ch === '|' ||
    ch === '(' ||
    ch === ')' ||
    ch === '<' ||
    ch === '>'
  );
}

/**
 * Index of the bracket that closes the one opened just before `start`, or -1.
 * Quotes and backslashes inside are skipped so a `)` in a string does not close early.
 */
function findClosing(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return -1;
      i = j + 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

interface ScanResult {
  items: Item[];
  unterminated: boolean;
}

function scan(text: string): ScanResult {
  const items: Item[] = [];
  const length = text.length;
  let unterminated = false;
  let word: WordBuilder | undefined;
  let pendingHeredocs: PendingHeredoc[] = [];
  let i = 0;

  const current = (): WordBuilder => {
    word ??= { parts: [], nested: [], quoted: false };
    return word;
  };
  const addLiteral = (literal: string): void => {
    const builder = current();
    const last = builder.parts.at(-1);
    if (last?.kind === 'literal') last.text += literal;
    else builder.parts.push({ kind: 'literal', text: literal });
  };
  const addVariable = (written: string): void => {
    current().parts.push({ kind: 'variable', text: written });
  };
  const flush = (): void => {
    if (word === undefined) return;
    items.push({
      type: 'word',
      word: { parts: word.parts, nested: word.nested },
      bare: !word.quoted,
    });
    word = undefined;
  };
  const pushOperator = (operator: ControlOperator): void => {
    flush();
    items.push({ type: 'operator', operator });
  };
  const pushRedirect = (operator: RedirectOperator): RedirectItem => {
    const item: RedirectItem = { type: 'redirect', operator };
    items.push(item);
    return item;
  };

  /** Reads `$(...)`, `<(...)` or `>(...)` whose `(` sits at `open`; returns the index after it. */
  const scanSubstitution = (start: number, open: number, via: NestedScript['via']): number => {
    const close = findClosing(text, open + 1, '(', ')');
    const end = close === -1 ? length : close + 1;
    if (close === -1) unterminated = true;
    addVariable(text.slice(start, end));
    current().nested.push({ text: text.slice(open + 1, close === -1 ? length : close), via });
    return end;
  };

  /**
   * Reads arithmetic (`$((...))`, `$[...]`, `((...))`) ending at `bodyEnd`
   * (exclusive) and `end` (exclusive), as one word of unknown value. Inside it
   * `<<` is a shift, not a heredoc, so none of it may reach the redirect reader.
   */
  const addArithmetic = (start: number, bodyStart: number, bodyEnd: number, end: number): void => {
    addVariable(text.slice(start, end));
    current().nested.push(...embeddedSubstitutions(text.slice(bodyStart, bodyEnd)));
  };

  /** Reads the expansion starting at the `$` at `start`; returns the index after it. */
  const scanDollar = (start: number, inDoubleQuotes: boolean): number => {
    const next = text[start + 1];
    if (next === '(') {
      // `$(( expr ))` is arithmetic when the inner bracket is closed by `))`;
      // otherwise it is a command substitution that starts with a subshell.
      const inner = text[start + 2] === '(' ? findClosing(text, start + 3, '(', ')') : -1;
      if (inner !== -1 && text[inner + 1] === ')') {
        addArithmetic(start, start + 3, inner, inner + 2);
        return inner + 2;
      }
      return scanSubstitution(start, start + 1, 'command_substitution');
    }
    if (next === '[') {
      // The old spelling of arithmetic expansion, still accepted by bash.
      const close = findClosing(text, start + 2, '[', ']');
      if (close === -1) unterminated = true;
      const end = close === -1 ? length : close + 1;
      addArithmetic(start, start + 2, close === -1 ? length : close, end);
      return end;
    }
    if (next === '{') {
      const close = findClosing(text, start + 2, '{', '}');
      const end = close === -1 ? length : close + 1;
      if (close === -1) unterminated = true;
      const body = text.slice(start + 2, close === -1 ? length : close);
      if (body === 'HOME') {
        current().parts.push({ kind: 'home' });
      } else if (body === 'PWD') {
        current().parts.push({ kind: 'cwd' });
      } else {
        addVariable(text.slice(start, end));
        // `${X:-$(cmd)}` runs cmd: hand the body on so the substitution in it is read.
        if (body.includes('$(') || body.includes('`')) {
          current().nested.push({ text: body, via: 'command_substitution' });
        }
      }
      return end;
    }
    if (next === "'" && !inDoubleQuotes) {
      let j = start + 2;
      while (j < length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
      if (j >= length) unterminated = true;
      const end = Math.min(j + 1, length);
      current().quoted = true;
      const decoded = decodeAnsiC(text.slice(start + 2, Math.min(j, length)));
      if (decoded === undefined) addVariable(text.slice(start, end));
      else addLiteral(decoded);
      return end;
    }
    if (next === '"' && !inDoubleQuotes) return start + 1;
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      let j = start + 1;
      while (j < length && /[A-Za-z0-9_]/.test(text[j] ?? '')) j++;
      const name = text.slice(start + 1, j);
      if (name === 'HOME') current().parts.push({ kind: 'home' });
      else if (name === 'PWD') current().parts.push({ kind: 'cwd' });
      else addVariable(`$${name}`);
      return j;
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      addVariable(`$${next}`);
      return start + 2;
    }
    addLiteral('$');
    return start + 1;
  };

  /** Reads a backtick substitution starting at `start`; returns the index after it. */
  const scanBackticks = (start: number): number => {
    let inner = '';
    let j = start + 1;
    while (j < length && text[j] !== '`') {
      const ch = text[j] ?? '';
      const escaped = text[j + 1];
      if (ch === '\\' && escaped !== undefined) {
        inner += escaped === '`' || escaped === '\\' || escaped === '$' ? escaped : ch + escaped;
        j += 2;
      } else {
        inner += ch;
        j++;
      }
    }
    if (j >= length) unterminated = true;
    const end = Math.min(j + 1, length);
    addVariable(text.slice(start, end));
    current().nested.push({ text: inner, via: 'command_substitution' });
    return end;
  };

  const scanDoubleQuotes = (start: number): number => {
    current().quoted = true;
    let j = start + 1;
    while (j < length && text[j] !== '"') {
      const ch = text[j] ?? '';
      if (ch === '\\') {
        const escaped = text[j + 1];
        if (escaped === undefined) {
          addLiteral(ch);
          j++;
        } else if (escaped === '\n') {
          j += 2;
        } else {
          addLiteral('$`"\\'.includes(escaped) ? escaped : ch + escaped);
          j += 2;
        }
      } else if (ch === '$') {
        j = scanDollar(j, true);
      } else if (ch === '`') {
        j = scanBackticks(j);
      } else {
        addLiteral(ch);
        j++;
      }
    }
    if (j >= length) {
      unterminated = true;
      return length;
    }
    return j + 1;
  };

  /**
   * Reads a heredoc delimiter starting at `start`. The shell removes quotes
   * from it and expands nothing: `<<$HOME` ends at a line reading `$HOME`.
   * Reading it as an ordinary word would move the end of the body, and with it
   * which lines are data and which are commands.
   */
  const scanDelimiter = (start: number): { delimiter: string; quoted: boolean; end: number } => {
    let delimiter = '';
    let quoted = false;
    let j = start;
    while (j < length && !isWordBreak(text[j])) {
      const ch = text[j] ?? '';
      if (ch === '\\') {
        quoted = true;
        delimiter += text[j + 1] ?? '';
        j += 2;
      } else if (ch === "'" || ch === '"') {
        quoted = true;
        let close = j + 1;
        while (close < length && text[close] !== ch) {
          close += ch === '"' && text[close] === '\\' ? 2 : 1;
        }
        const inner = text.slice(j + 1, Math.min(close, length));
        delimiter += ch === '"' ? inner.replace(/\\([$`"\\])/g, '$1') : inner;
        if (close >= length) unterminated = true;
        j = close + 1;
      } else if (ch === '$' && text[j + 1] === '(') {
        // Kept verbatim, spaces included: the word runs to the matching bracket.
        const close = findClosing(text, j + 2, '(', ')');
        const end = close === -1 ? length : close + 1;
        delimiter += text.slice(j, end);
        j = end;
      } else {
        delimiter += ch;
        j++;
      }
    }
    return { delimiter, quoted, end: Math.min(j, length) };
  };

  const scanRedirect = (start: number): number => {
    const ch = text[start];
    const next = text[start + 1];
    if (next === '(') {
      const via = ch === '>' ? 'output_substitution' : 'process_substitution';
      return scanSubstitution(start, start + 1, via);
    }

    // `2>` — a bare number glued to the operator is the fd, not an argument.
    const fd = word !== undefined && !word.quoted ? literalText(word) : undefined;
    if (fd !== undefined && /^\d+$/.test(fd)) word = undefined;
    else flush();

    if (ch === '<') {
      if (text.startsWith('<<<', start)) {
        pushRedirect('<<<');
        return start + 3;
      }
      if (next === '<') {
        const stripTabs = text[start + 2] === '-';
        let at = start + (stripTabs ? 3 : 2);
        while (isBlank(text[at])) at++;
        const { delimiter, quoted, end } = scanDelimiter(at);
        const item = pushRedirect('<<');
        item.expands = !quoted;
        items.push({ type: 'word', word: literalWord(delimiter), bare: false });
        pendingHeredocs.push({ item, stripTabs, delimiter });
        return end;
      }
      if (next === '&') {
        pushRedirect('<&');
        return start + 2;
      }
      if (next === '>') {
        pushRedirect('<>');
        return start + 2;
      }
      pushRedirect('<');
      return start + 1;
    }
    if (next === '>') {
      pushRedirect('>>');
      return start + 2;
    }
    if (next === '&') {
      pushRedirect('>&');
      return start + 2;
    }
    if (next === '|') {
      pushRedirect('>|');
      return start + 2;
    }
    pushRedirect('>');
    return start + 1;
  };

  /** Consumes the heredoc bodies that start on the line at `start`. */
  const consumeHeredocs = (start: number): number => {
    let position = start;
    for (const heredoc of pendingHeredocs) {
      const lines: string[] = [];
      let closed = false;
      while (position < length && !closed) {
        const lineEnd = text.indexOf('\n', position);
        const line = text.slice(position, lineEnd === -1 ? length : lineEnd);
        position = lineEnd === -1 ? length : lineEnd + 1;
        closed = (heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter;
        if (!closed) lines.push(line);
      }
      heredoc.item.body = lines.join('\n');
    }
    pendingHeredocs = [];
    return position;
  };

  /** Whether `~` at `at` follows `=` or `:` in a word shaped like `name=value`. */
  const tildeInAssignment = (at: number): boolean => {
    if (word === undefined || word.quoted) return false;
    const before = text[at - 1];
    if (before !== '=' && before !== ':') return false;
    const first = word.parts[0];
    return first?.kind === 'literal' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text);
  };

  while (i < length) {
    const ch = text[i] ?? '';
    const next = text[i + 1];
    if (ch === '\\') {
      if (next === undefined) {
        addLiteral(ch);
        i++;
      } else if (next === '\n') {
        i += 2;
      } else {
        current().quoted = true;
        addLiteral(next);
        i += 2;
      }
    } else if (ch === "'") {
      current().quoted = true;
      const close = text.indexOf("'", i + 1);
      if (close === -1) {
        unterminated = true;
        addLiteral(text.slice(i + 1));
        i = length;
      } else {
        addLiteral(text.slice(i + 1, close));
        i = close + 1;
      }
    } else if (ch === '"') {
      i = scanDoubleQuotes(i);
    } else if (ch === '$') {
      i = scanDollar(i, false);
    } else if (ch === '`') {
      i = scanBackticks(i);
    } else if (isBlank(ch)) {
      flush();
      i++;
    } else if (ch === '\n') {
      pushOperator('\n');
      i = consumeHeredocs(i + 1);
    } else if (ch === '#' && word === undefined) {
      const lineEnd = text.indexOf('\n', i);
      i = lineEnd === -1 ? length : lineEnd;
    } else if (ch === ';') {
      pushOperator(';');
      i += next === ';' ? 2 : 1;
    } else if (ch === '&') {
      if (next === '&') {
        pushOperator('&&');
        i += 2;
      } else if (next === '>') {
        flush();
        const append = text[i + 2] === '>';
        pushRedirect(append ? '&>>' : '&>');
        i += append ? 3 : 2;
      } else {
        pushOperator('&');
        i++;
      }
    } else if (ch === '|') {
      if (next === '|') {
        pushOperator('||');
        i += 2;
      } else {
        pushOperator('|');
        i += next === '&' ? 2 : 1;
      }
    } else if (ch === '(' && next === '(' && word === undefined) {
      // `(( expr ))` is arithmetic when the inner bracket is closed by `))`;
      // otherwise it is two nested subshells.
      const inner = findClosing(text, i + 2, '(', ')');
      if (inner !== -1 && text[inner + 1] === ')') {
        addArithmetic(i, i + 2, inner, inner + 2);
        // A shell without `((` runs the same text as nested subshells: read it as commands too.
        current().nested.push({ text: text.slice(i + 2, inner), via: 'command_substitution' });
        i = inner + 2;
      } else {
        pushOperator(ch);
        i++;
      }
    } else if (ch === '(' || ch === ')') {
      pushOperator(ch);
      i++;
    } else if (ch === '<' || ch === '>') {
      i = scanRedirect(i);
    } else if (ch === '*' || ch === '?') {
      current().parts.push({ kind: 'glob', text: ch });
      i++;
    } else if (ch === '[') {
      let close = i + 1;
      while (!isWordBreak(text[close]) && text[close] !== ']') close++;
      if (text[close] === ']' && close > i + 1) {
        current().parts.push({ kind: 'glob', text: text.slice(i, close + 1) });
        i = close + 1;
      } else {
        addLiteral(ch);
        i++;
      }
    } else if (ch === '~' && (word === undefined || tildeInAssignment(i))) {
      // Bash also expands `~` after `=` and `:` in an argument shaped like an
      // assignment (`dd of=~/x`). Other shells do not; reading it as home is the safe side.
      if (next === '/' || next === ':' || isWordBreak(next)) {
        current().parts.push({ kind: 'home' });
        i++;
      } else if (word === undefined) {
        // ~user, ~+ and ~- name a directory this reader cannot know.
        let j = i + 1;
        while (!isWordBreak(text[j]) && text[j] !== '/') j++;
        addVariable(text.slice(i, j));
        i = j;
      } else {
        addLiteral(ch);
        i++;
      }
    } else if (ch === '{') {
      const standalone = word === undefined && (next === undefined || isBlank(next));
      if (standalone || next === '}' || next === '\n') addLiteral(ch);
      // Brace expansion (`{a,b}`, `{1..3}`) turns one word into several.
      else addVariable(ch);
      i++;
    } else {
      addLiteral(ch);
      i++;
    }
  }
  flush();
  // A heredoc opened on the last line has no body at all.
  for (const heredoc of pendingHeredocs) heredoc.item.body = '';
  return { items, unterminated };
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

export interface WrapperSpec extends OptionSpec {
  /**
   * `benign`: the wrapped command does exactly what it would do alone.
   * `privileged`: it runs with more rights. `runner`: it resolves or fetches the
   * command, or feeds it arguments the reader cannot see.
   */
  kind: 'benign' | 'privileged' | 'runner';
  /** Words between the options and the command: timeout's duration, chroot's new root. */
  operands?: number;
  /** Takes `NAME=value` words before the command. */
  assignments?: boolean;
  /** Options whose value is a file the wrapper writes. */
  writes?: readonly string[];
  /** Options whose value is the directory the command runs in. */
  chdir?: readonly string[];
  /** Options whose value is shell text the wrapper runs. */
  script?: readonly string[];
  /** The command's arguments arrive on stdin (`xargs`). */
  stdinArgs?: boolean;
  /** With one of these as its first word the wrapper runs nothing (`command -v git`). */
  lookup?: readonly string[];
}

/**
 * Every command that runs another command given as its remaining words, and how
 * to get from one to the other. The rules read `kind` from here too, so what
 * counts as a harmless or a privileged wrapper has one definition.
 */
export const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  sudo: {
    kind: 'privileged',
    valueShort: 'ughpCDRTUrt',
    valueLong: [
      ...['--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type'],
      ...['--other-user', '--close-from'],
    ],
    assignments: true,
    chdir: ['-D', '--chdir'],
  },
  doas: { kind: 'privileged', valueShort: 'uC' },
  pkexec: { kind: 'privileged', valueLong: ['--user'] },
  runuser: {
    kind: 'privileged',
    valueShort: 'ugGcsw',
    valueLong: ['--user', '--group', '--supp-group', '--command', '--shell'],
    script: ['-c', '--command'],
  },
  chroot: { kind: 'privileged', valueLong: ['--userspec', '--groups'], operands: 1 },
  'systemd-run': {
    kind: 'privileged',
    valueShort: 'puEMH',
    valueLong: ['--property', '--unit', '--uid', '--gid', '--setenv', '--working-directory'],
    chdir: ['--working-directory'],
  },
  env: {
    kind: 'benign',
    valueShort: 'uCS',
    valueLong: ['--unset', '--chdir', '--split-string'],
    assignments: true,
    chdir: ['-C', '--chdir'],
    script: ['-S', '--split-string'],
  },
  timeout: {
    kind: 'benign',
    valueShort: 'sk',
    valueLong: ['--signal', '--kill-after'],
    operands: 1,
  },
  nice: { kind: 'benign', valueShort: 'n', valueLong: ['--adjustment'] },
  ionice: { kind: 'benign', valueShort: 'cnp', valueLong: ['--class', '--classdata', '--pid'] },
  chrt: { kind: 'benign', valueShort: 'pT', operands: 1 },
  taskset: { kind: 'benign', valueShort: 'p', operands: 1 },
  nohup: { kind: 'benign' },
  setsid: { kind: 'benign' },
  unbuffer: { kind: 'benign' },
  chronic: { kind: 'benign' },
  caffeinate: { kind: 'benign', valueShort: 'tw' },
  stdbuf: { kind: 'benign', valueShort: 'ioe', valueLong: ['--input', '--output', '--error'] },
  command: { kind: 'benign', lookup: ['-v', '-V'] },
  builtin: { kind: 'benign' },
  exec: { kind: 'benign', valueShort: 'a' },
  time: {
    kind: 'benign',
    valueShort: 'of',
    valueLong: ['--output', '--format'],
    writes: ['-o', '--output'],
  },
  strace: {
    kind: 'runner',
    valueShort: 'oepsuEaPIbXSU',
    valueLong: ['--output', '--trace', '--attach', '--user'],
    writes: ['-o', '--output'],
  },
  ltrace: {
    kind: 'runner',
    valueShort: 'oepsuanlxwD',
    valueLong: ['--output', '--library'],
    writes: ['-o', '--output'],
  },
  flock: {
    kind: 'runner',
    valueShort: 'wEc',
    valueLong: ['--timeout', '--conflict-exit-code', '--command'],
    operands: 1,
    script: ['-c', '--command'],
  },
  unshare: { kind: 'runner', valueShort: 'SGR', valueLong: ['--setuid', '--setgid', '--root'] },
  setpriv: { kind: 'runner' },
  // Multi-call binaries run the applet named next: `busybox rm` is `rm`.
  busybox: { kind: 'runner' },
  toybox: { kind: 'runner' },
  npx: {
    kind: 'runner',
    valueShort: 'pc',
    valueLong: ['--package', '--call'],
    script: ['-c', '--call'],
  },
  bunx: { kind: 'runner' },
  xargs: {
    kind: 'runner',
    valueShort: 'InPLsdEa',
    valueLong: [
      ...['--max-args', '--max-procs', '--replace', '--delimiter', '--arg-file', '--max-lines'],
      ...['--max-chars', '--eof'],
    ],
    stdinArgs: true,
  },
  parallel: {
    kind: 'runner',
    valueShort: 'jIS',
    valueLong: ['--jobs', '--sshlogin'],
    stdinArgs: true,
  },
};

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isAssignment(item: WordItem | undefined): string | undefined {
  const first = item?.word.parts[0];
  if (first?.kind !== 'literal') return undefined;
  return /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(first.text)?.[1];
}

/** An option word that remembers the shell word it was read from. */
interface ItemWord extends OptionWord {
  item: WordItem;
}

function toItemWord(item: WordItem): ItemWord {
  const literal = literalText(item.word);
  return { text: literal ?? renderWord(item.word), dynamic: literal === undefined, item };
}

/** An option value as a word: the whole next word, or the text attached to the option. */
function valueWord(value: ItemWord): ShellWord {
  return value.text === renderWord(value.item.word) ? value.item.word : literalWord(value.text);
}

/**
 * How a shell was invoked: with a script as an argument (`-c`), and what is
 * left after its options. The script is the first word that is not an option
 * (`bash -c -- 'x'`, `sh -c -e 'x'`), wherever `-c` sat among them.
 */
export function shellInvocation(args: readonly ShellWord[]): {
  dashC: boolean;
  script: ShellWord | undefined;
  operands: ShellWord[];
} {
  let dashC = false;
  let index = 0;
  while (index < args.length) {
    const word = args[index];
    const text = word === undefined ? undefined : literalText(word);
    if (text === undefined || text === '-' || !/^[-+]/.test(text)) break;
    index++;
    if (text === '--') break;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(text)) dashC = true;
    if (/^[-+][A-Za-z]*[oO]$/.test(text) || text === '--rcfile' || text === '--init-file') index++;
  }
  const operands = args.slice(index);
  return { dashC, script: dashC ? operands[0] : undefined, operands };
}

// ---------------------------------------------------------------------------
// Assembly: words → commands
// ---------------------------------------------------------------------------

/** The rest of these lines is a loop variable list or a pattern, not a command. */
const BLOCK_HEADERS: ReadonlySet<string> = new Set(['for', 'case', 'select']);

type CommandFields = Omit<
  ShellCommand,
  'pipeline' | 'pipelinePath' | 'scope' | 'parent' | 'via' | 'stdin'
>;

interface Normalised {
  command: CommandFields;
  /** Shell text this command runs: a `-c` string, an `eval` argument, an alias value. */
  scripts: string[];
  /** Commands this one runs given as words: what follows `find -exec`. */
  wordCommands: WordItem[][];
}

function normalise(words: WordItem[], redirections: ShellRedirection[]): Normalised | undefined {
  const first = words[0];
  const keyword = first?.bare ? literalText(first.word) : undefined;
  if (keyword !== undefined && BLOCK_HEADERS.has(keyword)) return undefined;

  const opaque = new Set<OpaqueKind>();
  const scripts: string[] = [];
  const assignments: string[] = [];
  const wrappers: string[] = [];
  const wrapperWords: ShellWord[] = [];
  const wrapperTargets: ShellWord[] = [];
  let chdir: ShellWord | undefined;

  let rest = [...words];
  const skipAssignments = (): void => {
    for (;;) {
      const name = isAssignment(rest[0]);
      if (name === undefined) break;
      assignments.push(name);
      rest.shift();
    }
  };
  skipAssignments();

  // No cap on depth: every pass removes at least the wrapper's own word, so this
  // ends, and a cap would be a place to hide a command behind.
  for (;;) {
    const name = rest[0] === undefined ? undefined : literalText(rest[0].word);
    const wrapper = name === undefined ? undefined : baseName(name);
    const spec = wrapper === undefined ? undefined : WRAPPERS[wrapper];
    if (wrapper === undefined || spec === undefined) break;
    const following = rest.slice(1).map(toItemWord);
    if (spec.lookup?.includes(following[0]?.text ?? '')) break;

    const options = leadingOptions(following, spec);
    const consumed = options.count + (spec.operands ?? 0);
    const scriptValues = (spec.script ?? []).flatMap(flag => options.values.get(flag) ?? []);
    for (const value of scriptValues) {
      // `env -S 'cmd args'` runs a string: the command is not what the other words say.
      opaque.add('wrapper_option');
      scripts.push(value.text);
    }
    const after = rest.slice(1 + consumed);
    // `env` or `sudo -s` with nothing to run is the command itself.
    if (after.length === 0 && scriptValues.length === 0) break;

    for (const flag of spec.chdir ?? [])
      chdir = options.values.get(flag)?.map(valueWord).at(-1) ?? chdir;
    for (const flag of spec.writes ?? []) {
      wrapperTargets.push(...(options.values.get(flag) ?? []).map(valueWord));
    }
    wrapperWords.push(...rest.slice(1, 1 + consumed).map(item => item.word));
    wrappers.push(wrapper);
    if (spec.stdinArgs) opaque.add('xargs');
    rest = after;
    if (spec.assignments) skipAssignments();
  }

  if (words.length === 0 && redirections.length === 0) return undefined;

  const headWord = rest[0];
  let head = '';
  if (headWord !== undefined) {
    const resolved = resolveWord(headWord.word, '~');
    if (!resolved.dynamic && !resolved.glob) {
      head = baseName(resolved.text);
    } else {
      opaque.add('variable_head');
      if (SHELL_VARIABLES.has(resolved.text)) head = 'sh';
    }
  }
  const argItems = rest.slice(1);
  const args = argItems.map(item => item.word);
  const literals = args.map(literalText);
  const wordCommands: WordItem[][] = [];

  for (const word of [...words.map(item => item.word), ...redirections.map(r => r.target)]) {
    for (const nested of word.nested) {
      opaque.add(nested.via === 'command_substitution' ? nested.via : 'process_substitution');
    }
  }

  if (head === 'eval' && args.length > 0) {
    opaque.add('eval');
    scripts.push(args.map(renderWord).join(' '));
  }
  if (head === 'trap' && args[0] !== undefined) {
    opaque.add('eval');
    scripts.push(renderWord(args[0]));
  }
  if (head === 'alias') {
    // The value runs whenever the name is used, which this reader cannot track.
    opaque.add('alias_or_function');
    for (const arg of args) {
      const written = renderWord(arg);
      const equals = written.indexOf('=');
      if (equals !== -1) scripts.push(written.slice(equals + 1));
    }
  }

  if (SHELL_INTERPRETERS.has(head)) {
    const { dashC, script } = shellInvocation(args);
    if (dashC) {
      opaque.add('shell_dash_c');
      if (script !== undefined) scripts.push(renderWord(script));
    }
  }

  if (head === 'find') {
    let start = -1;
    literals.forEach((text, index) => {
      if (text !== undefined && FIND_EXEC_FLAGS.has(text)) {
        opaque.add('find_exec');
        start = index + 1;
      } else if (start !== -1 && (text === ';' || text === '+')) {
        wordCommands.push(argItems.slice(start, index));
        start = -1;
      }
    });
    if (start !== -1) wordCommands.push(argItems.slice(start));
  }

  for (const redirection of redirections) {
    if (redirection.operator !== '<<' && redirection.operator !== '<<<') continue;
    if (!HEREDOC_DATA_SINKS.has(head)) opaque.add('heredoc');
  }

  return {
    command: {
      head,
      args,
      assignments,
      wrappers,
      wrapperWords,
      wrapperTargets,
      ...(chdir !== undefined && { chdir }),
      redirections,
      opaque: [...opaque],
    },
    scripts,
    wordCommands,
  };
}

function redirectionWrites(operator: RedirectOperator, target: ShellWord): boolean {
  switch (operator) {
    case '>':
    case '>>':
    case '&>':
    case '&>>':
    case '>|':
    case '<>':
      return true;
    case '>&': {
      // `>&2` and `>&-` duplicate or close an fd; `>& file` writes both streams to it.
      const text = literalText(target);
      return text === undefined || !/^(\d+|-)$/.test(text);
    }
    case '<':
    case '<&':
    case '<<':
    case '<<<':
      return false;
  }
}

interface ParseState {
  commands: ShellCommand[];
  opaque: Set<OpaqueKind>;
  nextPipeline: number;
  scopeParents: (number | undefined)[];
}

function openScope(state: ParseState, enclosing: number | undefined): number {
  state.scopeParents.push(enclosing);
  return state.scopeParents.length - 1;
}

/** Where a command sits when it is added. */
interface Placement {
  nesting: number;
  scope: number;
  pipelinePath: PipelineStage[];
  owner: number | undefined;
  via: NestedVia | undefined;
}

function nestedVia(via: NestedScript['via']): NestedVia {
  return via === 'output_substitution' ? 'sink' : 'substitution';
}

function addCommand(
  state: ParseState,
  commandWords: WordItem[],
  redirections: ShellRedirection[],
  stdin: string[],
  place: Placement
): void {
  const follow = (script: string, owner: number | undefined, via: NestedVia): void => {
    if (place.nesting >= MAX_NESTING) {
      state.opaque.add('nesting_limit');
      return;
    }
    parseInto(script, state, place.nesting + 1, place.scope, owner, via);
  };

  let headWords = commandWords;
  const first = commandWords[0];
  if (first?.bare && literalText(first.word) === 'function') {
    // `function name { ... }`: skip the keyword and the name, keep reading the body.
    state.opaque.add('alias_or_function');
    headWords = commandWords.slice(2);
    const brace = headWords[0];
    if (brace?.bare && literalText(brace.word) === '{') headWords = headWords.slice(1);
  }
  const normalised = normalise(headWords, redirections);
  let index = place.owner;
  if (normalised !== undefined) {
    index = state.commands.length;
    state.commands.push({
      ...normalised.command,
      stdin,
      pipeline: place.pipelinePath.at(-1)?.id ?? 0,
      pipelinePath: place.pipelinePath,
      scope: place.scope,
      parent: place.owner,
      via: place.via,
    });
  }
  const allWords = [
    ...commandWords.map(item => item.word),
    ...redirections.map(redirection => redirection.target),
  ];
  for (const word of allWords) {
    for (const nested of word.nested) follow(nested.text, index, nestedVia(nested.via));
  }
  if (normalised === undefined) return;
  for (const script of normalised.scripts) follow(script, index, 'script');
  if (SHELL_INTERPRETERS.has(normalised.command.head)) {
    for (const body of stdin) follow(body, index, 'script');
  }
  for (const nestedWords of normalised.wordCommands) {
    addCommand(state, nestedWords, [], [], { ...place, owner: index, via: 'exec' });
  }
}

type GroupKind = '(' | '{' | 'if' | 'loop' | 'case';

const GROUP_OPENERS: Readonly<Record<string, GroupKind>> = {
  '{': '{',
  if: 'if',
  while: 'loop',
  until: 'loop',
  for: 'loop',
  select: 'loop',
  case: 'case',
};
const GROUP_CLOSERS: Readonly<Record<string, GroupKind>> = {
  '}': '{',
  fi: 'if',
  done: 'loop',
  esac: 'case',
};
/** Words that only join the parts of a compound command, or modify the next one. */
const CONNECTIVES: ReadonlySet<string> = new Set(['then', 'elif', 'else', 'do', '!', 'coproc']);

function parseInto(
  text: string,
  state: ParseState,
  nesting: number,
  enclosingScope: number | undefined,
  parent: number | undefined,
  parentVia: NestedVia | undefined
): void {
  const { items, unterminated } = scan(text);
  if (unterminated) state.opaque.add('unterminated_quote');

  let words: WordItem[] = [];
  let redirections: ShellRedirection[] = [];
  let stdin: string[] = [];
  /** A closing keyword was read: the group ends once this command is finished. */
  let closing: GroupKind | undefined;
  const scopes = [openScope(state, enclosingScope)];
  const groups: GroupKind[] = [];
  // One entry per open group plus the current level. A group is one stage of the
  // pipeline it stands in, so its commands keep that pipeline in their path.
  const levels: PipelineStage[] = [{ id: state.nextPipeline++, stage: 0 }];

  const startPipeline = (): void => {
    levels[levels.length - 1] = { id: state.nextPipeline++, stage: 0 };
  };
  const openGroup = (kind: GroupKind): void => {
    groups.push(kind);
    levels.push({ id: state.nextPipeline++, stage: 0 });
    if (kind === '(') scopes.push(openScope(state, scopes.at(-1)));
  };
  const closeGroup = (kind: GroupKind): void => {
    // An unmatched closer (a `case` pattern's `)`) closes nothing.
    if (groups.at(-1) !== kind) return;
    groups.pop();
    levels.pop();
    if (kind === '(') scopes.pop();
  };

  const finish = (): void => {
    if (words.length > 0 || redirections.length > 0) {
      addCommand(state, words, redirections, stdin, {
        nesting,
        scope: scopes.at(-1) ?? 0,
        pipelinePath: levels.map(level => ({ ...level })),
        owner: parent,
        via: parentVia,
      });
    }
    words = [];
    redirections = [];
    stdin = [];
    if (closing !== undefined) closeGroup(closing);
    closing = undefined;
  };

  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    if (item === undefined) continue;
    if (item.type === 'word') {
      const keyword = item.bare && words.length === 0 ? literalText(item.word) : undefined;
      if (keyword !== undefined && closing === undefined) {
        if (CONNECTIVES.has(keyword)) continue;
        const closer = GROUP_CLOSERS[keyword];
        if (closer !== undefined) {
          closing = closer;
          continue;
        }
        const opener = GROUP_OPENERS[keyword];
        if (opener !== undefined) {
          openGroup(opener);
          // `for` and `case` head a line of names or patterns; `normalise` drops it.
          if (!BLOCK_HEADERS.has(keyword)) continue;
        }
      }
      words.push(item);
      continue;
    }
    if (item.type === 'redirect') {
      const following = items[k + 1];
      let target: ShellWord = { parts: [], nested: [] };
      if (following?.type === 'word') {
        target = following.word;
        k++;
      }
      if (item.operator === '<<' && item.expands && item.body !== undefined) {
        // An unquoted heredoc body is expanded like a double-quoted string.
        target = {
          parts: target.parts,
          nested: [...target.nested, ...embeddedSubstitutions(item.body)],
        };
      }
      redirections.push({
        operator: item.operator,
        target,
        write: redirectionWrites(item.operator, target),
      });
      if (item.operator === '<<' && item.body !== undefined) stdin.push(item.body);
      if (item.operator === '<<<') stdin.push(renderWord(target));
      continue;
    }
    if (item.operator === '|') {
      finish();
      const level = levels.at(-1);
      if (level !== undefined) levels[levels.length - 1] = { id: level.id, stage: level.stage + 1 };
      continue;
    }
    if (item.operator === '(') {
      const following = items[k + 1];
      if (words.length > 0 && following?.type === 'operator' && following.operator === ')') {
        // `name() { ... }` defines a function: its body runs whenever the name is used.
        state.opaque.add('alias_or_function');
        words = [];
        k++;
        continue;
      }
      finish();
      openGroup('(');
      continue;
    }
    if (item.operator === ')') {
      if (groups.at(-1) === 'case') {
        // `pattern)` inside `case`: the words before it are the pattern. On one
        // line they follow the `case ... in` header, which is finished as usual.
        const header = words[0];
        if (header?.bare && literalText(header.word) === 'case') finish();
        words = [];
        continue;
      }
      finish();
      closeGroup('(');
      continue;
    }
    finish();
    startPipeline();
  }
  finish();
}

function newState(): ParseState {
  return { commands: [], opaque: new Set(), nextPipeline: 0, scopeParents: [] };
}

function result(state: ParseState): ParsedShell {
  return {
    commands: state.commands,
    opaque: [...state.opaque],
    scopeParents: state.scopeParents,
  };
}

export function parseShell(text: string): ParsedShell {
  const state = newState();
  parseInto(text, state, 0, undefined, undefined, undefined);
  return result(state);
}

/**
 * Reads words that are already split as one command line, the way a wrapper
 * hands its remaining arguments to the command it runs. Wrappers, `-c` scripts
 * and substitutions inside the words are followed as usual.
 */
export function parseArgv(words: readonly ShellWord[]): ParsedShell {
  const state = newState();
  addCommand(
    state,
    words.map(word => ({ type: 'word', word, bare: false })),
    [],
    [],
    {
      nesting: 0,
      scope: openScope(state, undefined),
      pipelinePath: [{ id: state.nextPipeline++, stage: 0 }],
      owner: undefined,
      via: undefined,
    }
  );
  return result(state);
}
