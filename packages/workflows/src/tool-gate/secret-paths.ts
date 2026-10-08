/**
 * Which paths are shaped like a secret: an env file, a key, a credential store,
 * or anything inside a directory that holds them. Decided from the path alone,
 * so the file is never opened.
 *
 * Import-free on purpose. The context scout's pack script carries the same
 * vocabulary (`isSecretPath` in `.shared/context-scout.ts`), and a pack script
 * cannot import engine code. Until one of them owns the list and the other
 * derives from it, this file must cover at least everything that predicate
 * covers.
 */

const SECRET_DIRECTORIES = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.gcloud',
  '.azure',
  '.kube',
  '.docker',
  'secrets',
  '.secrets',
]);

const SECRET_NAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials',
  'authorized_keys',
  'known_hosts',
]);

/** A file whose name starts with one of these, whatever follows the next dot, stores secrets. */
const SECRET_STEMS = new Set(['credentials', 'credential', 'secrets', 'secret']);

/** SSH private keys keep these prefixes through every rename: `id_rsa.bak`, `id_ed25519_sk`. */
const KEY_NAME_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

const SECRET_EXTENSIONS = new Set([
  'pem',
  'key',
  'p12',
  'pfx',
  'jks',
  'keystore',
  'kdbx',
  'ppk',
  'gpg',
  'asc',
  'crt',
  'cer',
  'der',
  'tfvars',
  'tfstate',
]);

/**
 * What makes a file named `env.<something>` code that reads the environment
 * rather than an env file written without its dot. Everything else called `env`
 * is treated as the env file.
 */
const ENV_CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'php',
  'cs',
  'swift',
  'sh',
]);

/**
 * A secret store keeps its name when something is appended to it
 * (`secrets.enc.yaml`, `id_rsa.bak`, `.netrc.old`), so every dotted prefix of
 * the file name is checked, and every extension after the first dot. A secret
 * directory counts in the last position too: the path may name the directory.
 */
export function isSecretPath(path: string): boolean {
  const segments = path
    .toLowerCase()
    .split(/[\\/]/)
    .filter(segment => segment !== '' && segment !== '.');
  if (segments.some(segment => SECRET_DIRECTORIES.has(segment))) return true;

  const name = segments.pop();
  if (name === undefined) return false;
  if (segments.some(segment => segment.startsWith('.env'))) return true;
  if (name.startsWith('.env') || name.endsWith('.env')) return true;
  if (KEY_NAME_PREFIXES.some(prefix => name.startsWith(prefix))) return true;

  const parts = name.split('.');
  if (parts[0] === 'env' && !ENV_CODE_EXTENSIONS.has(parts.at(-1) ?? '')) return true;
  for (let end = 1; end <= parts.length; end++) {
    const prefix = parts.slice(0, end).join('.');
    if (SECRET_NAMES.has(prefix) || SECRET_STEMS.has(prefix.replace(/^\./, ''))) return true;
  }
  return parts.slice(1).some(extension => SECRET_EXTENSIONS.has(extension));
}
