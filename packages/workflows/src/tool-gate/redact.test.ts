import { describe, expect, test } from 'bun:test';
import { redactInput, redactText } from './redact';

const WIDE = { credentialValues: [], cap: 10_000 };

function redact(text: string): string {
  return redactText(text, WIDE);
}

describe('redactText: exact credential values', () => {
  test('masks an injected value wherever it appears, with or without its key', () => {
    const out = redactText('echo live-credential-7781 && X=live-credential-7781', {
      credentialValues: ['live-credential-7781'],
      cap: 10_000,
    });
    expect(out).not.toContain('live-credential-7781');
    expect(out).toContain('[REDACTED]');
  });

  test('masks the longer value first so a shorter one cannot leave its tail', () => {
    const out = redactText('use abcdef-long-value here', {
      credentialValues: ['abcdef', 'abcdef-long-value'],
      cap: 10_000,
    });
    expect(out).toBe('use [REDACTED] here');
  });

  test('ignores an empty value instead of masking between every character', () => {
    expect(redactText('git status', { credentialValues: [''], cap: 10_000 })).toBe('git status');
  });
});

describe('redactText: secret-shaped assignments', () => {
  test.each([
    ['API_KEY=abc123 curl x', 'abc123'],
    ['export GITHUB_TOKEN="ghx one two"', 'ghx one two'],
    ["DB_PASSWORD='p w' psql", 'p w'],
    ['db_password=lowercase1', 'lowercase1'],
    ['AWS_SECRET_ACCESS_KEY=AbCdEf012345', 'AbCdEf012345'],
    ['DATABASE_URL=postgres://db.internal/app', 'db.internal'],
    ['password: hunter2zz', 'hunter2zz'],
    ['{"apiKey": "json-value-9"}', 'json-value-9'],
    ['mysql --password=flagvalue1', 'flagvalue1'],
    ['mysql --password flagvalue2', 'flagvalue2'],
    ['tool --api-key "spaced value 3"', 'spaced value 3'],
  ])('%s', (text, secret) => {
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  test.each(['NODE_ENV=test bun run build', 'KEYBOARD=us', 'git log --format=%H', 'a=1 b=2'])(
    'leaves %s alone',
    text => {
      expect(redact(text)).toBe(text);
    }
  );
});

describe('redactText: headers, bearer tokens, URLs and keys', () => {
  test('masks an Authorization header value', () => {
    const out = redact('curl -H "Authorization: Bearer tok-en.value_123" https://api.example.com');
    expect(out).not.toContain('tok-en.value_123');
    expect(out).toContain('https://api.example.com');
  });

  test('masks other credential headers', () => {
    expect(redact("curl -H 'X-Api-Key: k-998877' u")).not.toContain('k-998877');
    expect(redact('curl -H "Cookie: session=s-112233" u')).not.toContain('s-112233');
  });

  test('masks a bare bearer token', () => {
    expect(redact('token is bearer abcdefgh12345678')).not.toContain('abcdefgh12345678');
  });

  test('masks URL userinfo and keeps the host', () => {
    const out = redact('git clone https://deploy:s3cr3t-pw@git.example.com/acme/app.git');
    expect(out).not.toContain('s3cr3t-pw');
    expect(out).not.toContain('deploy:');
    expect(out).toContain('git.example.com/acme/app.git');
  });

  test('masks a PEM block, terminated or cut off', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nhkiG9w0BAQEF\n-----END PRIVATE KEY-----';
    const whole = redact(`cat <<EOF > k\n${pem}\nEOF`);
    expect(whole).not.toContain('MIIEvQIBADANBgkq');
    expect(whole).toContain('EOF');
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkq')).not.toContain('MIIEvQ');
  });

  test('masks well-known token shapes with no key next to them', () => {
    for (const token of [
      `ghp_${'a1B2'.repeat(9)}`,
      `github_pat_${'a1B2_'.repeat(6)}`,
      `sk-${'x9'.repeat(15)}`,
      `xoxb-${'1234567890-'.repeat(2)}abc`,
      'AKIAABCDEFGHIJKLMNOP',
    ]) {
      expect(redact(`echo ${token} | tool`)).not.toContain(token);
    }
  });
});

describe('redactText: truncation', () => {
  test('cuts to the cap and says how much is missing', () => {
    const out = redactText('x'.repeat(500), { credentialValues: [], cap: 100 });
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('400');
    expect(out.length).toBeLessThan(160);
  });

  test('redacts before cutting, so a secret across the cap leaves no prefix', () => {
    const secret = 'straddling-secret-value-0123456789';
    const text = `${'x'.repeat(90)} ${secret}`;
    const out = redactText(text, { credentialValues: [secret], cap: 100 });
    expect(out).not.toContain('straddling');
  });

  test('stays fast on a huge single word', () => {
    const started = performance.now();
    redactText('a'.repeat(400_000), { credentialValues: [], cap: 200 });
    redactText('-'.repeat(400_000), { credentialValues: [], cap: 200 });
    redactText('a.'.repeat(200_000), { credentialValues: [], cap: 200 });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('redactInput', () => {
  test('masks values under secret-shaped keys at any depth and keeps the rest', () => {
    const out = redactInput(
      {
        title: 'Rotate keys',
        auth: { apiKey: 'nested-key-1', user: 'sam' },
        headers: [{ Authorization: 'Bearer header-token-22334455' }],
        password: 'top-level-pw',
      },
      WIDE
    );
    expect(out).toContain('Rotate keys');
    expect(out).toContain('sam');
    for (const secret of ['nested-key-1', 'header-token-22334455', 'top-level-pw']) {
      expect(out).not.toContain(secret);
    }
  });

  test('applies the text rules to string values too', () => {
    const out = redactInput({ body: 'curl https://u:pw-in-url@host/x' }, WIDE);
    expect(out).not.toContain('pw-in-url');
  });

  test('survives input JSON cannot serialise', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(() => redactInput(cyclic, WIDE)).not.toThrow();
    expect(() => redactInput({ big: 10n }, WIDE)).not.toThrow();
  });
});
