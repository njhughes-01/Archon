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
