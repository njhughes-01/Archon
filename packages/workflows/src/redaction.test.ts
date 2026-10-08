import { describe, expect, it } from 'bun:test';
import {
  collectCredentialValues,
  maskSecretShapes,
  redactCredentialValues,
  redactForClassifier,
  REDACTED,
} from './redaction';

describe('collectCredentialValues', () => {
  it('collects secret-named, explicitly protected and file-delivered values, longest first', () => {
    const values = collectCredentialValues(
      { GH_TOKEN: 'short', DATABASE_URL: 'postgres://long-value', HOME: '/home/x', CUSTOM: 'kept' },
      ['CUSTOM'],
      ['file-delivered-credential']
    );
    expect(values).toEqual(['file-delivered-credential', 'postgres://long-value', 'short', 'kept']);
  });

  it('ignores empty values and repeats', () => {
    expect(collectCredentialValues({ A_KEY: '', B_KEY: 'same', C_KEY: 'same' }, [], [''])).toEqual([
      'same',
    ]);
  });
});

describe('redactCredentialValues', () => {
  it('replaces every occurrence of each exact value', () => {
    expect(redactCredentialValues('a tok-1 b tok-1 c', ['tok-1'])).toBe(
      `a ${REDACTED} b ${REDACTED} c`
    );
  });
});

