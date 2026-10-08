/**
 * What the pack removes from text before it leaves the machine. Every row is a shape a
 * failing command really prints; the planted value is spelled so that no row can pass by
 * leaving part of it behind.
 *
 * Credential-shaped literals are assembled at runtime. Written out whole, they would trip
 * the secret scanners that guard this repository's own pushes.
 */
import { describe, expect, it } from 'bun:test';
import { redactSecrets } from '../../workflows/sdlc/.shared/redaction';

const redact = (text: string, env: Record<string, string> = {}): string =>
  redactSecrets(text, env);

/** Joins the pieces of a credential-shaped literal. */
const shaped = (...pieces: string[]): string => pieces.join('');

describe('values assigned to secret-named keys', () => {
  it.each([
    'SECRET_KEY_BASE=PLANTEDaaaa1111',
    'JWT_SECRET_KEY=PLANTEDbbbb2222',
    'ENCRYPTION_KEY=PLANTEDcccc3333',
    'signing_key: PLANTEDdddd4444',
    'DB_PASS=PLANTEDeeee5555',
    'DB_PWD=PLANTEDffff6666',
    'auth: PLANTEDgggg7777',
    '{"auths":{"ghcr.io":{"auth":"PLANTEDBASE64AUTH=="}}}',
    'spring.datasource.password=PLANTEDhhhh8888',
    'export apiKey="PLANTEDiiii9999"',
    'x-api-key: PLANTEDjjjj0000',
    'DATABASE_PASSWORD=PLANTED_ASSIGNED_SECRET',
    "db_password: 'PLANTED QUOTED SECRET'",
    'authToken=PLANTEDkkkk1212',
    'clientSecret: "PLANTEDllll3434"',
  ])('removes the value in: %s', line => {
    const redacted = redact(line);

    expect(redacted).not.toContain('PLANTED');
    expect(redacted).toContain('[REDACTED]');
    // The name stays, so a reader still knows what was there.
    expect(redacted.slice(0, 4)).toBe(line.slice(0, 4));
  });

  it.each([
    ['PASSWORD=PLANTED pa ss word', 'PASSWORD=[REDACTED]'],
    ['PASSWORD="PLANTED pa ss word" then more', 'PASSWORD="[REDACTED]" then more'],
    ["PASSWORD='PLANTED pa ss word' then more", "PASSWORD='[REDACTED]' then more"],
    ['PASSWORD="PLANTED \\" escaped quote" then more', 'PASSWORD="[REDACTED]" then more'],
    ['PASSWORD=PLANTEDabc;PLANTEDdef123456', 'PASSWORD=[REDACTED]'],
    ['Password=PLANTEDabc&PLANTEDdef', 'Password=[REDACTED]'],
    ['password: PLANTED, retries: 3', 'password: [REDACTED]'],
  ])('takes the whole value, not its first word: %s', (line, expected) => {
    expect(redact(line)).toBe(expected);
  });

  it('stops at the next parameter inside a query string', () => {
    expect(redact('GET /callback?access_token=PLANTED_QUERY&state=kept HTTP/1.1')).toBe(
      'GET /callback?access_token=[REDACTED]&state=kept HTTP/1.1'
    );
    expect(
      redact(
        'https://bucket.s3.example/o?X-Amz-Date=20260501&X-Amz-Signature=PLANTEDsig0123456789abcdef&X-Amz-Expires=300'
      )
    ).toBe(
      'https://bucket.s3.example/o?X-Amz-Date=20260501&X-Amz-Signature=[REDACTED]&X-Amz-Expires=300'
    );
    expect(
      redact('https://acct.blob.example/c/b?sv=2022-11-02&sig=PLANTEDazure%2Bsig%3D&se=2026-05-01')
    ).toBe('https://acct.blob.example/c/b?sv=2022-11-02&sig=[REDACTED]&se=2026-05-01');
  });

  it.each([
    'Cookie: session=PLANTEDcookie; theme=PLANTEDdark',
    'Set-Cookie: sid=PLANTEDsid; Path=/; HttpOnly',
    '< set-cookie: sid=PLANTEDsid; Path=/',
  ])('removes a whole cookie header: %s', line => {
    expect(redact(line)).not.toContain('PLANTED');
  });

  it('removes a value on the lines under a secret-named key', () => {
    const nextLine = ['db:', '  password:', '    PLANTEDnextline', '  host: db.internal'].join(
      '\n'
    );
    expect(redact(nextLine)).toBe(
      ['db:', '  password:', '    [REDACTED]', '  host: db.internal'].join('\n')
    );

    const block = ['api_key: |', '  PLANTEDline1', '', '  PLANTEDline2', 'name: app'].join('\n');
    expect(redact(block)).toBe(['api_key: |', '  [REDACTED]', 'name: app'].join('\n'));

    const listItem = ['- token: >-', '    PLANTEDfolded', '- name: next'].join('\n');
    expect(redact(listItem)).toBe(['- token: >-', '  [REDACTED]', '- name: next'].join('\n'));
  });

  it.each([
    'Error: DATABASE_URL is not set',
    'FATAL: password authentication failed for user "postgres"',
    'tests/test_token.py::test_refresh_token FAILED',
    'thread main panicked at src/auth/token.rs:42:9',
    'error[E0433]: failed to resolve: use of undeclared crate `auth::token::verify`',
    "SyntaxError: Unexpected token '}' in JSON at position 41",
    'Unexpected token: }',
    'Error: listen EADDRINUSE: address already in use :::3000',
    'npm error code ERESOLVE',
    'expect(received).toBe(expected) // Object.is equality',
    'see https://github.com/example/repo/issues/12 for details',
    'Tests:       2 failed, 14 passed, 16 total',
    'pass: 12, fail: 1',
    'ℹ pass 0',
    'cache key: v1-deps-linux-x64',
    'duplicate key value violates unique constraint "users_pkey"',
    'token: undefined',
    'password: null',
    'auth: true',
    'sig: 11',
    'PWD=/srv/app/build',
    'A jest worker process (pid=48213) was terminated by another process: signal=SIGKILL, exitCode=null.',
    'Authorization: denied for user ci',
    'assert token == expected_token',
    'if (token === expected) return;',
    'const length = (token) => token.length;',
    'retry 1 of 3: true path /srv/app/build failed in production',
  ])('leaves an ordinary failure line as it is: %s', line => {
    expect(redact(line)).toBe(line);
  });
});

