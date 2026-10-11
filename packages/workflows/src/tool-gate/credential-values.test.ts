import { describe, expect, test } from 'bun:test';
import { collectCredentialValues, redactCredentialValues } from './credential-values';
import { REDACTED } from './redact';

describe('redactCredentialValues', () => {
  test('every occurrence is masked, the longer value first', () => {
    // `abc` is a prefix of `abcdef`: masking the short one first would leave `def` behind.
    expect(redactCredentialValues('x abcdef y abc z abcdef', ['abc', 'abcdef'])).toBe(
      `x ${REDACTED} y ${REDACTED} z ${REDACTED}`
    );
  });

  test('empty values are ignored instead of masking between every character', () => {
    expect(redactCredentialValues('plain text', ['', 'absent'])).toBe('plain text');
  });
});

describe('collectCredentialValues', () => {
  const env = {
    GH_TOKEN: 'token-value',
    OPENAI_API_KEY: 'key-value',
    DATABASE_URL: 'postgres://u:p@h/db',
    DB_PASSWD: 'passwd-value',
    GOOGLE_CREDENTIALS: 'credentials-value',
    PATH: '/usr/bin',
    EDITOR: 'vim',
    EMPTY_TOKEN: '',
    UNSET_SECRET: undefined,
  };

  test('takes the value of every secret-named variable and nothing else', () => {
    expect(new Set(collectCredentialValues(env, undefined, undefined))).toEqual(
      new Set([
        'token-value',
        'key-value',
        'postgres://u:p@h/db',
        'passwd-value',
        'credentials-value',
      ])
    );
  });

  test('a name that runs its words together still counts, a plural setting does not', () => {
    expect(
      new Set(
        collectCredentialValues(
          {
            NPM_AUTHTOKEN: 'npm-value',
            DBPASSWORD: 'db-value',
            SMTP_PASS: 'smtp-value',
            MAX_TOKENS: '4096',
            TOKENIZERS_PARALLELISM: 'false',
          },
          undefined,
          undefined
        )
      )
    ).toEqual(new Set(['npm-value', 'db-value', 'smtp-value']));
  });

  test('a run-together key name counts, an everyday word ending in key does not', () => {
    expect(
      new Set(
        collectCredentialValues(
          {
            SSHKEY: 'ssh-value',
            STRIPEKEY: 'vendor-value',
            PGPASSWORD: 'pg-value',
            MYSECRET: 'secret-value',
            HOTKEY: 'ctrl+k',
            MONKEY: 'banana',
          },
          undefined,
          undefined
        )
      )
    ).toEqual(new Set(['ssh-value', 'vendor-value', 'pg-value', 'secret-value']));
  });

  test('a protected variable is taken whatever it is called', () => {
    expect(collectCredentialValues({ CODEX_HOME: '/run/codex-home' }, ['CODEX_HOME'], [])).toEqual([
      '/run/codex-home',
    ]);
  });

  test('protected values delivered outside the environment are added', () => {
    expect(collectCredentialValues({ PATH: '/usr/bin' }, [], ['file-secret'])).toEqual([
      'file-secret',
    ]);
  });

  test('the result has no duplicates or empties and puts the longest value first', () => {
    const values = collectCredentialValues(
      { A_TOKEN: 'same', B_TOKEN: 'same', C_TOKEN: 'a-much-longer-value' },
      [],
      ['same', '']
    );
    expect(values).toEqual(['a-much-longer-value', 'same']);
  });
});