describe('maskSecretShapes', () => {
  it('masks the value of a secret-shaped KEY=value and keeps the key', () => {
    const masked = maskSecretShapes('run with STRIPE_SECRET_KEY=sk_live_abc123 and DEBUG=1');
    expect(masked).toContain(`STRIPE_SECRET_KEY=${REDACTED}`);
    expect(masked).not.toContain('sk_live_abc123');
    expect(masked).toContain('DEBUG=1');
  });

  it('masks quoted and colon-separated secret values', () => {
    const masked = maskSecretShapes('password: "hunter two" and api_key=\'abc def\'');
    expect(masked).not.toContain('hunter two');
    expect(masked).not.toContain('abc def');
  });

  it('masks bearer and basic credentials and a whole Authorization header value', () => {
    const masked = maskSecretShapes(
      'curl -H "Authorization: Token abc.def.ghi" then Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'
    );
    expect(masked).not.toContain('abc.def.ghi');
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('masks URL userinfo and keeps the host', () => {
    const masked = maskSecretShapes('clone https://nathan:p4ss@git.example.com/repo.git');
    expect(masked).toBe(`clone https://${REDACTED}@git.example.com/repo.git`);
  });

  it('masks a PEM block, terminated or cut off', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    expect(maskSecretShapes(`key:\n${pem}\ndone`)).toBe(`key:\n${REDACTED}\ndone`);
    expect(maskSecretShapes('-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBg')).toBe(REDACTED);
  });

  it('masks well-known token prefixes that carry no key name', () => {
    const masked = maskSecretShapes(
      'use ghp_0123456789abcdefghijABCDEFGHIJ0123456789 or AKIAIOSFODNN7EXAMPLE'
    );
    expect(masked).not.toContain('ghp_0123456789');
    expect(masked).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('leaves ordinary prose and code alone', () => {
    const text =
      'Rename the key column to id and keep the author field. See https://example.com/a.';
    expect(maskSecretShapes(text)).toBe(text);
  });
});

describe('maskSecretShapes: one row per shape', () => {
  const SECRET = 'S3cr3tValue9';
  const JWT_VALUE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
  it.each([
    ['a JSON double-quoted key', `{"password": "${SECRET}", "user": "bob"}`],
    ['a single-quoted key', `{'api_key': '${SECRET}'}`],
    ['a JSON key holding a JWT', `{"token":"${JWT_VALUE}"}`],
    ['a camel-case cloud key', `"SecretAccessKey": "${SECRET}"`],
    ['a bare KEY=', `KEY=${SECRET}`],
    ['a Stripe live key', `charge with sk_live_${SECRET}abcdef`],
    ['a Stripe test key', `rk_test_${SECRET}abcdef`],
    ['a bare JWT', `the header was ${JWT_VALUE} yesterday`],
    ['a value holding a semicolon', `password=abc;${SECRET}`],
    ['a value holding a comma', `password=abc,${SECRET}`],
    ['an unquoted value with spaces', `password: correct horse ${SECRET}`],
    ['a spaced assignment', `db_password = hunter ${SECRET}`],
    ['a long CLI flag', `mysql --password ${SECRET} -h db`],
    ['a long CLI flag with =', `tool --api-token=${SECRET}`],
    ['an attached short password flag', `mysql -uroot -p${SECRET} app`],
    ['a Cookie header', `Cookie: session=${SECRET}; theme=dark`],
    ['a session id assignment', `sessionid=${SECRET}`],
    ['a passphrase', `passphrase: ${SECRET}`],
    ['a key query parameter', `https://api.example.com/v1/items?key=${SECRET}&page=2`],
    ['a signed-URL signature', `https://bucket.example.com/file?X-Amz-Signature=${SECRET}`],
    ['a Slack webhook URL', `https://hooks.slack.com/services/T00000000/B00000000/${SECRET}`],
    ['a Telegram bot URL', `https://api.telegram.org/bot123456:${SECRET}/sendMessage`],
    ['a URL password holding a slash', `postgres://app:pa/${SECRET}@db.internal/app`],
    ['a URL password holding an at sign', `https://bot:p@${SECRET}@git.example.com/x`],
  ])('masks %s', (_label, text) => {
    const masked = maskSecretShapes(text);
    expect(masked).not.toContain(SECRET);
    expect(masked).not.toContain(JWT_VALUE);
    expect(masked).toContain(REDACTED);
  });

  it.each([
    ['a sentence about keys', 'Rotate the session signing key and keep the monkey patch.'],
    ['a plain URL', 'See https://example.com/docs/page for the token bucket design.'],
    ['an ordinary assignment', 'retries=3 and mode: fast'],
  ])('leaves %s alone', (_label, text) => {
    expect(maskSecretShapes(text)).toBe(text);
  });
});

describe('redaction cost', () => {
  // The masks run synchronously on every routed node, before any request timeout starts.
  it.each([
    ['65K of dotted name characters', 'a.b-'.repeat(16_384)],
    ['400K of base64url', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo_-'.repeat(10_811)],
    ['200K of words that look like names', 'api.key- '.repeat(22_222)],
  ])('stays under 50 ms on %s', (_label, text) => {
    const started = performance.now();
    const out = redactForClassifier(text, [], 1200);
    expect(performance.now() - started).toBeLessThan(50);
    expect(out.length).toBeLessThan(1300);
  });

  it('masks over a bounded window, whatever the input size', () => {
    const started = performance.now();
    maskSecretShapes('a.b-'.repeat(16_384));
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('drops a half-seen word at the edge of the window instead of sending half a secret', () => {
    // Masking the key block shrinks the text by more than the lookahead, which pulls the
    // edge of the window into what is sent. The token there was cut in half by the window,
    // so no shape can recognise it any more.
    const keyBlock = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(8250)}\n-----END PRIVATE KEY-----`;
    const token = `eyJ${'a'.repeat(60)}.eyJ${'b'.repeat(60)}.${'c'.repeat(60)}`;
    const out = redactForClassifier(`${keyBlock} note ${token} tail ${'x '.repeat(200)}`, [], 200);
    expect(out.startsWith(`${REDACTED} note`)).toBe(true);
    expect(out).not.toContain('eyJ');
  });
});

describe('redactForClassifier', () => {
  it('removes exact credentials first, then shapes, then truncates with a marker', () => {
    const text = `token is live-credential-value. ${'x'.repeat(50)}`;
    const out = redactForClassifier(text, ['live-credential-value'], 40);
    expect(out).not.toContain('live-credential-value');
    expect(out.startsWith(`token is ${REDACTED}.`)).toBe(true);
    expect(out).toMatch(/\[truncated \d+ chars\]$/);
  });

  it('truncates after masking, so a secret cut by the cap cannot survive as a fragment', () => {
    const secret = 'S'.repeat(60);
    const out = redactForClassifier(`API_TOKEN=${secret} tail`, [], 30);
    expect(out).not.toContain('SSSS');
  });

  it('returns short text unchanged apart from masking', () => {
    expect(redactForClassifier('plain task', [], 100)).toBe('plain task');
  });
});
