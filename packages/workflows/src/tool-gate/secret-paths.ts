/**
 * Which paths are shaped like a secret: an env file, a key, a credential store,
 * a login file one of the agent CLIs keeps, or anything inside a directory that
 * holds them. Decided from the path alone, so the file is never opened.
 *
 * Import-free on purpose. The context scout's pack script carries the base
 * vocabulary (`isSecretPath` in `.shared/context-scout.ts`) and a pack script
 * cannot import engine code, so the two lists cannot share a module yet.
 * `secret-paths.test.ts` holds them together instead: every path the scout
 * calls secret must be secret here too, unless `secretPathExemption` names why
 * the gate lets it through. The gate has those exemptions because it guards
 * work, not prompts: an agent has to edit `.env.example` and read
 * `src/secrets/manager.ts`, while the scout only chooses what to quote.
 */

/** Directories that hold credentials and nothing an agent needs to open. */
const CREDENTIAL_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg', '.gcloud', '.azure', '.kube']);

/**
 * Credential directories of a user's home that are ordinary project
 * directories too: a repository keeps its `Dockerfile` in `.docker/`. They
 * count only in a path that starts outside the repository (absolute, `~`, or
 * a variable), where a path relative to the checkout cannot reach.
 */
const HOME_CREDENTIAL_DIRECTORIES = new Set(['.docker']);
const STARTS_OUTSIDE = /^([/~$]|[a-z]:\/)/;

/** Directories named for secrets. Source code inside them is exempt. */
const SECRET_DIRECTORIES = new Set(['secrets', '.secrets']);

/** Credential directories that are only recognisable with their parent. */
const CREDENTIAL_DIRECTORY_PAIRS = new Set(['.config/gcloud', '.config/github-copilot']);

/** Credential files that are only recognisable with their directory. */
const CREDENTIAL_FILE_SUFFIXES = [
  ...['gh/hosts.yml', 'github-copilot/hosts.json', 'github-copilot/apps.json'],
  ...['etc/shadow', 'etc/gshadow', 'etc/sudoers'],
];

/** `hosts.yml` is a login store when it sits in a tool's config directory. */
const HOSTS_FILE = /^hosts\.(yml|yaml|json)$/;
/** A tool's config or home directory, as the user keeps it or as the engine delivers a copy. */
const TOOL_HOME = /^(\.config|.+-home|\.[a-z0-9-]+)$/;

const SECRET_NAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials',
  'authorized_keys',
  'known_hosts',
  // Login stores of the agent CLIs (Codex, OpenCode, Pi) and of package tools.
  'auth.json',
  '.claude.json',
  'application_default_credentials.json',
  '.vault-token',
  '.my.cnf',
  '.s3cfg',
  '.boto',
  '.dockercfg',
  'kubeconfig',
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

/** Source and prose files: `src/secrets/manager.ts` and `docs/secrets.md` are not secrets. */
const SOURCE_EXTENSIONS = new Set([
  ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'rb', 'java'],
  ...['kt', 'swift', 'php', 'cs', 'c', 'h', 'cpp', 'hpp', 'vue', 'svelte', 'scala', 'ex'],
  ...['exs', 'md', 'mdx', 'rst', 'html', 'css', 'scss'],
]);

/** Public halves of a key pair, and certificates. */
const PUBLIC_EXTENSIONS = new Set(['pub', 'crt', 'cer']);

/** An env file checked in as a template: `.env.example`, `.env.production.sample`, `env.example`. */
const ENV_TEMPLATE = /^\.?env(\.[^.]+)*\.(example|sample|template|dist|defaults)$/;

/** The environment of a running process, as the kernel serves it. */
const PROCESS_ENVIRONMENT = /(^|\/)proc\/[^/]+\/environ$/;

export type SecretPathExemption =
  | 'env_template'
  | 'source_file'
  | 'public_material'
  | 'env_directory_name'
  | 'project_directory';

interface PathShape {
  path: string;
  /** Every segment but the last. */
  directories: string[];
  name: string;
  extension: string;
}

function shapeOf(path: string): PathShape | undefined {
  const lowered = path.toLowerCase().replaceAll('\\', '/');
  const segments = lowered.split('/').filter(segment => segment !== '' && segment !== '.');
  const name = segments.pop();
  if (name === undefined) return undefined;
  const dot = name.lastIndexOf('.');
  return {
    path: lowered,
    directories: segments,
    name,
    extension: dot <= 0 ? '' : name.slice(dot + 1),
  };
}

