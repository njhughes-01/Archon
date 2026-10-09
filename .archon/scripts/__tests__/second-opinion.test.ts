/**
 * The second opinion's core, exercised through its real functions with only the network
 * replaced: `fetch` is injected, and every evidence file is a real file on disk.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { Fetch } from '../../workflows/sdlc/.shared/jev-client';
import {
  askSecondOpinion,
  OPINION_TIMEOUT_LIMIT_MS,
  parseChoices,
  readOpinionSettings,
  type SecondOpinion,
} from '../../workflows/sdlc/.shared/second-opinion';

const trackTempRoot = trackTempRoots();

// Credential-shaped literals are joined at runtime, so no secret scanner mistakes a
// fixture for a leak.
const API_KEY = ['sk', '-test-PLANTED-OPINION-KEY'].join('');
const QUESTION = 'Why did this check fail?';
const CHOICES = {
  broken: 'The code under test is wrong.',
  machine: 'The machine running the check is at fault.',
  other: 'Neither of the above.',
};

interface Sent {
  url: string;
  authorization: string;
  body: {
    model: string;
    state: { evidence: string };
    questions: Record<
      string,
      { type: string; instructions: string; criteria: Record<string, string> }
    >;
  };
  raw: string;
}

interface FakeJev {
  fetch: Fetch;
  sent: Sent[];
}

/** A Jev-compatible endpoint in memory. `answer` builds the response from the request. */
function fakeJev(answer: (sent: Sent) => Response | Promise<Response>): FakeJev {
  const sent: Sent[] = [];
  const fetch: Fetch = async (input, init) => {
    const raw = typeof init?.body === 'string' ? init.body : '';
    const headers = new Headers(init?.headers);
    const request: Sent = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      authorization: headers.get('authorization') ?? '',
      body: JSON.parse(raw) as Sent['body'],
      raw,
    };
    sent.push(request);
    return answer(request);
  };
  return { fetch, sent };
}

/** Answers the one question asked with `choice`, spreading the rest evenly. */
function choosing(choice: string, probabilities?: Record<string, number>): FakeJev {
  return fakeJev(sent => {
    const [name, question] = Object.entries(sent.body.questions)[0];
    const offered = Object.keys(question.criteria);
    const spread =
      probabilities ??
      Object.fromEntries(offered.map(option => [option, option === choice ? 0.8 : 0.1]));
    return Response.json({
      model: 'fake',
      answers: { [name]: { type: 'choice', choice, confidence: 0.7, probabilities: spread } },
    });
  });
}

function artifacts(files: Record<string, string | Uint8Array> = {}): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'second-opinion-')));
  const dir = join(root, 'artifacts');
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return { JEV_API_KEY: API_KEY, JEV_API_BASE: 'https://jev.example', ...overrides };
}

function unavailable(reason: string): SecondOpinion {
  return {
    status: 'unavailable',
    reason,
    choice: null,
    probabilities: {},
    confidence: null,
    advisory: true,
  };
}

