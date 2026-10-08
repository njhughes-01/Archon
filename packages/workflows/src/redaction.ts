/**
 * Credential redaction for text that leaves the process or is retained as evidence.
 *
 * Two layers, one owner each. The exact layer removes values the engine knows are
 * credentials because it injected them or they sit under a secret-named variable. The
 * shape layer masks text that merely looks like a credential, for text a person typed and
 * the engine therefore has no provenance for. Shapes can miss a secret and can mask an
 * innocent value, so nothing may treat the shape layer as proof that text is clean.
 */

export const REDACTED = '[REDACTED]';

const CREDENTIAL_ENV_KEY_SUFFIX = /(?:TOKEN|KEY|SECRET|PASSWORD)$/i;
const CREDENTIAL_ENV_KEYS = new Set(['DATABASE_URL']);

/** Exact credential values in `env`, longest first so a value never survives inside another. */
export function collectCredentialValues(
  env: NodeJS.ProcessEnv,
  protectedEnvKeys: readonly string[] | undefined,
  protectedCredentialValues: readonly string[] | undefined
): string[] {
  const explicitlyProtected = new Set(protectedEnvKeys);
  const values = Object.entries(env).flatMap(([key, value]) =>
    value &&
    (explicitlyProtected.has(key) ||
      CREDENTIAL_ENV_KEYS.has(key) ||
      CREDENTIAL_ENV_KEY_SUFFIX.test(key))
      ? [value]
      : []
  );
  return [...new Set([...values, ...(protectedCredentialValues ?? [])])]
    .filter(value => value.length > 0)
    .sort((a, b) => b.length - a.length);
}

export function redactCredentialValues(input: string, credentialValues: readonly string[]): string {
  let result = input;
  for (const value of credentialValues) {
    result = result.replaceAll(value, REDACTED);
  }
  return result;
}

/**
 * Every quantifier below is bounded or anchored on a literal, so matching is linear in the
 * input. An unbounded name class in front of a keyword made the original pattern quadratic
 * on long runs of word characters.
 */

/** A PEM block, or one whose end marker is missing: then everything after the start goes. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]{1,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,40}-----|$)/g;
/** `scheme://user:password@host`, where the password may itself hold `/` or `@`. */
const URL_USER_PASSWORD = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s:@/]{1,256}:[^\s]{0,512}@/gi;
/** `scheme://token@host`. */
const URL_USER_ONLY = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]{1,512}@/gi;
/** Chat webhook and bot URLs carry their secret in the path. */
const SECRET_PATH_URL =
  /\b(hooks\.slack\.com\/services\/|api\.telegram\.org\/bot|discord(?:app)?\.com\/api\/webhooks\/)[^\s"'<>]{1,512}/gi;
/** The whole value of a header that carries a credential, whatever its scheme. */
const CREDENTIAL_HEADER =
  /\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-auth-token)(\s*[:=]\s*)[^\r\n"']{1,4096}/gi;
const BEARER_TOKEN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,4096}/gi;

/** Words that make a name read as a credential. */
const SECRET_WORD =
  'token|secret|passw(?:or)?d|passphrase|pwd|api[_-]?key|access[_-]?key|private[_-]?key|[_-]key|credential|signature|session(?:[_-]?id)?|dsn|database_url';
/** A credential-like name, at most 64 characters either side of the word that makes it one. */
const SECRET_NAME = `[A-Za-z0-9_.-]{0,64}(?:${SECRET_WORD})[A-Za-z0-9_.-]{0,64}`;
/** The same name, or a bare `key`, with the quotes JSON and Python put around it. */
const QUOTED_SECRET_NAME = `(?:${SECRET_NAME}|key)`;

