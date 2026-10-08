/**
 * Masks secrets in text before it leaves the gate for the classifier or the
 * event log. Redaction errs toward masking: a harmless value that looks like a
 * secret is lost, a secret that looks harmless is the failure.
 *
 * Exact credential values come from the caller, which knows what the engine
 * injected. They are masked first and on the full text, so truncation can never
 * leave the front half of one behind.
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

const SECRET_KEY = /(?:token|key|secret|password|passwd|credentials?)$/i;
const SECRET_KEY_NAMES = new Set([
  'database_url',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

/** Whether a variable, flag, header or JSON key names a secret. */
export function isSecretKey(name: string): boolean {
  return SECRET_KEY.test(name) || SECRET_KEY_NAMES.has(name.toLowerCase());
}

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const CREDENTIAL_HEADER =
  /\b((?:proxy-)?authorization|x-api-key|x-auth-token|(?:set-)?cookie)(["']?\s*[:=]\s*["']?)[^"'\r\n]+/gi;
const BEARER_TOKEN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const VALUE = String.raw`"[^"]*"|'[^']*'|[^\s"',;&|)}]+`;
/** `NAME=value`, `name: value`, `"name": "value"`. The replacer keeps non-secret names. */
const ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(?:${VALUE})`,
  'g'
);
/** `--password value` and `--password=value`. */
const SECRET_FLAG = new RegExp(
  String.raw`(?<![A-Za-z0-9-])(--?[A-Za-z0-9-]*(?:token|key|secret|password|passwd|credentials?))(=|\s+(?!-))(?:${VALUE})`,
  'gi'
);
const TOKEN_SHAPES =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;

export function maskCredentialValues(text: string, credentialValues: readonly string[]): string {
  const ordered = [...new Set(credentialValues)]
    .filter(value => value.length > 0)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const value of ordered) result = result.replaceAll(value, REDACTED);
  return result;
}

function maskShapes(text: string): string {
  return text
    .replace(PEM_BLOCK, `${REDACTED} PEM block`)
    .replace(CREDENTIAL_HEADER, `$1$2${REDACTED}`)
    .replace(BEARER_TOKEN, `$1 ${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(ASSIGNMENT, (match: string, name: string, separator: string) =>
      isSecretKey(name) ? `${name}${separator}${REDACTED}` : match
    )
    .replace(SECRET_FLAG, `$1$2${REDACTED}`)
    .replace(TOKEN_SHAPES, REDACTED);
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}… [truncated ${String(text.length - cap)} chars]`;
}

/** Masks secrets in `text`, then cuts it to the cap. */
export function redactText(text: string, options: RedactOptions): string {
  const exact = maskCredentialValues(text, options.credentialValues);
  const scanned = exact.length > SHAPE_SCAN_LIMIT ? exact.slice(0, SHAPE_SCAN_LIMIT) : exact;
  const masked = maskShapes(scanned);
  // Keep the true length in the marker even when the scan was cut short.
  const dropped = exact.length - scanned.length;
  if (dropped === 0) return truncate(masked, options.cap);
  return `${masked.slice(0, options.cap)}… [truncated ${String(Math.max(masked.length - options.cap, 0) + dropped)} chars]`;
}

function maskSecretKeys(value: unknown, depth: number): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_INPUT_DEPTH) return '[nested]';
  if (Array.isArray(value)) return value.map(item => maskSecretKeys(item, depth + 1));
  const masked: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    masked[key] = isSecretKey(key) ? REDACTED : maskSecretKeys(item, depth + 1);
  }
  return masked;
}

/**
 * A tool's raw input as redacted JSON: values under secret-named keys are
 * masked whatever they hold, then the text rules run over the rest.
 */
export function redactInput(input: Record<string, unknown>, options: RedactOptions): string {
  let json: string;
  try {
    json = JSON.stringify(maskSecretKeys(input, 0));
  } catch {
    // Not serialisable even after the walk: describe it by its keys alone.
    json = `{${Object.keys(input).join(', ')}}`;
  }
  return redactText(json, options);
}