describe('readOpinionSettings', () => {
  it('is unavailable without a key, and when either switch turns it off', () => {
    expect(readOpinionSettings({})).toEqual({ available: false, reason: 'no_api_key' });
    expect(readOpinionSettings({ JEV_API_KEY: '  ' })).toEqual({
      available: false,
      reason: 'no_api_key',
    });
    for (const off of ['0', 'false', 'FALSE', ' False ']) {
      expect(readOpinionSettings({ JEV_API_KEY: 'k', JEV_ENABLED: off })).toEqual({
        available: false,
        reason: 'disabled',
      });
      expect(readOpinionSettings({ JEV_API_KEY: 'k', JEV_OPINION_ENABLED: off })).toEqual({
        available: false,
        reason: 'disabled',
      });
    }
  });

  it('accepts a request timeout just inside the limit', () => {
    expect(OPINION_TIMEOUT_LIMIT_MS).toBe(120_000);
    const read = readOpinionSettings({ JEV_API_KEY: 'k', JEV_OPINION_TIMEOUT_MS: '119999' });
    expect(read.available && read.settings.timeoutMs).toBe(119_999);
  });

  it('is not turned off by the switch of another Jev feature', () => {
    expect(readOpinionSettings({ JEV_API_KEY: 'k', JEV_SCOUT_ENABLED: '0' }).available).toBe(true);
  });

  it('has defaults, and reads every setting from the environment', () => {
    expect(readOpinionSettings({ JEV_API_KEY: ' k ' })).toEqual({
      available: true,
      settings: {
        apiKey: 'k',
        apiBase: 'https://api.typesafe.ai',
        model: 'jev-1.13.0',
        timeoutMs: 30_000,
        maxEvidenceChars: 16_000,
      },
    });
    expect(
      readOpinionSettings({
        JEV_API_KEY: 'k',
        JEV_API_BASE: 'http://10.0.0.5:8080/',
        JEV_MODEL: 'local-1',
        JEV_OPINION_TIMEOUT_MS: '500',
        JEV_OPINION_MAX_EVIDENCE_CHARS: '4000',
      })
    ).toEqual({
      available: true,
      settings: {
        apiKey: 'k',
        apiBase: 'http://10.0.0.5:8080/',
        model: 'local-1',
        timeoutMs: 500,
        maxEvidenceChars: 4000,
      },
    });
  });

  it.each([
    ['JEV_OPINION_TIMEOUT_MS', '0'],
    ['JEV_OPINION_TIMEOUT_MS', '-5'],
    ['JEV_OPINION_TIMEOUT_MS', '1.5'],
    ['JEV_OPINION_TIMEOUT_MS', 'soon'],
    // At or past the longest a checkpoint's node waits, the node would be stopped first.
    ['JEV_OPINION_TIMEOUT_MS', '120000'],
    ['JEV_OPINION_TIMEOUT_MS', '600000'],
    ['JEV_OPINION_MAX_EVIDENCE_CHARS', '0'],
    ['JEV_OPINION_MAX_EVIDENCE_CHARS', 'lots'],
    ['JEV_OPINION_MAX_EVIDENCE_CHARS', '12e99999'],
  ])('names the variable when %s is %s, instead of using the default', (name, value) => {
    expect(readOpinionSettings({ JEV_API_KEY: 'k', [name]: value })).toEqual({
      available: false,
      reason: `invalid_setting:${name}`,
    });
  });
});

describe('parseChoices', () => {
  it('reads a list of named criteria into a map, in order', () => {
    const text = JSON.stringify([
      { name: 'broken', criterion: 'The code is wrong.' },
      { name: 'machine', criterion: 'The machine is at fault.' },
    ]);
    expect(parseChoices(text)).toEqual({
      broken: 'The code is wrong.',
      machine: 'The machine is at fault.',
    });
    expect(Object.keys(parseChoices(text))).toEqual(['broken', 'machine']);
  });

  it.each([
    ['not JSON', 'broken, machine'],
    ['a map instead of a list', '{"broken":"x","machine":"y"}'],
    ['an entry without a criterion', '[{"name":"a","criterion":"x"},{"name":"b"}]'],
    ['an empty name', '[{"name":"a","criterion":"x"},{"name":" ","criterion":"y"}]'],
    ['an empty criterion', '[{"name":"a","criterion":"x"},{"name":"b","criterion":""}]'],
    ['the same name twice', '[{"name":"a","criterion":"x"},{"name":"a","criterion":"y"}]'],
    ['nothing', ''],
  ])('offers no choices at all for %s', (_label, text) => {
    expect(parseChoices(text)).toEqual({});
  });
});

