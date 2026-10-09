import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Fetch } from '../packages/workflows/src/jev/jev-client';
import { ROUTER_DEFAULTS } from '../packages/workflows/src/jev/model-router';
import { packInstances, unmatchedSteps } from './model-router-lowerable';
import {
  EVAL_CASES,
  MIN_ROUTINE_LOWERED_SHARE,
  PACK_ROOT,
  formatReport,
  main,
  readCases,
  runEval,
  scoreResults,
  type CaseResult,
  type EvalCase,
} from './model-router-eval';

const KEY = 'eval-key-that-must-not-be-printed';
const LIVE_ENV = { JEV_API_KEY: KEY };

interface Reply {
  choice: string;
  probability?: number;
  confidence?: number;
  risk?: number;
  ambiguity?: number;
}

/** A classifier that answers each request from its task text. */
function classifier(reply: (task: string) => Reply | Response): {
  fetch: Fetch;
  tasks: string[];
  steps: string[];
} {
  const tasks: string[] = [];
  const steps: string[] = [];
  const fetch: Fetch = (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { state: { task: string; step: string } };
    tasks.push(body.state.task);
    steps.push(body.state.step);
    const answer = reply(body.state.task);
    if (answer instanceof Response) return Promise.resolve(answer);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          answers: {
            tier: {
              type: 'choice',
              choice: answer.choice,
              probabilities: { [answer.choice]: answer.probability ?? 0.95 },
              confidence: answer.confidence ?? 0.9,
            },
            high_risk: { type: 'noul', noul: answer.risk ?? 0.02 },
            ambiguous_or_multi_step: { type: 'noul', noul: answer.ambiguity ?? 0.05 },
          },
        }),
        { status: 200 }
      )
    );
  };
  return { fetch, tasks, steps };
}

const features = {
  has_output_format: true,
  tools_declared: false,
  mcp_present: false,
  skills_present: false,
  mutates_checkout: true,
};
const evalCase = (
  id: string,
  label: EvalCase['label_min_tier'],
  kind: EvalCase['kind'],
  node = 'discover-checks'
): EvalCase => ({
  id,
  node,
  task: `task for ${id}`,
  features,
  label_min_tier: label,
  kind,
  split: 'tuning',
});

const result = (fields: Partial<CaseResult> & Pick<CaseResult, 'id'>): CaseResult => ({
  node: 'discover-checks',
  kind: 'extraction',
  split: 'tuning',
  label: 'small',
  routedTier: 'small',
  answered: true,
  underRouted: false,
  source: 'jev',
  chosenTier: 'small',
  probability: 0.95,
  confidence: 0.9,
  riskNoul: 0.02,
  ambiguityNoul: 0.05,
  ...fields,
});

async function capture(
  argv: string[],
  env: NodeJS.ProcessEnv,
  fetch?: Fetch
): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await main(argv, env, line => lines.push(line), fetch);
  return { code, text: lines.join('\n') };
}

