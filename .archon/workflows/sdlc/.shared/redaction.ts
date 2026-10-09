/**
 * Removes recognisable secrets from text before it leaves the machine.
 *
 * Two kinds of match. Exact: the value of every secret-named variable in the caller's
 * environment, wherever a command echoed it. By shape: private keys, values assigned to
 * secret-named keys or passed after secret-named flags, credentials in URLs and headers,
 * and well-known token formats.
 *
 * This is a filter, not a guarantee. A credential in a shape nothing here describes is
 * left as it is, and a caller that sends the result anywhere must say so to its operator.
 *
 * It leans toward removing too much: a value is taken to the end of its line unless its
 * end is certain, because a cut-short secret is worse than a lost word. It also has to stay
 * useful, since what it filters is evidence someone will read, so names stay, ordinary
 * failure lines pass through untouched, and a line that only mentions a key header does
 * not cost the lines after it.
 *
 * Every pattern bounds how far it may run. The input is whatever a failing command
 * printed, and no shape of it may cost time quadratic in its length.
 */

export const REDACTED = '[REDACTED]';
export const REDACTED_KEY = '[REDACTED PRIVATE KEY]';

/**
 * Name parts that mark a secret wherever they stand in a name (`SECRET_KEY_BASE`), and as
 * the end of a run-together part (`dbpassword`, `authToken`).
 */
const SECRET_WORDS = [
  'PASSWORD',
  'PASSWD',
  'SECRET',
  'SECRETS',
  'TOKEN',
  'APIKEY',
  'CREDENTIAL',
  'CREDENTIALS',
  'COOKIE',
];
/**
 * Parts that mark a secret when they end the name, alone or after others (`auth`,
 * `X-Amz-Signature`). Earlier in a name they describe something else (`auth_mode`,
 * `SSH_AUTH_SOCK`).
 */
const SECRET_ENDINGS = new Set(['AUTH', 'SIG', 'SIGNATURE', 'DSN']);
/**
 * Parts that mark a secret only as the end of a longer name (`DB_PASS`, `ENCRYPTION_KEY`,
 * `DB_PWD`). Alone they are ordinary words: `pass: 12` is a test count, `key:` is any map
 * key, and `PWD` is the working directory.
 */
const SECRET_COMPOUND_ENDINGS = new Set(['KEY', 'PASS', 'PWD']);
/**
 * What ends the name of an error's class. `TokenExpiredError: jwt expired` and
 * `KeyError: 'access_token'` read like assignments and are the failure itself.
 */
const ERROR_NAME_ENDINGS = new Set(['ERROR', 'EXCEPTION', 'WARNING', 'FAILURE', 'FAULT']);

type Strength = 'strong' | 'weak';

/**
 * Whether a name holds a secret, and how sure the name alone makes it. A weak name's
 * value is left alone when it is plainly a number, which a flag or a count is and a
 * credential is not.
 */
function secretName(name: string): Strength | null {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const last = parts.at(-1);
  if (last === undefined || ERROR_NAME_ENDINGS.has(last)) return null;
  if (parts.some(part => SECRET_WORDS.some(word => part.endsWith(word)))) return 'strong';
  if (SECRET_ENDINGS.has(last)) return 'weak';
  if (parts.length > 1 && SECRET_COMPOUND_ENDINGS.has(last)) return 'weak';
  return null;
}

/** Words printed where a value would be, which say that there is none. */
const NO_VALUE = /^(?:null|nil|none|undefined|true|false|yes|no|empty|unset|<[^<>]{0,40}>)$/i;

/** Whether what follows a secret name is plainly not a credential. */
function plainlyNotSecret(value: string, strength: Strength): boolean {
  const bare = value.trim().replace(/[,;.]+$/, '');
  if (!/[A-Za-z0-9]/.test(bare)) return true;
  if (NO_VALUE.test(bare)) return true;
  return strength === 'weak' && /^\d{1,6}$/.test(bare);
}

/**
 * The shortest value removed by exact match. Below this a value is as likely to be a flag
 * as a credential, and removing every `1` or `true` from a log would leave nothing to read.
 */
const MIN_SECRET_VALUE_CHARS = 8;

/** The values of the environment's secret-named variables, longest first. */
function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    const secret = value?.trim() ?? '';
    if (secret.length >= MIN_SECRET_VALUE_CHARS && secretName(name) !== null) values.add(secret);
  }
  return [...values].sort((left, right) => right.length - left.length);
}