describe('askSecondOpinion', () => {
  it('asks one choice question and returns the answer as an advisory opinion', async () => {
    const jev = choosing('machine');

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: 'Error: listen EADDRINUSE: address already in use :::3000' },
      env: env({ JEV_MODEL: 'jev-test' }),
      fetch: jev.fetch,
    });

    expect(opinion).toEqual({
      status: 'ok',
      reason: '',
      choice: 'machine',
      probabilities: { broken: 0.1, machine: 0.8, other: 0.1 },
      confidence: 0.7,
      advisory: true,
    });
    expect(jev.sent).toHaveLength(1);
    const [request] = jev.sent;
    expect(request.url).toBe('https://jev.example/v1/systemone');
    expect(request.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request.body.model).toBe('jev-test');
    expect(request.body.state).toEqual({
      evidence: 'Error: listen EADDRINUSE: address already in use :::3000',
    });
    const questions = Object.values(request.body.questions);
    expect(questions).toHaveLength(1);
    expect(questions[0].type).toBe('choice');
    expect(questions[0].instructions).toStartWith(QUESTION);
    expect(questions[0].instructions).toContain('`evidence`');
    expect(questions[0].criteria).toEqual(CHOICES);
  });

  it.each([
    ['no key', {}, 'no_api_key'],
    ['every Jev feature switched off', { JEV_API_KEY: API_KEY, JEV_ENABLED: '0' }, 'disabled'],
    ['its own switch off', { JEV_API_KEY: API_KEY, JEV_OPINION_ENABLED: 'false' }, 'disabled'],
    [
      'an unusable setting',
      { JEV_API_KEY: API_KEY, JEV_OPINION_TIMEOUT_MS: 'soon' },
      'invalid_setting:JEV_OPINION_TIMEOUT_MS',
    ],
  ])('is unavailable with %s, and sends nothing', async (_label, settings, reason) => {
    const jev = choosing('machine');

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: 'exit status 1' },
      env: settings,
      fetch: jev.fetch,
    });

    expect(opinion).toEqual(unavailable(reason));
    expect(jev.sent).toEqual([]);
  });

  it.each([
    ['no choices', {}],
    ['one choice', { broken: 'The code is wrong.' }],
    ['a choice without a criterion', { broken: 'The code is wrong.', machine: '  ' }],
  ])('is unavailable with %s, and sends nothing', async (_label, choices) => {
    const jev = choosing('broken');

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices,
      evidence: { text: 'exit status 1' },
      env: env(),
      fetch: jev.fetch,
    });

    expect(opinion).toEqual(unavailable('invalid_choices'));
    expect(jev.sent).toEqual([]);
  });

  it('is unavailable without a question or without evidence, and sends nothing', async () => {
    const jev = choosing('broken');
    const ask = (question: string, text: string): Promise<SecondOpinion> =>
      askSecondOpinion({
        question,
        choices: CHOICES,
        evidence: { text },
        env: env(),
        fetch: jev.fetch,
      });

    expect(await ask('  ', 'exit status 1')).toEqual(unavailable('no_question'));
    expect(await ask(QUESTION, ' \n ')).toEqual(unavailable('no_evidence'));
    expect(jev.sent).toEqual([]);
  });

  it.each([
    [
      'an HTTP 500',
      (): Response => new Response('boom', { status: 500 }),
      'classifier_http_error:500',
    ],
    [
      'a body that is not JSON',
      (): Response => new Response('<html>'),
      'classifier_malformed_response',
    ],
    [
      'an answer of another type',
      (sent: Sent): Response =>
        Response.json({
          answers: { [Object.keys(sent.body.questions)[0]]: { type: 'noul', noul: 0.5 } },
        }),
      'classifier_malformed_response',
    ],
    [
      'no answer to the question asked',
      (): Response => Response.json({ answers: {} }),
      'classifier_malformed_response',
    ],
  ])('is unavailable on %s', async (_label, answer, reason) => {
    const jev = fakeJev(answer);

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: 'exit status 1' },
      env: env(),
      fetch: jev.fetch,
    });

    expect(opinion).toEqual(unavailable(reason));
    expect(jev.sent).toHaveLength(1);
  });

  it('is unavailable when the classifier picks an option that was not offered', async () => {
    const jev = choosing('timing', { timing: 0.9, broken: 0.1 });

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: 'exit status 1' },
      env: env(),
      fetch: jev.fetch,
    });

    expect(opinion).toEqual(unavailable('classifier_unknown_choice'));
  });

  it.each([
    ['a probability for an option that was not offered', { broken: 0.6, timing: 0.4 }],
    ['a probability outside 0 to 1', { broken: 1.4, machine: -0.4, other: 0 }],
    ['an offered option with no probability', { broken: 1 }],
  ])('is unavailable on %s', async (_label, probabilities) => {
    const jev = choosing('broken', probabilities);

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: 'exit status 1' },
      env: env(),
      fetch: jev.fetch,
    });

    expect(opinion).toEqual(unavailable('classifier_malformed_response'));
  });

  it('is unavailable when the classifier does not answer in time', async () => {
    // Never answers: it settles only when the request's own deadline aborts it.
    const stalled: Fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: 'exit status 1' },
      env: env({ JEV_OPINION_TIMEOUT_MS: '30' }),
      fetch: stalled,
    });

    expect(opinion).toEqual(unavailable('classifier_timeout'));
  });

  it('is unavailable when the request cannot be made at all', async () => {
    const refused: Fetch = () => Promise.reject(new TypeError('fetch failed'));

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: 'exit status 1' },
      env: env(),
      fetch: refused,
    });

    expect(opinion).toEqual(unavailable('classifier_network_error'));
  });

  it('reports only the class of an unexpected error, never its message', async () => {
    const jev = choosing('broken');
    // A getter that throws stands in for a bug anywhere inside: the message quotes text
    // that must not reach the result.
    const hostile = {
      get text(): string {
        throw new RangeError('PLANTED_EVIDENCE_IN_ERROR');
      },
    };

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: hostile,
      env: env(),
      fetch: jev.fetch,
    });

    expect(opinion).toEqual(unavailable('internal_error:RangeError'));
  });
});