describe('credentials on a command line', () => {
  it.each([
    ['deploy --token PLANTEDflagtoken --region eu', 'deploy --token [REDACTED] --region eu'],
    [
      'deploy --password "PLANTED flag pw" --region eu',
      'deploy --password "[REDACTED]" --region eu',
    ],
    ['curl --api-key PLANTEDflagkey https://api.example', 'curl --api-key [REDACTED] https://api.example'],
    ['mysql -u root -pPLANTEDmysqlpw -h db app', 'mysql -u root -p[REDACTED] -h db app'],
    ['mysqldump -uroot -pPLANTEDmysqlpw app', 'mysqldump -uroot -p[REDACTED] app'],
  ])('removes the value after the flag: %s', (line, expected) => {
    expect(redact(line)).toBe(expected);
  });

  it.each([
    'mysql --port 3306 -h db',
    'mysql -P 3306 -p',
    'deploy --token --verbose',
    'jest --key value --watch',
  ])('leaves a flag that carries no credential: %s', line => {
    expect(redact(line)).toBe(line);
  });
});

describe('credentials in a URL', () => {
  it.each([
    ['fetching https://deploy:PLANTEDpw@git.example/repo.git', 'fetching https://deploy:[REDACTED]@git.example/repo.git'],
    [
      'postgres://app:PLANTEDpa/PLANTEDss@db.internal:5432/app',
      'postgres://app:[REDACTED]@db.internal:5432/app',
    ],
    [
      'postgres://app:PLANTEDp@PLANTEDss@db.internal:5432/app',
      'postgres://app:[REDACTED]@db.internal:5432/app',
    ],
    ['redis://:PLANTEDonlypw@cache:6379/0', 'redis://:[REDACTED]@cache:6379/0'],
    ['https://PLANTEDtokenonly@github.example/org/repo', 'https://[REDACTED]@github.example/org/repo'],
  ])('removes the password and keeps the host: %s', (line, expected) => {
    expect(redact(line)).toBe(expected);
  });

  it.each([
    'http://localhost:4873/@scope/pkg/-/pkg-1.0.0.tgz',
    'https://registry.npmjs.org/@types/node',
    'http://127.0.0.1:8080/users?email=a@b.example',
    'connect ECONNREFUSED 127.0.0.1:5432',
  ])('leaves a URL with no credential: %s', line => {
    expect(redact(line)).toBe(line);
  });
});

