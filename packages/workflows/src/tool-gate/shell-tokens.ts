/**
 * Reads shell text into commands without evaluating any of it.
 *
 * The reader is quote-aware: a word is a list of parts, so `"git"`, `g''it`,
 * `\git` and `/usr/bin/git` all end up with the head `git`. It splits on `;`,
 * `&&`, `||`, `|`, `&`, newlines and parentheses, strips leading env
 * assignments, control keywords and wrappers (`sudo`, `env`, `timeout`, `nice`,
 * `xargs` and a few more), and records redirections. The only expansions it
 * resolves are a leading `~`, `$HOME`, a leading `$PWD` and plain `$'...'`
 * escapes; every other expansion makes a word dynamic.
 *
 * What it cannot read it marks opaque, so the rules never allow it outright:
 * command and process substitution, `eval`, `sh -c` strings, heredocs fed to an
 * interpreter, `find -exec`, aliases and functions, `xargs`-fed arguments, a
 * variable as the command name, an unterminated quote. Where the hidden text is
 * a literal (`bash -c 'literal'`, the body of `$(...)`, a heredoc fed to a
 * shell) it is read as commands too, so a destructive command inside still
 * shows.
 *
 * Limits. This is a reader, not a shell, and these stay invisible to it:
 *  - a script written to disk and then executed (`./run.sh`, `bash run.sh`,
 *    `source x`, `curl -o x.sh ... && sh x.sh`);
 *  - interpreter one-liners and programs (`python -c`, `node -e`, `perl -e`):
 *    the string is never read, so a file write or a spawn inside it is unseen;
 *  - indirection through `make`, package scripts, git hooks, and aliases or
 *    functions defined in the user's shell or git config;
 *  - what a variable, a glob, brace expansion or an `xargs` input becomes at run
 *    time: a destructive flag kept in a variable is at best escalated, never
 *    denied, because its value is not known here;
 *  - a wrapper it does not know: the command it runs is read as an argument;
 *  - shell syntax it does not model (`case` patterns, extended globs, `[[ ]]`
 *    internals) and every non-POSIX shell: PowerShell and cmd text is read as
 *    if it were POSIX and mostly matches nothing;
 *  - anything a tool does that is not shell text at all, such as an MCP tool.
 */

/** One piece of a word. Quotes are already removed; `variable` text is as written. */
export type WordPart =
  | { kind: 'literal'; text: string }
  /** A leading unquoted `~`, `$HOME` or `${HOME}`. */
  | { kind: 'home' }
  /** `$PWD` or `${PWD}`: the working directory, which only the caller can place. */
  | { kind: 'cwd' }
  /** Any other expansion: its value is unknown here. */
  | { kind: 'variable'; text: string }
  /** An unquoted `*`, `?` or `[...]`. */
  | { kind: 'glob'; text: string };

/** Shell text hidden inside a word: the body of `$(...)`, backticks or `<(...)`. */
export interface NestedScript {
  text: string;
  via: 'command_substitution' | 'process_substitution';
}

export interface ShellWord {
  parts: WordPart[];
  nested: NestedScript[];
}

export type NestedVia = 'substitution' | 'script' | 'exec';

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

