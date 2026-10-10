/**
 * The Jev escalator against a stubbed `fetch`: what it reads from the
 * environment, the one request it sends, and how every failure comes back.
 * Nothing here reaches a network.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { Fetch } from '../jev/jev-client';
import {
  createJevEscalator,
  DEFAULT_GATE_TIMEOUT_MS,
  MAX_GATE_TIMEOUT_MS,
  readToolGateJevSettings,
  type ToolGateJevSettings,
} from './escalate-jev';
import {
  createToolGate,
  DEFAULT_NOUL_THRESHOLD,
  DEFAULT_SCORE_THRESHOLD,
  ESCALATION_LEVELS,
  NOUL_THRESHOLD_BOUNDS,
  SCORE_THRESHOLD_BOUNDS,
  type ToolGateDecisionEvent,
  type ToolGateEscalationRequest,
} from './index';

const trackTempRoot = trackTempRoots();

const SETTINGS: ToolGateJevSettings = {
  apiKey: 'jev-test-key',
  apiBase: 'https://jev.example.test/',
  model: 'jev-test-model',
  timeoutMs: 1_000,
  thresholds: { score: DEFAULT_SCORE_THRESHOLD, noul: DEFAULT_NOUL_THRESHOLD },
};

const REQUEST: ToolGateEscalationRequest = {
  tool: 'Bash',
  kind: 'shell',
  command: 'gh pr merge 5',
  targets: ['src/app.ts'],
  repoRelative: true,
  reversibleHint: 'unlikely',
  signals: ['risk.mutation_verb'],
  facts: { githubAction: 'merge_or_close' },
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    state: Record<string, unknown>;
    questions: Record<string, { type: string; instructions: string; criteria: unknown }>;
  };
}

function answering(body: unknown, status = 200): { fetch: Fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: Fetch = (input, init) => {
    sent.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Sent['body'],
    });
    return Promise.resolve(Response.json(body, { status }));
  };
  return { fetch, sent };
}

function jevAnswers(score: number, noul: number, confidence = 0.8): unknown {
  return {
    answers: {
      risk: { type: 'score', score, probabilities: { '0': 1 }, confidence },
      external_state: { type: 'noul', noul },
    },
  };
}

describe('readToolGateJevSettings', () => {
  test('without a key the classifier is off', () => {
    expect(readToolGateJevSettings({})).toEqual({ status: 'off', reason: 'no_api_key' });
    expect(readToolGateJevSettings({ JEV_API_KEY: '   ' })).toEqual({
      status: 'off',
      reason: 'no_api_key',
    });
  });

  test.each([
    ['JEV_ENABLED', '0'],
    ['JEV_ENABLED', 'false'],
    ['JEV_ENABLED', ' FALSE '],
    ['JEV_GATE_ENABLED', '0'],
    ['JEV_GATE_ENABLED', 'false'],
  ])('%s=%p turns it off while the key stays set', (variable, value) => {
    expect(readToolGateJevSettings({ JEV_API_KEY: 'k', [variable]: value })).toEqual({
      status: 'off',
      reason: 'disabled',
    });
  });

  test('a key alone turns it on with the defaults', () => {
    expect(readToolGateJevSettings({ JEV_API_KEY: ' k ' })).toEqual({
      status: 'on',
      settings: {
        apiKey: 'k',
        apiBase: 'https://api.typesafe.ai',
        model: 'jev-1.13.0',
        timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
        thresholds: { score: DEFAULT_SCORE_THRESHOLD, noul: DEFAULT_NOUL_THRESHOLD },
      },
    });
  });

  test('the endpoint, model, timeout and thresholds can each be set', () => {
    const read = readToolGateJevSettings({
      JEV_API_KEY: 'k',
      JEV_ENABLED: '1',
      JEV_GATE_ENABLED: 'true',
      JEV_API_BASE: 'http://10.0.0.5:8080',
      JEV_MODEL: 'local-jev',
      JEV_GATE_TIMEOUT_MS: '2500',
      JEV_GATE_SCORE_THRESHOLD: '2',
      JEV_GATE_NOUL_THRESHOLD: '0.25',
    });
    expect(read).toEqual({
      status: 'on',
      settings: {
        apiKey: 'k',
        apiBase: 'http://10.0.0.5:8080',
        model: 'local-jev',
        timeoutMs: 2500,
        thresholds: { score: 2, noul: 0.25 },
      },
    });
  });

  test('the score threshold may be anywhere on the level scale and nowhere else', () => {
    const top = ESCALATION_LEVELS.length - 1;
    expect(SCORE_THRESHOLD_BOUNDS).toEqual({ min: 0, max: top });
    for (const usable of ['0', String(top), '1.5']) {
      expect(
        readToolGateJevSettings({ JEV_API_KEY: 'k', JEV_GATE_SCORE_THRESHOLD: usable }).status
      ).toBe('on');
    }
    for (const unusable of ['-0.1', String(top + 0.01), 'high', 'NaN', 'Infinity']) {
      expect(
        readToolGateJevSettings({ JEV_API_KEY: 'k', JEV_GATE_SCORE_THRESHOLD: unusable })
      ).toMatchObject({ status: 'invalid', variable: 'JEV_GATE_SCORE_THRESHOLD' });
    }
  });

  test('the noul threshold is a probability', () => {
    expect(NOUL_THRESHOLD_BOUNDS).toEqual({ min: 0, max: 1 });
    for (const unusable of ['-0.01', '1.01', 'often']) {
      expect(
        readToolGateJevSettings({ JEV_API_KEY: 'k', JEV_GATE_NOUL_THRESHOLD: unusable })
      ).toMatchObject({ status: 'invalid', variable: 'JEV_GATE_NOUL_THRESHOLD' });
    }
  });

  test('the timeout is a whole number of milliseconds up to the cap', () => {
    expect(
      readToolGateJevSettings({
        JEV_API_KEY: 'k',
        JEV_GATE_TIMEOUT_MS: String(MAX_GATE_TIMEOUT_MS),
      }).status
    ).toBe('on');
    for (const unusable of ['0', '-5', '1.5', 'soon', String(MAX_GATE_TIMEOUT_MS + 1)]) {
      expect(
        readToolGateJevSettings({ JEV_API_KEY: 'k', JEV_GATE_TIMEOUT_MS: unusable })
      ).toMatchObject({ status: 'invalid', variable: 'JEV_GATE_TIMEOUT_MS' });
    }
  });

  test('an unusable number is reported, never replaced by the default', () => {
    const read = readToolGateJevSettings({ JEV_API_KEY: 'k', JEV_GATE_NOUL_THRESHOLD: '5' });
    expect(read).toEqual({
      status: 'invalid',
      variable: 'JEV_GATE_NOUL_THRESHOLD',
      problem: 'must be a number from 0 to 1',
    });
  });
});

describe('createJevEscalator: the request', () => {
  test('one POST carries both questions over the six state fields and the context facts', async () => {
    const { fetch, sent } = answering(jevAnswers(1, 0.1));
    await createJevEscalator(SETTINGS, { fetch })(REQUEST);

    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe('https://jev.example.test/v1/systemone');
    expect(request?.headers.Authorization).toBe('Bearer jev-test-key');
    expect(request?.body.model).toBe('jev-test-model');
    expect(request?.body.state).toEqual({
      tool: 'Bash',
      kind: 'shell',
      command: 'gh pr merge 5',
      targets: ['src/app.ts'],
      repo_relative: true,
      reversible_hint: 'unlikely',
      // Every fact travels under a fixed name; the ones the rules did not state say so.
      context: {
        git_push_target: 'not_applicable',
        uncommitted_work: 'not_applicable',
        removal_target: 'not_applicable',
        github_action: 'merge_or_close',
        target_host: 'not_applicable',
      },
    });
    expect(Object.keys(request?.body.questions ?? {}).sort()).toEqual(['external_state', 'risk']);
  });

  test('the score question has one distinct criterion sentence per level, lowest first', async () => {
    const { fetch, sent } = answering(jevAnswers(1, 0.1));
    await createJevEscalator(SETTINGS, { fetch })(REQUEST);

    const risk = sent[0]?.body.questions.risk;
    expect(risk?.type).toBe('score');
    const criteria = risk?.criteria as string[];
    expect(criteria).toHaveLength(ESCALATION_LEVELS.length);
    expect(new Set(criteria).size).toBe(ESCALATION_LEVELS.length);
    for (const sentence of criteria) expect(sentence.length).toBeGreaterThan(40);
    // The order is the scale: the lowest level only reads, the highest cannot be recovered.
    expect(criteria[ESCALATION_LEVELS.indexOf('read_only')]).toMatch(/only reads/i);
    expect(criteria[ESCALATION_LEVELS.indexOf('destructive')]).toMatch(/cannot be recovered/i);
    // The two classes the owner named: one is routine, the other is never to be waved through.
    expect(criteria[ESCALATION_LEVELS.indexOf('reversible')]).toMatch(
      /build, cache or dependency output/
    );
    expect(criteria[ESCALATION_LEVELS.indexOf('destructive')]).toMatch(
      /uncommitted work across the whole working tree/
    );
    // Every level says what does not belong to it.
    for (const sentence of criteria) expect(sentence).toMatch(/do(es)? not belong here/);
  });

  test('the yes/no question asks about production or shared state and says what each answer means', async () => {
    const { fetch, sent } = answering(jevAnswers(1, 0.1));
    await createJevEscalator(SETTINGS, { fetch })(REQUEST);

    const external = sent[0]?.body.questions.external_state;
    expect(external?.type).toBe('noul');
    expect(external?.instructions).toContain('production, shared or third-party state');
    // Routine visible actions are named as not counting.
    expect((external?.criteria as Record<string, string>).false).toContain(
      'Commenting, opening or updating a pull request and rerunning CI do not count'
    );
    expect(Object.keys(external?.criteria as Record<string, string>).sort()).toEqual([
      'false',
      'true',
    ]);
  });
});

describe('createJevEscalator: the answer', () => {
  test('a usable answer is handed back as score, noul and the score confidence', async () => {
    const { fetch } = answering(jevAnswers(1.05, 0.2, 0.66));
    expect(await createJevEscalator(SETTINGS, { fetch })(REQUEST)).toEqual({
      ok: true,
      score: 1.05,
      noul: 0.2,
      confidence: 0.66,
    });
  });

  test.each([
    ['an HTTP error', answering({ error: 'overloaded' }, 503).fetch, 'http_error_503'],
    ['a body that is not an answer', answering({ hello: 'world' }).fetch, 'malformed_response'],
    [
      'a score outside the asked scale',
      answering(jevAnswers(ESCALATION_LEVELS.length, 0.1)).fetch,
      'malformed_response',
    ],
    [
      'one of the two answers missing',
      answering({ answers: { external_state: { type: 'noul', noul: 0.1 } } }).fetch,
      'malformed_response',
    ],
    [
      'a refused connection',
      ((): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))) as Fetch,
      'network_error',
    ],
  ])('%s comes back as a failure', async (_name, fetch, reason) => {
    expect(await createJevEscalator(SETTINGS, { fetch })(REQUEST)).toEqual({ ok: false, reason });
  });

  test('a request that outlives the timeout is a failure, not a wait', async () => {
    const fetch: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const started = performance.now();
    const result = await createJevEscalator({ ...SETTINGS, timeoutMs: 20 }, { fetch })(REQUEST);
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(performance.now() - started).toBeLessThan(900);
  });

  test('a fetch that throws before returning a promise is still a failure value', async () => {
    const fetch = ((): Promise<Response> => {
      throw new Error('boom');
    }) as Fetch;
    const result = await createJevEscalator(SETTINGS, { fetch })(REQUEST);
    expect(result.ok).toBe(false);
  });
});

describe('the escalator behind the real gate', () => {
  function shellGate(
    fetch: Fetch,
    records: ToolGateDecisionEvent[]
  ): {
    root: string;
    gate: ReturnType<typeof createToolGate>;
  } {
    const root = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tool-gate-jev-'))));
    const gate = createToolGate({
      repoRoot: root,
      classifierConfigured: true,
      escalate: createJevEscalator(SETTINGS, { fetch }),
      thresholds: SETTINGS.thresholds,
      credentialValues: ['planted-credential-4471'],
      record: event => records.push(event),
    });
    return { root, gate };
  }

  test('a low score and noul allow the call and are recorded as the classifier decision', async () => {
    const records: ToolGateDecisionEvent[] = [];
    const { fetch } = answering(jevAnswers(1.05, 0.1, 0.7));
    const { root, gate } = shellGate(fetch, records);
    const decision = await gate({
      toolName: 'Bash',
      kind: 'shell',
      cwd: root,
      command: 'gh pr ready 5',
      input: {},
    });
    expect(decision).toEqual({ action: 'allow' });
    expect(records[0]).toMatchObject({ source: 'jev', score: 1.05, noul: 0.1, confidence: 0.7 });
  });

  test.each([
    ['a score at the out_of_bounds level', jevAnswers(2, 0.1)],
    ['a noul at its threshold', jevAnswers(0.2, DEFAULT_NOUL_THRESHOLD)],
  ])('%s is denied as needing approval', async (_name, body) => {
    const records: ToolGateDecisionEvent[] = [];
    const { root, gate } = shellGate(answering(body).fetch, records);
    const decision = await gate({
      toolName: 'Bash',
      kind: 'shell',
      cwd: root,
      command: 'gh pr merge 5',
      input: {},
    });
    expect(decision).toMatchObject({ action: 'deny', needsApproval: true });
    expect(records[0]).toMatchObject({ source: 'jev', decision: 'deny' });
  });

  test('a failed request denies with the failure recorded, and the secret never left', async () => {
    const records: ToolGateDecisionEvent[] = [];
    const { fetch, sent } = answering({ error: 'down' }, 500);
    const { root, gate } = shellGate(fetch, records);
    const decision = await gate({
      toolName: 'Bash',
      kind: 'shell',
      cwd: root,
      command: 'curl -X POST -H "X-Key: planted-credential-4471" https://api.example.com/deploy',
      input: {},
    });
    expect(decision).toMatchObject({ action: 'deny', needsApproval: true });
    if (decision.action !== 'deny') throw new Error('unreachable');
    // The agent is not told what went wrong with the classifier; the record is.
    expect(decision.reason).not.toContain('http_error_500');
    expect(records[0]).toMatchObject({
      source: 'fallback',
      decision: 'deny',
      classifierFailure: 'http_error_500',
    });
    expect(JSON.stringify(sent)).not.toContain('planted-credential-4471');
  });
});