describe('credentials known by their own shape', () => {
  const tail = (length: number): string => 'x1Y2'.repeat(Math.ceil(length / 4)).slice(0, length);
  const hex = (seed: string): string => seed.repeat(32).slice(0, 32);

  it.each([
    ['an OpenAI-style key', shaped('sk', '-', 'PLANTED', tail(24))],
    ['a GitHub token', shaped('gh', 'p_', 'PLANTED', tail(30))],
    ['an AWS access key id', shaped('AK', 'IA', 'PLANTEDAWSKEY012')],
    ['a Slack token', shaped('xo', 'xb-', 'PLANTED-', tail(12))],
    ['a Stripe secret key', shaped('sk', '_live_', 'PLANTED', tail(20))],
    ['a Stripe restricted key', shaped('rk', '_test_', 'PLANTED', tail(20))],
    ['a Stripe webhook secret', shaped('wh', 'sec_', 'PLANTED', tail(20))],
    ['a Google API key', shaped('AI', 'za', 'PLANTED', tail(28))],
    ['a GitLab token', shaped('gl', 'pat-', 'PLANTED', tail(16))],
    ['a SendGrid key', shaped('S', 'G.', 'PLANTED', tail(16), '.', 'PLANTED', tail(24))],
    ['an npm token', shaped('np', 'm_', 'PLANTED', tail(30))],
  ])('removes %s wherever it appears', (_label, credential) => {
    for (const line of [
      `using ${credential} for the request`,
      `"${credential}"`,
      `GET /v1/items?key=${credential}&page=2`,
    ]) {
      const redacted = redact(line);
      expect(redacted).not.toContain('PLANTED');
      expect(redacted).toContain('[REDACTED]');
    }
  });

  it('removes a Slack webhook path and a Twilio account pair', () => {
    const webhook = shaped('https://hooks.', 'slack.com/services/', 'T0PLANTED/B0PLANTED/PLANTED', tail(20));
    expect(redact(`POST ${webhook} failed`)).toBe(
      'POST https://hooks.slack.com/services/[REDACTED] failed'
    );

    const pair = shaped('A', 'C', hex('0a1b'), ':', hex('9f8e'));
    const redacted = redact(`curl -u ${pair} https://api.example/Messages`);
    expect(redacted).not.toContain(hex('9f8e'));
    expect(redacted).toContain('https://api.example/Messages');
  });

  it('removes authorization and bearer credentials', () => {
    expect(redact('Authorization: Bearer PLANTED_BEARER_0123456789')).not.toContain('PLANTED');
    expect(redact('curl -H "authorization: Basic PLANTEDBASIC==" https://api.example')).toBe(
      'curl -H "authorization: [REDACTED]" https://api.example'
    );
    expect(redact('sent with bearer PLANTEDbearer1234')).toBe('sent with bearer [REDACTED]');
  });
});

