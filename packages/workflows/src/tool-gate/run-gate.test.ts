/**
 * The per-run wiring around the gate: the switch, the classifier settings, the
 * shared cache and the audit sink. The gate and its rules are the real ones;
 * only `fetch` and the store are stand-ins.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLogLines, trackTempRoots } from '@archon/paths/test-utils';
import type { ToolActionRequest } from '@archon/providers/types';
import type { Fetch } from '../jev/jev-client';
import type { WorkflowEventInput } from '../store';
import type { ToolGateConfig } from './config';
import { UNRECORDED_DECISION_RULE_ID, type ToolGateDecisionEvent } from './gate';
import {
  assertProviderHonoursToolGate,
  createRunToolGate,
  emptyToolGateRoot,
  githubRepositoryOf,
  providerHonoursToolGate,
  providersUsableUnderToolGate,
  workflowToolGateRecorder,
  type RunToolGateInput,
} from './run-gate';

const trackTempRoot = trackTempRoots();
const isWindows = process.platform === 'win32';

const ON: ToolGateConfig = { enabled: true, protectedBranches: [], verificationCommands: [] };
const ESCALATED = 'gh pr merge 5';

function makeRoot(): string {
  return trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tool-gate-run-'))));
}

function shell(command: string, cwd: string): ToolActionRequest {
  return { toolName: 'Bash', kind: 'shell', cwd, command, input: { command } };
}

function write(path: string, cwd: string): ToolActionRequest {
  return { toolName: 'Write', kind: 'file_write', cwd, paths: [path], input: {} };
}

interface Recorded {
  event: ToolGateDecisionEvent;
  step: string;
}

interface Harness {
  root: string;
  records: Recorded[];
  input: RunToolGateInput;
}

function harness(overrides: Partial<RunToolGateInput> = {}): Harness {
  const root = overrides.repoRoot ?? makeRoot();
  const records: Recorded[] = [];
  return {
    root,
    records,
    input: {
      config: ON,
      env: {},
      repoRoot: root,
      credentialValues: [],
      record: (event, step) => {
        records.push({ event, step });
      },
      ...overrides,
    },
  };
}

function jevFetch(score: number, noul: number): { fetch: Fetch; calls: () => number } {
  let calls = 0;
  const fetch: Fetch = () => {
    calls++;
    return Promise.resolve(
      Response.json({
        answers: {
          risk: { type: 'score', score, probabilities: { '0': 1 }, confidence: 0.9 },
          external_state: { type: 'noul', noul },
        },
      })
    );
  };
  return { fetch, calls: () => calls };
}

describe.skipIf(isWindows)('the switch', () => {
  test.each([
    ['no toolGate block', undefined],
    ['enabled: false', { ...ON, enabled: false }],
  ])('%s builds no gate', (_name, config) => {
    expect(createRunToolGate(harness({ config }).input)).toBeUndefined();
  });

  test('a gate that is off is not stopped by a broken classifier setting or a container', () => {
    const off = harness({
      config: undefined,
      env: { JEV_API_KEY: 'k', JEV_GATE_NOUL_THRESHOLD: 'nonsense' },
      inContainer: true,
    });
    expect(createRunToolGate(off.input)).toBeUndefined();
  });

  test('enabled: true builds one, and each step gets its own callback', async () => {
    const h = harness();
    const run = createRunToolGate(h.input);
    expect(run).toBeDefined();
    const first = run?.forStep('plan');
    const second = run?.forStep('implement');
    expect(first).not.toBe(second);
    expect(await first?.(shell('git status', h.root))).toEqual({ action: 'allow' });
    expect(h.records).toHaveLength(1);
    expect(h.records[0]?.step).toBe('plan');
    expect(h.records[0]?.event).toMatchObject({ decision: 'allow', source: 'rule' });
  });
});

describe.skipIf(isWindows)('what cannot be gated fails at the start', () => {
  test('a container run is refused, saying why and both ways to proceed', () => {
    let message = '';
    try {
      createRunToolGate(harness({ inContainer: true }).input);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('runs in a container');
    expect(message).toContain("a container's paths are not the host's");
    expect(message).toContain('Run it on the host');
    expect(message).toContain('toolGate.enabled: false');
  });

  test('an unusable classifier number is refused, naming the variable', () => {
    const h = harness({ env: { JEV_API_KEY: 'k', JEV_GATE_SCORE_THRESHOLD: '9' } });
    expect(() => createRunToolGate(h.input)).toThrow(/JEV_GATE_SCORE_THRESHOLD must be a number/);
  });

  test('a repository root that does not exist is refused before any step asks', () => {
    const h = harness({ repoRoot: join(makeRoot(), 'missing') });
    expect(() => createRunToolGate(h.input)).toThrow();
  });
});

describe.skipIf(isWindows)('the classifier', () => {
  test('without a key the rules are the whole gate: an escalated call is allowed as fallback', async () => {
    const { fetch, calls } = jevFetch(3, 1);
    const h = harness({ fetch });
    const gate = createRunToolGate(h.input)?.forStep('pr');
    expect(await gate?.(shell(ESCALATED, h.root))).toEqual({ action: 'allow' });
    expect(calls()).toBe(0);
    expect(h.records[0]?.event).toMatchObject({ source: 'fallback', decision: 'allow' });
  });

  test('with a key but the gate classifier switched off, the same holds', async () => {
    const { fetch, calls } = jevFetch(3, 1);
    const h = harness({ fetch, env: { JEV_API_KEY: 'k', JEV_GATE_ENABLED: '0' } });
    const gate = createRunToolGate(h.input)?.forStep('pr');
    expect(await gate?.(shell(ESCALATED, h.root))).toEqual({ action: 'allow' });
    expect(calls()).toBe(0);
  });

  test('with a key the classifier decides the escalation band', async () => {
    const { fetch, calls } = jevFetch(3, 1);
    const h = harness({ fetch, env: { JEV_API_KEY: 'k' } });
    const gate = createRunToolGate(h.input)?.forStep('pr');
    expect(await gate?.(shell(ESCALATED, h.root))).toMatchObject({
      action: 'deny',
      needsApproval: true,
    });
    expect(calls()).toBe(1);
    expect(h.records[0]?.event).toMatchObject({ source: 'jev', decision: 'deny', score: 3 });
  });

  test('with a key and no usable answer the call is denied, never waved through', async () => {
    const fetch: Fetch = () => Promise.resolve(Response.json({ error: 'down' }, { status: 502 }));
    const h = harness({ fetch, env: { JEV_API_KEY: 'k' } });
    const gate = createRunToolGate(h.input)?.forStep('pr');
    expect(await gate?.(shell(ESCALATED, h.root))).toMatchObject({
      action: 'deny',
      needsApproval: true,
    });
    expect(h.records[0]?.event).toMatchObject({ source: 'fallback', decision: 'deny' });
  });

  test('thresholds from the environment replace the defaults', async () => {
    // Score 2 is denied by default; a threshold at the top of the scale lets it through.
    const { fetch } = jevFetch(2, 0.1);
    const h = harness({ fetch, env: { JEV_API_KEY: 'k', JEV_GATE_SCORE_THRESHOLD: '3' } });
    const gate = createRunToolGate(h.input)?.forStep('pr');
    expect(await gate?.(shell(ESCALATED, h.root))).toEqual({ action: 'allow' });
  });

  test('one answer serves every step of the run', async () => {
    const { fetch, calls } = jevFetch(0, 0);
    const h = harness({ fetch, env: { JEV_API_KEY: 'k' } });
    const run = createRunToolGate(h.input);
    await run?.forStep('pr')(shell(ESCALATED, h.root));
    await run?.forStep('sync-pr-body')(shell(ESCALATED, h.root));
    expect(calls()).toBe(1);
    expect(h.records.map(record => record.step)).toEqual(['pr', 'sync-pr-body']);
  });

  test('another run asks for itself', async () => {
    const { fetch, calls } = jevFetch(0, 0);
    const h = harness({ fetch, env: { JEV_API_KEY: 'k' } });
    await createRunToolGate(h.input)?.forStep('pr')(shell(ESCALATED, h.root));
    await createRunToolGate(h.input)?.forStep('pr')(shell(ESCALATED, h.root));
    expect(calls()).toBe(2);
  });
});

describe.skipIf(isWindows)('per step and per run', () => {
  test('the denial count belongs to the step', async () => {
    const h = harness();
    const run = createRunToolGate(h.input);
    const first = run?.forStep('a');
    for (let i = 0; i < 6; i++) await first?.(shell('git reset --hard', h.root));
    expect(h.records.at(-1)?.event.ruleId).toBe('guard.repeated_denials');
    await run?.forStep('b')(shell('git reset --hard', h.root));
    expect(h.records.at(-1)?.event.ruleId).toBe('deny.git_reset_hard');
  });

  // The call the executor makes for each loop iteration and each retry attempt:
  // `forStep` again, with the same step name.
  test('asking for the same step again starts a new attempt: a fresh denial count on the same classifier answers', async () => {
    const { fetch, calls } = jevFetch(3, 1);
    const h = harness({ fetch, env: { JEV_API_KEY: 'k' } });
    const run = createRunToolGate(h.input);
    const firstAttempt = run?.forStep('iterate');
    await firstAttempt?.(shell(ESCALATED, h.root));
    for (let i = 0; i < 6; i++) await firstAttempt?.(shell('git reset --hard', h.root));
    expect(h.records.at(-1)?.event.ruleId).toBe('guard.repeated_denials');

    const nextAttempt = run?.forStep('iterate');
    await nextAttempt?.(shell('git reset --hard', h.root));
    expect(h.records.at(-1)).toMatchObject({
      step: 'iterate',
      event: { ruleId: 'deny.git_reset_hard' },
    });
    await nextAttempt?.(shell(ESCALATED, h.root));
    expect(h.records.at(-1)?.event).toMatchObject({ decision: 'deny', source: 'jev' });
    expect(calls()).toBe(1);
  });

  test('a sink that returns a promise is waited for, and one that rejects denies the call', async () => {
    const order: string[] = [];
    let fail = false;
    const h = harness({
      record: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (fail) throw new Error('db down');
        order.push('recorded');
      },
    });
    const gate = createRunToolGate(h.input)?.forStep('a');
    expect(await gate?.(shell('git status', h.root))).toEqual({ action: 'allow' });
    order.push('answered');
    expect(order).toEqual(['recorded', 'answered']);

    fail = true;
    expect(await gate?.(shell('git status', h.root))).toMatchObject({
      action: 'deny',
      needsApproval: true,
      ruleId: UNRECORDED_DECISION_RULE_ID,
    });
  });
});

describe.skipIf(isWindows)('roots', () => {
  test('a write into an extra root is allowed, a protected path in it is not, anything else outside is denied', async () => {
    const artifacts = makeRoot();
    const elsewhere = makeRoot();
    mkdirSync(join(artifacts, 'codex-home'));
    const h = harness({
      extraWriteRoots: [artifacts],
      protectedPaths: [join(artifacts, 'codex-home')],
    });
    const gate = createRunToolGate(h.input)?.forStep('plan');
    expect(await gate?.(write(join(artifacts, 'plan.md'), h.root))).toEqual({ action: 'allow' });
    expect(await gate?.(write(join(artifacts, 'codex-home', 'auth.json'), h.root))).toMatchObject({
      action: 'deny',
      ruleId: 'deny.secret_write',
    });
    expect(await gate?.(write(join(elsewhere, 'plan.md'), h.root))).toMatchObject({
      action: 'deny',
      ruleId: 'deny.path_outside_root',
    });
  });
});

describe.skipIf(isWindows)('protected branches and verification commands', () => {
  const leasePush = (branch: string): string => `git push --force-with-lease origin ${branch}`;

  test('main and master stay protected whatever the config adds', async () => {
    const h = harness({ config: { ...ON, protectedBranches: ['release'] }, baseBranch: 'dev' });
    const run = createRunToolGate(h.input);
    for (const branch of ['main', 'master', 'release', 'dev']) {
      // A step of its own each time, so the repeated-denial guard stays out of it.
      const gate = run?.forStep(`push-${branch}`);
      expect(await gate?.(shell(leasePush(branch), h.root))).toMatchObject({
        action: 'deny',
        ruleId: 'deny.git_force_push_protected',
      });
    }
  });

  test('a feature branch is not protected: the push goes to the escalation band', async () => {
    const h = harness({ baseBranch: 'dev' });
    const gate = createRunToolGate(h.input)?.forStep('push');
    expect(await gate?.(shell(leasePush('feat/x'), h.root))).toEqual({ action: 'allow' });
    expect(h.records[0]?.event).toMatchObject({ source: 'fallback', ruleId: 'risk.mutation_verb' });
  });

  test('an unknown base branch protects nothing extra', async () => {
    const h = harness({ baseBranch: '' });
    const gate = createRunToolGate(h.input)?.forStep('push');
    expect(await gate?.(shell(leasePush('dev'), h.root))).toEqual({ action: 'allow' });
  });

  test('configured verification commands are added to the built-in ones', async () => {
    const h = harness({ config: { ...ON, verificationCommands: ['make check'] } });
    const gate = createRunToolGate(h.input)?.forStep('validate');
    await gate?.(shell('make check', h.root));
    await gate?.(shell('bun run test', h.root));
    await gate?.(shell('make deploy', h.root));
    expect(h.records.map(record => record.event.ruleId)).toEqual([
      'allow.read_only',
      'allow.read_only',
      'default.no_signal',
    ]);
  });
});

describe.skipIf(isWindows)('redaction', () => {
  test('a known credential value never reaches the classifier or the record', async () => {
    const bodies: string[] = [];
    const fetch: Fetch = (_input, init) => {
      bodies.push(String(init?.body));
      return Promise.resolve(
        Response.json({
          answers: {
            risk: { type: 'score', score: 0, probabilities: { '0': 1 }, confidence: 0.9 },
            external_state: { type: 'noul', noul: 0 },
          },
        })
      );
    };
    const h = harness({
      fetch,
      env: { JEV_API_KEY: 'k' },
      credentialValues: ['injected-credential-9902'],
    });
    const gate = createRunToolGate(h.input)?.forStep('deploy');
    await gate?.(shell('docker login -p injected-credential-9902 registry.example.com', h.root));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('injected-credential-9902');
    expect(JSON.stringify(h.records)).not.toContain('injected-credential-9902');
  });
});

describe.skipIf(isWindows)('emptyToolGateRoot', () => {
  test('is an existing, empty directory that stays the same for the process', async () => {
    const root = await emptyToolGateRoot();
    trackTempRoot(root);
    expect(readdirSync(root)).toEqual([]);
    expect(await emptyToolGateRoot()).toBe(root);
  });

  test.skipIf(isWindows)(
    'rooted there, a gate has nowhere to write: every other path is outside',
    async () => {
      const root = await emptyToolGateRoot();
      trackTempRoot(root);
      const workspaces = makeRoot();
      const h = harness({ repoRoot: root, outsideRootAdvice: 'Register a project first.' });
      const gate = createRunToolGate(h.input)?.forStep('chat');
      for (const path of [
        join(workspaces, 'notes.md'),
        join(workspaces, 'owner', 'repo', 'source', 'a.ts'),
        join(workspaces, 'owner', 'repo', 'artifacts', 'runs', 'r1', 'plan.md'),
      ]) {
        const decision = await createRunToolGate(h.input)?.forStep('chat')(write(path, workspaces));
        expect(decision).toMatchObject({ action: 'deny', ruleId: 'deny.path_outside_root' });
        if (decision?.action !== 'deny') throw new Error('unreachable');
        expect(decision.reason).toContain('Register a project first.');
      }
      // A read-only command from a directory outside the root is flagged, not settled.
      expect(await gate?.(shell('ls', workspaces))).toEqual({ action: 'allow' });
      expect(h.records.at(-1)?.event).toMatchObject({
        source: 'fallback',
        ruleId: 'risk.cwd_outside_root',
      });
    }
  );

  test('is created again if something removed it', async () => {
    const root = await emptyToolGateRoot();
    rmSync(root, { recursive: true, force: true });
    const again = await emptyToolGateRoot();
    trackTempRoot(again);
    expect(again).not.toBe(root);
    expect(readdirSync(again)).toEqual([]);
  });
});

describe.skipIf(isWindows)('assertProviderHonoursToolGate', () => {
  test('with the gate off every provider passes', () => {
    expect(() => {
      assertProviderHonoursToolGate(undefined, 'codex', {});
      assertProviderHonoursToolGate({ ...ON, enabled: false }, 'codex', { toolActionGate: false });
    }).not.toThrow();
  });

  test('with the gate on a provider that declares the capability passes', () => {
    expect(() => {
      assertProviderHonoursToolGate(ON, 'claude', { toolActionGate: true });
    }).not.toThrow();
  });

  test.each([
    ['does not declare it', {}],
    ['declares it false', { toolActionGate: false }],
  ])('with the gate on a provider that %s is refused by name', (_name, capabilities) => {
    expect(() => {
      assertProviderHonoursToolGate(ON, 'some-provider', capabilities);
    }).toThrow(/provider 'some-provider'.*toolActionGate/s);
  });

  test('the router is offered only providers the gate can check, and every provider with the gate off', () => {
    const capabilities = (provider: string): { toolActionGate?: boolean } =>
      provider === 'gated'
        ? { toolActionGate: true }
        : provider === 'refuses'
          ? { toolActionGate: false }
          : {};
    const gateOn = providersUsableUnderToolGate(ON, capabilities);
    expect(['gated', 'refuses', 'silent'].map(gateOn)).toEqual([true, false, false]);
    const gateOff = providersUsableUnderToolGate({ ...ON, enabled: false }, capabilities);
    expect(['gated', 'refuses', 'silent'].map(gateOff)).toEqual([true, true, true]);
    const noConfig = providersUsableUnderToolGate(undefined, capabilities);
    expect(['gated', 'refuses', 'silent'].map(noConfig)).toEqual([true, true, true]);
  });

  test('providerHonoursToolGate answers the same question without throwing', () => {
    expect(providerHonoursToolGate(undefined, {})).toBe(true);
    expect(providerHonoursToolGate({ ...ON, enabled: false }, { toolActionGate: false })).toBe(
      true
    );
    expect(providerHonoursToolGate(ON, { toolActionGate: true })).toBe(true);
    expect(providerHonoursToolGate(ON, { toolActionGate: false })).toBe(false);
    expect(providerHonoursToolGate(ON, {})).toBe(false);
  });

  test('the refusal says both ways out: another provider, or how to switch the gate off', () => {
    let message = '';
    try {
      assertProviderHonoursToolGate(ON, 'opencode', {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('provider that supports the gate');
    expect(message).toContain('provider capability matrix');
    expect(message).toContain("to run on 'opencode' without the gate");
    expect(message).toContain('toolGate.enabled: false');
    expect(message).toContain('~/.archon/config.yaml');
    expect(message).toContain('.archon/config.yaml if it is set there');
  });
});

describe.skipIf(isWindows)('merging a pull request', () => {
  const KEYED = { JEV_API_KEY: 'k' };

  test('a workflow step is refused when the classifier says the merge is risky', async () => {
    const { fetch, calls } = jevFetch(3, 1);
    const h = harness({ fetch, env: KEYED });
    const gate = createRunToolGate(h.input)?.forStep('pr');
    expect(await gate?.(shell('gh pr merge 5 --squash --repo acme/app', h.root))).toMatchObject({
      action: 'deny',
      needsApproval: true,
    });
    expect(calls()).toBe(1);
  });

  test('a caller given the merge of its own repository is allowed without the classifier', async () => {
    const { fetch, calls } = jevFetch(3, 1);
    const h = harness({ fetch, env: KEYED, ownPullRequestMerge: { repository: 'acme/app' } });
    const gate = createRunToolGate(h.input)?.forStep('chat');
    expect(await gate?.(shell('gh pr merge 5 --squash --repo acme/app', h.root))).toEqual({
      action: 'allow',
    });
    expect(calls()).toBe(0);
    // The merge that skips required checks still goes to the classifier, which refuses it.
    expect(
      await gate?.(shell('gh pr merge 5 --squash --admin --repo acme/app', h.root))
    ).toMatchObject({
      action: 'deny',
    });
    expect(calls()).toBe(1);
  });
});

describe('githubRepositoryOf', () => {
  test.each([
    ['https://github.com/acme/app', 'acme/app'],
    ['https://github.com/acme/app.git', 'acme/app'],
    ['https://github.com/acme/app/', 'acme/app'],
    ['git@github.com:acme/app.git', 'acme/app'],
    ['ssh://git@github.com/acme/my.app.git', 'acme/my.app'],
  ])('%s is %s', (url, expected) => {
    expect(githubRepositoryOf(url)).toBe(expected);
  });

  test.each([
    null,
    undefined,
    '',
    'acme/app',
    'https://gitlab.com/acme/app',
    'https://github.com.evil.test/acme/app',
    'https://github.com/acme/app/pull/5',
    'https://github.com/acme',
    'https://evil.test/https://github.com/acme/app',
  ])('%s has none', url => {
    expect(githubRepositoryOf(url)).toBeUndefined();
  });
});

describe.skipIf(isWindows)('workflowToolGateRecorder', () => {
  const EVENT: ToolGateDecisionEvent = {
    tool: 'Bash',
    kind: 'shell',
    decision: 'deny',
    needsApproval: true,
    source: 'jev',
    ruleId: 'risk.mutation_verb',
    score: 2.4,
    noul: 0.8,
    confidence: 0.7,
    count: 1,
    latencyMs: 12,
    commandHash: 'a'.repeat(64),
    redactedPreview: 'gh pr merge 5',
  };

  test('writes one tool_gate_decision event carrying exactly the decision fields', async () => {
    const written: WorkflowEventInput[] = [];
    const record = workflowToolGateRecorder(
      {
        persistWorkflowEvent: event => {
          written.push(event);
          return Promise.resolve();
        },
      },
      'run-1'
    );
    await record(EVENT, 'group.implement');
    expect(written).toEqual([
      {
        workflow_run_id: 'run-1',
        event_type: 'tool_gate_decision',
        step_name: 'group.implement',
        data: { ...EVENT },
      },
    ]);
  });

  test('the write is waited for: the sink settles when the store has taken the event', async () => {
    let stored = false;
    const record = workflowToolGateRecorder(
      {
        persistWorkflowEvent: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          stored = true;
        },
      },
      'run-1'
    );
    await record(EVENT, 'implement');
    expect(stored).toBe(true);
  });

  test('a store that cannot write fails the sink, so the gate can refuse the call', async () => {
    const record = workflowToolGateRecorder(
      { persistWorkflowEvent: () => Promise.reject(new Error('db down')) },
      'run-1'
    );
    await expect(Promise.resolve(record(EVENT, 'implement'))).rejects.toThrow('db down');
  });

  test('in a run, a decision the store could not take is a denial, logged once without the error text', async () => {
    const root = makeRoot();
    const run = createRunToolGate({
      config: ON,
      env: {},
      repoRoot: root,
      credentialValues: [],
      record: workflowToolGateRecorder(
        { persistWorkflowEvent: () => Promise.reject(new TypeError('db down: planted-row-text')) },
        'run-3'
      ),
    });
    const logs = captureLogLines();
    try {
      const decision = await run?.forStep('implement')(shell('git status', root));
      expect(decision).toMatchObject({
        action: 'deny',
        needsApproval: true,
        ruleId: UNRECORDED_DECISION_RULE_ID,
      });
      expect(JSON.stringify(decision)).not.toContain('db down');
      // Let anything fired and forgotten settle: a second log line would come from there.
      await new Promise(resolve => setTimeout(resolve, 10));
      const failures = logs.lines.filter(line => line.level === 50);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        msg: 'tool_gate.decision_record_failed',
        errorName: 'TypeError',
      });
      expect(JSON.stringify(logs.lines)).not.toContain('planted-row-text');
      expect(JSON.stringify(logs.lines)).not.toContain('git status');
    } finally {
      logs.restore();
    }
  });

  test('what a real gate records holds no raw command text beyond the redacted preview', async () => {
    const written: WorkflowEventInput[] = [];
    const root = makeRoot();
    const run = createRunToolGate({
      config: ON,
      env: {},
      repoRoot: root,
      credentialValues: [],
      record: workflowToolGateRecorder(
        {
          persistWorkflowEvent: event => {
            written.push(event);
            return Promise.resolve();
          },
        },
        'run-2'
      ),
    });
    const command = `curl -X POST -H "Authorization: Bearer abcdef0123456789abcdef" https://api.example.com/x ${'y'.repeat(600)}`;
    await run?.forStep('notify')(shell(command, root));

    expect(written).toHaveLength(1);
    const [event] = written;
    expect(event?.event_type).toBe('tool_gate_decision');
    expect(Object.keys(event?.data ?? {}).sort()).toEqual([
      'commandHash',
      'count',
      'decision',
      'kind',
      'latencyMs',
      'needsApproval',
      'redactedPreview',
      'ruleId',
      'source',
      'tool',
    ]);
    const stored = JSON.stringify(event);
    expect(stored).not.toContain('abcdef0123456789abcdef');
    expect(stored).not.toContain('y'.repeat(300));
  });
});