describe('the labelled set', () => {
  it('has at least 60 cases, about a third each routine, ordinary and complex', async () => {
    const cases = await readCases(EVAL_CASES);
    expect(cases.length).toBeGreaterThanOrEqual(60);
    const share = (kinds: string[]): number =>
      cases.filter(c => kinds.includes(c.kind)).length / cases.length;
    for (const group of [
      ['extraction', 'mechanical'],
      ['implementation'],
      ['architecture', 'high_risk'],
    ]) {
      expect(share(group)).toBeGreaterThan(0.25);
      expect(share(group)).toBeLessThan(0.42);
    }
  });

  it('names only commands the repository ships, with unique ids and tasks', async () => {
    const cases = await readCases(EVAL_CASES);
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map(c => c.task)).size).toBe(cases.length);
    const repoCommands = join(PACK_ROOT, '../../commands');
    const dirs = [
      ...[
        'deliver',
        'implement',
        'investigate',
        'plan',
        'pr',
        'review',
        'scout',
        'triage',
        'upkeep',
        'validate',
      ].map(workflow => join(PACK_ROOT, workflow, 'commands')),
      join(repoCommands, 'defaults'),
      repoCommands,
    ];
    for (const node of new Set(cases.map(c => c.node))) {
      const found = dirs.some(dir => existsSync(join(dir, `${node}.md`)));
      expect({ node, found }).toEqual({ node, found: true });
    }
  });

  it('keeps a second held-out group that shares no command with the tuning half', async () => {
    const cases = await readCases(EVAL_CASES);
    const tuned = new Set(cases.filter(c => c.split === 'tuning').map(c => c.node));
    const fresh = cases.filter(c => c.split === 'heldout2');
    expect(fresh.length).toBeGreaterThanOrEqual(12);
    expect(fresh.filter(c => tuned.has(c.node))).toEqual([]);
    for (const kinds of [
      ['extraction', 'mechanical'],
      ['implementation'],
      ['architecture', 'high_risk'],
    ]) {
      expect(fresh.some(c => kinds.includes(c.kind))).toBe(true);
    }
  });

  it('splits every kind evenly into a tuning half and a held-out half', async () => {
    const cases = await readCases(EVAL_CASES);
    const count = (split: string, kind: string): number =>
      cases.filter(c => c.split === split && c.kind === kind).length;
    for (const kind of new Set(cases.map(c => c.kind))) {
      expect(Math.abs(count('tuning', kind) - count('heldout', kind))).toBeLessThanOrEqual(1);
    }
  });

  it('labels every routine case small and no complex case below large', async () => {
    for (const c of await readCases(EVAL_CASES)) {
      if (c.kind === 'extraction' || c.kind === 'mechanical')
        expect(c.label_min_tier).toBe('small');
      if (c.kind === 'architecture' || c.kind === 'high_risk')
        expect(c.label_min_tier).toBe('large');
    }
  });

  it('refuses a cases file it cannot read', async () => {
    const path = join(import.meta.dir, 'fixtures/model-router-eval/does-not-exist.jsonl');
    await expect(readCases(path)).rejects.toThrow();
  });
});

