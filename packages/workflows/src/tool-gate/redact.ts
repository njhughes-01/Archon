/**
 * Masks secrets in text before it leaves the gate for the classifier or the
 * event log. Redaction errs toward masking: a harmless value that looks like a
 * secret is lost, a secret that looks harmless is the failure.
 *
 * Exact credential values come from the caller, which knows what the engine
 * injected. They are masked first and on the full text, so truncation can never
 * leave the front half of one behind.
 *
 * The shape rules below are a net, not a proof: a secret with no telling name,
 * prefix or position passes through. Callers must not treat redacted text as
 * safe to publish.
 */

export const REDACTED = '[REDACTED]';

/** How much of a command the classifier is sent. */
export const ESCALATION_TEXT_CAP = 2_000;
/** How much of a command the event log keeps. */
export const PREVIEW_TEXT_CAP = 200;

/**
 * Shape rules are not run past this many characters. They are written to stay
 * linear, and this bounds them anyway: what lies beyond is cut by every cap.
 */
const SHAPE_SCAN_LIMIT = 64_000;

/** How deep `redactInput` walks before it stops describing a value. */
const MAX_INPUT_DEPTH = 6;

export interface RedactOptions {
  /** Exact values to mask wherever they appear. */
  credentialValues: readonly string[];
  /** Length the result is cut to. */
  cap: number;
}

/** Words that mark a name as secret wherever they stand in it: `SECRET_KEY_BASE`, `apiToken`. */
const SECRET_WORDS = new Set([
  ...['secret', 'secrets', 'token', 'password', 'passwd', 'passphrase'],
  ...['credential', 'credentials', 'apikey'],
]);
/** Words that mark a name as secret only as its last word: `API_KEY`, `Pwd`, `SMTP_PASS`, `REGISTRY_AUTH`. */
const SECRET_LAST_WORDS = new Set(['key', 'pwd', 'pass', 'auth']);
/** Word pairs that mark a name as secret wherever they stand: `PRIVATE_KEY_PEM`, `accessKeyId`. */
const SECRET_WORD_PAIRS = new Set(['api key', 'access key', 'private key', 'secret key']);
const SECRET_KEY_NAMES = new Set([
  'database_url',
  'dsn',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

/** `GITHUB_TOKEN`, `x-api-key` and `apiKey` as lower-case words. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word !== '');
}

/**
 * Whether a variable, flag, header or JSON key names a secret. Whole words
 * only: `MAX_TOKENS` and `TOKENIZERS_PARALLELISM` are settings, and a caller
 * that masks the values of secret-named variables must not mask theirs.
 */
export function isSecretKey(name: string): boolean {
  if (SECRET_KEY_NAMES.has(name.toLowerCase())) return true;
  const words = nameWords(name);
  return (
    words.some(word => SECRET_WORDS.has(word)) ||
    SECRET_LAST_WORDS.has(words.at(-1) ?? '') ||
    words.some((word, index) => SECRET_WORD_PAIRS.has(`${word} ${words[index + 1] ?? ''}`))
  );
}

/** A value: double-quoted (escapes kept), single-quoted, or a run up to the next space or quote. */
const VALUE = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+`;

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const CREDENTIAL_HEADER =
  /\b((?:proxy-)?authorization|x-api-key|x-auth-token|(?:set-)?cookie)(["']?\s*[:=]\s*["']?)[^"'\r\n]+/gi;
const BEARER_TOKEN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** `scheme://user:password@host`. The password may itself hold `@` or `/`, so run to the last `@`. */
const URL_USER_PASSWORD = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]*:\S{0,512}@/gi;
/** `scheme://token@host`. */
const URL_USER_ONLY = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
/** The name and separator of `NAME=value`, `name: value` or `"name": "value"`. */
const ASSIGNMENT_NAME = /(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)/g;
const VALUE_HERE = new RegExp(VALUE, 'y');
/** `--password value` and `--password=value`. */
const SECRET_FLAG = new RegExp(
  String.raw`(?<![A-Za-z0-9-])(--?[A-Za-z0-9-]*(?:token|key|secret|password|passwd|passphrase|credentials?|pwd|pass|auth))(=|\s+(?!-))(?:${VALUE})`,
  'gi'
);
/** `-u user:password` and `--user user:password`: the part after the colon. */
const USER_PASSWORD_FLAG = /(?<![A-Za-z0-9-])(-u|--user)(=|\s+)(["']?[^\s:"']+):[^\s"']+/g;
/** Password flags that only mean a password for these commands. */
const COMMAND_PASSWORD_FLAGS: readonly RegExp[] = [
  /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n;|&]{0,400}?\s-p)[^\s-]\S*/g,
  /(\bsshpass\b[^\n;|&]{0,400}?\s-p\s*)\S+/g,
  /(\b(?:docker|podman|helm|npm)\s+login\b[^\n;|&]{0,400}?\s-p[=\s]*)\S+/g,
  /(\bredis-cli\b[^\n;|&]{0,400}?\s(?:-a|--pass)\s+)\S+/g,
];
const TOKEN_SHAPES = new RegExp(
  [
    String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`github_pat_[A-Za-z0-9_]{20,}`,
    String.raw`glpat-[A-Za-z0-9_-]{20,}`,
    String.raw`sk-[A-Za-z0-9_-]{20,}`,
    String.raw`[sr]k_(?:live|test)_[A-Za-z0-9]{16,}`,
    String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`A[KS]IA[0-9A-Z]{16}`,
    String.raw`AIza[0-9A-Za-z_-]{35}`,
    String.raw`npm_[A-Za-z0-9]{36}`,
    String.raw`hf_[A-Za-z0-9]{30,}`,
    String.raw`pypi-[A-Za-z0-9_-]{40,}`,
    String.raw`dckr_pat_[A-Za-z0-9_-]{20,}`,
    String.raw`shp(?:at|ss|ca)_[A-Fa-f0-9]{32}`,
    String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
    String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
  ]
    .map(shape => `(?:${shape})`)
    .join('|')
    // A token starts at a word edge: `risk-…` must not read as `sk-…`.
    .replace(/^/, '(?<![A-Za-z0-9])(?:')
    .concat(')'),
  'g'
);
/**
 * A bare AWS secret key: exactly forty base64 characters. Mixed case and a
 * digit are required so a forty-character commit id is left alone.
 */
