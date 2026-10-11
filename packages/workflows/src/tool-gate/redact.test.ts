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
    for (const unit of [
      ...['a://a:', 'mysql ', 'x=', 'note: ', '-u a:'],
      // The prefix of every later rule, each a start the rule has to give up on.
      ...[String.raw`password:\"`, String.raw`password:\"x `, String.raw`{\"a\":`, '\\', '\\"'],
      ...[String.raw`password:\\\'`, 'password:"', 'pgpassword=', 'authtoken '],
      ...['gh secret set ', 'gh secret set x --body', '--body ', ' -b '],
      ...['--proxy-user a:', '-U a:', 'az ', 'az -p', 'zip ', 'unzip -P', '7z ', '7z -p '],
      ...['ldapsearch ', 'ldapsearch -w', 'ssh-keygen ', 'ssh-keygen -N', ' -N ', ' -P ', ' -w '],
    ]) {
      redactText(unit.repeat(20_000), { credentialValues: [], cap: 200 });
    }
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test('stays fast on a huge argument list', () => {
    const started = performance.now();
    for (const unit of [['-p'], ['--token'], ['az', '-p'], ['-u', 'a:'], ['--body=', '-b']]) {
      redactInput(
        { args: Array.from({ length: 20_000 }, (_, index) => unit[index % unit.length]) },
        { credentialValues: [], cap: 200 }
      );
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

  test.each([
    ...['PGPASSWORD', 'pgpassword', 'authtoken', 'MYSECRET', 'mysecret', 'DBPASSWORD'],
    ...['NPM_AUTHTOKEN', 'dbpasswd', 'gcpcredentials', 'myapikey', 'PGPASSWORD_FILE'],
    ...['SSHKEY', 'sshkey', 'STRIPEKEY', 'DEPLOY_SIGNINGKEY', 'licensekey'],
  ])('item 2: %s runs its words together and still names a secret', name => {
    expect(isSecretKey(name)).toBe(true);
  });

  test.each([
    ...['turkey', 'hockey', 'whiskey', 'donkey', 'jockey', 'hotkey', 'HOTKEY', 'MONKEY'],
    ...['tokens', 'PASSWORDLESS_LOGIN', 'secretary', 'SSHKEY_COUNT', 'compass', 'OAUTH'],
  ])('item 2: %s only resembles one', name => {
    expect(isSecretKey(name)).toBe(false);
  });
});

describe('item 1: JSON with backslash-escaped quotes', () => {
  test.each([
    [String.raw`curl -d "{\"password\":\"escaped-json-1\"}" https://api.example.com`, 'json-1'],
    [String.raw`curl -d "{\"user\":\"sam\",\"apiKey\": \"escaped-json-2\"}" u`, 'json-2'],
    [String.raw`curl -d "{\"password\":\"two words-3\"}" u`, 'words-3'],
    [String.raw`curl -d "{\"password\":\"two words-3\"}" u`, 'two'],
    [String.raw`curl -d "{\"password\":\"inner\\\"quote-4\"}" u`, 'quote-4'],
    [String.raw`curl -d "{\"retries\":0,\"token\":escaped5bare}" u`, 'escaped5bare'],
    [String.raw`echo "{\\\"password\\\":\\\"twice-escaped-6\\\"}"`, 'escaped-6'],
    [String.raw`python -c 'print({\'password\': \'single-escaped-7\'})'`, 'escaped-7'],
    [String.raw`{\"password\":\"cut-off-8`, 'cut-off-8'],
    ['{"password": "cut-off-9', 'cut-off-9'],
  ])('%s', (text, secret) => {
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  test('masks only the value and keeps what follows it', () => {
    const out = redact(
      String.raw`curl -d "{\"password\":\"escaped-json-10\",\"user\":\"sam\"}" https://api.example.com`
    );
    expect(out).toBe(
      String.raw`curl -d "{\"password\":[REDACTED],\"user\":\"sam\"}" https://api.example.com`
    );
  });

  test('an escaped quote left open ends where the argument around it ends', () => {
    const out = redact(
      String.raw`echo "{\"password\":\"cut-off-12" && curl -d "{\"user\":\"sam\"}" https://api.example.com`
    );
    expect(out).not.toContain('cut-off-12');
    expect(out).toContain(String.raw`&& curl -d "{\"user\":\"sam\"}" https://api.example.com`);
  });

  test('a harmless escaped key is left alone', () => {
    const text = String.raw`curl -d "{\"user\":\"sam\",\"retries\":3}" https://api.example.com`;
    expect(redact(text)).toBe(text);
  });

  test('redactInput masks it inside a command string', () => {
    const out = redactInput(
      { command: String.raw`curl -d "{\"password\":\"escaped-json-11\"}" https://api.example.com` },
      WIDE
    );
    expect(out).not.toContain('escaped-json-11');
    expect(out).toContain('api.example.com');
  });
});

describe('item 2: secret names that run their words together', () => {
  test.each([
    ['PGPASSWORD=run-together-1 psql -h db app', 'run-together-1'],
    ['pgpassword=run-together-2', 'run-together-2'],
    ['authtoken: run-together-3', 'run-together-3'],
    ['MYSECRET=run-together-4 ./deploy', 'run-together-4'],
    ['DBPASSWORD="run together-5"', 'together-5'],
    ['SSHKEY=run-together-6', 'run-together-6'],
    ['{"authtoken": "run-together-7"}', 'run-together-7'],
  ])('%s', (text, secret) => {
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  test.each(['monkey=banana', 'hotkey: ctrl+k', 'MAX_TOKENS=4096', 'TOKENIZERS_PARALLELISM=false'])(
    'leaves %s alone',
    text => {
      expect(redact(text)).toBe(text);
    }
  );
});

describe('item 3: the body of gh secret set', () => {
  test.each([
    ['gh secret set DEPLOY --body gh-body-1', 'gh-body-1'],
    ['gh secret set DEPLOY --body "gh body-2"', 'body-2'],
    ['gh secret set DEPLOY --body=gh-body-3', 'gh-body-3'],
    ['gh secret set DEPLOY -b gh-body-4 --repo acme/app', 'gh-body-4'],
    ['gh secret set DEPLOY -bgh-body-5', 'gh-body-5'],
    ['gh secret set DEPLOY --org acme --visibility all --body gh-body-6', 'gh-body-6'],
    ['gh  secret   set DEPLOY -b"gh body-7"', 'body-7'],
  ])('%s', (text, secret) => {
    expect(redact(text)).not.toContain(secret);
  });

  test('keeps the secret name and the flags after the body', () => {
    expect(redact('gh secret set DEPLOY -b gh-body-8 --repo acme/app')).toBe(
      'gh secret set DEPLOY -b [REDACTED] --repo acme/app'
    );
  });

  test.each([
    'gh variable set REGION --body us-east-1',
    'gh variable set REGION -b us-east-1',
    'gh pr create --title fix --body "plain text"',
    'gh issue comment 12 -b "plain text"',
    'gh secret list; gh pr comment 3 --body done',
  ])('leaves %s alone', text => {
    expect(redact(text)).toBe(text);
  });
});

describe('item 4: proxy credentials', () => {
  test.each([
    ['curl --proxy-user proxy:proxy-pass-1 https://api.example.com', 'proxy-pass-1'],
    ['curl --proxy-user=proxy:proxy-pass-2 https://api.example.com', 'proxy-pass-2'],
    ['curl -U proxy:proxy-pass-3 -x http://proxy.internal:8080 u', 'proxy-pass-3'],
  ])('%s', (text, secret) => {
    expect(redact(text)).not.toContain(secret);
  });

  test('masks the part after the colon, as -u does', () => {
    expect(redact('curl --proxy-user proxy:proxy-pass-4 https://api.example.com')).toBe(
      'curl --proxy-user proxy:[REDACTED] https://api.example.com'
    );
  });

  test('a -U flag without a colon is left alone', () => {
    expect(redact('psql -U postgres -h db app')).toBe('psql -U postgres -h db app');
    expect(redact('pip install -U requests')).toBe('pip install -U requests');
  });
});

describe('item 5: password flags that belong to one command', () => {
  test.each([
    ['az login --service-principal -u app-id -p az-pass-1 --tenant t', 'az-pass-1'],
    ['az login -u me --password az-pass-2', 'az-pass-2'],
    ['az acr login -n registry -p "az pass-3"', 'pass-3'],
    ['/usr/bin/az login -u me -p=az-pass-4', 'az-pass-4'],
    ['zip -P zip-pass-5 -r out.zip dir', 'zip-pass-5'],
    ['zip -r -P "zip pass-6" out.zip dir', 'pass-6'],
    ['unzip -P zip-pass-7 out.zip', 'zip-pass-7'],
    ['7z a -p7z-pass-8 out.7z dir', '7z-pass-8'],
    ['7za x out.7z -p7z-pass-9 -o/tmp/out', '7z-pass-9'],
    ['7z a -p"7z pass-10" out.7z dir', 'pass-10'],
    ['ldapsearch -x -D cn=admin,dc=example -w ldap-pass-11 -b dc=example', 'ldap-pass-11'],
    ['ldapmodify -D cn=admin -w ldap-pass-12 -f change.ldif', 'ldap-pass-12'],
    ['ssh-keygen -t ed25519 -N keygen-pass-13 -f id', 'keygen-pass-13'],
    ['ssh-keygen -p -P keygen-old-14 -N keygen-new-15 -f id', 'keygen-old-14'],
    ['ssh-keygen -p -P keygen-old-14 -N keygen-new-15 -f id', 'keygen-new-15'],
    ['ssh-keygen -p -N keygen-new-16 -P keygen-old-17 -f id', 'keygen-new-16'],
    ['ssh-keygen -p -N keygen-new-16 -P keygen-old-17 -f id', 'keygen-old-17'],
    ["ssh-keygen -N 'keygen pass-18' -f id", 'pass-18'],
  ])('%s', (text, secret) => {
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  test('keeps the arguments around the password', () => {
    expect(redact('az login -u app-id -p az-pass-19 --tenant t')).toBe(
      'az login -u app-id -p [REDACTED] --tenant t'
    );
    expect(redact('zip -P zip-pass-20 -r out.zip dir')).toBe('zip -P [REDACTED] -r out.zip dir');
    expect(redact('7z a -p7z-pass-21 out.7z dir')).toBe('7z a -p[REDACTED] out.7z dir');
    expect(redact('ldapsearch -w ldap-pass-22 -b dc=example')).toBe(
      'ldapsearch -w [REDACTED] -b dc=example'
    );
    expect(redact('ssh-keygen -N keygen-pass-23 -f id')).toBe('ssh-keygen -N [REDACTED] -f id');
  });

  test.each([
    'ssh -p 22 host',
    'wget -P downloads https://example.com/a',
    'wget https://example.com/out.zip -P downloads',
    'zip -r out.zip dir && wget -P downloads https://example.com/a',
    'zip -r out.zip dir; cp -P a b',
    'az group list | xargs mkdir -p out',
    'gzip -9 file\nmkdir -p build/out',
    'az group list\nmkdir -p build/out',
    'azcopy copy src dst -p 8',
    'grep -w word file',
    'tar -N 2024-01-01 -cf out.tar dir',
    'ssh-keygen -l -f id.pub',
    '7z a -p out.7z dir',
    'scp -P 2222 file host:',
    'ldapsearch -W -x -b dc=example',
  ])('leaves %s alone', text => {
    expect(redact(text)).toBe(text);
  });
});

describe('item 6: name/value pairs in another letter case', () => {
  test('the pair is found whatever the case of its field names', () => {
    const out = redactInput(
      {
        env: [
          { Name: 'DB_PASSWORD', Value: 'pair-case-1' },
          { KEY: 'API_TOKEN', VALUE: 'pair-case-2' },
          { Key: 'SMTP_PASS', value: 'pair-case-3' },
          { Name: 'PORT', Value: '8080' },
          { KEY: 'REGION', VALUE: 'us-east-1' },
        ],
      },
      WIDE
    );
    for (const secret of ['pair-case-1', 'pair-case-2', 'pair-case-3']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('DB_PASSWORD');
    expect(out).toContain('8080');
    expect(out).toContain('us-east-1');
  });
});

describe('item 7: argument lists', () => {
  function redactArgs(args: unknown[]): string {
    return redactInput({ args }, WIDE);
  }

  test.each<[unknown[], string]>([
    [['--token', 'array-value-1', '--verbose'], 'array-value-1'],
    [['tool', '--api-key', 'array value-2'], 'value-2'],
    [['tool', '--api-key', 'array value-2'], 'array'],
    [['az', 'login', '-u', 'app-id', '-p', 'array-value-3'], 'array-value-3'],
    [['docker', 'login', '-p', 'array-value-4', 'registry.example.com'], 'array-value-4'],
    [['sshpass', '-p', 'array-value-5', 'ssh', '-p', '22', 'host'], 'array-value-5'],
    [['gh', 'secret', 'set', 'DEPLOY', '--body', 'array value-6'], 'value-6'],
    [['sudo', '-E', 'gh', 'secret', 'set', 'DEPLOY', '--body', 'array-value-16'], 'array-value-16'],
    [
      ['az', 'acr', 'login', '-n', 'registry', '-u', 'me', '-g', 'rg', '-p', 'array-value-17'],
      '17',
    ],
    [['curl', '-u', 'deploy:array-value-7', 'https://api.example.com'], 'array-value-7'],
    [['curl', '--proxy-user', 'proxy:array value-8'], 'value-8'],
    [['mysql', '-uroot', '-parray-value-9', 'app'], 'array-value-9'],
    [['7z', 'a', '-parray value-10', 'out.7z'], 'value-10'],
    [['tool', '--password=array value-11'], 'value-11'],
    [['zip', '-P', 'array-value-12', 'out.zip'], 'array-value-12'],
    [['ssh-keygen', '-N', 'array-value-13', '-P', 'array-value-14'], 'array-value-13'],
    [['ssh-keygen', '-N', 'array-value-13', '-P', 'array-value-14'], 'array-value-14'],
    [['ldapsearch', '-x', '-w', 'array-value-15'], 'array-value-15'],
    [['tool', '--pin-token', 15_161_718], '15161718'],
    [[['nested', '--secret', 'array-value-19']], 'array-value-19'],
  ])('%j', (args, secret) => {
    const out = redactArgs(args);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  test('keeps the arguments around the secret', () => {
    expect(redactArgs(['--token', 'array-value-20', '--verbose'])).toBe(
      '{"args":["--token","[REDACTED]","--verbose"]}'
    );
    expect(redactArgs(['sshpass', '-p', 'array-value-21', 'ssh', '-p', '22', 'host'])).toBe(
      '{"args":["sshpass","-p","[REDACTED]","ssh","-p","22","host"]}'
    );
    expect(redactArgs(['curl', '-u', 'deploy:array-value-22', 'https://api.example.com'])).toBe(
      '{"args":["curl","-u","deploy:[REDACTED]","https://api.example.com"]}'
    );
    expect(redactArgs(['mysql', '-uroot', '-parray-value-23', 'app'])).toBe(
      '{"args":["mysql","-uroot","-p[REDACTED]","app"]}'
    );
  });

  test.each<[unknown[]]>([
    [['mkdir', '-p', 'build/out']],
    [['ssh', '-p', '22', 'host']],
    [['wget', '-P', 'downloads', 'https://example.com/a']],
    [['git', 'push', '-u', 'origin', 'feature/login']],
    [['grep', '-w', 'word', 'file']],
    [['tool', '--verbose', 'plain-word']],
    [['gh', 'variable', 'set', 'REGION', '--body', 'us-east-1']],
    [['- first line', 'second line']],
    [['tool', '--port', 8080]],
  ])('leaves %j alone', args => {
    expect(redactArgs(args)).toBe(JSON.stringify({ args }));
  });

  test('a flag after a secret flag is kept, as the text rule keeps it', () => {
    expect(redact('tool --no-auth --force')).toBe('tool --no-auth --force');
    expect(redactArgs(['tool', '--no-auth', '--force'])).toBe(
      '{"args":["tool","--no-auth","--force"]}'
    );
  });
});

const FAKE = 's3cr3t-VALUE-123';

/** [group, command, text that must stay readable after the value is gone]. */
const LEAK_SHAPES: ReadonlyArray<readonly [string, string, string]> = [
  // 1. JSON with backslash-escaped quotes inside a double-quoted body
  [
    '1 json',
    String.raw`curl -d "{\"password\":\"${FAKE}\"}" https://api.example.com`,
    'api.example.com',
  ],
  [
    '1 json',
    String.raw`curl -d "{\"token\":\"${FAKE}\"}" https://api.example.com`,
    'api.example.com',
  ],
  [
    '1 json',
    String.raw`curl -d "{\"secret\":\"${FAKE}\"}" https://api.example.com`,
    'api.example.com',
  ],
  [
    '1 json',
    String.raw`curl -d "{\"api_key\":\"${FAKE}\"}" https://api.example.com`,
    'api.example.com',
  ],
  [
    '1 json',
    String.raw`curl -d "{\"authorization\":\"${FAKE}\"}" https://api.example.com`,
    'api.example.com',
  ],
  ['1 json', String.raw`curl -d "{\"user\":\"sam\",\"password\":\"${FAKE}\"}" https://x.io`, 'sam'],
  [
    '1 json',
    String.raw`curl -d "{\"password\": \"${FAKE}\", \"user\": \"sam\"}" https://x.io`,
    'sam',
  ],
  ['1 json', String.raw`curl -X POST -d "{\"Password\":\"${FAKE}\"}" https://x.io`, 'POST'],
  // 2. single-word compound env names
  ['2 env', `PGPASSWORD=${FAKE} psql -h db app`, 'psql -h db app'],
  ['2 env', `MYSQL_PWD=${FAKE} mysql -h db app`, 'mysql -h db app'],
  ['2 env', `authtoken=${FAKE} ./run`, './run'],
  ['2 env', `pgpassword=${FAKE} psql app`, 'psql app'],
  ['2 env', `AUTHTOKEN=${FAKE} ./run`, './run'],
  ['2 env', `APIKEY=${FAKE} ./run`, './run'],
  ['2 env', `ACCESSKEY=${FAKE} ./run`, './run'],
  ['2 env', `secretkey=${FAKE} ./run`, './run'],
  ['2 env', `export PGPASSWORD="${FAKE}" && psql app`, 'psql app'],
  // 3. gh secret set body
  ['3 gh', `gh secret set NAME --body ${FAKE}`, 'gh secret set NAME'],
  ['3 gh', `gh secret set NAME -b ${FAKE} --repo acme/app`, '--repo acme/app'],
  ['3 gh', `gh secret set NAME --body=${FAKE}`, 'gh secret set NAME'],
  ['3 gh', `gh secret set NAME --body "${FAKE}" --org acme`, '--org acme'],
  // 4. user:password options
  ['4 user', `curl --proxy-user user:${FAKE} https://x.io`, 'https://x.io'],
  ['4 user', `curl -U user:${FAKE} https://x.io`, 'https://x.io'],
  ['4 user', `curl --user user:${FAKE} https://x.io`, 'https://x.io'],
  ['4 user', `curl -u user:${FAKE} https://x.io`, 'https://x.io'],
  ['4 user', `curl -u "user:${FAKE}" https://x.io`, 'https://x.io'],
  // 5. password options of other tools
  ['5 tool', `zip -p ${FAKE} out.zip dir`, 'out.zip'],
  ['5 tool', `zip -P ${FAKE} out.zip dir`, 'out.zip'],
  ['5 tool', `7z a -p${FAKE} out.7z dir`, 'out.7z'],
  ['5 tool', `mysql -u root -p${FAKE} app`, 'app'],
  ['5 tool', `ldapsearch -x -w ${FAKE} -b dc=x`, '-b dc=x'],
  ['5 tool', `ssh-keygen -t ed25519 -N ${FAKE} -f id`, '-f id'],
  ['5 tool', `az login -u me --password ${FAKE}`, 'az login'],
  ['5 tool', `az login -u me -p ${FAKE}`, 'az login'],
  ['5 tool', `sshpass -p ${FAKE} ssh host`, 'ssh host'],
  // 6. pair keys in other letter case
  ['6 case', `Password=${FAKE} ./run`, './run'],
  ['6 case', `PASSWORD: ${FAKE}`, 'PASSWORD'],
  ['6 case', `curl -H "Api-Key: ${FAKE}" https://x.io`, 'https://x.io'],
  ['6 case', `curl -H "X-API-KEY: ${FAKE}" https://x.io`, 'https://x.io'],
  ['6 case', `curl -H "x-api-key: ${FAKE}" https://x.io`, 'https://x.io'],
  ['6 case', `curl -H "Authorization: Bearer ${FAKE}" https://x.io`, 'https://x.io'],
  ['6 case', `curl -H "AUTHORIZATION: BEARER ${FAKE}" https://x.io`, 'https://x.io'],
  ['6 case', `curl -H "authorization: bearer ${FAKE}" https://x.io`, 'https://x.io'],
  ['6 case', `curl -H 'Authorization: Basic ${FAKE}' https://x.io`, 'https://x.io'],
  ['6 case', `TOKEN=${FAKE} ./run`, './run'],
  ['6 case', `Secret: ${FAKE}`, 'Secret'],
  // 7. argv given as JSON or Python array text
  ['7 array', `["curl","--token","${FAKE}","https://x.io"]`, 'https://x.io'],
  ['7 array', `['tool', '--password', '${FAKE}', 'next']`, 'next'],
  ['7 array', `["tool", "--password", "${FAKE}", "next"]`, 'next'],
  ['7 array', `["tool","--api-key","${FAKE}"]`, 'tool'],
  ['7 array', `["sshpass","-p","${FAKE}","ssh","host"]`, 'host'],
  ['7 array', `["curl","-u","user:${FAKE}","https://x.io"]`, 'https://x.io'],
  ['7 array', `["curl","--user","user:${FAKE}","https://x.io"]`, 'https://x.io'],
  ['7 array', `["mysql","-p${FAKE}","app"]`, 'app'],
  ['7 array', `["zip","-P","${FAKE}","out.zip"]`, 'out.zip'],
  ['7 array', `["ssh-keygen","-N","${FAKE}","-f","id"]`, 'id'],
  ['7 array', `["gh","secret","set","NAME","--body","${FAKE}"]`, 'NAME'],
];

describe('review shapes: the value leaves the preview and the command stays readable', () => {
  test('there are at least 48 shapes', () => {
    expect(LEAK_SHAPES.length).toBeGreaterThanOrEqual(48);
  });

  test.each(LEAK_SHAPES.map(([group, command, readable]) => [group, command, readable] as const))(
    '%s: %s',
    (_group, command, readable) => {
      const out = redact(command);
      expect(out).not.toContain(FAKE);
      expect(out).not.toContain('VALUE-123');
      expect(out).toContain('[REDACTED]');
      expect(out).toContain(readable);
    }
  );

  test.each(LEAK_SHAPES.map(([group, command]) => [group, command] as const))(
    '%s: %s as a tool input field',
    (_group, command) => {
      const out = redactInput({ command }, WIDE);
      expect(out).not.toContain(FAKE);
      expect(out).not.toContain('VALUE-123');
    }
  );

  test.each([
    'git commit -m "fix password prompt"',
    'git commit -m "rotate token handling"',
    'grep -p pattern file',
    'ls -p',
    'mkdir -p src/x',
    'cp -p a b',
    'ssh -p 2222 host',
    'docker run -p 8080:80 img',
    'curl -u',
    'curl -u deploy https://x.io',
    'gh variable set REGION --body us-east-1',
    'gh variable set REGION -b us-east-1',
    'mysql -h db -P 3306 app',
    'wget -P downloads https://example.com/a',
    'tar -cf out.tar -N 2024-01-01 dir',
    'echo password',
    'echo "the token was rotated"',
    'MAX_TOKENS=4096 ./run',
    'Content-Type: application/json',
    String.raw`curl -d "{\"user\":\"sam\"}" https://x.io`,
    '["ls","-p","src"]',
    '["mkdir","-p","src/x"]',
  ])('control: leaves %s unchanged', text => {
    expect(redact(text)).toBe(text);
  });
});

describe('review shapes: redaction stays linear on adversarial input', () => {
  const KINDS: ReadonlyArray<readonly [string, string]> = [
    ['quotes', '"\'"\''],
    ['backslashed quotes', String.raw`\"\"\\"`],
    ['backslashes', '\\'],
    ['equals', '='],
    ['colons', ':'],
    ['-p flags', ' -p'],
    ['-P flags', ' -P'],
    ['json pairs', String.raw`{\"password\":`],
    ['name equals', 'password='],
    ['user flags', ' -u a:'],
    ['array elements', '["-p",'],
    ['mixed', String.raw`\"=:-p "`],
  ];

  test('a closed 100 KB array text redacts quickly', () => {
    const text = `["mysql"${',"-p"'.repeat(16_000)}]`;
    const started = performance.now();
    redactText(text, { credentialValues: [], cap: 200 });
    const elapsed = performance.now() - started;
    console.info(`redact 100 KB closed array text: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(500);
  });

  test.each(KINDS)('100 KB of %s redacts quickly', (_kind, unit) => {
    const text = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000);
    const started = performance.now();
    redactText(text, { credentialValues: [], cap: 200 });
    redactInput({ command: text, args: text.split(' ') }, { credentialValues: [], cap: 200 });
    const elapsed = performance.now() - started;
    console.info(`redact 100 KB of ${_kind}: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(500);
  });
});
