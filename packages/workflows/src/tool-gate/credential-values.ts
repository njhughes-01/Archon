/**
 * The exact credential values the engine knows about, and masking them.
 *
 * One owner for both: the subprocess paths of the workflow executor and the
 * tool gate redact against the same set, found the same way. The masking
 * itself and the secret-name vocabulary live in `redact.ts`.
 */
import { isSecretKey, maskCredentialValues } from './redact';

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
    value !== undefined && (explicitlyProtected.has(key) || isSecretKey(key)) ? [value] : []
  );
  return [...new Set([...values, ...(protectedCredentialValues ?? [])])]
    .filter(value => value.length > 0)
    .sort((a, b) => b.length - a.length);
}