const ARMOR = String.raw`[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----`;
/** A whole key between its armor lines, also when printed on one line with `\n` escapes. */
const KEY_INLINE = new RegExp(
  String.raw`-----BEGIN ${ARMOR}(?:\\[nr]|[A-Za-z0-9+/=\s]){0,65536}?-----END ${ARMOR}`,
  'g'
);
/** Armor lines on their own. A sentence that mentions one is not a key. */
const KEY_BEGIN_LINE = new RegExp(`^-----BEGIN ${ARMOR}$`);
const KEY_END_LINE = new RegExp(`^-----END ${ARMOR}$`);
/** `Proc-Type: 4,ENCRYPTED`, `Version: ...`: what may stand between the armor and the body. */
const ARMOR_HEADER = /^[A-Za-z][A-Za-z0-9-]{0,40}: /;
const KEY_BODY = /^[A-Za-z0-9+/=]+$/;
/** Far enough above an end line, only a full-width line still reads as key material. */
const KEY_BODY_FULL = /^[A-Za-z0-9+/=]{16,}$/;

/**
 * `name = value` and `name: value`, with the name optionally quoted. One `=` or `:` only,
 * so a comparison (`token == x`), an arrow and a path (`auth::token::verify`) are not
 * assignments. Whether the name is secret, and where the value ends, is decided in code.
 */
