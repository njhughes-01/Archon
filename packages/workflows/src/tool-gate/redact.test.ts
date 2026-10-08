import { describe, expect, test } from 'bun:test';
import { isSecretKey, redactInput, redactText } from './redact';

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
        account: { apiKey: 'nested-key-1', user: 'sam' },
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

describe('redactText: a harmless name does not shield the secret after it', () => {
  test.each([
    ['curl https://x.example.com/api?token=query-token-1', 'query-token-1'],
    ['note: API_KEY=after-note-2', 'after-note-2'],
    ['x=y:API_KEY=after-pair-3', 'after-pair-3'],
    ['A=1\nAPI_TOKEN=second-line-4', 'second-line-4'],
    ['mode=fast; Pwd=short-name-5', 'short-name-5'],
    ['SMTP_PASS=pass-suffix-6', 'pass-suffix-6'],
    ['REGISTRY_AUTH=auth-suffix-7', 'auth-suffix-7'],
    ['SECRET_KEY_BASE=word-inside-8', 'word-inside-8'],
  ])('%s', (text, secret) => {
    expect(redact(text)).not.toContain(secret);
  });
});

describe('redactText: command-line credentials', () => {
  test.each([
    ['curl -u deploy:user-pass-1 https://api.example.com', 'user-pass-1'],
    ['curl --user deploy:user-pass-2 https://api.example.com', 'user-pass-2'],
    ['mysql -h db -uroot -pattached-3 app', 'attached-3'],
    ['sshpass -p sshpass-4 ssh host', 'sshpass-4'],
    ['docker login -u me -p docker-5 registry.example.com', 'docker-5'],
    ['redis-cli -a redis-6 ping', 'redis-6'],
    ['gpg --passphrase phrase-7 -d file', 'phrase-7'],
    ['git clone https://user:p@ss/w0rd-8@git.example.com/r.git', 'w0rd-8'],
    ['git clone https://user:p@ss/w0rd-8@git.example.com/r.git', 'p@ss'],
  ])('%s', (text, secret) => {
    expect(redact(text)).not.toContain(secret);
  });

  test('a flag that only looks like a password flag is left alone', () => {
    expect(redact('mkdir -p build/out')).toBe('mkdir -p build/out');
    expect(redact('git push -u origin feature/login')).toBe('git push -u origin feature/login');
    expect(redact('sort -u names.txt')).toBe('sort -u names.txt');
  });
});

describe('redactText: more token shapes', () => {
  test('masks vendor tokens with no name next to them', () => {
    for (const token of [
      `sk_live_${'a1B2'.repeat(6)}`,
      `AIza${'a1B2c'.repeat(7)}`,
      `glpat-${'a1B2'.repeat(5)}`,
      `npm_${'a1B2'.repeat(9)}`,
      `hf_${'a1B2'.repeat(8)}`,
      `wJalrXUtnFEMI/K7MDENG/bPxRfiCY${'a1B2c3D4e5'}`,
    ]) {
      expect(redact(`use ${token} now`)).not.toContain(token);
    }
  });

  test('leaves a commit id and a word that merely contains a prefix alone', () => {
    const sha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    expect(redact(`git show ${sha}`)).toContain(sha);
    const word = 'risk-assessment-document-final-version';
    expect(redact(word)).toBe(word);
  });
});

describe('redactText: the scan limit', () => {
  test('a token cut by the scan limit leaves no prefix behind', () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    // A huge PEM block collapses to a few characters, pulling the cut point into the cap.
    const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(63_930)}\n-----END PRIVATE KEY-----`;
    const text = `${pem} ${'x'.repeat(64_000 - pem.length - 8)}${token}`;
    const out = redactText(text, { credentialValues: [], cap: 2_000 });
    expect(out).not.toContain('ghp_');
  });

  test('stays fast on text built to make the rules backtrack', () => {
    const started = performance.now();
    for (const unit of ['a://a:', 'mysql ', 'x=', 'note: ', '-u a:']) {
      redactText(unit.repeat(20_000), { credentialValues: [], cap: 200 });
    }
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe('redactInput: structure-aware masking', () => {
  test('a later line in a multi-line string is still masked', () => {
    const out = redactInput({ env: 'A=1\nAPI_TOKEN=multi-line-1\nB=2' }, WIDE);
    expect(out).not.toContain('multi-line-1');
  });

  test('a header on a later line is still masked', () => {
    const out = redactInput({ raw: 'GET / HTTP/1.1\nAuthorization: Basic later-header-2x' }, WIDE);
    expect(out).not.toContain('later-header-2x');
    const cookie = redactInput({ raw: 'Host: x\ncookie: session=later-cookie-3' }, WIDE);
    expect(cookie).not.toContain('later-cookie-3');
  });

  test('JSON carried inside a string is masked before it is escaped', () => {
    const out = redactInput({ body: '{"password":"embedded-json-4","user":"sam"}' }, WIDE);
    expect(out).not.toContain('embedded-json-4');
    expect(out).toContain('sam');
  });

  test('a name/value pair is masked by its name', () => {
    const out = redactInput(
      {
        env: [
          { name: 'DB_PASSWORD', value: 'pair-value-5' },
          { name: 'PORT', value: '8080' },
        ],
      },
      WIDE
    );
    expect(out).not.toContain('pair-value-5');
    expect(out).toContain('8080');
  });
});

describe('isSecretKey', () => {
  test.each([
    ...['API_KEY', 'apiKey', 'x-api-key', 'GITHUB_TOKEN', 'authToken', 'DB_PASSWORD', 'Pwd'],
    ...['SMTP_PASS', 'REGISTRY_AUTH', 'SECRET_KEY_BASE', 'PRIVATE_KEY_PEM', 'accessKeyId'],
    ...['client_secret', 'DATABASE_URL', 'Authorization', 'credentials', 'passphrase'],
  ])('%s names a secret', name => {
    expect(isSecretKey(name)).toBe(true);
  });

  test.each([
    ...['MAX_TOKENS', 'TOKENIZERS_PARALLELISM', 'KEYBOARD', 'monkey', 'NODE_ENV', 'PATH'],
    ...['author', 'OAUTH_CALLBACK_URL', 'bypass_cache', 'passenger_count', 'PORT'],
  ])('%s does not', name => {
    expect(isSecretKey(name)).toBe(false);
  });
});