describe('scoreResults: the arithmetic', () => {
  it('counts a case routed below its label as under-routed and fails on one', () => {
    const score = scoreResults(
      [
        result({ id: 'a' }),
        result({
          id: 'b',
          kind: 'implementation',
          label: 'medium',
          routedTier: 'small',
          underRouted: true,
        }),
        result({
          id: 'c',
          kind: 'high_risk',
          label: 'large',
          routedTier: 'large',
          chosenTier: 'large',
        }),
      ],
      'large',
      ROUTER_DEFAULTS
    );
    expect(score.underRouted).toEqual(['b']);
    expect(score.confusion).toEqual({
      small: { small: 1, medium: 0, large: 0 },
      medium: { small: 1, medium: 0, large: 0 },
      large: { small: 0, medium: 0, large: 1 },
    });
    expect(score.scored).toBe(true);
    expect(score.pass).toBe(false);
  });

  it('passes only when enough routine cases were lowered', () => {
    const routine = (id: string, lowered: boolean): CaseResult =>
      result({
        id,
        routedTier: lowered ? 'small' : 'large',
        chosenTier: lowered ? 'small' : 'large',
      });
    const half = scoreResults([routine('a', true), routine('b', false)], 'large', ROUTER_DEFAULTS);
    expect(half.routineLoweredShare).toBe(0.5);
    expect(half.pass).toBe(MIN_ROUTINE_LOWERED_SHARE <= 0.5);
    const none = scoreResults([routine('a', false), routine('b', false)], 'large', ROUTER_DEFAULTS);
    expect(none.underRouted).toEqual([]);
    expect(none.routineLoweredShare).toBe(0);
    expect(none.pass).toBe(false);
  });

  it('does not score a run in which the classifier left a case unanswered', () => {
    const score = scoreResults(
      [
        result({ id: 'a' }),
        result({
          id: 'b',
          answered: false,
          source: 'fallback',
          reason: 'timeout',
          routedTier: 'large',
        }),
      ],
      'large',
      ROUTER_DEFAULTS
    );
    expect(score.scored).toBe(false);
    expect(score.pass).toBe(false);
    expect(score.unanswered).toEqual(['b']);
  });

  it('reports the highest risk and ambiguity thresholds that keep under-routing at zero', () => {
    const score = scoreResults(
      [
        result({ id: 'safe', riskNoul: 0.1, ambiguityNoul: 0.1 }),
        // Chosen small but labelled large: only the floors keep these two at the ceiling.
        result({
          id: 'risky',
          kind: 'high_risk',
          label: 'large',
          routedTier: 'large',
          riskNoul: 0.4,
          reason: 'high_risk',
        }),
        result({
          id: 'riskier',
          kind: 'high_risk',
          label: 'large',
          routedTier: 'large',
          riskNoul: 0.8,
          reason: 'high_risk',
        }),
        result({
          id: 'vague',
          kind: 'architecture',
          label: 'large',
          routedTier: 'large',
          ambiguityNoul: 0.6,
          reason: 'ambiguous_or_multi_step',
        }),
      ],
      'large',
      ROUTER_DEFAULTS
    );
    expect(score.underRouted).toEqual([]);
    // Any risk threshold above 0.4 lets `risky` through; any ambiguity threshold above 0.6 lets `vague` through.
    expect(score.limits.maxRiskThreshold).toBe(0.4);
    expect(score.limits.maxAmbiguityThreshold).toBe(0.6);
    expect(score.limits.probabilityMustExceed).toBeNull();
    expect(score.limits.confidenceMustExceed).toBeNull();
  });

  it('reports the probability and confidence a wrong cheap pick reached', () => {
    const score = scoreResults(
      [
        result({ id: 'safe' }),
        result({
          id: 'unsure',
          kind: 'implementation',
          label: 'medium',
          routedTier: 'large',
          probability: 0.65,
          reason: 'low_probability',
        }),
        result({
          id: 'shaky',
          kind: 'implementation',
          label: 'medium',
          routedTier: 'large',
          confidence: 0.45,
          reason: 'low_confidence',
        }),
      ],
      'large',
      ROUTER_DEFAULTS
    );
    expect(score.limits.probabilityMustExceed).toBe(0.65);
    expect(score.limits.confidenceMustExceed).toBe(0.45);
    expect(score.limits.maxRiskThreshold).toBeNull();
  });
});

describe('runEval', () => {
  const cases = [
    evalCase('routine-1', 'small', 'extraction'),
    evalCase('routine-2', 'small', 'mechanical', 'pr'),
    evalCase('ordinary', 'medium', 'implementation', 'triage'),
    evalCase('risky', 'large', 'high_risk', 'plan'),
  ];

  it('runs every case through the router and scores what it routed', async () => {
    const { fetch, tasks } = classifier(task =>
      task.includes('routine')
        ? { choice: 'small' }
        : task.includes('ordinary')
          ? { choice: 'medium' }
          : { choice: 'small', risk: 0.9 }
    );
    const report = await runEval({
      cases,
      packRoot: PACK_ROOT,
      ceiling: 'large',
      env: LIVE_ENV,
      dry: false,
      fetch,
    });
    expect(tasks).toHaveLength(4);
    expect(report.dry).toBe(false);
    expect(report.results.map(r => [r.id, r.routedTier, r.underRouted])).toEqual([
      ['routine-1', 'small', false],
      ['routine-2', 'small', false],
      ['ordinary', 'medium', false],
      ['risky', 'large', false],
    ]);
    expect(report.score.pass).toBe(true);
    expect(report.score.routineLoweredShare).toBe(1);
  });

  it('never scores a label above the ceiling as under-routing', async () => {
    const { fetch } = classifier(task => ({
      choice: task.includes('routine') ? 'small' : 'medium',
    }));
    const report = await runEval({
      cases,
      packRoot: PACK_ROOT,
      ceiling: 'medium',
      env: LIVE_ENV,
      dry: false,
      fetch,
    });
    expect(report.results.find(r => r.id === 'risky')).toMatchObject({
      label: 'medium',
      routedTier: 'medium',
      underRouted: false,
    });
    expect(report.score.underRouted).toEqual([]);
  });

  it('answers from the labels in a dry run, with no key and nothing sent anywhere', async () => {
    const report = await runEval({
      cases,
      packRoot: PACK_ROOT,
      ceiling: 'large',
      env: {},
      dry: true,
    });
    expect(report.dry).toBe(true);
    expect(report.score.underRouted).toEqual([]);
    expect(report.score.pass).toBe(true);
  });
});

