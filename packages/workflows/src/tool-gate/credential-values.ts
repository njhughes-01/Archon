/**
 * The exact credential values the engine knows about, and masking them.
 *
 * One owner for both: the subprocess paths of the workflow executor and the
 * tool gate redact against the same set, found the same way. The masking
 * itself and the secret-name vocabulary live in `redact.ts`.
 */
import { isSecretKey, maskCredentialValues } from './redact';

/**
 * Environment names often run the words together (`NPM_AUTHTOKEN`,
 * `DBPASSWORD`), which the whole-word vocabulary in `redact.ts` rightly does
 * not read as secret in free text. For a variable the engine is about to hand
 * to a process, a name that ends this way is still treated as one: a value
 * left unmasked in a log costs more than one masked needlessly.
 */
const RUN_TOGETHER_SECRET_NAME = /(?:token|key|secret|password)$/i;

function namesCredential(key: string): boolean {
  return isSecretKey(key) || RUN_TOGETHER_SECRET_NAME.test(key);
}

/** Masks every occurrence of each exact credential value in `text`. */
export function redactCredentialValues(text: string, credentialValues: readonly string[]): string {
  return maskCredentialValues(text, credentialValues);
}

/**
 * The exact values to mask for a process given `env`: the value of every
 * secret-named variable, of every variable the engine marked protected, and
 * the credentials it delivered some other way (a file, for instance).
 * Distinct, non-empty, longest first.
 */
export function collectCredentialValues(
  env: Readonly<Record<string, string | undefined>>,
  protectedEnvKeys: readonly string[] | undefined,
  protectedCredentialValues: readonly string[] | undefined
): string[] {
  const explicitlyProtected = new Set(protectedEnvKeys);
  const values = Object.entries(env).flatMap(([key, value]) =>
    value !== undefined && (explicitlyProtected.has(key) || namesCredential(key)) ? [value] : []
  );
  return [...new Set([...values, ...(protectedCredentialValues ?? [])])]
    .filter(value => value.length > 0)
    .sort((a, b) => b.length - a.length);
}