describe('private keys', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAPLANTEDPEMBODYLINEONE',
    'PLANTEDPEMBODYLINETWO==',
    '-----END RSA PRIVATE KEY-----',
  ];

  it('removes a whole key and keeps the lines around it', () => {
    expect(redact(['KEEP: before', ...pem, 'KEEP: after'].join('\n'))).toBe(
      ['KEEP: before', '[REDACTED PRIVATE KEY]', 'KEEP: after'].join('\n')
    );
  });

  it('removes a key with armor headers, such as an encrypted or PGP one', () => {
    const encrypted = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,PLANTEDIV',
      '',
      'PLANTEDENCRYPTEDBODY',
      '-----END RSA PRIVATE KEY-----',
      'Error: KEEP exit 1',
    ].join('\n');
    expect(redact(encrypted)).toBe('[REDACTED PRIVATE KEY]\nError: KEEP exit 1');

    const pgp = [
      'KEEP: importing key',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      'Version: PLANTED v2',
      '',
      'PLANTEDPGPBODYLINE',
      '=PLNT',
      '-----END PGP PRIVATE KEY BLOCK-----',
      'gpg: KEEP key imported',
      'Error: KEEP exit 1',
    ].join('\n');
    expect(redact(pgp)).toBe(
      ['KEEP: importing key', '[REDACTED PRIVATE KEY]', 'gpg: KEEP key imported', 'Error: KEEP exit 1'].join('\n')
    );
  });

  it('removes a key printed on one line with escaped line breaks', () => {
    const escaped = `{"private_key_pem": "${pem.join('\\n')}\\n", "client_email": "KEEP@example.test"}`;
    const redacted = redact(escaped);

    expect(redacted).not.toContain('PLANTED');
    expect(redacted).toContain('KEEP@example.test');
  });

  it('removes a key whose start or end lies outside the text', () => {
    const tailOfBlock = 'PLANTEDBODY==\n-----END OPENSSH PRIVATE KEY-----\nError: exit 1';
    expect(redact(tailOfBlock)).toBe('[REDACTED PRIVATE KEY]\nError: exit 1');
    const headOfBlock = 'Error: exit 1\n-----BEGIN EC PRIVATE KEY-----\nPLANTEDBODY';
    expect(redact(headOfBlock)).toBe('Error: exit 1\n[REDACTED PRIVATE KEY]');
  });

  it('keeps the log around a key whose end never comes', () => {
    const cutShort = [
      'KEEP: writing key',
      '-----BEGIN PRIVATE KEY-----',
      'PLANTEDBODYLINEONEPLANTEDBODYLINEONE',
      'Error: KEEP disk full while writing key',
      'KEEP: cleanup done',
    ].join('\n');
    expect(redact(cutShort)).toBe(
      [
        'KEEP: writing key',
        '[REDACTED PRIVATE KEY]',
        'Error: KEEP disk full while writing key',
        'KEEP: cleanup done',
      ].join('\n')
    );
  });

  it.each([
    'error: expected -----BEGIN RSA PRIVATE KEY----- header in deploy.pem\nKEEP: next line\nKEEP: last line',
    'KEEP: first\nfound trailing data after -----END RSA PRIVATE KEY----- marker\nKEEP: last',
    'KEEP: first\nthe file must start with -----BEGIN PGP PRIVATE KEY BLOCK\nKEEP: last',
  ])('leaves a sentence that only mentions a key header: %s', text => {
    expect(redact(text)).toBe(text);
  });
});

describe('values of secret-named variables', () => {
  it('removes the exact value wherever it is echoed, whatever is around it', () => {
    const text = 'request failed, upstream said: bad credential abcd1234efgh in header';
    expect(redact(text, { UPSTREAM_API_KEY: 'abcd1234efgh' })).toBe(
      'request failed, upstream said: bad credential [REDACTED] in header'
    );
  });

  it('never treats a short or ordinary variable as a value to remove', () => {
    const text = 'retry 1 of 3: true path /srv/app/build failed in production';
    expect(
      redact(text, {
        // Too short to be removed safely: every `1` and `true` in the log would go.
        FEATURE_TOKEN: '1',
        DEBUG_SECRET: 'true',
        // Not secret-named: the working directory and the mode stay readable.
        PWD: '/srv/app/build',
        OLDPWD: '/srv/app/build',
        NODE_ENV: 'production',
        KEY: '/srv/app/build',
      })
    ).toBe(text);
  });
});

describe('the cost of redacting', () => {
  /** The longest redaction of one adversarial input may take. */
  const WORST_CASE_BUDGET_MS = 5000;
  /** Larger than the largest window read at the default evidence cap. */
  const SIZE = 135_000;
  const repeated = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length));

  // Evidence is whatever a failing command printed. Every pattern bounds how far it may
  // run, so none of these shapes costs time quadratic in the text.
  it.each([
    ['dotted text', repeated('a.')],
    ['hyphenated text', repeated('a-')],
    ['scheme separators', repeated('x://')],
    ['half URLs with a user', repeated('http://u:')],
    ['at signs', repeated('http://a:b@')],
    ['one unbroken word', repeated('a')],
    ['secret words run together', repeated('password')],
    ['secret names with no value', repeated('token=')],
    ['secret names on every line', repeated('api_key:\n')],
    ['opening quotes', repeated('password="')],
    ['key headers with no end', repeated('-----BEGIN PRIVATE KEY-----\n')],
    ['key headers on one line', repeated('-----BEGIN PRIVATE KEY-----')],
    ['key ends with no start', repeated('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END PRIVATE KEY-----\n')],
    ['base64 lines', repeated('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n')],
    ['flags', repeated('--token ')],
    ['mysql flags', repeated('mysql -p')],
    ['bearer words', repeated('bearer ')],
    ['token prefixes', repeated('sk-sk_live_AIzaglpat-')],
  ])('stays inside the budget on 135 KB of %s', (_label, text) => {
    const started = performance.now();

    redact(text, { SOME_API_KEY: 'value-that-is-not-there' });

    expect(performance.now() - started).toBeLessThan(WORST_CASE_BUDGET_MS);
  });
});