describe('which pack steps can be lowered on a tier map', () => {
  const REPO_ROOT = join(PACK_ROOT, '../../..');

  it('lowers only steps that declare a contract, write the checkout and sit clear of any session', async () => {
    const instances = await packInstances(REPO_ROOT, PACK_ROOT, 'codex-small');
    const lowerable = instances.filter(instance => instance.lowerable);
    expect(lowerable.length).toBeGreaterThan(0);
    for (const instance of lowerable) {
      const { node } = instance.candidate;
      expect(node.output_format).toBeDefined();
      expect(node.mutates_checkout).not.toBe(false);
      expect(instance.candidate.sameProviderOnly).toBe(false);
      expect(instance.authoredTier).toBe('medium');
      expect(instance.target).toBe('small (codex)');
    }
    // Every step without an output contract is refused for that reason and no other.
    for (const instance of instances) {
      if (instance.authoredTier !== 'medium') continue;
      if (
        instance.candidate.node.output_format === undefined &&
        instance.candidate.node.mutates_checkout !== false
      ) {
        expect({ id: instance.nodeId, reason: instance.reason }).toEqual({
          id: instance.nodeId,
          reason: 'unverifiable',
        });
      }
    }
  });

  it('never lowers a read-only step, across providers or within one', async () => {
    for (const map of ['codex-small', 'claude-only'] as const) {
      const readOnly = (await packInstances(REPO_ROOT, PACK_ROOT, map)).filter(
        i => i.authoredTier === 'medium' && i.candidate.node.mutates_checkout === false
      );
      expect(readOnly.length).toBeGreaterThan(0);
      expect(
        readOnly.map(i => ({ id: i.nodeId, lowerable: i.lowerable, reason: i.reason }))
      ).toEqual(readOnly.map(i => ({ id: i.nodeId, lowerable: false, reason: 'read_only_node' })));
    }
  });

  it('refuses review-scope on a strict provider: its contract has an object with no properties, which that provider closes and then rejects', async () => {
    const scope = (
      map: 'codex-small' | 'claude-only'
    ): Promise<{ lowerable: boolean; reason?: string }[]> =>
      packInstances(REPO_ROOT, PACK_ROOT, map).then(instances =>
        instances
          .filter(i => i.command === 'review-scope')
          .map(i => ({
            lowerable: i.lowerable,
            ...(i.reason !== undefined ? { reason: i.reason } : {}),
          }))
      );
    const across = await scope('codex-small');
    expect(across.length).toBeGreaterThan(1);
    expect(across).toEqual(across.map(() => ({ lowerable: false, reason: 'open_schema' })));
    // The same contract on a provider that enforces it as written is no obstacle.
    const within = await scope('claude-only');
    expect(within).toEqual(within.map(() => ({ lowerable: true })));
  });

  it('names a composed step by the command its own workflow names', async () => {
    const instances = await packInstances(REPO_ROOT, PACK_ROOT, 'codex-small');
    const composed = instances.filter(i => i.candidate.node.source.kind === 'inline');
    expect(composed.length).toBeGreaterThan(0);
    expect(composed.filter(i => i.command === undefined)).toEqual([]);
    expect(composed.filter(i => i.stepName !== i.command)).toEqual([]);
    const names = (command: string): string[] =>
      instances.filter(i => i.command === command).map(i => `${i.workflow}/${i.nodeId}`);
    expect(names('discover-checks')).toEqual([
      'archon-deliver/validate__discover',
      'archon-ship/deliver__validate__discover',
      'archon-upkeep/deliver__validate__discover',
      'archon-validate/discover',
    ]);
  });

  it("lowers only the operator's listed steps, standalone and composed, and says not_listed for the rest", async () => {
    const steps = ['discover-checks', 'sync-pr-body'];
    const all = await packInstances(REPO_ROOT, PACK_ROOT, 'codex-small');
    const listed = await packInstances(REPO_ROOT, PACK_ROOT, 'codex-small', { steps });
    const key = (i: { workflow: string; nodeId: string }): string => `${i.workflow}/${i.nodeId}`;
    // Exactly the steps that were lowerable before and carry a listed name.
    expect(listed.filter(i => i.lowerable).map(key)).toEqual(
      all.filter(i => i.lowerable && steps.includes(i.stepName)).map(key)
    );
    expect(
      listed.filter(i => i.lowerable).some(i => i.candidate.node.source.kind === 'inline')
    ).toBe(true);
    expect(
      listed.filter(i => i.lowerable).some(i => i.candidate.node.source.kind === 'command')
    ).toBe(true);
    for (const instance of listed) {
      if (instance.authoredTier !== 'medium' || steps.includes(instance.stepName)) continue;
      expect({ id: key(instance), reason: instance.reason }).toEqual({
        id: key(instance),
        reason: 'not_listed',
      });
    }
    // An empty list lowers nothing. A list can only take steps away.
    const none = await packInstances(REPO_ROOT, PACK_ROOT, 'codex-small', { steps: [] });
    expect(none.filter(i => i.lowerable)).toEqual([]);
  });

  it('reports a listed name that matches no step, as a warning and not a failure', async () => {
    const steps = ['discover-checks', 'discover-cheks'];
    const instances = await packInstances(REPO_ROOT, PACK_ROOT, 'codex-small', { steps });
    expect(unmatchedSteps(instances, steps)).toEqual(['discover-cheks']);
    expect(unmatchedSteps(instances, undefined)).toEqual([]);
    const { code, text } = await capture(
      ['--lowerable', 'codex-small', '--steps', steps.join(',')],
      {}
    );
    expect(code).toBe(0);
    expect(text).toContain('steps: discover-checks, discover-cheks');
    expect(text).toContain('WARNING: no step in the pack is named discover-cheks.');
    expect((await capture(['--lowerable', 'codex-small'], {})).text).toContain('steps: not set');
  });

  it('prints the report without calling a classifier', async () => {
    const { fetch, tasks } = classifier(() => ({ choice: 'small' }));
    const { code, text } = await capture(['--lowerable', 'codex-small'], LIVE_ENV, fetch);
    expect(code).toBe(0);
    expect(tasks).toEqual([]);
    expect(text).toContain("on the 'codex-small' map");
    expect(text).toMatch(/Single-shot agent steps: \d+; on a routable tier: \d+; lowerable: \d+/);
    expect((await capture(['--lowerable', 'nope'], {})).code).toBe(2);
  });
});

