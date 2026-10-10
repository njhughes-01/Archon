import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSecretPath, secretPathExemption } from './secret-paths';

describe('isSecretPath', () => {
  const secret = [
    '.env',
    '.env.local',
    '.envrc',
    'config/.env.production',
    'prod.env',
    'env.production',
    '/home/someone/.docker/config.json',
    '~/.docker/config.json',
    '/home/someone/.ssh/id_ed25519.pub',
    '.aws/ca.crt',
    'deploy/server.key.bak',
    'k8s/secrets.yaml',
    '.env.d/app.conf',
    '.envs/local/app.conf',
    'secrets.enc.yaml',
    'config/credentials.yml.enc',
    'credentials.json',
    '.secret',
    'config/secrets/prod.yaml',
    'secrets',
    'id_rsa',
    'id_rsa.bak',
    'id_ed25519_sk',
    'certs/server.pem',
    'certs/server.key',
    'store.p12',
    'release.jks',
    'prod.tfvars',
    'terraform.tfstate',
    '.netrc',
    '.netrc.old',
    '.npmrc',
    '.git-credentials',
    'authorized_keys',
    '/home/someone/.ssh/config',
    '~/.ssh',
    '~/.aws/config',
    '.kube/config',
    'C:\\Users\\me\\.ssh\\id_rsa',
    'CONFIG/SERVER.PEM',
    // Login stores of the agent CLIs and cloud tools.
    '/home/someone/.codex/auth.json',
    '/home/someone/.config/gh/hosts.yml',
    '/home/someone/.local/share/opencode/auth.json',
    '/home/someone/.config/github-copilot/hosts.json',
    '/home/someone/.config/github-copilot/apps.json',
    '/home/someone/.pi/agent/auth.json',
    '/home/someone/.config/gcloud/application_default_credentials.json',
    '/home/someone/.config/gcloud/credentials.db',
    '/home/someone/.vault-token',
    '/home/someone/.claude.json',
    '/etc/shadow',
    '/proc/self/environ',
    '/proc/4242/environ',
  ];
  const plain = [
    'README.md',
    'src/app.ts',
    'src/token-validator.ts',
    'src/env.ts',
    'env.py',
    'environment.md',
    'docs/secrets-handling.md',
    'packages/core/src/keys.ts',
    '.venv/bin/python',
    'env/bin/python',
    'package.json',
    '/home/someone/.config/gh/config.yml',
    '/home/someone/.codex/config.toml',
    '/proc/self/status',
    '/etc/hosts',
    '',
  ];

  test.each(secret)('treats %s as a secret path', path => {
    expect(isSecretPath(path)).toBe(true);
  });

  test.each(plain)('leaves %s alone', path => {
    expect(isSecretPath(path)).toBe(false);
  });
});

describe('secretPathExemption', () => {
  test.each([
    ['.env.example', 'env_template'],
    ['.env.sample', 'env_template'],
    ['config/.env.production.template', 'env_template'],
    ['.env.dist', 'env_template'],
    ['.env.defaults', 'env_template'],
    ['env.example', 'env_template'],
    ['src/secrets/manager.ts', 'source_file'],
    ['src/auth/credentials.ts', 'source_file'],
    ['docs/secrets.md', 'source_file'],
    ['lib/secret.rb', 'source_file'],
    ['id_rsa.pub', 'public_material'],
    ['keys/id_ed25519.pub', 'public_material'],
    ['env', 'env_directory_name'],
    ['src/env', 'env_directory_name'],
    ['.docker/Dockerfile', 'project_directory'],
    ['src/api.key.ts', 'source_file'],
    ['src/secrets/index.jsx', 'source_file'],
    ['docs/credentials.mdx', 'source_file'],
    ['lib/secrets.mjs', 'source_file'],
    ['certs/server.crt', 'public_material'],
    ['certs/ca.cer', 'public_material'],
  ] as const)('%s is exempt as %s', (path, exemption) => {
    expect(secretPathExemption(path)).toBe(exemption);
    expect(isSecretPath(path)).toBe(false);
  });

  test.each([
    '.env',
    '.env.local',
    '.env.example.local',
    'example.env',
    '.env.d/settings.example',
    '.ssh/config.ts',
    '.aws/credentials.md',
    'secrets/prod.yaml',
    'secrets/server.key',
    'secrets/id_rsa.ts',
    'credentials.json',
    'server.pem',
    'README.md',
  ])('%s gets no exemption', path => {
    expect(secretPathExemption(path)).toBeUndefined();
  });
});

/**
 * The scout's predicate is the base vocabulary and lives in a pack script the
 * engine cannot import statically. This holds the two together: whatever the
 * scout calls secret, the gate calls secret too, unless one of the documented
 * exemptions says why not.
 */
describe('conformance with the context scout', () => {
  const directories = [
    '',
    'config/',
    'src/secrets/',
    '.secrets/',
    '.ssh/',
    '.aws/',
    '.kube/',
    '.docker/',
    '.gnupg/',
    'deploy/.env.d/',
    'a/b/',
  ];
  const names = [
    ...['.env', '.env.local', '.env.example', '.env.sample', '.envrc', 'prod.env', 'env'],
    ...['env.production', 'env.example', 'env.ts', 'env.yaml'],
    ...[
      'credentials',
      'credentials.json',
      'credentials.yml.enc',
      'credentials.ts',
      'credential.md',
    ],
    ...['secrets', 'secrets.enc.yaml', 'secrets.md', 'secret.py', '.secret', 'secret-notes.txt'],
    ...['id_rsa', 'id_rsa.pub', 'id_rsa.bak', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ed25519_sk'],
    ...['server.pem', 'server.key', 'server.crt', 'ca.cer', 'cert.der', 'store.p12', 'store.pfx'],
    ...['release.jks', 'app.keystore', 'vault.kdbx', 'putty.ppk', 'key.gpg', 'key.asc'],
    ...['prod.tfvars', 'terraform.tfstate', 'terraform.tfstate.backup'],
    ...['.netrc', '.netrc.old', '.npmrc', '.pypirc', '.pgpass', '.htpasswd', '.git-credentials'],
    ...[
      'authorized_keys',
      'known_hosts',
      'config',
      'manager.ts',
      'README.md',
      'index.js',
      'notes.txt',
    ],
  ];
  const corpus = directories.flatMap(directory => names.map(name => `${directory}${name}`));

  test('every path the scout calls secret is secret here, or exempt for a stated reason', async () => {
    const scoutPath = join(
      import.meta.dir,
      ...['..', '..', '..', '..'],
      ...['.archon', 'workflows', 'sdlc', '.shared', 'context-scout.ts']
    );
    const scout = (await import(pathToFileURL(scoutPath).href)) as {
      isSecretPath: (path: string) => boolean;
    };

    const scoutSecrets = corpus.filter(path => scout.isSecretPath(path));
    // Guard against a vacuous pass: the scout must recognise most of this corpus.
    expect(scoutSecrets.length).toBeGreaterThan(corpus.length / 2);

    const missed = scoutSecrets.filter(
      path => !isSecretPath(path) && secretPathExemption(path) === undefined
    );
    expect(missed).toEqual([]);

    const exempted = new Set(scoutSecrets.map(path => secretPathExemption(path)));
    expect([...exempted].filter(kind => kind !== undefined).sort()).toEqual([
      'env_directory_name',
      'env_template',
      'project_directory',
      'public_material',
      'source_file',
    ]);
  });
});
