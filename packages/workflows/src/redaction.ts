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

/** A PEM block, or one whose end marker is missing: then everything after the start goes. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
/** `scheme://user:password@host` and `scheme://token@host`. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
/** The whole value of an Authorization header, whatever its scheme. */
const AUTHORIZATION_HEADER = /\b(authorization\s*[:=]\s*)[^\r\n"']+/gi;
const BEARER_TOKEN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** A name that reads as a credential, then `=` or `:`, then a quoted or bare value. */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|pwd|apikey|[_-]key|credential|dsn|database_url)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;]+)/gi;
/** Token formats that identify themselves, for a credential pasted with no name beside it. */
const KNOWN_TOKEN_PREFIX =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;

/** Mask text shaped like a credential. Defence in depth, never a guarantee. */
export function maskSecretShapes(input: string): string {
  return input
    .replace(PEM_BLOCK, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(AUTHORIZATION_HEADER, `$1${REDACTED}`)
    .replace(BEARER_TOKEN, `$1 ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, `$1$2${REDACTED}`)
    .replace(KNOWN_TOKEN_PREFIX, REDACTED);
}

/**
 * Text fit to send to an external classifier: exact credentials removed, credential
 * shapes masked, then cut to `maxChars`. The cut comes last so it can never leave the
 * unmasked half of a secret behind.
 */
export function redactForClassifier(
  input: string,
  credentialValues: readonly string[],
  maxChars: number
): string {
  const masked = maskSecretShapes(redactCredentialValues(input, credentialValues));
  if (masked.length <= maxChars) return masked;
  return `${masked.slice(0, maxChars)} [truncated ${String(masked.length - maxChars)} chars]`;
}