describe('main with a tier map', () => {
  interface MapReport {
    map: string;
    ceiling: string;
    results: {
      id: string;
      node: string;
      instance?: string;
      offered: boolean;
      notOfferedReason?: string;
    }[];
  }

  it("asks about every step that runs a case's command and can be lowered, and says why not for the rest", async () => {
    const { fetch, tasks } = classifier(() => ({ choice: 'small' }));
    const { code, text } = await capture(['--map', 'codex-small', '--json'], LIVE_ENV, fetch);
    const report = JSON.parse(text) as MapReport;
    expect(report.map).toBe('codex-small');
    expect(report.ceiling).toBe('medium');
    const offered = report.results.filter(r => r.offered);
    expect(tasks).toHaveLength(offered.length);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.length).toBeLessThan(report.results.length);
    expect(
      report.results.filter(r => !r.offered).every(r => typeof r.notOfferedReason === 'string')
    ).toBe(true);
    // One row per lowerable step of the case's command: the standalone step and its
    // composed copies, each named.
    const lowerable = (await packInstances(join(PACK_ROOT, '../../..'), PACK_ROOT, 'codex-small'))
      .filter(i => i.lowerable && i.command === 'discover-checks')
      .map(i => `${i.workflow}/${i.nodeId}`);
    expect(lowerable.length).toBeGreaterThan(1);
    const [first] = offered.filter(r => r.node === 'discover-checks');
    expect(offered.filter(r => r.id === first?.id).map(r => r.instance)).toEqual(lowerable);
    // A classifier that says "small" to everything under-routes the offered risky cases.
    expect(code).toBe(1);
  });

  it("classifies each step with its own text: a composed step's compiled prompt, not the command file", async () => {
    const cases = (await readCases(EVAL_CASES))
      .filter(c => c.node === 'discover-checks')
      .slice(0, 1);
    const { fetch, steps } = classifier(() => ({ choice: 'small' }));
    const report = await runEval({
      cases,
      packRoot: PACK_ROOT,
      ceiling: 'medium',
      env: LIVE_ENV,
      dry: false,
      fetch,
      map: 'codex-small',
    });
    const instances = (
      await packInstances(join(PACK_ROOT, '../../..'), PACK_ROOT, 'codex-small')
    ).filter(i => i.lowerable && i.command === 'discover-checks');
    expect(report.results.map(r => r.instance)).toEqual(
      instances.map(i => `${i.workflow}/${i.nodeId}`)
    );
    const file = await Bun.file(join(PACK_ROOT, 'validate/commands/discover-checks.md')).text();
    const sent = new Map(report.results.map((r, index) => [r.instance, steps[index]]));
    const head = (text: string): string => text.slice(0, 200);
    // The standalone step sends the command file. Every composed step sends the prompt
    // the loader compiled for it, which is the text that step runs.
    expect(head(sent.get('archon-validate/discover') ?? '')).toBe(head(file));
    for (const instance of instances) {
      const { source } = instance.candidate.node;
      if (source.kind !== 'inline') continue;
      const own = sent.get(`${instance.workflow}/${instance.nodeId}`) ?? '';
      expect(own.length).toBeGreaterThan(0);
      expect(source.prompt.startsWith(own.slice(0, 200))).toBe(true);
    }
    expect(new Set(steps).size).toBeGreaterThan(1);
  });

  it("asks only about the operator's listed steps with --steps", async () => {
    const { fetch, tasks } = classifier(() => ({ choice: 'small' }));
    const { text } = await capture(
      ['--map', 'codex-small', '--steps', 'sync-pr-body', '--json'],
      LIVE_ENV,
      fetch
    );
    const report = JSON.parse(text) as MapReport;
    const offered = report.results.filter(r => r.offered);
    expect(offered.length).toBeGreaterThan(0);
    expect(tasks).toHaveLength(offered.length);
    expect([...new Set(offered.map(r => r.node))]).toEqual(['sync-pr-body']);
    expect(
      report.results.filter(r => r.node === 'discover-checks').map(r => r.notOfferedReason)
    ).toContain('not_listed');
    // Without a map there is no pack step to list.
    expect((await capture(['--steps', 'sync-pr-body', '--dry'], {})).code).toBe(2);
  });

  it('keeps the lowerable count apart from the agreement verdict', async () => {
    const { text, code } = await capture(['--map', 'codex-small', '--dry'], {});
    expect(code).toBe(0);
    expect(text).toMatch(/Can be lowered on this map: \d+ of \d+ cases, as \d+ step instances/);
    expect(text).toContain('Not offered, by reason:');
    expect(text.trim().split('\n').at(-1)).toMatch(
      /PASS\. No step instance was routed below its case's label\.$/
    );
    expect(text).not.toContain('too few routine cases');
  });
});