describe('the evidence that is sent', () => {
  function numbered(count: number): string {
    return Array.from({ length: count }, (_unused, index) => `line ${String(index + 1)}`).join(
      '\n'
    );
  }

  it('keeps the tail up to the cap, starting on a whole line', async () => {
    const jev = choosing('broken');

    await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: `${numbered(500)}\nFINAL LINE` },
      env: env({ JEV_OPINION_MAX_EVIDENCE_CHARS: '200' }),
      fetch: jev.fetch,
    });

    const sent = jev.sent[0].body.state.evidence;
    expect(sent.length).toBeLessThanOrEqual(200);
    expect(sent.endsWith('FINAL LINE')).toBe(true);
    expect(sent).toMatch(/^line \d+\n/);
    expect(sent).not.toContain('line 1\n');
    // Nothing is cut that the cap had room for: one more line would not have fitted.
    const firstKept = Number(/^line (\d+)/.exec(sent)?.[1]);
    expect(`line ${String(firstKept - 1)}\n${sent}`.length).toBeGreaterThan(200);
  });

  it('sends short evidence whole', async () => {
    const jev = choosing('broken');
    const text = 'FAIL src/cart.test.ts\n  expected 3, received 4';

    await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text },
      env: env(),
      fetch: jev.fetch,
    });

    expect(jev.sent[0].body.state.evidence).toBe(text);
  });

  it('keeps the end of one line that is longer than the cap', async () => {
    const jev = choosing('broken');

    await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: `${'x'.repeat(5000)}THE_END` },
      env: env({ JEV_OPINION_MAX_EVIDENCE_CHARS: '100' }),
      fetch: jev.fetch,
    });

    const sent = jev.sent[0].body.state.evidence;
    expect(sent).toHaveLength(100);
    expect(sent.endsWith('THE_END')).toBe(true);
  });

  it('keeps the end of a long line rather than only what follows it', async () => {
    const jev = choosing('broken');
    // One assertion line far longer than the cap, then a short closing line. Starting
    // on the next whole line would send the closing line alone.
    const long = `AssertionError: expected ${'a b c '.repeat(4000)}LONG_LINE_END`;

    await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: `first line\n${long}\nexit status 1` },
      env: env({ JEV_OPINION_MAX_EVIDENCE_CHARS: '1000' }),
      fetch: jev.fetch,
    });

    const sent = jev.sent[0].body.state.evidence;
    // The cap, less at most a space the cut landed on.
    expect(sent.length).toBeGreaterThan(990);
    expect(sent.length).toBeLessThanOrEqual(1000);
    expect(sent.endsWith('LONG_LINE_END\nexit status 1')).toBe(true);
  });

  it('still starts on a whole line when that costs little', async () => {
    const jev = choosing('broken');
    const lines = Array.from({ length: 50 }, (_unused, index) => `line ${String(index)} ${'x'.repeat(30)}`);

    await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: lines.join('\n') },
      env: env({ JEV_OPINION_MAX_EVIDENCE_CHARS: '1000' }),
      fetch: jev.fetch,
    });

    expect(jev.sent[0].body.state.evidence).toMatch(/^line \d+ x/);
  });

  it('is unavailable when nothing but removed secrets is left to judge', async () => {
    const jev = choosing('broken');

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: {
        text: `-----BEGIN PRIVATE KEY-----\nPLANTEDBODY\n-----END PRIVATE KEY-----\n${['gh', 'p_PLANTEDGITHUBTOKEN0123456789abcdefghij'].join('')}\n`,
      },
      env: env(),
      fetch: jev.fetch,
    });

    expect(opinion).toEqual(unavailable('insufficient_evidence'));
    expect(jev.sent).toEqual([]);
  });

  it('judges only the part of the evidence its caller says the question is about', async () => {
    const jev = choosing('broken');
    const framed = (output: string): string => `HEADER the check failed\n<<${output}>>\nFOOTER see the log`;
    const inside = (evidence: string): string =>
      evidence.slice(evidence.indexOf('<<') + 2, evidence.lastIndexOf('>>'));
    const ask = (output: string): Promise<SecondOpinion> =>
      askSecondOpinion({
        question: QUESTION,
        choices: CHOICES,
        evidence: { text: framed(output) },
        judged: inside,
        env: env(),
        fetch: jev.fetch,
      });

    // The framing alone says that something failed, never why.
    expect(await ask('')).toEqual(unavailable('insufficient_evidence'));
    expect(await ask('  \n ')).toEqual(unavailable('insufficient_evidence'));
    expect(jev.sent).toEqual([]);

    expect((await ask('Killed')).status).toBe('ok');
    // The framing is still sent: it is context for what is judged.
    expect(jev.sent[0].body.state.evidence).toBe(framed('Killed'));
  });

  it('removes planted secrets from the request and keeps the lines around them', async () => {
    const jev = choosing('machine');
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAPLANTEDPEMBODYLINEONE',
      'PLANTEDPEMBODYLINETWO==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const log = [
      'KEEP: connecting to the database',
      'DATABASE_PASSWORD=PLANTED_ASSIGNED_SECRET',
      'db_password: "PLANTED QUOTED SECRET"',
      '{"client_secret": "PLANTED_JSON_SECRET", "retries": 3}',
      'Authorization: Bearer PLANTED_BEARER_TOKEN_0123456789',
      'curl -H "authorization: Basic PLANTEDBASICAUTH==" https://api.example/v1',
      'fetching https://deploy:PLANTED_URL_PASSWORD@git.example/repo.git',
      'GET /callback?access_token=PLANTED_QUERY_TOKEN&state=kept',
      `using key ${['sk', '-PLANTEDPROVIDERKEY0123456789abcdef'].join('')}`,
      `token ${['gh', 'p_PLANTEDGITHUBTOKEN0123456789abcdefghij'].join('')}`,
      `aws ${['AK', 'IAPLANTEDAWSKEY012'].join('')}`,
      pem,
      'echo of an injected value: PLANTED-ENV-VALUE-123',
      `the classifier key itself: ${API_KEY}`,
      'KEEP: Error: connect ECONNREFUSED 127.0.0.1:5432',
    ].join('\n');

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: log },
      env: env({ DEPLOY_TOKEN: 'PLANTED-ENV-VALUE-123' }),
      fetch: jev.fetch,
    });

    expect(opinion.status).toBe('ok');
    const { raw } = jev.sent[0];
    expect(raw).not.toContain('PLANTED');
    expect(raw).not.toContain(API_KEY);
    const sent = jev.sent[0].body.state.evidence;
    expect(sent).toContain('KEEP: connecting to the database');
    expect(sent).toContain('KEEP: Error: connect ECONNREFUSED 127.0.0.1:5432');
    expect(sent).toContain('DATABASE_PASSWORD=[REDACTED]');
    expect(sent).toContain('"retries": 3');
    expect(sent).toContain('&state=kept');
    expect(sent).toContain('@git.example/repo.git');
    expect(sent).toContain('[REDACTED PRIVATE KEY]');
  });

  it('redacts before it cuts, so a secret the cut would split is still removed', async () => {
    const jev = choosing('machine');
    // The cap lands in the middle of the key block and of the assignment before it.
    const log = [
      'earlier output '.repeat(40),
      'SERVICE_API_KEY=PLANTED_SPLIT_SECRET_VALUE_THAT_IS_QUITE_LONG_0123456789',
      '-----BEGIN PRIVATE KEY-----',
      'PLANTEDKEYBODY'.repeat(20),
      '-----END PRIVATE KEY-----',
      'Error: permission denied',
    ].join('\n');

    await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { text: log },
      env: env({ JEV_OPINION_MAX_EVIDENCE_CHARS: '120' }),
      fetch: jev.fetch,
    });

    expect(jev.sent[0].raw).not.toContain('PLANTED');
    expect(jev.sent[0].body.state.evidence.endsWith('Error: permission denied')).toBe(true);
  });
});