const AWS_SECRET_KEY =
  /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}[A-Z])(?=[A-Za-z0-9/+]{0,39}[0-9])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;

export function maskCredentialValues(text: string, credentialValues: readonly string[]): string {
  const ordered = [...new Set(credentialValues)]
    .filter(value => value.length > 0)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const value of ordered) result = result.replaceAll(value, REDACTED);
  return result;
}

/**
 * Masks the value of every secret-named assignment. A name that is not secret
 * is stepped over on its own, never together with its value: in
 * `note: API_KEY=abc` the value of `note` is itself an assignment, and taking
 * it whole would carry the secret past the rule.
 */
function maskAssignments(text: string): string {
  let masked = '';
  let copied = 0;
  ASSIGNMENT_NAME.lastIndex = 0;
  for (;;) {
    const match = ASSIGNMENT_NAME.exec(text);
    if (match === null) break;
    const name = match[1] ?? '';
    const valueStart = match.index + match[0].length;
    VALUE_HERE.lastIndex = valueStart;
    const value = isSecretKey(name) ? VALUE_HERE.exec(text) : null;
    if (value === null) {
      ASSIGNMENT_NAME.lastIndex = match.index + name.length;
      continue;
    }
    masked += text.slice(copied, valueStart) + REDACTED;
    copied = valueStart + value[0].length;
    ASSIGNMENT_NAME.lastIndex = copied;
  }
  return masked + text.slice(copied);
}

function maskShapes(text: string): string {
  let masked = text
    .replace(PEM_BLOCK, `${REDACTED} PEM block`)
    .replace(CREDENTIAL_HEADER, `$1$2${REDACTED}`)
    .replace(BEARER_TOKEN, `$1 ${REDACTED}`)
    .replace(URL_USER_PASSWORD, `$1${REDACTED}@`)
    .replace(URL_USER_ONLY, `$1${REDACTED}@`);
  masked = maskAssignments(masked)
    .replace(SECRET_FLAG, `$1$2${REDACTED}`)
    .replace(USER_PASSWORD_FLAG, `$1$2$3:${REDACTED}`);
  for (const flag of COMMAND_PASSWORD_FLAGS) masked = masked.replace(flag, `$1${REDACTED}`);
  return masked.replace(TOKEN_SHAPES, REDACTED).replace(AWS_SECRET_KEY, REDACTED);
}

/** Exact values, then shapes, over at most `SHAPE_SCAN_LIMIT` characters. */
function mask(text: string, credentialValues: readonly string[]): { text: string; cut: number } {
  const exact = maskCredentialValues(text, credentialValues);
  if (exact.length <= SHAPE_SCAN_LIMIT) return { text: maskShapes(exact), cut: 0 };
  // The cut can fall inside a token, leaving a prefix too short for any shape
  // rule. Drop the last unfinished word so a partial secret cannot survive.
  const window = maskShapes(exact.slice(0, SHAPE_SCAN_LIMIT)).replace(/\S+$/, '');
  return { text: window, cut: exact.length - SHAPE_SCAN_LIMIT };
}

/** Masks secrets in `text`, then cuts it to the cap. */
export function redactText(text: string, options: RedactOptions): string {
  const masked = mask(text, options.credentialValues);
  const dropped = Math.max(masked.text.length - options.cap, 0) + masked.cut;
  if (dropped === 0) return masked.text;
  return `${masked.text.slice(0, options.cap)}… [truncated ${String(dropped)} chars]`;
}

/** `{ name: 'DB_PASSWORD', value: '…' }`: a pair whose name field is secret. */
function isSecretPair(value: Record<string, unknown>): boolean {
  const label = value.name ?? value.key;
  return typeof label === 'string' && isSecretKey(label) && 'value' in value;
}

function maskInput(value: unknown, credentialValues: readonly string[], depth: number): unknown {
  // Strings are masked here, before JSON escaping turns a newline into `\n` and
  // glues the next line's name onto it.
  if (typeof value === 'string') return mask(value, credentialValues).text;
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_INPUT_DEPTH) return '[nested]';
  if (Array.isArray(value)) {
    return value.map(item => maskInput(item, credentialValues, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const pair = isSecretPair(record);
  const masked: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    masked[key] =
      isSecretKey(key) || (pair && key === 'value')
        ? REDACTED
        : maskInput(item, credentialValues, depth + 1);
  }
  return masked;
}

/**
 * A tool's raw input as redacted JSON: values under secret-named keys are
 * masked whatever they hold, every string is masked by the text rules, and the
 * result is cut to the cap.
 */
export function redactInput(input: Record<string, unknown>, options: RedactOptions): string {
  let json: string;
  try {
    json = JSON.stringify(maskInput(input, options.credentialValues, 0));
  } catch {
    // Not serialisable even after the walk: describe it by its keys alone.
    json = `{${Object.keys(input).join(', ')}}`;
  }
  return redactText(json, options);
}
