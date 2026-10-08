import { describe, expect, test } from 'bun:test';
import { isSecretPath } from './secret-paths';

describe('isSecretPath', () => {
  const secret = [
    '.env',
    '.env.local',
    '.env.example',
    '.envrc',
    'config/.env.production',
    'prod.env',
    'env.production',
    'env',
    '.env.d/app.conf',
    '.envs/local/app.conf',
    'secrets.enc.yaml',
    'config/credentials.yml.enc',
    'credentials.json',
    '.secret',
    'id_rsa',
    'id_rsa.bak',
    'id_ed25519_sk',
    'deploy/id_ecdsa.pub',
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
    'src/secrets/manager.ts',
    'C:\\Users\\me\\.ssh\\id_rsa',
    'CONFIG/SERVER.PEM',
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
    '',
  ];

  test.each(secret)('treats %s as a secret path', path => {
    expect(isSecretPath(path)).toBe(true);
  });

  test.each(plain)('leaves %s alone', path => {
    expect(isSecretPath(path)).toBe(false);
  });
});