function inCredentialStore(shape: PathShape): boolean {
  const segments = [...shape.directories, shape.name];
  if (segments.some(segment => CREDENTIAL_DIRECTORIES.has(segment))) return true;
  if (
    STARTS_OUTSIDE.test(shape.path) &&
    segments.some(segment => HOME_CREDENTIAL_DIRECTORIES.has(segment))
  ) {
    return true;
  }
  const joined = segments.join('/');
  if (CREDENTIAL_FILE_SUFFIXES.some(suffix => joined === suffix || joined.endsWith(`/${suffix}`))) {
    return true;
  }
  if (HOSTS_FILE.test(shape.name) && shape.directories.some(segment => TOOL_HOME.test(segment))) {
    return true;
  }
  return segments.some(
    (segment, index) =>
      index > 0 && CREDENTIAL_DIRECTORY_PAIRS.has(`${segments[index - 1] ?? ''}/${segment}`)
  );
}

function isEnvFile(shape: PathShape): boolean {
  const { name } = shape;
  if (name.startsWith('.env') || name.endsWith('.env')) return true;
  // A bare `env` is a directory far more often than a file (`python -m venv env`,
  // `src/env/`), and nothing here can look: see `env_directory_name`.
  if (name === 'env') return false;
  return name.split('.')[0] === 'env' && !ENV_CODE_EXTENSIONS.has(shape.extension);
}

/** Named after secrets: inside `secrets/`, or called `secrets.*` / `credentials.*`. */
function isNamedForSecrets(shape: PathShape): boolean {
  if ([...shape.directories, shape.name].some(segment => SECRET_DIRECTORIES.has(segment))) {
    return true;
  }
  const parts = shape.name.split('.');
  return parts.some((_, index) =>
    SECRET_STEMS.has(
      parts
        .slice(0, index + 1)
        .join('.')
        .replace(/^\./, '')
    )
  );
}

function isKeyOrStore(shape: PathShape): boolean {
  const { name } = shape;
  if (KEY_NAME_PREFIXES.some(prefix => name.startsWith(prefix))) return true;
  const parts = name.split('.');
  for (let end = 1; end <= parts.length; end++) {
    if (SECRET_NAMES.has(parts.slice(0, end).join('.'))) return true;
  }
  return keyExtensions(shape).some(extension => SECRET_EXTENSIONS.has(extension));
}

/**
 * The extensions that can make a file a key. A source file keeps its own
 * extension last, so `api.key.ts` is code about keys; `server.key.bak` is
 * still the key.
 */
function keyExtensions(shape: PathShape): string[] {
  return SOURCE_EXTENSIONS.has(shape.extension) ? [] : shape.name.split('.').slice(1);
}

/** `api.key.ts`: a key extension in the middle of a source file's name. */
function isSourceNamedForKeys(shape: PathShape): boolean {
  return (
    SOURCE_EXTENSIONS.has(shape.extension) &&
    shape.name
      .split('.')
      .slice(1, -1)
      .some(extension => SECRET_EXTENSIONS.has(extension))
  );
}

/**
 * Why the gate does not treat a secret-shaped path as a secret, or `undefined`
 * when no exemption applies. These are the only differences from the scout's
 * vocabulary that the conformance test accepts.
 */
export function secretPathExemption(path: string): SecretPathExemption | undefined {
  const shape = shapeOf(path);
  if (shape === undefined) return undefined;
  // A credential directory holds nothing an agent needs, whatever the file is called.
  if (inCredentialStore(shape) || PROCESS_ENVIRONMENT.test(shape.path)) return undefined;
  if (PUBLIC_EXTENSIONS.has(shape.extension)) return 'public_material';
  if (shape.directories.some(segment => segment.startsWith('.env'))) return undefined;
  if (ENV_TEMPLATE.test(shape.name)) return 'env_template';
  if (isEnvFile(shape) || isKeyOrStore(shape)) return undefined;
  if (SOURCE_EXTENSIONS.has(shape.extension) && isNamedForSecrets(shape)) return 'source_file';
  if (isSourceNamedForKeys(shape)) return 'source_file';
  if (shape.name === 'env') return 'env_directory_name';
  const segments = [...shape.directories, shape.name];
  if (segments.some(segment => HOME_CREDENTIAL_DIRECTORIES.has(segment))) {
    return 'project_directory';
  }
  return undefined;
}

/**
 * Whether a path names an env file, a key, a credential or login store, or a
 * process environment. A secret store keeps its name when something is appended
 * to it (`secrets.enc.yaml`, `id_rsa.bak`, `.netrc.old`), so every dotted prefix
 * of the file name is checked, and every extension after the first dot.
 */
export function isSecretPath(path: string): boolean {
  const shape = shapeOf(path);
  if (shape === undefined) return false;
  if (secretPathExemption(path) !== undefined) return false;
  return (
    PROCESS_ENVIRONMENT.test(shape.path) ||
    inCredentialStore(shape) ||
    shape.directories.some(segment => segment.startsWith('.env')) ||
    isEnvFile(shape) ||
    isKeyOrStore(shape) ||
    isNamedForSecrets(shape)
  );
}