describe('evidence read from the artifacts directory', () => {
  const ask = (
    dir: string,
    path: string,
    jev: FakeJev,
    overrides: Record<string, string> = {}
  ): Promise<SecondOpinion> =>
    askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { path },
      env: env({ ARTIFACTS_DIR: dir, ...overrides }),
      fetch: jev.fetch,
    });

  it('reads a file named relative to the directory, or absolutely inside it', async () => {
    const dir = artifacts({ 'validation.md': '# Validation\n\nSENT_MARKER exit 1\n' });
    const jev = choosing('broken');

    expect((await ask(dir, 'validation.md', jev)).status).toBe('ok');
    expect((await ask(dir, join(dir, 'validation.md'), jev)).status).toBe('ok');

    expect(jev.sent).toHaveLength(2);
    for (const request of jev.sent) {
      expect(request.body.state.evidence).toBe('# Validation\n\nSENT_MARKER exit 1');
    }
  });

  it('reads only the end of a large file', async () => {
    const big = `${'padding line that is never sent\n'.repeat(200_000)}SENT_MARKER last line\n`;
    const dir = artifacts({ 'validation.md': big });
    const jev = choosing('broken');

    const opinion = await ask(dir, 'validation.md', jev, {
      JEV_OPINION_MAX_EVIDENCE_CHARS: '300',
    });

    expect(opinion.status).toBe('ok');
    const sent = jev.sent[0].body.state.evidence;
    expect(sent.length).toBeLessThanOrEqual(300);
    expect(sent.endsWith('SENT_MARKER last line')).toBe(true);
    expect(sent.startsWith('padding line')).toBe(true);
  });

  it('keeps the end of a last line that is longer than everything it reads', async () => {
    const long = `expected ${'word '.repeat(60_000)}LONG_LINE_END`;
    const dir = artifacts({ 'validation.md': `# Validation\n\n${long}\nexit status 1\n` });
    const jev = choosing('broken');

    const opinion = await ask(dir, 'validation.md', jev, {
      JEV_OPINION_MAX_EVIDENCE_CHARS: '1000',
    });

    expect(opinion.status).toBe('ok');
    const sent = jev.sent[0].body.state.evidence;
    // The cap, less at most a space the cut landed on.
    expect(sent.length).toBeGreaterThan(990);
    expect(sent.length).toBeLessThanOrEqual(1000);
    expect(sent.endsWith('LONG_LINE_END\nexit status 1')).toBe(true);
  });

  it('refuses a path outside the directory', async () => {
    const dir = artifacts({ 'validation.md': 'inside' });
    writeFileSync(join(dirname(dir), 'outside.md'), 'PLANTED_OUTSIDE');
    const jev = choosing('broken');

    for (const path of ['../outside.md', join(dirname(dir), 'outside.md'), 'sub/../../outside.md']) {
      expect(await ask(dir, path, jev)).toEqual(unavailable('evidence_outside_artifacts'));
    }
    expect(jev.sent).toEqual([]);
  });

  it('refuses a symlink, and a file reached through a linked directory', async () => {
    const dir = artifacts({ 'validation.md': 'inside' });
    const outside = join(dirname(dir), 'elsewhere');
    mkdirSync(outside);
    writeFileSync(join(outside, 'host.md'), 'PLANTED_HOST_FILE');
    symlinkSync(join(outside, 'host.md'), join(dir, 'link.md'));
    symlinkSync(join(dir, 'validation.md'), join(dir, 'inner-link.md'));
    symlinkSync(outside, join(dir, 'linked'));
    const jev = choosing('broken');

    expect(await ask(dir, 'link.md', jev)).toEqual(unavailable('evidence_not_regular_file'));
    expect(await ask(dir, 'inner-link.md', jev)).toEqual(unavailable('evidence_not_regular_file'));
    expect(await ask(dir, 'linked/host.md', jev)).toEqual(
      unavailable('evidence_outside_artifacts')
    );
    expect(jev.sent).toEqual([]);
  });

  it('resolves the directory itself, so one reached through a link still works', async () => {
    const dir = artifacts({ 'validation.md': 'SENT_MARKER' });
    const alias = join(dirname(dir), 'alias');
    symlinkSync(dir, alias);
    const jev = choosing('broken');

    expect((await ask(alias, 'validation.md', jev)).status).toBe('ok');
    expect(jev.sent[0].body.state.evidence).toBe('SENT_MARKER');
  });

  it.each(['.env', '.env.local', 'secrets/validation.md', 'id_rsa', 'deploy.pem', 'credentials.json'])(
    'refuses the secret-named file %s without opening it',
    async path => {
      const dir = artifacts({ [path]: 'PLANTED_SECRET_FILE' });
      const jev = choosing('broken');

      expect(await ask(dir, path, jev)).toEqual(unavailable('evidence_secret_path'));
      expect(jev.sent).toEqual([]);
    }
  );

  it('refuses what is not a readable text file', async () => {
    const dir = artifacts({
      'folder/inner.md': 'inside',
      'binary.md': new Uint8Array([35, 32, 0, 1, 2, 3]),
      'blank.md': ' \n\n',
    });
    const jev = choosing('broken');

    expect(await ask(dir, 'missing.md', jev)).toEqual(unavailable('evidence_not_regular_file'));
    expect(await ask(dir, 'folder', jev)).toEqual(unavailable('evidence_not_regular_file'));
    expect(await ask(dir, 'binary.md', jev)).toEqual(unavailable('evidence_binary'));
    expect(await ask(dir, 'blank.md', jev)).toEqual(unavailable('no_evidence'));
    expect(await ask(dir, '  ', jev)).toEqual(unavailable('no_evidence'));
    expect(jev.sent).toEqual([]);
  });

  it('is unavailable when the run gave no artifacts directory', async () => {
    const jev = choosing('broken');

    const opinion = await askSecondOpinion({
      question: QUESTION,
      choices: CHOICES,
      evidence: { path: 'validation.md' },
      env: env(),
      fetch: jev.fetch,
    });

    expect(opinion).toEqual(unavailable('no_artifacts_dir'));
    expect(jev.sent).toEqual([]);
  });
});