const ASSIGNMENT =
  /(["']?)([A-Za-z_][A-Za-z0-9_-]{0,63})\1[ \t]{0,4}(?:=(?![=>~])|:(?![:=]))[ \t]{0,4}/g;
/** A key with nothing after it: its value is on the lines below, indented under it. */
const BLOCK_KEY =
  /^([ \t]*)(?:-[ \t]+)?(["']?)([A-Za-z_][A-Za-z0-9_-]{0,63})\2[ \t]*:[ \t]*(?:[|>][+-]?[0-9]?[+-]?)?[ \t]*$/;
/** Most lines one such value may span. */
const MAX_BLOCK_LINES = 200;

/** `--token value`: a long flag, then its value as the next word. */
const FLAG = /(^|[\s"'`(=])(--[A-Za-z][A-Za-z0-9-]{0,63})([ \t]{1,4})(?=[^\s-])/g;
/** MySQL clients take the password glued to `-p`. */
const MYSQL_PASSWORD =
  /(\bmysql(?:dump|admin|import|show)?\b[^\n|;&]{0,200}?[ \t]-p)([^\s]{1,256})/g;

/**
 * An `Authorization` header's value: a scheme and its credential, or one long token. A
 * word after the colon (`Authorization: denied`) is prose and stays.
 */
const AUTHORIZATION =
  /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)(?:(?:bearer|basic|token|digest|negotiate)[ \t]+[^\s"',;]+|[A-Za-z0-9._~+/=-]{16,})/gi;
const BEARER = /\b(bearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * `scheme://user:password@host`. The password may itself hold `/` and `@`, so it runs to
 * the last `@` of the word. A port (`host:8080/…@…`) is not a password.
 */
const URL_PASSWORD =
  /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]{0,256}:)(?!\d{1,5}(?:[/?#\s]|$))[^\s]{1,512}@/gi;
/** `scheme://token@host`: a credential with no user in front of it. */
const URL_TOKEN = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,512}@/gi;

/** Credentials recognisable by their own shape, wherever they appear. */
const TOKEN_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]{8,}/g, `$1${REDACTED}`],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:AC|SK)[0-9a-fA-F]{32}:[0-9a-fA-F]{32}\b/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
];

/** The index just past a quoted value's closing quote, or -1 when the quote never closes. */
function closingQuote(line: string, open: number): number {
  const quote = line[open];
  for (let index = open + 1; index < line.length; index++) {
    if (line[index] === '\\') index++;
    else if (line[index] === quote) return index;
  }
  return -1;
}

/** What ends an unquoted value inside a query string. */
const QUERY_VALUE_END = /[&\s"'#]/;

/**
 * One line with the value of every secret-named assignment replaced.
 *
 * A quoted value ends at its closing quote and a query parameter at the next `&`. Any
 * other value has no certain end, so it is taken to the end of the line.
 */
function redactAssignments(line: string): string {
  let result = '';
  let copied = 0;
  for (const match of line.matchAll(ASSIGNMENT)) {
    const start = match.index;
    if (start < copied) continue;
    const before = start === 0 ? '' : line[start - 1];
    // Matched from the middle of a longer word: not a name.
    if (/[A-Za-z0-9_]/.test(before)) continue;
    const strength = secretName(match[2]);
    if (strength === null) continue;

    const valueStart = start + match[0].length;
    if (valueStart >= line.length) continue;
    const first = line[valueStart];
    let from = valueStart;
    let to = line.length;
    if (first === '"' || first === "'") {
      const close = closingQuote(line, valueStart);
      if (close !== -1) {
        from = valueStart + 1;
        to = close;
      }
    } else if (before === '?' || before === '&') {
      const end = line.slice(valueStart).search(QUERY_VALUE_END);
      if (end !== -1) to = valueStart + end;
    }
    if (plainlyNotSecret(line.slice(from, to), strength)) continue;
    result += line.slice(copied, from) + REDACTED;
    copied = to;
  }
  return result + line.slice(copied);
}

/** One line with the word after every secret-named long flag replaced. */
function redactFlags(line: string): string {
  let result = '';
  let copied = 0;
  for (const match of line.matchAll(FLAG)) {
    const valueStart = match.index + match[0].length;
    if (valueStart < copied || secretName(match[2]) === null) continue;
    let from = valueStart;
    let to: number;
    const first = line[valueStart];
    const close = first === '"' || first === "'" ? closingQuote(line, valueStart) : -1;
    if (close !== -1) {
      from = valueStart + 1;
      to = close;
    } else {
      const end = line.slice(valueStart).search(/\s/);
      to = end === -1 ? line.length : valueStart + end;
    }
    result += line.slice(copied, from) + REDACTED;
    copied = to;
  }
  return result + line.slice(copied);
}

function redactLine(line: string): string {
  return redactFlags(redactAssignments(line))
    .replace(MYSQL_PASSWORD, `$1${REDACTED}`)
    .replace(AUTHORIZATION, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(URL_PASSWORD, `$1${REDACTED}@`)
    .replace(URL_TOKEN, `$1${REDACTED}@`);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The lines of `text` with keys, block values and per-line secrets replaced.
 *
 * Keys are followed line by line rather than matched as one span, so a header with no end
 * costs only the lines that read as key material, never the rest of the text.
 */
function redactLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (KEY_BEGIN_LINE.test(trimmed)) {
      let next = index + 1;
      while (
        next < lines.length &&
        (lines[next].trim() === '' || ARMOR_HEADER.test(lines[next].trim()))
      ) {
        next++;
      }
      while (
        next < lines.length &&
        (lines[next].trim() === '' || KEY_BODY.test(lines[next].trim()))
      ) {
        next++;
      }
      if (next < lines.length && KEY_END_LINE.test(lines[next].trim())) next++;
      // No end line: the key was cut short. Blank lines after it are not part of it.
      else while (next > index + 1 && lines[next - 1].trim() === '') next--;
      out.push(REDACTED_KEY);
      index = next;
      continue;
    }

    if (KEY_END_LINE.test(trimmed)) {
      // The key began before this text: the lines right above its end are its body.
      let taken = 0;
      while (out.length > 0) {
        const above = out[out.length - 1].trim();
        if (!(taken < 2 ? KEY_BODY : KEY_BODY_FULL).test(above)) break;
        out.pop();
        taken++;
      }
      out.push(REDACTED_KEY);
      index++;
      continue;
    }

    const key = BLOCK_KEY.exec(line.replace(/\r$/, ''));
    if (key !== null && secretName(key[3]) !== null) {
      const indent = key[1].length;
      let next = index + 1;
      while (
        next < lines.length &&
        next - index <= MAX_BLOCK_LINES &&
        (lines[next].trim() === '' || indentOf(lines[next]) > indent)
      ) {
        next++;
      }
      while (next > index + 1 && lines[next - 1].trim() === '') next--;
      if (next > index + 1) {
        out.push(line, `${key[1]}  ${REDACTED}`);
        index = next;
        continue;
      }
    }

    out.push(redactLine(line));
    index++;
  }
  return out.join('\n');
}

/**
 * `text` with recognisable secrets replaced by a marker.
 *
 * @param env Whose secret-named variables' values are removed by exact match.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv): string {
  let redacted = text;
  for (const value of secretValues(env)) redacted = redacted.replaceAll(value, REDACTED);
  redacted = redactLines(redacted.replace(KEY_INLINE, REDACTED_KEY));
  for (const [shape, replacement] of TOKEN_SHAPES) redacted = redacted.replace(shape, replacement);
  return redacted;
}