export interface ShellCommand {
  /** Base name of the command after assignments and wrappers; `''` when unknown or absent. */
  head: string;
  args: ShellWord[];
  /** Names of the env assignments stripped from the front. */
  assignments: string[];
  /** Wrappers stripped from the front, outermost first. */
  wrappers: string[];
  redirections: ShellRedirection[];
  /** Commands joined by `|` share a pipeline number. */
  pipeline: number;
  /**
   * The subshell this command runs in: `( ... )`, a substitution body and a `-c`
   * script each get their own, so a `cd` inside one ends with it. Index into
   * `ParsedShell.scopeParents`.
   */
  scope: number;
  /** Index of the command whose substitution, `-c` string or heredoc held this one. */
  parent?: number;
  /**
   * How `parent` holds this command: inside one of its words (`$(...)`, backticks,
   * `<(...)`), as the script it runs (`-c`, `eval`, a heredoc), or as the command
   * `find -exec` runs.
   */
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

/** Commands that only read a heredoc as data. Fed to anything else, a heredoc is opaque. */
const HEREDOC_DATA_SINKS: ReadonlySet<string> = new Set(['cat', 'tee', 'wc', 'grep', 'jq']);

/** How deep literal `-c` strings and substitution bodies are followed. */
const MAX_NESTING = 5;
const MAX_WRAPPERS = 8;

const LEADING_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'elif',
  'else',
  'do',
  'while',
  'until',
  '!',
  '{',
  'coproc',
]);
const CLOSING_KEYWORDS: ReadonlySet<string> = new Set(['fi', 'done', 'esac', '}']);
/** The rest of these lines is a loop variable list or a pattern, not a command. */
const BLOCK_HEADERS: ReadonlySet<string> = new Set(['for', 'case', 'select']);

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
  let awaitingDelimiter: { item: RedirectItem; stripTabs: boolean } | undefined;
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
    const finished: ShellWord = { parts: word.parts, nested: word.nested };
    items.push({ type: 'word', word: finished, bare: !word.quoted });
    if (awaitingDelimiter !== undefined) {
      awaitingDelimiter.item.expands = !word.quoted;
      pendingHeredocs.push({
        ...awaitingDelimiter,
        delimiter: resolveWord(finished, '~').text,
      });
      awaitingDelimiter = undefined;
    }
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

  /** Reads the expansion starting at the `$` at `start`; returns the index after it. */
  const scanDollar = (start: number, inDoubleQuotes: boolean): number => {
    const next = text[start + 1];
    if (next === '(') {
      if (text[start + 2] === '(') {
        const close = text.indexOf('))', start + 3);
        const end = close === -1 ? length : close + 2;
        if (close === -1) unterminated = true;
        addVariable(text.slice(start, end));
        // Arithmetic can hold a substitution: `$(( $(cmd) + 1 ))` runs cmd.
        const body = text.slice(start + 3, close === -1 ? length : close);
        current().nested.push(...embeddedSubstitutions(body));
        return end;
      }
      return scanSubstitution(start, start + 1, 'command_substitution');
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

  const scanRedirect = (start: number): number => {
    const ch = text[start];
    const next = text[start + 1];
    if (next === '(') return scanSubstitution(start, start + 1, 'process_substitution');

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
        awaitingDelimiter = { item: pushRedirect('<<'), stripTabs };
        return start + (stripTabs ? 3 : 2);
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
      while (position < length) {
        const lineEnd = text.indexOf('\n', position);
        const line = text.slice(position, lineEnd === -1 ? length : lineEnd);
        position = lineEnd === -1 ? length : lineEnd + 1;
        if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
        lines.push(line);
      }
      heredoc.item.body = lines.join('\n');
    }
    pendingHeredocs = [];
    return position;
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
    } else if (ch === '~' && word === undefined) {
      if (next === '/' || isWordBreak(next)) {
        current().parts.push({ kind: 'home' });
        i++;
      } else {
        // ~user, ~+ and ~- name a directory this reader cannot know.
        let j = i + 1;
        while (!isWordBreak(text[j]) && text[j] !== '/') j++;
        addVariable(text.slice(i, j));
        i = j;
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
  return { items, unterminated };
}

// ---------------------------------------------------------------------------
// Assembly: words → commands
// ---------------------------------------------------------------------------

type OptionSkipper = (words: WordItem[]) => WordItem[] | undefined;

/** Drops leading options, and the value after each option named in `valueFlags`. */
function skipOptions(words: WordItem[], valueFlags: ReadonlySet<string>): WordItem[] {
  let index = 0;
  while (index < words.length) {
    const item = words[index];
    const text = item === undefined ? undefined : literalText(item.word);
    if (!text?.startsWith('-')) break;
    index++;
    if (text === '--') break;
    if (valueFlags.has(text)) index++;
  }
  return words.slice(index);
}

function isAssignment(item: WordItem | undefined): string | undefined {
  const first = item?.word.parts[0];
  if (first?.kind !== 'literal') return undefined;
  return /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(first.text)?.[1];
}

function skipAssignments(words: WordItem[], names: string[]): WordItem[] {
  let index = 0;
  for (;;) {
    const name = isAssignment(words[index]);
    if (name === undefined) break;
    names.push(name);
    index++;
  }
  return words.slice(index);
}

function withValueFlags(...flags: string[]): OptionSkipper {
  const valueFlags = new Set(flags);
  return words => skipOptions(words, valueFlags);
}

/**
 * How to get from a wrapper to the command it runs. A skipper returns
 * `undefined` when the word is not acting as a wrapper (`command -v git`).
 */
const WRAPPERS: Readonly<Record<string, OptionSkipper>> = {
  sudo: withValueFlags(
    ...['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'],
    ...['--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user'],
    '--close-from'
  ),
  doas: withValueFlags('-u', '-C'),
  env: withValueFlags('-u', '--unset', '-C', '--chdir', '-S', '--split-string'),
  timeout: words => skipOptions(words, new Set(['-s', '--signal', '-k', '--kill-after'])).slice(1),
  nice: withValueFlags('-n', '--adjustment'),
  nohup: withValueFlags(),
  setsid: withValueFlags(),
  ionice: withValueFlags('-c', '--class', '-n', '--classdata', '-p', '--pid'),
  unbuffer: withValueFlags(),
  caffeinate: withValueFlags('-t', '-w'),
  // Multi-call binaries run the applet named next: `busybox rm` is `rm`.
  busybox: withValueFlags(),
  toybox: withValueFlags(),
  time: withValueFlags('-o', '--output', '-f', '--format'),
  stdbuf: withValueFlags('-i', '-o', '-e'),
  exec: withValueFlags('-a'),
  builtin: withValueFlags(),
  command: words => {
    const first = words[0] === undefined ? undefined : literalText(words[0].word);
    if (first === '-v' || first === '-V') return undefined;
    return skipOptions(words, new Set());
  },
  xargs: withValueFlags(
    ...['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'],
    ...['--max-args', '--max-procs', '--replace', '--delimiter', '--arg-file', '--max-lines'],
    ...['--max-chars', '--eof']
  ),
};

/** Wrappers that take `NAME=value` words before the command. */
const WRAPPERS_WITH_ASSIGNMENTS: ReadonlySet<string> = new Set(['sudo', 'doas', 'env']);

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

interface Normalised {
  command: Omit<ShellCommand, 'pipeline' | 'scope' | 'parent' | 'via'>;
  /** Literal shell text this command runs: a `-c` string, an `eval` argument, a heredoc body. */
  scripts: string[];
  /** Commands this one runs given as words: what follows `find -exec`. */
  wordCommands: WordItem[][];
}

function normalise(words: WordItem[], redirections: ShellRedirection[]): Normalised | undefined {
  let rest = [...words];
  for (;;) {
    const first = rest[0];
    const keyword = first?.bare ? literalText(first.word) : undefined;
    if (keyword === undefined) break;
    if (BLOCK_HEADERS.has(keyword)) return undefined;
    if (!LEADING_KEYWORDS.has(keyword) && !CLOSING_KEYWORDS.has(keyword)) break;
    rest.shift();
  }

  const assignments: string[] = [];
  const hadWords = rest.length > 0;
  rest = skipAssignments(rest, assignments);

  const opaque = new Set<OpaqueKind>();
  const scripts: string[] = [];
  const wrappers: string[] = [];
  while (wrappers.length < MAX_WRAPPERS) {
    const first = rest[0];
    const name = first === undefined ? undefined : literalText(first.word);
    const skip = name === undefined ? undefined : WRAPPERS[baseName(name)];
    if (name === undefined || skip === undefined) break;
    const wrapper = baseName(name);
    const options = rest.slice(1);
    let after = skip(options);
    if (after === undefined) break;
    if (WRAPPERS_WITH_ASSIGNMENTS.has(wrapper)) after = skipAssignments(after, assignments);
    if (wrapper === 'env') {
      // `env -S 'cmd args'` runs a string and `env -C dir` runs somewhere else:
      // either way the command is not what the remaining words say.
      const skipped = options.slice(0, options.length - after.length).map(literalOrEmpty);
      skipped.forEach((option, index) => {
        if (!/^(-S|--split-string|-C|--chdir)/.test(option)) return;
        opaque.add('wrapper_option');
        const value = option.includes('=')
          ? option.slice(option.indexOf('=') + 1)
          : skipped[index + 1];
        if (option.startsWith('-S') || option.startsWith('--split')) scripts.push(value ?? '');
      });
    }
    // `env` or `sudo -s` with nothing to run is the command itself.
    if (after.length === 0) break;
    wrappers.push(wrapper);
    if (wrapper === 'xargs') opaque.add('xargs');
    rest = after;
  }

  if (!hadWords && redirections.length === 0) return undefined;

  const headWord = rest[0];
  let head = '';
  if (headWord !== undefined) {
    const resolved = resolveWord(headWord.word, '~');
    if (resolved.dynamic || resolved.glob) opaque.add('variable_head');
    else head = baseName(resolved.text);
  }
  const argItems = rest.slice(1);
  const args = argItems.map(item => item.word);
  const literals = args.map(literalText);

  const wordCommands: WordItem[][] = [];

  for (const word of [...words.map(item => item.word), ...redirections.map(r => r.target)]) {
    for (const nested of word.nested) opaque.add(nested.via);
  }

  if (head === 'eval' || head === 'trap') {
    opaque.add('eval');
    const evaluated = head === 'trap' ? literals.slice(0, 1) : literals;
    if (evaluated.length > 0 && evaluated.every(text => text !== undefined)) {
      scripts.push(evaluated.join(' '));
    }
  }
  if (head === 'alias') opaque.add('alias_or_function');

  if (SHELL_INTERPRETERS.has(head)) {
    const flag = literals.findIndex(
      text => text !== undefined && /^-[A-Za-z]*c[A-Za-z]*$/.test(text)
    );
    if (flag !== -1) {
      opaque.add('shell_dash_c');
      const script = literals[flag + 1];
      if (script !== undefined) scripts.push(script);
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
    command: { head, args, assignments, wrappers, redirections, opaque: [...opaque] },
    scripts,
    wordCommands,
  };
}

function literalOrEmpty(item: WordItem): string {
  return literalText(item.word) ?? '';
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
  let heredocBodies: string[] = [];
  const scopes = [openScope(state, enclosingScope)];
  const scope = (): number => scopes.at(-1) ?? 0;
  let pipeline = state.nextPipeline++;

  const follow = (script: string, owner: number | undefined, via: NestedVia): void => {
    if (nesting >= MAX_NESTING) {
      state.opaque.add('nesting_limit');
      return;
    }
    parseInto(script, state, nesting + 1, scope(), owner, via);
  };

  const addCommand = (
    commandWords: WordItem[],
    commandRedirections: ShellRedirection[],
    bodies: string[],
    owner: number | undefined,
    via: NestedVia | undefined
  ): void => {
    let headWords = commandWords;
    const first = commandWords[0];
    if (first?.bare && literalText(first.word) === 'function') {
      // `function name { ... }`: skip the keyword and the name, keep reading the body.
      state.opaque.add('alias_or_function');
      headWords = commandWords.slice(2);
    }
    const normalised = normalise(headWords, commandRedirections);
    let index = owner;
    if (normalised !== undefined) {
      index = state.commands.length;
      state.commands.push({
        ...normalised.command,
        pipeline,
        scope: scope(),
        parent: owner,
        via,
      });
    }
    const allWords = [
      ...commandWords.map(item => item.word),
      ...commandRedirections.map(redirection => redirection.target),
    ];
    for (const word of allWords) {
      for (const nested of word.nested) follow(nested.text, index, 'substitution');
    }
    if (normalised === undefined) return;
    for (const script of normalised.scripts) follow(script, index, 'script');
    if (SHELL_INTERPRETERS.has(normalised.command.head)) {
      for (const body of bodies) follow(body, index, 'script');
    }
    for (const nestedWords of normalised.wordCommands) {
      addCommand(nestedWords, [], [], index, 'exec');
    }
  };

  const finish = (): void => {
    if (words.length > 0 || redirections.length > 0) {
      addCommand(words, redirections, heredocBodies, parent, parentVia);
    }
    words = [];
    redirections = [];
    heredocBodies = [];
  };

  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    if (item === undefined) continue;
    if (item.type === 'word') {
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
      if (item.operator === '<<' && item.body !== undefined) heredocBodies.push(item.body);
      if (item.operator === '<<<') {
        const text = literalText(target);
        if (text !== undefined) heredocBodies.push(text);
      }
      continue;
    }
    if (item.operator === '|') {
      finish();
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
      scopes.push(openScope(state, scope()));
    } else if (item.operator === ')') {
      finish();
      // An unmatched `)` (a `case` pattern) closes nothing.
      if (scopes.length > 1) scopes.pop();
    } else {
      finish();
    }
    pipeline = state.nextPipeline++;
  }
  finish();
}

export function parseShell(text: string): ParsedShell {
  const state: ParseState = {
    commands: [],
    opaque: new Set(),
    nextPipeline: 0,
    scopeParents: [],
  };
  parseInto(text, state, 0, undefined, undefined, undefined);
  return {
    commands: state.commands,
    opaque: [...state.opaque],
    scopeParents: state.scopeParents,
  };
}