describe('main', () => {
  it('passes a dry run of the shipped set and labels every result line as dry', async () => {
    const { code, text } = await capture(['--dry'], {});
    expect(code).toBe(0);
    expect(text).toContain('DRY RUN');
    expect(text.trim().split('\n').at(-1)).toMatch(
      /^RESULT \(dry run: the answers came from the labels, not from a classifier\): PASS/
    );
    expect(text).toContain('under-routed: 0');
  });

  it('exits 1 when a confident classifier under-routes', async () => {
    const { fetch } = classifier(() => ({
      choice: 'small',
      probability: 0.99,
      confidence: 0.99,
      risk: 0,
      ambiguity: 0,
    }));
    const { code, text } = await capture([], LIVE_ENV, fetch);
    expect(code).toBe(1);
    expect(text.trim().split('\n').at(-1)).toMatch(
      /^RESULT: FAIL\. \d+ case\(s\) were routed below their label/
    );
  });

  it('exits 1 when nothing is under-routed but too few routine cases were lowered', async () => {
    const { fetch } = classifier(() => ({ choice: 'large' }));
    const { code, text } = await capture([], LIVE_ENV, fetch);
    expect(code).toBe(1);
    expect(text).toContain('under-routed: 0');
    expect(text.trim().split('\n').at(-1)).toContain(
      'too few routine cases were routed below the ceiling'
    );
  });

  it('exits 2, not scored, when the classifier gives no answers', async () => {
    const { fetch } = classifier(() => new Response('{}', { status: 500 }));
    const { code, text } = await capture([], LIVE_ENV, fetch);
    expect(code).toBe(2);
    expect(text.trim().split('\n').at(-1)).toMatch(/^RESULT: NOT SCORED/);
  });

  it('exits 2 without a key, and sends nothing', async () => {
    const { fetch, tasks } = classifier(() => ({ choice: 'small' }));
    const { code, text } = await capture([], {}, fetch);
    expect(code).toBe(2);
    expect(tasks).toEqual([]);
    expect(text).toContain('no_api_key');
  });

  it('runs one half with --split, and reports each half beside the whole otherwise', async () => {
    const all = await readCases(EVAL_CASES);
    const tuning = JSON.parse(
      (await capture(['--dry', '--json', '--split', 'tuning'], {})).text
    ) as {
      results: { id: string }[];
      splits: Record<string, { pass: boolean }>;
    };
    expect(tuning.results.map(r => r.id)).toEqual(
      all.filter(c => c.split === 'tuning').map(c => c.id)
    );
    expect(Object.keys(tuning.splits)).toEqual(['tuning']);

    const whole = await capture(['--dry'], {});
    expect(whole.text).toContain('tuning half');
    expect(whole.text).toContain('heldout half');
    expect(whole.text).toContain('heldout2 half');
    expect(whole.text.match(/passes on its own/g)).toHaveLength(3);
    expect((await capture(['--split', 'nope'], {})).code).toBe(2);
  });

  it('exits 2 on bad usage and on a cases file it cannot read', async () => {
    expect((await capture(['--nope'], {})).code).toBe(2);
    expect((await capture(['--ceiling', 'huge'], {})).code).toBe(2);
    expect((await capture(['--dry', '--cases', '/nonexistent/cases.jsonl'], {})).code).toBe(2);
  });

  it('prints ids and numbers only: no task text and no key, in text or JSON', async () => {
    const cases = await readCases(EVAL_CASES);
    const { fetch } = classifier(() => ({ choice: 'small' }));
    for (const argv of [[], ['--json']]) {
      const { text } = await capture(argv, LIVE_ENV, fetch);
      expect(text).not.toContain(KEY);
      for (const c of cases) expect(text).not.toContain(c.task);
    }
  });

  it('emits the same report as JSON, marked dry when it is', async () => {
    const { code, text } = await capture(['--dry', '--json', '--ceiling', 'medium'], {});
    expect(code).toBe(0);
    const report = JSON.parse(text) as { dry: boolean; ceiling: string; score: { pass: boolean } };
    expect(report).toMatchObject({ dry: true, ceiling: 'medium', score: { pass: true } });
  });

  it('renders the report from the same data the exit code is computed from', async () => {
    const report = await runEval({
      cases: await readCases(EVAL_CASES),
      packRoot: PACK_ROOT,
      ceiling: 'large',
      env: {},
      dry: true,
    });
    expect(formatReport(report)).toContain(`cases: ${String(report.results.length)}`);
  });
});
