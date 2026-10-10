/**
 * Behaviour of the composed gate. Every command here is free of absolute paths,
 * so these run on any platform; the path rules are covered by the fixture table.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLogLines, trackTempRoots } from '@archon/paths/test-utils';
import type { ToolActionRequest } from '@archon/providers/types';
import {
  createToolGate,
  createToolGateCache,
  DEFAULT_MAX_DENIALS_PER_NODE,
  DENY_RULES,
  DEFAULT_NOUL_THRESHOLD,
  DEFAULT_SCORE_THRESHOLD,
  ESCALATION_LEVELS,
  ESCALATION_TEXT_CAP,
  MAX_ESCALATION_TARGETS,
  NOUL_THRESHOLD_BOUNDS,
  REPEATED_DENIALS_RULE_ID,
  SCORE_THRESHOLD_BOUNDS,
  UNRECORDED_DECISION_RULE_ID,
  type ToolGate,
  type ToolGateDecisionEvent,
  type ToolGateEscalationRequest,
  type ToolGateEscalationResult,
  type ToolGateOptions,
} from './index';

const trackTempRoot = trackTempRoots();
const isWindows = process.platform === 'win32';

function makeRoot(): string {
  return trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tool-gate-'))));
}

function shell(command: string, cwd: string): ToolActionRequest {
  return { toolName: 'Bash', kind: 'shell', cwd, command, input: { command } };
}

const ALLOWED = 'git status';
const DENIED_BY_RULE = 'git reset --hard';
const ESCALATED = 'gh pr merge 5';

interface Harness {
  root: string;
  gate: ToolGate;
  calls: ToolGateEscalationRequest[];
  records: ToolGateDecisionEvent[];
}

type Answer = ToolGateEscalationResult | (() => ToolGateEscalationResult);

function harness(answer: Answer, overrides: Partial<ToolGateOptions> = {}): Harness {
  const root = overrides.repoRoot ?? makeRoot();
  const calls: ToolGateEscalationRequest[] = [];
  const records: ToolGateDecisionEvent[] = [];
  const gate = createToolGate({
    repoRoot: root,
    classifierConfigured: true,
    escalate: request => {
      calls.push(request);
      return Promise.resolve(typeof answer === 'function' ? answer() : answer);
    },
    record: event => records.push(event),
    ...overrides,
  });
  return { root, gate, calls, records };
}

function answer(score: number, noul: number, confidence = 0.9): ToolGateEscalationResult {
  return { ok: true, score, noul, confidence };
}

const CALM = answer(0, 0);
const FAILED: ToolGateEscalationResult = { ok: false, reason: 'timeout' };

describe('rules decide first and finally', () => {
  test('an allow rule answers without asking the classifier', async () => {
    const h = harness(answer(3, 1));
    expect(await h.gate(shell(ALLOWED, h.root))).toEqual({ action: 'allow' });
    expect(h.calls).toHaveLength(0);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      tool: 'Bash',
      kind: 'shell',
      decision: 'allow',
      needsApproval: false,
      source: 'rule',
      ruleId: 'allow.read_only',
    });
  });

  test('a deny rule stays a deny when the classifier would call it read-only', async () => {
    const h = harness(CALM);
    const decision = await h.gate(shell(DENIED_BY_RULE, h.root));
    expect(decision).toMatchObject({
      action: 'deny',
      needsApproval: false,
      ruleId: 'deny.git_reset_hard',
    });
    if (decision.action !== 'deny') throw new Error('unreachable');
    expect(decision.reason).toContain('do not retry');
    expect(decision.alternatives.length).toBeGreaterThan(0);
    expect(h.calls).toHaveLength(0);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ decision: 'deny', source: 'rule' });
  });
});

describe('the escalation band', () => {
  test('a calm answer allows and records the scores', async () => {
    const h = harness(answer(0.4, 0.1, 0.77));
    expect(await h.gate(shell(ESCALATED, h.root))).toEqual({ action: 'allow' });
    expect(h.calls).toHaveLength(1);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      decision: 'allow',
      needsApproval: false,
      source: 'jev',
      ruleId: 'risk.mutation_verb',
      score: 0.4,
      noul: 0.1,
      confidence: 0.77,
    });
  });

  test('the classifier is handed the whitelisted description, not the raw request', async () => {
    const h = harness(CALM);
    await h.gate(shell(ESCALATED, h.root));
    expect(Object.keys(h.calls[0] ?? {}).sort()).toEqual([
      'command',
      'facts',
      'kind',
      'repoRelative',
      'reversibleHint',
      'signals',
      'targets',
      'tool',
    ]);
    expect(h.calls[0]).toMatchObject({ tool: 'Bash', kind: 'shell', command: ESCALATED });
    // The facts are the rules' fixed words, never text from the request.
    expect(h.calls[0]?.facts).toEqual({ githubAction: 'merge_or_close' });
  });

  test('the default score threshold sits between reversible and out_of_bounds', () => {
    expect(DEFAULT_SCORE_THRESHOLD).toBeGreaterThan(ESCALATION_LEVELS.indexOf('reversible'));
    expect(DEFAULT_SCORE_THRESHOLD).toBeLessThanOrEqual(ESCALATION_LEVELS.indexOf('out_of_bounds'));
    expect(SCORE_THRESHOLD_BOUNDS).toEqual({ min: 0, max: ESCALATION_LEVELS.length - 1 });
    expect(NOUL_THRESHOLD_BOUNDS).toEqual({ min: 0, max: 1 });
  });

  const EPSILON = 1e-9;
  test.each([
    ['score exactly at the threshold', answer(DEFAULT_SCORE_THRESHOLD, 0), 'deny'],
    ['score just below the threshold', answer(DEFAULT_SCORE_THRESHOLD - EPSILON, 0), 'allow'],
    ['score at the top level', answer(SCORE_THRESHOLD_BOUNDS.max, 0), 'deny'],
    ['noul exactly at the threshold', answer(0, DEFAULT_NOUL_THRESHOLD), 'deny'],
    ['noul just below the threshold', answer(0, DEFAULT_NOUL_THRESHOLD - EPSILON), 'allow'],
    [
      'both below',
      answer(DEFAULT_SCORE_THRESHOLD - EPSILON, DEFAULT_NOUL_THRESHOLD - EPSILON),
      'allow',
    ],
  ] as const)('%s → %s', async (_name, classifierAnswer, expected) => {
    const h = harness(classifierAnswer);
    const decision = await h.gate(shell(ESCALATED, h.root));
    expect(decision.action).toBe(expected);
    if (decision.action === 'deny') {
      expect(decision.needsApproval).toBe(true);
      expect(decision.alternatives.length).toBeGreaterThan(0);
      expect(h.records[0]).toMatchObject({ decision: 'deny', needsApproval: true, source: 'jev' });
    }
  });

  test('confidence is recorded and never moves the decision', async () => {
    const unsure = harness(answer(SCORE_THRESHOLD_BOUNDS.max, 1, 0));
    expect((await unsure.gate(shell(ESCALATED, unsure.root))).action).toBe('deny');
    expect(unsure.records[0]?.confidence).toBe(0);

    const calmButUnsure = harness(answer(0, 0, 0));
    expect((await calmButUnsure.gate(shell(ESCALATED, calmButUnsure.root))).action).toBe('allow');
  });

  test('configured thresholds replace the defaults', async () => {
    const strict = harness(answer(1, 0), { thresholds: { score: 1 } });
    expect((await strict.gate(shell(ESCALATED, strict.root))).action).toBe('deny');
    const loose = harness(answer(0, 0.9), { thresholds: { noul: 0.95 } });
    expect((await loose.gate(shell(ESCALATED, loose.root))).action).toBe('allow');
  });

  test.each([
    ['score above the top level', { score: SCORE_THRESHOLD_BOUNDS.max + 0.1 }],
    ['score below zero', { score: -0.1 }],
    ['score not a number', { score: Number.NaN }],
    ['noul above one', { noul: 1.01 }],
    ['noul below zero', { noul: -0.01 }],
  ])('a threshold out of bounds is refused when the gate is built: %s', (_name, thresholds) => {
    expect(() => harness(CALM, { thresholds })).toThrow(/threshold/);
  });
});

describe('no usable classifier answer', () => {
  test.each([
    ['the classifier reports a failure', FAILED],
    ['the score is past the top level', answer(SCORE_THRESHOLD_BOUNDS.max + 1, 0)],
    ['the score is not a number', answer(Number.NaN, 0)],
    ['the noul is out of range', answer(0, 1.5)],
    ['the confidence is out of range', answer(0, 0, -1)],
  ])('with a classifier configured, %s → deny, needs approval, fallback', async (_name, bad) => {
    const h = harness(bad);
    const decision = await h.gate(shell(ESCALATED, h.root));
    expect(decision).toMatchObject({ action: 'deny', needsApproval: true });
    expect(h.calls).toHaveLength(1);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      decision: 'deny',
      needsApproval: true,
      source: 'fallback',
      ruleId: 'risk.mutation_verb',
    });
    expect(h.records[0]?.score).toBeUndefined();
  });

  test('a classifier that throws is the same failure', async () => {
    const h = harness(CALM, {
      escalate: () => Promise.reject(new Error('socket hang up')),
    });
    expect(await h.gate(shell(ESCALATED, h.root))).toMatchObject({
      action: 'deny',
      needsApproval: true,
    });
    expect(h.records[0]).toMatchObject({ decision: 'deny', source: 'fallback' });
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['a string', 'allow'],
    ['ok: true with no numbers', { ok: true }],
    ['ok: false with no reason', { ok: false }],
    ['ok that is not a boolean', { ok: 'yes', score: 0, noul: 0, confidence: 1 }],
  ])('an escalator that returns %s is a recorded denial, not a crash', async (_name, shapeless) => {
    const h = harness(CALM, {
      escalate: () => Promise.resolve(shapeless as unknown as ToolGateEscalationResult),
    });
    const decision = await h.gate(shell(ESCALATED, h.root));
    expect(decision).toMatchObject({ action: 'deny', needsApproval: true });
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      decision: 'deny',
      source: 'fallback',
      classifierFailure: 'malformed_escalation',
    });
  });

  test('the agent is told a fixed sentence; the classifier failure text goes only into the record', async () => {
    const leaky = 'connect ECONNREFUSED 10.1.2.3:8443 retry with header X-Internal: abc';
    const texts: string[] = [];
    for (const failure of [
      { ok: false, reason: leaky } as const,
      { ok: false, reason: 'timeout' } as const,
      answer(99, 0),
    ]) {
      const h = harness(failure);
      const decision = await h.gate(shell(ESCALATED, h.root));
      if (decision.action !== 'deny') throw new Error('unreachable');
      texts.push(decision.reason);
      expect(decision.reason).not.toContain('ECONNREFUSED');
      expect(decision.reason).not.toContain('timeout');
    }
    // One sentence whatever went wrong: nothing the classifier says reaches the agent.
    expect(new Set(texts).size).toBe(1);

    const h = harness({ ok: false, reason: leaky });
    await h.gate(shell(ESCALATED, h.root));
    expect(h.records[0]?.classifierFailure).toBe(leaky);
  });

  test('the recorded failure text is redacted and capped like every other recorded text', async () => {
    const h = harness(
      { ok: false, reason: `Authorization: Bearer abcdef0123456789abcdef ${'x'.repeat(500)}` },
      { credentialValues: [] }
    );
    await h.gate(shell(ESCALATED, h.root));
    const recorded = h.records[0]?.classifierFailure ?? '';
    expect(recorded).not.toContain('abcdef0123456789abcdef');
    expect(recorded.length).toBeLessThan(260);
  });

  test('with no classifier configured the call is allowed, logged as fallback, and nothing is asked', async () => {
    let asked = 0;
    const h = harness(CALM, {
      classifierConfigured: false,
      escalate: () => {
        asked++;
        return Promise.resolve(FAILED);
      },
    });
    expect(await h.gate(shell(ESCALATED, h.root))).toEqual({ action: 'allow' });
    expect(asked).toBe(0);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      decision: 'allow',
      needsApproval: false,
      source: 'fallback',
      ruleId: 'risk.mutation_verb',
    });
  });

  test('with no classifier configured a deny rule still denies', async () => {
    const h = harness(CALM, { classifierConfigured: false });
    expect((await h.gate(shell(DENIED_BY_RULE, h.root))).action).toBe('deny');
  });
});

describe('redaction', () => {
  const EXACT = 'exact-credential-value-5521';
  const SECRETS = [
    EXACT,
    'header-token-AAAA1111',
    'assigned-value-BBBB2222',
    'url-password-CCCC3333',
    'input-secret-DDDD4444',
  ];
  const command =
    `curl -X POST -H "Authorization: Bearer header-token-AAAA1111" ` +
    `-d "API_KEY=assigned-value-BBBB2222" --trace ${EXACT} ` +
    `https://deploy:url-password-CCCC3333@api.example.com/items`;

  function leaks(value: unknown): string[] {
    const text = JSON.stringify(value);
    return SECRETS.filter(secret => text.includes(secret));
  }

  test('a planted secret reaches neither the classifier, the record nor the denial', async () => {
    const h = harness(answer(3, 1), { credentialValues: [EXACT] });
    const decision = await h.gate({
      ...shell(command, h.root),
      input: { command, env: { DEPLOY_TOKEN: 'input-secret-DDDD4444' } },
    });
    expect(h.calls).toHaveLength(1);
    expect(leaks(h.calls)).toEqual([]);
    expect(leaks(h.records)).toEqual([]);
    expect(leaks(decision)).toEqual([]);
    expect(h.calls[0]?.command).toContain('api.example.com');
    expect(h.records[0]?.redactedPreview).toContain('curl');
  });

  test('an MCP call is described from its redacted input', async () => {
    const h = harness(CALM, { credentialValues: [EXACT] });
    await h.gate({
      toolName: 'mcp__deploy__release',
      kind: 'mcp',
      cwd: h.root,
      input: {
        target: 'production',
        apiToken: 'input-secret-DDDD4444',
        note: `uses ${EXACT} and https://u:url-password-CCCC3333@host/x`,
      },
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.command).toContain('production');
    expect(leaks(h.calls)).toEqual([]);
    expect(leaks(h.records)).toEqual([]);
    expect(h.records[0]?.redactedPreview).toContain('mcp__deploy__release');
  });

  test('a network call has its URL userinfo masked', async () => {
    const h = harness(CALM);
    await h.gate({
      toolName: 'WebFetch',
      kind: 'network',
      cwd: h.root,
      url: 'https://deploy:url-password-CCCC3333@api.example.com/items',
      input: {},
    });
    expect(leaks(h.calls)).toEqual([]);
    expect(leaks(h.records)).toEqual([]);
    expect(h.calls[0]?.targets.join(' ')).toContain('api.example.com');
  });

  test('the preview is capped', async () => {
    const h = harness(CALM);
    await h.gate(shell(`echo ${'x'.repeat(5_000)}`, h.root));
    expect(h.records[0]?.redactedPreview.length).toBeLessThan(400);
  });
});

describe('command hash and decision cache', () => {
  test('the hash is stable for one request and differs for another', async () => {
    const h = harness(CALM);
    await h.gate(shell(ALLOWED, h.root));
    await h.gate(shell(ALLOWED, h.root));
    await h.gate(shell('git diff', h.root));
    const hashes = h.records.map(record => record.commandHash);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]).toBe(hashes[1] ?? '');
    expect(hashes[0]).not.toBe(hashes[2] ?? '');
  });

  test('a repeated escalated command asks the classifier once and still records twice', async () => {
    const h = harness(answer(0.2, 0.1));
    await h.gate(shell(ESCALATED, h.root));
    await h.gate(shell(ESCALATED, h.root));
    expect(h.calls).toHaveLength(1);
    expect(h.records).toHaveLength(2);
    expect(h.records[1]).toMatchObject({ decision: 'allow', source: 'jev', score: 0.2, noul: 0.1 });
  });

  test('a different command, or the same one from another directory, is asked again', async () => {
    const h = harness(CALM);
    await h.gate(shell(ESCALATED, h.root));
    await h.gate(shell('gh pr merge 6', h.root));
    await h.gate(shell(ESCALATED, join(h.root, 'sub')));
    expect(h.calls).toHaveLength(3);
  });

  test('a cache shared by two gates serves the second one', async () => {
    const cache = createToolGateCache();
    const first = harness(answer(3, 1), { cache });
    const second = harness(CALM, { cache, repoRoot: first.root });
    await first.gate(shell(ESCALATED, first.root));
    const decision = await second.gate(shell(ESCALATED, first.root));
    expect(second.calls).toHaveLength(0);
    expect(decision).toMatchObject({ action: 'deny', needsApproval: true });
    expect(second.records).toHaveLength(1);
  });

  test('without a shared cache each gate asks for itself', async () => {
    const first = harness(CALM);
    const second = harness(CALM, { repoRoot: first.root });
    await first.gate(shell(ESCALATED, first.root));
    await second.gate(shell(ESCALATED, first.root));
    expect(second.calls).toHaveLength(1);
  });

  test('a failure is not cached: the next attempt asks again', async () => {
    const answers: ToolGateEscalationResult[] = [FAILED, CALM];
    const h = harness(() => answers.shift() ?? CALM, { maxDenialsPerNode: 5 });
    expect((await h.gate(shell(ESCALATED, h.root))).action).toBe('deny');
    expect((await h.gate(shell(ESCALATED, h.root))).action).toBe('allow');
    expect(h.calls).toHaveLength(2);
  });

  test('a rule deny is judged afresh every time, never served from the cache', async () => {
    const h = harness(CALM, { maxDenialsPerNode: 5 });
    await h.gate(shell(DENIED_BY_RULE, h.root));
    await h.gate(shell(DENIED_BY_RULE, h.root));
    expect(h.records.map(record => record.source)).toEqual(['rule', 'rule']);
  });
});

describe('repeated denials in one node', () => {
  test('after the limit, a further denial tells the agent to stop', async () => {
    const h = harness(CALM, { maxDenialsPerNode: 2 });
    const first = await h.gate(shell(DENIED_BY_RULE, h.root));
    const second = await h.gate(shell('git clean -fd', h.root));
    const third = await h.gate(shell(DENIED_BY_RULE, h.root));
    expect(first).toMatchObject({ ruleId: 'deny.git_reset_hard' });
    expect(second).toMatchObject({ ruleId: 'deny.git_clean_force' });
    expect(third).toMatchObject({ action: 'deny', ruleId: REPEATED_DENIALS_RULE_ID });
    if (third.action !== 'deny') throw new Error('unreachable');
    expect(third.reason).toContain('Stop');
    expect(third.reason).toContain('deny.git_reset_hard');
    expect(h.records).toHaveLength(3);
    expect(h.records[2]).toMatchObject({ decision: 'deny', ruleId: REPEATED_DENIALS_RULE_ID });
  });

  test('classifier and fallback denials count too', async () => {
    const h = harness(answer(3, 1), { maxDenialsPerNode: 1 });
    await h.gate(shell(ESCALATED, h.root));
    const next = await h.gate(shell('gh pr merge 6', h.root));
    expect(next).toMatchObject({ ruleId: REPEATED_DENIALS_RULE_ID, needsApproval: true });
  });

  test('an allowed call is still allowed after the limit', async () => {
    const h = harness(CALM, { maxDenialsPerNode: 1 });
    await h.gate(shell(DENIED_BY_RULE, h.root));
    await h.gate(shell(DENIED_BY_RULE, h.root));
    expect(await h.gate(shell(ALLOWED, h.root))).toEqual({ action: 'allow' });
  });

  test('the count belongs to one gate: another node starts at zero', async () => {
    const cache = createToolGateCache();
    const first = harness(CALM, { maxDenialsPerNode: 1, cache });
    await first.gate(shell(DENIED_BY_RULE, first.root));
    await first.gate(shell(DENIED_BY_RULE, first.root));
    const second = harness(CALM, { maxDenialsPerNode: 1, cache, repoRoot: first.root });
    expect(await second.gate(shell(DENIED_BY_RULE, first.root))).toMatchObject({
      ruleId: 'deny.git_reset_hard',
    });
  });

  test('a new attempt of the same step is a new gate: its count starts at zero and the run cache still answers', async () => {
    const cache = createToolGateCache();
    const first = harness(answer(3, 1), { maxDenialsPerNode: 2, cache });
    await first.gate(shell(ESCALATED, first.root));
    await first.gate(shell(DENIED_BY_RULE, first.root));
    expect(await first.gate(shell(DENIED_BY_RULE, first.root))).toMatchObject({
      ruleId: REPEATED_DENIALS_RULE_ID,
    });
    expect(first.calls).toHaveLength(1);

    const next = harness(answer(3, 1), { maxDenialsPerNode: 2, cache, repoRoot: first.root });
    expect(await next.gate(shell(DENIED_BY_RULE, first.root))).toMatchObject({
      ruleId: 'deny.git_reset_hard',
    });
    const escalated = await next.gate(shell(ESCALATED, first.root));
    expect(escalated).toMatchObject({ action: 'deny', needsApproval: true });
    expect(escalated).not.toMatchObject({ ruleId: REPEATED_DENIALS_RULE_ID });
    // The classifier's answer belongs to the run, not to the attempt.
    expect(next.calls).toHaveLength(0);
  });

  test('the default limit is a positive whole number', () => {
    expect(Number.isInteger(DEFAULT_MAX_DENIALS_PER_NODE)).toBe(true);
    expect(DEFAULT_MAX_DENIALS_PER_NODE).toBeGreaterThan(0);
  });
});

describe('what the classifier is sent is bounded', () => {
  test('a call naming hundreds of targets sends a capped list and says how many were left out', async () => {
    const h = harness(CALM);
    const paths = Array.from({ length: 400 }, (_, index) => `src/gen/out-${String(index)}.tmp`);
    await h.gate(shell(`rm ${paths.join(' ')}`, h.root));

    const sent = h.calls[0]?.targets ?? [];
    expect(sent.length).toBeLessThanOrEqual(MAX_ESCALATION_TARGETS + 1);
    expect(sent[0]).toBe('src/gen/out-0.tmp');
    expect(sent.at(-1)).toBe(`… [${String(400 - MAX_ESCALATION_TARGETS)} more targets]`);
    expect(sent.join('').length).toBeLessThanOrEqual(ESCALATION_TEXT_CAP + 40);
  });

  test('a few very long targets are cut by total length, not only by count', async () => {
    const h = harness(CALM);
    const long = Array.from(
      { length: 15 },
      (_, index) => `src/${'d'.repeat(192)}-${String(index)}`
    );
    await h.gate(shell(`rm ${long.join(' ')}`, h.root));

    const sent = h.calls[0]?.targets ?? [];
    expect(sent.length).toBeLessThan(15);
    expect(sent.at(-1)).toMatch(/^… \[\d+ more targets\]$/);
    expect(sent.join('').length).toBeLessThanOrEqual(ESCALATION_TEXT_CAP + 40);
  });

  test('a short list is sent whole', async () => {
    const h = harness(CALM);
    await h.gate(shell('rm src/a.tmp src/b.tmp', h.root));
    expect(h.calls[0]?.targets).toEqual(['src/a.tmp', 'src/b.tmp']);
  });
});

describe('identical calls made at the same time', () => {
  function slowEscalator(result: ToolGateEscalationResult): {
    escalate: ToolGateOptions['escalate'];
    asked: () => number;
    release: () => void;
  } {
    let asked = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    return {
      escalate: async () => {
        asked++;
        await gate;
        return result;
      },
      asked: () => asked,
      release: () => {
        release();
      },
    };
  }

  test('share one evaluation, one classifier call and one record', async () => {
    const slow = slowEscalator(answer(0, 0));
    const h = harness(CALM, { escalate: slow.escalate });
    const batch = Array.from({ length: 8 }, () => h.gate(shell(ESCALATED, h.root)));
    await new Promise(resolve => setTimeout(resolve, 5));
    slow.release();

    expect(await Promise.all(batch)).toEqual(
      Array.from({ length: 8 }, () => ({ action: 'allow' }))
    );
    expect(slow.asked()).toBe(1);
    expect(h.records).toHaveLength(1);
    // The one record says how many calls it answered.
    expect(h.records[0]?.count).toBe(8);
  });

  test('a call made alone is a record that covers one call', async () => {
    const h = harness(CALM);
    await h.gate(shell(ALLOWED, h.root));
    await h.gate(shell(ESCALATED, h.root));
    expect(h.records.map(record => record.count)).toEqual([1, 1]);
  });

  test('a call that arrives once the record is being written is judged and counted on its own', async () => {
    // The count is final when the record is handed over, so a later caller cannot
    // be answered by a record that does not count it.
    const counts: number[] = [];
    let release: () => void = () => {};
    const writing = new Promise<void>(resolve => {
      release = resolve;
    });
    const h = harness(CALM, {
      record: async event => {
        counts.push(event.count);
        if (counts.length === 1) await writing;
      },
    });
    const first = h.gate(shell(ALLOWED, h.root));
    await new Promise(resolve => setTimeout(resolve, 5));
    const late = h.gate(shell(ALLOWED, h.root));
    release();
    await Promise.all([first, late]);
    expect(counts).toEqual([1, 1]);
  });

  test('count once toward the repeated-denial guard: the batch itself never trips it', async () => {
    const slow = slowEscalator(answer(3, 1));
    const h = harness(CALM, { escalate: slow.escalate, maxDenialsPerNode: 2 });
    const batch = Array.from({ length: 8 }, () => h.gate(shell(ESCALATED, h.root)));
    await new Promise(resolve => setTimeout(resolve, 5));
    slow.release();

    const decisions = await Promise.all(batch);
    for (const decision of decisions) {
      expect(decision).toMatchObject({ action: 'deny', ruleId: 'risk.mutation_verb' });
    }
    // One denial was counted, so one more ordinary denial fits before the guard speaks.
    expect(await h.gate(shell(DENIED_BY_RULE, h.root))).toMatchObject({
      ruleId: 'deny.git_reset_hard',
    });
    expect(await h.gate(shell(DENIED_BY_RULE, h.root))).toMatchObject({
      ruleId: REPEATED_DENIALS_RULE_ID,
    });
  });

  test('different calls made at the same time are judged separately', async () => {
    const slow = slowEscalator(answer(0, 0));
    const h = harness(CALM, { escalate: slow.escalate });
    const batch = [h.gate(shell(ESCALATED, h.root)), h.gate(shell('gh pr merge 6', h.root))];
    await new Promise(resolve => setTimeout(resolve, 5));
    slow.release();
    await Promise.all(batch);
    expect(slow.asked()).toBe(2);
    expect(h.records).toHaveLength(2);
  });

  test('the same call made again after the first finished is judged and recorded again', async () => {
    const h = harness(CALM);
    await h.gate(shell(DENIED_BY_RULE, h.root));
    await h.gate(shell(DENIED_BY_RULE, h.root));
    expect(h.records).toHaveLength(2);
  });

  test('a shared failure reaches every caller and is not kept for the next call', async () => {
    let fail = true;
    const h = harness(CALM, {
      record: () => {
        if (fail) throw new Error('store is down');
      },
    });
    const batch = await Promise.all([
      h.gate(shell(ALLOWED, h.root)),
      h.gate(shell(ALLOWED, h.root)),
    ]);
    expect(batch.map(decision => decision.action)).toEqual(['deny', 'deny']);
    expect(batch[0]).toMatchObject({ ruleId: UNRECORDED_DECISION_RULE_ID });
    fail = false;
    expect(await h.gate(shell(ALLOWED, h.root))).toEqual({ action: 'allow' });
  });
});

describe('advice for a gate with nothing writable', () => {
  const ADVICE = 'This chat has no project. Register one first.';

  function write(path: string, cwd: string): ToolActionRequest {
    return { toolName: 'Write', kind: 'file_write', cwd, paths: [path], input: {} };
  }

  test('a write outside the root is told the advice along with the rule', async () => {
    const h = harness(CALM, { outsideRootAdvice: ADVICE });
    const decision = await h.gate(write(join(makeRoot(), 'x.md'), h.root));
    if (decision.action !== 'deny') throw new Error('unreachable');
    expect(decision.ruleId).toBe('deny.path_outside_root');
    expect(decision.reason).toContain(ADVICE);
    expect(decision.reason).toContain('do not retry');
  });

  test.each([
    ['the classifier denies', answer(3, 1)],
    ['the classifier gives no answer', FAILED],
  ])('a flagged call is told it when %s', async (_name, result) => {
    const h = harness(result, { outsideRootAdvice: ADVICE });
    const decision = await h.gate(shell(ESCALATED, h.root));
    if (decision.action !== 'deny') throw new Error('unreachable');
    expect(decision.needsApproval).toBe(true);
    expect(decision.reason).toContain(ADVICE);
  });

  test('other rule denials are not: the advice would not help with them', async () => {
    const h = harness(CALM, { outsideRootAdvice: ADVICE });
    const decision = await h.gate(shell(DENIED_BY_RULE, h.root));
    if (decision.action !== 'deny') throw new Error('unreachable');
    expect(decision.reason).not.toContain(ADVICE);
  });

  test('without the option nothing is added', async () => {
    const h = harness(CALM);
    const decision = await h.gate(write(join(makeRoot(), 'x.md'), h.root));
    if (decision.action !== 'deny') throw new Error('unreachable');
    expect(decision.reason).not.toContain('Register one first');
  });
});

describe('a request the gate cannot read', () => {
  test.each([['delete'], [undefined], [42]])(
    'an unknown kind (%p) is denied and recorded, whatever else the request says',
    async kind => {
      const h = harness(answer(0, 0));
      const request = { ...shell(ALLOWED, h.root), kind } as unknown as ToolActionRequest;
      const decision = await h.gate(request);
      expect(decision).toMatchObject({
        action: 'deny',
        needsApproval: false,
        ruleId: 'deny.unreadable_request',
      });
      expect(h.calls).toHaveLength(0);
      expect(h.records).toHaveLength(1);
      expect(h.records[0]).toMatchObject({
        decision: 'deny',
        source: 'rule',
        ruleId: 'deny.unreadable_request',
        kind: 'other',
      });
    }
  );

  const PLANTED = 'planted-raw-content-0123456789';
  test.each<[string, Record<string, unknown>]>([
    ['no input', { input: undefined }],
    ['a null input', { input: null }],
    ['an input that is not an object', { input: 7 }],
    ['an input that is a list', { input: [PLANTED] }],
    ['a command that is not text', { command: 10n }],
    ['a command that is an object', { command: { run: PLANTED } }],
    ['paths that are one string', { paths: `${PLANTED} b` }],
    ['paths holding something that is not text', { paths: ['a.txt', 5] }],
    ['a working directory that is not text', { cwd: 5 }],
    ['a tool name that is not text', { toolName: 1 }],
    ['a URL that is not text', { url: 1 }],
    // Spread as text, this would have been read one character at a time.
    ['parsed commands that are one string', { parsedCommands: 'ls' }],
    ['parsed commands holding something that is not text', { parsedCommands: [PLANTED, 3] }],
  ])(
    '%s is denied by rule and recorded once, with nothing of the request in the record',
    async (_name, fields) => {
      const h = harness(CALM);
      const request = {
        ...shell(ALLOWED, h.root),
        input: { command: PLANTED },
        ...fields,
      } as unknown as ToolActionRequest;
      const decision = await h.gate(request);

      const rule = DENY_RULES['deny.unreadable_request'];
      expect(decision).toMatchObject({
        action: 'deny',
        needsApproval: false,
        ruleId: 'deny.unreadable_request',
        alternatives: rule.alternatives,
      });
      if (decision.action !== 'deny') throw new Error('unreachable');
      expect(decision.reason.startsWith(rule.reason)).toBe(true);
      expect(h.calls).toHaveLength(0);
      expect(h.records).toHaveLength(1);
      const tool = typeof fields.toolName === 'number' ? 'unknown' : 'Bash';
      expect(h.records[0]).toMatchObject({
        tool,
        kind: 'other',
        decision: 'deny',
        needsApproval: false,
        source: 'rule',
        ruleId: 'deny.unreadable_request',
        count: 1,
      });
      expect(h.records[0]?.commandHash).toMatch(/^[0-9a-f]{64}$/);
      expect(h.records[0]?.redactedPreview).toContain(tool);
      const recorded = JSON.stringify(h.records);
      expect(recorded).not.toContain(PLANTED);
      expect(recorded).not.toContain(ALLOWED);
    }
  );

  test.each([[null], [undefined], ['Bash'], [3]])(
    'a request that is not an object at all (%p) is denied and recorded',
    async request => {
      const h = harness(CALM);
      const decision = await h.gate(request as unknown as ToolActionRequest);
      expect(decision).toMatchObject({ action: 'deny', ruleId: 'deny.unreadable_request' });
      expect(h.records).toHaveLength(1);
      expect(h.records[0]).toMatchObject({
        tool: 'unknown',
        kind: 'other',
        ruleId: 'deny.unreadable_request',
      });
    }
  );

  test('a tool name is all an unreadable request is recorded by, masked and capped like any recorded text', async () => {
    const secret = 'gho_engineInjectedCredential0123456789';
    const h = harness(CALM, { credentialValues: [secret] });
    const request = {
      ...shell(ALLOWED, h.root),
      toolName: `${secret}${'t'.repeat(2_000)}`,
      input: undefined,
    } as unknown as ToolActionRequest;
    await h.gate(request);
    const recorded = JSON.stringify(h.records);
    expect(recorded).not.toContain(secret);
    expect(recorded.length).toBeLessThan(2_000);
  });

  test('an unreadable request counts toward the repeated-denial guard like any denial', async () => {
    const h = harness(CALM, { maxDenialsPerNode: 1 });
    const request = { ...shell(ALLOWED, h.root), input: null } as unknown as ToolActionRequest;
    await h.gate(request);
    expect(await h.gate(request)).toMatchObject({ ruleId: REPEATED_DENIALS_RULE_ID });
  });
});

describe('records', () => {
  test('latency comes from the injected clock', async () => {
    const ticks = [1_000, 1_042];
    const h = harness(CALM, { now: () => ticks.shift() ?? 2_000 });
    await h.gate(shell(ALLOWED, h.root));
    expect(h.records[0]?.latencyMs).toBe(42);
  });

  test('a record carries exactly the audited fields', async () => {
    const h = harness(answer(0.2, 0.1, 0.8));
    await h.gate(shell(ESCALATED, h.root));
    expect(Object.keys(h.records[0] ?? {}).sort()).toEqual([
      'commandHash',
      'confidence',
      'count',
      'decision',
      'kind',
      'latencyMs',
      'needsApproval',
      'noul',
      'redactedPreview',
      'ruleId',
      'score',
      'source',
      'tool',
    ]);
  });

  test('a record sink that throws denies the call instead of losing the audit trail', async () => {
    const h = harness(CALM, {
      record: () => {
        throw new Error('store is down');
      },
    });
    const decision = await h.gate(shell(ALLOWED, h.root));
    expect(decision).toMatchObject({
      action: 'deny',
      needsApproval: true,
      ruleId: UNRECORDED_DECISION_RULE_ID,
    });
    if (decision.action !== 'deny') throw new Error('unreachable');
    expect(decision.reason).toContain('could not be recorded');
    // What went wrong in the store is not the agent's to read.
    expect(JSON.stringify(decision)).not.toContain('store is down');
  });

  test('an async record sink is waited for before the call is answered', async () => {
    const order: string[] = [];
    const h = harness(CALM, {
      record: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push('recorded');
      },
    });
    await h.gate(shell(ALLOWED, h.root));
    order.push('answered');
    expect(order).toEqual(['recorded', 'answered']);
  });

  test('an async record sink that rejects denies the call, like a throw: never an allow, never unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = harness(CALM, { record: () => Promise.reject(new Error('store is down')) });
      const decision = await h.gate(shell(ALLOWED, h.root));
      expect(decision).toMatchObject({
        action: 'deny',
        needsApproval: true,
        ruleId: UNRECORDED_DECISION_RULE_ID,
      });
      expect(JSON.stringify(decision)).not.toContain('store is down');
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a classifier allow that could not be recorded is denied too', async () => {
    const h = harness(CALM, { record: () => Promise.reject(new Error('store is down')) });
    expect(await h.gate(shell(ESCALATED, h.root))).toMatchObject({
      action: 'deny',
      needsApproval: true,
      ruleId: UNRECORDED_DECISION_RULE_ID,
    });
  });

  test('a call that was already denied stays that denial when its record fails', async () => {
    const recorded = harness(CALM);
    const unrecorded = harness(CALM, {
      repoRoot: recorded.root,
      record: () => Promise.reject(new Error('store is down')),
    });
    const request = shell(DENIED_BY_RULE, recorded.root);
    const decision = await unrecorded.gate(request);
    expect(decision).toMatchObject({ needsApproval: false, ruleId: 'deny.git_reset_hard' });
    expect(decision).toEqual(await recorded.gate(request));
  });

  test('a record failure is logged once, by the name of the error, without its text or the command', async () => {
    class StoreDown extends Error {
      override name = 'StoreDown';
    }
    const logs = captureLogLines();
    try {
      const h = harness(CALM, {
        record: () => Promise.reject(new StoreDown('insert failed for row planted-row-text')),
      });
      await h.gate(shell(ALLOWED, h.root));
      const failures = logs.lines.filter(line => line.msg === 'tool_gate.decision_record_failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ errorName: 'StoreDown' });
      const logged = JSON.stringify(logs.lines);
      expect(logged).not.toContain('planted-row-text');
      expect(logged).not.toContain(ALLOWED);
    } finally {
      logs.restore();
    }
  });

  test('a sink that fails with something that is not an error is still a denial', async () => {
    const h = harness(CALM, {
      record: () => Promise.reject('store is down'),
    });
    const decision = await h.gate(shell(ALLOWED, h.root));
    expect(decision).toMatchObject({ action: 'deny', ruleId: UNRECORDED_DECISION_RULE_ID });
    expect(JSON.stringify(decision)).not.toContain('store is down');
  });

  test('calls denied because they could not be recorded count toward the repeated-denial guard', async () => {
    const h = harness(CALM, {
      maxDenialsPerNode: 1,
      record: () => Promise.reject(new Error('store is down')),
    });
    expect(await h.gate(shell(ALLOWED, h.root))).toMatchObject({
      ruleId: UNRECORDED_DECISION_RULE_ID,
    });
    const second = await h.gate(shell('git diff', h.root));
    expect(second).toMatchObject({ action: 'deny', ruleId: REPEATED_DENIALS_RULE_ID });
    if (second.action !== 'deny') throw new Error('unreachable');
    expect(second.reason).toContain(UNRECORDED_DECISION_RULE_ID);
  });
});

// A provider's shell may keep its working directory between calls, and the gate
// is told only the directory each request reports.
describe('a shell that may be standing outside the root', () => {
  const LEAVE = 'cd ..';
  const RELATIVE_WRITE = 'echo hi > notes.txt';
  const BY_RULE = { decision: 'allow', source: 'rule' } as const;

  test('control: a relative write from the root is allowed by rule', async () => {
    const h = harness(CALM);
    await h.gate(shell(RELATIVE_WRITE, h.root));
    expect(h.records.at(-1)).toMatchObject(BY_RULE);
  });

  test.each([
    ['the classifier', true],
    ['nobody, no classifier being configured', false],
  ])(
    'once a call that leaves the root was allowed by %s, a later relative path is no longer placed by the reported directory',
    async (_who, classifierConfigured) => {
      const h = harness(CALM, { classifierConfigured });
      expect(await h.gate(shell(LEAVE, h.root))).toEqual({ action: 'allow' });
      expect(h.records.at(-1)).toMatchObject({ ruleId: 'risk.cwd_outside_root' });

      const later = await h.gate(shell(RELATIVE_WRITE, h.root));
      expect(h.records.at(-1)).not.toMatchObject(BY_RULE);
      expect(later).toMatchObject({ action: 'deny' });
      // A call that names no path is judged as before.
      await h.gate(shell(ALLOWED, h.root));
      expect(h.records.at(-1)).toMatchObject(BY_RULE);
    }
  );

  test('a call that leaves the root and was denied did not run: nothing changes', async () => {
    const h = harness(answer(3, 1));
    expect(await h.gate(shell(LEAVE, h.root))).toMatchObject({ action: 'deny' });
    await h.gate(shell(RELATIVE_WRITE, h.root));
    expect(h.records.at(-1)).toMatchObject(BY_RULE);
  });

  test('nor does one whose allow could not be recorded', async () => {
    let fail = true;
    const records: ToolGateDecisionEvent[] = [];
    const h = harness(CALM, {
      record: event => {
        if (fail) throw new Error('store is down');
        records.push(event);
      },
    });
    expect(await h.gate(shell(LEAVE, h.root))).toMatchObject({ action: 'deny' });
    fail = false;
    await h.gate(shell(RELATIVE_WRITE, h.root));
    expect(records.at(-1)).toMatchObject(BY_RULE);
  });

  test('a file-writing tool reports its own directory and is judged by it', async () => {
    const h = harness(CALM);
    await h.gate(shell(LEAVE, h.root));
    const write: ToolActionRequest = {
      toolName: 'Write',
      kind: 'file_write',
      cwd: h.root,
      paths: ['notes.txt'],
      input: {},
    };
    expect(await h.gate(write)).toEqual({ action: 'allow' });
    expect(h.records.at(-1)).toMatchObject(BY_RULE);
  });

  test('a new attempt starts in the directory it reports: the next gate trusts it again', async () => {
    const cache = createToolGateCache();
    const first = harness(CALM, { cache });
    await first.gate(shell(LEAVE, first.root));
    const next = harness(CALM, { cache, repoRoot: first.root });
    await next.gate(shell(RELATIVE_WRITE, first.root));
    expect(next.records.at(-1)).toMatchObject(BY_RULE);
  });
});

describe('building the gate', () => {
  test('a relative repo root is refused', () => {
    expect(() => harness(CALM, { repoRoot: 'relative/path' })).toThrow(/absolute/);
  });

  test('a repo root that does not exist is refused', () => {
    expect(() => harness(CALM, { repoRoot: join(makeRoot(), 'missing') })).toThrow();
  });

  test.each([0, -1, 1.5, Number.NaN])('a denial limit of %p is refused', limit => {
    expect(() => harness(CALM, { maxDenialsPerNode: limit })).toThrow(/maxDenialsPerNode/);
  });

  test('a relative extra write root is refused', () => {
    expect(() => harness(CALM, { extraWriteRoots: ['artifacts'] })).toThrow(
      /extraWriteRoots.*absolute/
    );
  });

  test('a relative protected path is refused', () => {
    expect(() => harness(CALM, { protectedPaths: ['codex-home'] })).toThrow(
      /protectedPaths.*absolute/
    );
  });

  test.skipIf(isWindows)(
    'an extra write root that would open the home directory or the whole disk is refused',
    () => {
      const home = makeRoot();
      for (const root of ['/', home, join(home, '..')]) {
        expect(() => harness(CALM, { homeDir: home, extraWriteRoots: [root] })).toThrow(
          /extraWriteRoots/
        );
      }
    }
  );
});

describe.skipIf(isWindows)('extra write roots', () => {
  function write(path: string, cwd: string): ToolActionRequest {
    return { toolName: 'Write', kind: 'file_write', cwd, paths: [path], input: {} };
  }

  test('without the option a write beside the repository is denied', async () => {
    const artifacts = makeRoot();
    const h = harness(CALM);
    expect(await h.gate(write(join(artifacts, 'plan.md'), h.root))).toMatchObject({
      action: 'deny',
      ruleId: 'deny.path_outside_root',
    });
  });

  test('with the option the same write is allowed by rule, and nothing else outside is', async () => {
    const artifacts = makeRoot();
    const elsewhere = makeRoot();
    const h = harness(CALM, { extraWriteRoots: [artifacts] });
    expect(await h.gate(write(join(artifacts, 'plan.md'), h.root))).toEqual({ action: 'allow' });
    expect(h.records[0]).toMatchObject({ source: 'rule', ruleId: 'allow.write_in_root' });
    expect(await h.gate(write(join(elsewhere, 'plan.md'), h.root))).toMatchObject({
      action: 'deny',
      ruleId: 'deny.path_outside_root',
    });
    expect(h.calls).toHaveLength(0);
  });

  test('the root is compared by where it really is, so a symlinked spelling still matches', async () => {
    const base = makeRoot();
    const real = join(base, 'real-artifacts');
    mkdirSync(real);
    symlinkSync(real, join(base, 'artifacts-link'));
    const h = harness(CALM, { extraWriteRoots: [join(base, 'artifacts-link')] });
    expect(await h.gate(write(join(real, 'a.md'), h.root))).toEqual({ action: 'allow' });
    expect(await h.gate(write(join(base, 'artifacts-link', 'b.md'), h.root))).toEqual({
      action: 'allow',
    });
  });

  test('a root that does not exist yet is accepted and covers what is later written there', async () => {
    const base = makeRoot();
    const h = harness(CALM, { extraWriteRoots: [join(base, 'not-yet', 'artifacts')] });
    expect(await h.gate(write(join(base, 'not-yet', 'artifacts', 'a.md'), h.root))).toEqual({
      action: 'allow',
    });
    expect(await h.gate(write(join(base, 'not-yet', 'other.md'), h.root))).toMatchObject({
      action: 'deny',
      ruleId: 'deny.path_outside_root',
    });
  });

  test('a secret-shaped name in the path to the root does not make every write there a secret', async () => {
    const base = makeRoot();
    const artifacts = join(base, 'secrets', 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    const h = harness(CALM, { extraWriteRoots: [artifacts] });
    expect(await h.gate(write(join(artifacts, 'plan.md'), h.root))).toEqual({ action: 'allow' });
    expect(await h.gate(write(join(artifacts, 'secrets', 'k.txt'), h.root))).toMatchObject({
      action: 'deny',
      ruleId: 'deny.secret_write',
    });
  });

  test.each([
    ['a nested new directory', 'file_write', '{extra}/reports/2026/summary.json', 'allow'],
    ['a shell redirect', 'shell', 'echo done > {extra}/notes.md', 'allow'],
    ['a copy into the root', 'shell', 'cp README.md {extra}/', 'allow'],
    [
      'mkdir and touch',
      'shell',
      'mkdir -p {extra}/evidence && touch {extra}/evidence/run.log',
      'allow',
    ],
    ['an env file', 'file_write', '{extra}/.env', 'deny.secret_write'],
    ['a key file by redirect', 'shell', 'echo x > {extra}/deploy.pem', 'deny.secret_write'],
    ['a .. escape', 'file_write', '{extra}/../outside/x.txt', 'deny.path_outside_root'],
    ['a symlink escape', 'file_write', '{extra}/link-out/x.txt', 'deny.path_outside_root'],
    [
      'a sibling with the same prefix',
      'file_write',
      '{extra}-sibling/x.txt',
      'deny.path_outside_root',
    ],
    ['removing the root itself', 'shell', 'rm -rf {extra}', 'deny.rm_recursive_root'],
    ['removing everything in it', 'shell', 'rm -rf {extra}/*', 'deny.rm_recursive_root'],
    [
      'a protected credential file',
      'file_write',
      '{extra}/codex-home/auth.json',
      'deny.secret_write',
    ],
    ['removing a protected directory', 'shell', 'rm -rf {extra}/codex-home', 'deny.secret_write'],
    [
      'moving a protected file out',
      'shell',
      'mv {extra}/codex-home/auth.json build/leak.json',
      'deny.secret_write',
    ],
    ['removing a sub-directory', 'shell', 'rm -rf {extra}/tmp', 'risk.mutation_verb'],
    ['a working directory there', 'shell', 'cd {extra} && ls', 'risk.cwd_outside_root'],
  ] as const)('in an extra root, %s → %s', async (_name, kind, text, expected) => {
    const base = makeRoot();
    const extra = join(base, 'extra');
    const outside = join(base, 'outside');
    mkdirSync(join(extra, 'tmp'), { recursive: true });
    mkdirSync(join(extra, 'codex-home'));
    mkdirSync(outside);
    symlinkSync('../outside', join(extra, 'link-out'));
    const h = harness(CALM, {
      classifierConfigured: false,
      extraWriteRoots: [extra],
      protectedPaths: [join(extra, 'codex-home')],
    });
    mkdirSync(join(h.root, 'build'));
    const filled = text.replaceAll('{extra}', extra);
    const decision = await h.gate(kind === 'shell' ? shell(filled, h.root) : write(filled, h.root));

    if (expected === 'allow') {
      expect(decision).toEqual({ action: 'allow' });
      expect(h.records[0]?.source).toBe('rule');
    } else if (expected.startsWith('risk.')) {
      // Flagged, not settled: with no classifier it runs and the record says so.
      expect(decision).toEqual({ action: 'allow' });
      expect(h.records[0]).toMatchObject({ source: 'fallback', ruleId: expected });
    } else {
      expect(decision).toMatchObject({ action: 'deny', ruleId: expected });
    }
  });

  test('a protected path is refused even inside the repository', async () => {
    const root = makeRoot();
    const h = harness(CALM, { repoRoot: root, protectedPaths: [join(root, 'managed')] });
    expect(await h.gate(write('managed/token.txt', root))).toMatchObject({
      action: 'deny',
      ruleId: 'deny.secret_write',
    });
    expect(await h.gate(write('managed-notes.txt', root))).toEqual({ action: 'allow' });
  });
});