/** `"name": "value"` and `'name': 'value'`, as in JSON or a dict. */
const QUOTED_ASSIGNMENT = new RegExp(
  `(["'])(${QUOTED_SECRET_NAME})\\1(\\s{0,8}[:=]\\s{0,8})(?:"[^"\\r\\n]{0,4096}"|'[^'\\r\\n]{0,4096}')`,
  'gi'
);
/** `name="value"` and `name: 'value'`. */
const ASSIGNMENT_TO_QUOTED = new RegExp(
  `(?<![A-Za-z0-9_.-])(${QUOTED_SECRET_NAME})(\\s{0,8}[:=]\\s{0,8})(?:"[^"\\r\\n]{0,4096}"|'[^'\\r\\n]{0,4096}')`,
  'gi'
);
/** `name=value`: the value runs to the next whitespace, so `;` and `,` inside it go too. */
const ASSIGNMENT_NO_SPACE = new RegExp(
  `(?<![A-Za-z0-9_.-])(${QUOTED_SECRET_NAME})(=)[^\\s"']{1,4096}`,
  'gi'
);
/** `name: value words` and `name = value words`: an unquoted value may hold spaces, so the rest of the line goes. */
const ASSIGNMENT_SPACED = new RegExp(
  `(?<![A-Za-z0-9_.-])(${QUOTED_SECRET_NAME})(\\s{0,8}:\\s{1,8}|\\s{1,8}=\\s{1,8})[^\\s"'][^\\r\\n]{0,4096}`,
  'gi'
);
/** `--password value`, `--api-token=value`. */
const LONG_FLAG =
  /(--[A-Za-z0-9-]{0,32}(?:passw(?:or)?d|pwd|passphrase|token|secret|key|credential)[A-Za-z0-9-]{0,32})([=\s]\s{0,8})[^\s"']{1,4096}/gi;
/** `-pVALUE`, the database clients' attached-password form. */
const SHORT_PASSWORD_FLAG = /(?<![\w-])(-p)[^\s-][^\s]{0,4096}/g;
/** A JSON Web Token: three base64url parts, the first two being JSON objects. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{4,4096}/g;
/** Token formats that identify themselves, for a credential pasted with no name beside it. */
const KNOWN_TOKEN_PREFIX =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|sk-[A-Za-z0-9_-]{20,255}|[srp]k_(?:live|test)_[A-Za-z0-9]{8,255}|xox[abprs]-[A-Za-z0-9-]{10,255}|AKIA[0-9A-Z]{16})\b/g;

/** Mask text shaped like a credential. Defence in depth, never a guarantee. */
export function maskSecretShapes(input: string): string {
  return input
    .replace(PEM_BLOCK, REDACTED)
    .replace(SECRET_PATH_URL, `$1${REDACTED}`)
    .replace(URL_USER_PASSWORD, `$1${REDACTED}@`)
    .replace(URL_USER_ONLY, `$1${REDACTED}@`)
    .replace(CREDENTIAL_HEADER, `$1$2${REDACTED}`)
    .replace(BEARER_TOKEN, `$1 ${REDACTED}`)
    .replace(QUOTED_ASSIGNMENT, `$1$2$1$3${REDACTED}`)
    .replace(ASSIGNMENT_TO_QUOTED, `$1$2${REDACTED}`)
    .replace(ASSIGNMENT_NO_SPACE, `$1$2${REDACTED}`)
    .replace(ASSIGNMENT_SPACED, `$1$2${REDACTED}`)
    .replace(LONG_FLAG, `$1$2${REDACTED}`)
    .replace(SHORT_PASSWORD_FLAG, `$1${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(KNOWN_TOKEN_PREFIX, REDACTED);
}

/**
 * How far past `maxChars` the shape masks look. A secret that starts inside the part that
 * will be sent must be seen whole to be masked, and none of the shapes above is longer.
 */
const MASK_LOOKAHEAD_CHARS = 8192;

/**
 * Text fit to send to an external classifier: exact credentials removed, credential
 * shapes masked, then cut to `maxChars`.
 *
 * The input is cut twice. First to `maxChars` plus a lookahead, so the masks run over a
 * bounded window however large the input is: they are synchronous and run before any
 * request timeout starts. Then to `maxChars`, after masking, so the final cut can never
 * leave the unmasked half of a secret behind. When the first cut removed text, the last
 * word of the window may be half a secret with nothing to identify it, so it is dropped.
 */
export function redactForClassifier(
  input: string,
  credentialValues: readonly string[],
  maxChars: number
): string {
  const exact = redactCredentialValues(input, credentialValues);
  const window = maxChars + MASK_LOOKAHEAD_CHARS;
  let bounded = exact;
  if (exact.length > window) {
    let end = window;
    while (end > 0 && !/\s/.test(exact.charAt(end - 1))) end--;
    bounded = exact.slice(0, end);
  }
  const masked = maskSecretShapes(bounded);
  const removed = exact.length - bounded.length + Math.max(0, masked.length - maxChars);
  if (masked.length <= maxChars && removed === 0) return masked;
  return `${masked.slice(0, maxChars)} [truncated ${String(removed)} chars]`;
}
