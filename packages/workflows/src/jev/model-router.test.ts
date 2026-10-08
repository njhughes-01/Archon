import { describe, expect, it } from 'bun:test';
import type { ProviderCapabilities } from '@archon/providers/types';
import { dagNodeSchema, type AgentNode } from '../schemas/dag-node';
import { nodeRouteSchema, type ModelRouterConfig, type NodeRoute } from '../schemas/model-router';
import type { ResolvedAiProfile, TierName } from '../schemas/model-binding';
import { resolveNodeModel } from '../node-model-resolution';
import { JEV_ENDPOINT_PATH, type Fetch } from './jev-client';
import {
  ROUTER_DEFAULTS,
  decideTier,
  escalateRoute,
  escalationReason,
  formatTaskText,
  offerTiers,
  readRouterSettings,
  routeAgentNode,
  routingCeiling,
  type CapabilityLookup,
  type RouteAgentNodeInput,
  type RouteOptions,
  type RouterLog,
  type RouterThresholds,
} from './model-router';

const API_KEY = 'jev-key-that-must-never-be-logged';
const ENV = { JEV_API_KEY: API_KEY };
const STEP_TEXT = 'Find the commands this repository uses to check itself.';
const TASK_TEXT = 'Run the checks for the billing package.';

const FULL: ProviderCapabilities = {
  sessionResume: true,
  sessionFork: true,
  mcp: true,
  hooks: true,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: 'enforced',
  requiresAllPropertiesRequired: false,
  envInjection: true,
  costControl: true,
  costReporting: true,
  effortControl: true,
  fallbackModel: true,
  sandbox: true,
  settingSources: true,
  nativeTools: true,
  containerExec: true,
};

/** `alpha` runs the authored tier; `beta` is the other provider a cheaper tier may name. */
function lookup(beta: Partial<ProviderCapabilities> = {}): CapabilityLookup {
  const table: Record<string, ProviderCapabilities> = { alpha: FULL, beta: { ...FULL, ...beta } };
  return provider => table[provider];
}

const SAME_PROVIDER: ResolvedAiProfile = {
  defaultProvider: 'alpha',
  aliases: {
    small: { provider: 'alpha', model: 'a-small' },
    medium: { provider: 'alpha', model: 'a-medium' },
    large: { provider: 'alpha', model: 'a-large' },
    '@pinned': { provider: 'alpha', model: 'a-pinned' },
  },
};

const CROSS_PROVIDER: ResolvedAiProfile = {
  defaultProvider: 'alpha',
  aliases: {
    small: { provider: 'beta', model: 'b-small' },
    medium: { provider: 'alpha', model: 'a-medium' },
    large: { provider: 'alpha', model: 'a-large' },
  },
};

function agentNode(fields: Record<string, unknown> = {}): AgentNode {
  const node = dagNodeSchema.parse({ id: 'step', prompt: STEP_TEXT, model: 'medium', ...fields });
  if (node.kind !== 'agent') throw new Error('fixture is not an agent node');
  return node;
}

interface CandidateOverrides extends Partial<RouteAgentNodeInput> {
  profile?: ResolvedAiProfile;
}

function candidate(overrides: CandidateOverrides = {}): RouteAgentNodeInput {
  const node = overrides.node ?? agentNode();
  const aiProfile =
    'aiProfile' in overrides ? overrides.aiProfile : (overrides.profile ?? SAME_PROVIDER);
  const config: ModelRouterConfig = overrides.config ?? { tiers: ['medium'], mode: 'apply' };
  return {
    node,
    resolution: resolveNodeModel(
      node,
      {
        provider: 'alpha',
        model: undefined,
        preset: undefined,
        tier: undefined,
        effort: undefined,
        providerOrigin: 'default assistant',
      },
      {},
      aiProfile
    ),
    aiProfile,
    config,
    isResumeSource: false,
    usesPersistedScope: false,
    sameProviderOnly: false,
    inContainer: false,
    capabilityScope: {
      declaredEffort: undefined,
      workflowFallbackModel: undefined,
      workflowSandbox: undefined,
      webSearchMode: undefined,
      hasEnvVars: false,
    },
    loadStepText: () => Promise.resolve(STEP_TEXT),
    taskText: () => TASK_TEXT,
    credentialValues: () => [],
    ...overrides,
  };
}

interface SentBody {
  model: string;
  state: { step: string; task: string; features: Record<string, unknown> };
  questions: Record<string, { type: string; instructions: string; criteria?: unknown }>;
}

interface Answer {
  choice?: string;
  probability?: number;
  confidence?: number;
  risk?: number;
  ambiguity?: number;
}

function answerBody(answer: Answer = {}): unknown {
  const choice = answer.choice ?? 'small';
  return {
    model: 'jev-1.13.0',
    answers: {
      tier: {
        type: 'choice',
        choice,
        probabilities: { [choice]: answer.probability ?? 0.95 },
        confidence: answer.confidence ?? 0.9,
      },
      high_risk: { type: 'noul', noul: answer.risk ?? 0.02 },
      ambiguous_or_multi_step: { type: 'noul', noul: answer.ambiguity ?? 0.05 },
    },
    usage: { input_tokens: 500 },
  };
}

function fakeFetch(respond: () => Response | Promise<Response>): {
  fetch: Fetch;
  urls: string[];
  bodies: SentBody[];
  raw: string[];
} {
  const urls: string[] = [];
  const bodies: SentBody[] = [];
  const raw: string[] = [];
  const fetch: Fetch = (input, init) => {
    urls.push(String(input));
    raw.push(String(init?.body));
    bodies.push(JSON.parse(String(init?.body)) as SentBody);
    return Promise.resolve(respond());
  };
  return { fetch, urls, bodies, raw };
}

const answering = (answer: Answer = {}): (() => Response) => {
  return () => new Response(JSON.stringify(answerBody(answer)), { status: 200 });
};

type LogCall = [level: string, data: Record<string, unknown>, message: string];
function recordingLog(): { log: RouterLog; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const at =
    (level: string) =>
    (data: Record<string, unknown>, message: string): void => {
      calls.push([level, data, message]);
    };
  return { log: { info: at('info'), warn: at('warn'), debug: at('debug') }, calls };
}

const QUIET: RouterLog = { info: () => undefined, warn: () => undefined, debug: () => undefined };

/** Options for a routing call: a key, the fixture providers and no log output unless a test asks. */
function opts(extra: RouteOptions = {}): RouteOptions {
  return { env: ENV, getCapabilities: lookup(), log: QUIET, ...extra };
}

const THRESHOLDS: RouterThresholds = {
  minProbability: 0.7,
  minConfidence: 0.5,
  riskThreshold: 0.3,
  ambiguityThreshold: 0.5,
};

describe('routingCeiling: which nodes the router may touch at all', () => {
  it('is the authored tier of a node on a configured tier', () => {
    expect(routingCeiling(candidate(), lookup())).toBe('medium');
  });

  it('reads the tier a workflow scope declared when the node itself declares none', () => {
    const node = agentNode({ model: undefined });
    const input = candidate({ node });
    const resolution = resolveNodeModel(
      node,
      {
        provider: 'alpha',
        model: 'a-medium',
        preset: SAME_PROVIDER.aliases.medium,
        tier: 'medium',
        effort: undefined,
        providerOrigin: 'model ref',
      },
      {},
      SAME_PROVIDER
    );
    expect(routingCeiling({ ...input, resolution }, lookup())).toBe('medium');
  });

  it.each([
    ['a literal model', { node: agentNode({ model: 'a-medium' }) }],
    ['an @alias', { node: agentNode({ model: '@pinned' }) }],
    ['no model at all', { node: agentNode({ model: undefined }) }],
    ['a tier the operator did not name', { node: agentNode({ model: 'large' }) }],
    ['a named session resume', { node: agentNode({ context: { resume: 'earlier' } }) }],
    ['a router the operator switched off', { config: { tiers: ['medium'], mode: 'off' } }],
    ['a node another node resumes from', { isResumeSource: true }],
    ['a node whose session persists across runs', { usesPersistedScope: true }],
    ['no AI profile to resolve tiers with', { aiProfile: undefined }],
  ] as [string, CandidateOverrides][])('is undefined for %s', (_label, overrides) => {
    expect(routingCeiling(candidate(overrides), lookup())).toBeUndefined();
  });

  it('is undefined when the authored tier names a provider that is not registered', () => {
    const profile: ResolvedAiProfile = {
      defaultProvider: 'ghost',
      aliases: {
        small: { provider: 'alpha', model: 'a-small' },
        medium: { provider: 'ghost', model: 'g-medium' },
      },
    };
    expect(routingCeiling(candidate({ profile }), lookup())).toBeUndefined();
  });
});

describe('offerTiers: which lower tiers may be offered', () => {
  const offer = (
    overrides: CandidateOverrides = {},
    caps: CapabilityLookup = lookup()
  ): ReturnType<typeof offerTiers> => {
    const input = candidate(overrides);
    const ceiling = routingCeiling(input, caps);
    if (ceiling === undefined) throw new Error('fixture node is not routable');
    return offerTiers(input, ceiling, caps);
  };

  it('offers every lower tier with its own preset, and never a tier above the ceiling', () => {
    const large = offer({
      node: agentNode({ model: 'large' }),
      config: { tiers: ['large'], mode: 'apply' },
    });
    expect(large.offered).toEqual(['small', 'medium']);
    expect(offer().offered).toEqual(['small']);
    const small = offer({
      node: agentNode({ model: 'small' }),
      config: { tiers: ['small'], mode: 'apply' },
    });
    expect(small.offered).toEqual([]);
  });

  it('does not offer a tier with no preset of its own, which would fall back to a higher one', () => {
    const profile: ResolvedAiProfile = {
      defaultProvider: 'alpha',
      aliases: { medium: SAME_PROVIDER.aliases.medium, large: SAME_PROVIDER.aliases.large },
    };
    expect(offer({ profile })).toEqual({ offered: [], excluded: { small: 'no_preset' } });
  });

  it('does not offer a tier that resolves to the same preset as the ceiling', () => {
    const profile: ResolvedAiProfile = {
      defaultProvider: 'alpha',
      aliases: { small: SAME_PROVIDER.aliases.medium, medium: SAME_PROVIDER.aliases.medium },
    };
    expect(offer({ profile }).excluded).toEqual({ small: 'same_as_ceiling' });
  });

  // The positive control for every exclusion below: the same cross-provider tier is
  // offered once nothing stands in its way.
  it('offers a tier on another provider that can run the node', () => {
    expect(offer({ profile: CROSS_PROVIDER })).toEqual({ offered: ['small'], excluded: {} });
  });

  it.each([
    [
      'tool restrictions',
      { allowed_tools: ['Read'] },
      { toolRestrictions: false },
      'allowed_tools/denied_tools',
    ],
    [
      'denied tools',
      { denied_tools: ['Bash'] },
      { toolRestrictions: false },
      'allowed_tools/denied_tools',
    ],
    ['hooks', { hooks: { PreToolUse: [{ response: {} }] } }, { hooks: false }, 'hooks'],
    ['mcp', { mcp: 'servers.json' }, { mcp: false }, 'mcp'],
    ['skills', { skills: ['lint'] }, { skills: false }, 'skills'],
    ['sandbox', { sandbox: { enabled: true } }, { sandbox: false }, 'sandbox'],
    [
      'inline sub-agents',
      { agents: { helper: { description: 'd', prompt: 'p' } } },
      { agents: false },
      'agents',
    ],
    ['a spend limit', { maxBudgetUsd: 2 }, { costControl: false }, 'maxBudgetUsd'],
    [
      'setting sources',
      { settingSources: ['project'] },
      { settingSources: false },
      'settingSources',
    ],
    ['a fallback model', { fallbackModel: 'a-other' }, { fallbackModel: false }, 'fallbackModel'],
  ] as [string, Record<string, unknown>, Partial<ProviderCapabilities>, string][])(
    'does not offer a provider that would ignore %s',
    (_label, fields, betaCaps, field) => {
      const node = agentNode(fields);
      expect(offer({ node, profile: CROSS_PROVIDER }, lookup(betaCaps))).toEqual({
        offered: [],
        excluded: { small: `unsupported:${field}` },
      });
      // The field alone is not what excludes the tier: a provider that honours it is offered.
      expect(offer({ node, profile: CROSS_PROVIDER }).offered).toEqual(['small']);
    }
  );

  it.each([
    ['declared effort', { declaredEffort: 'high' as const }, { effortControl: false }, 'effort'],
    ['injected environment', { hasEnvVars: true }, { envInjection: false }, 'env'],
    [
      'a workflow-level sandbox',
      { workflowSandbox: { enabled: true } },
      { sandbox: false },
      'sandbox',
    ],
  ])('does not offer a provider that would ignore %s', (_label, scope, betaCaps, field) => {
    const capabilityScope = { ...candidate().capabilityScope, ...scope };
    expect(offer({ profile: CROSS_PROVIDER, capabilityScope }, lookup(betaCaps)).excluded).toEqual({
      small: `unsupported:${field}`,
    });
  });

  it('does not offer a provider with a weaker structured-output guarantee', () => {
    const node = agentNode({
      output_format: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    });
    expect(
      offer({ node, profile: CROSS_PROVIDER }, lookup({ structuredOutput: 'best-effort' })).excluded
    ).toEqual({ small: 'structured_output' });
    // Without an output_format the guarantee is irrelevant.
    expect(
      offer({ profile: CROSS_PROVIDER }, lookup({ structuredOutput: 'best-effort' })).offered
    ).toEqual(['small']);
  });

  it('does not offer a strict-schema provider a schema it would reject', () => {
    const node = agentNode({
      output_format: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        required: ['ok'],
      },
    });
    const strict = lookup({ requiresAllPropertiesRequired: true });
    expect(offer({ node, profile: CROSS_PROVIDER }, strict).excluded).toEqual({
      small: 'strict_schema',
    });
    const complete = agentNode({
      output_format: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    });
    expect(offer({ node: complete, profile: CROSS_PROVIDER }, strict).offered).toEqual(['small']);
  });

  it('does not offer a provider that cannot run inside the container the run uses', () => {
    const noContainer = lookup({ containerExec: false });
    expect(offer({ profile: CROSS_PROVIDER, inContainer: true }, noContainer).excluded).toEqual({
      small: 'container_exec',
    });
    expect(offer({ profile: CROSS_PROVIDER }, noContainer).offered).toEqual(['small']);
  });

  it('does not offer a provider that is not registered', () => {
    const profile: ResolvedAiProfile = {
      defaultProvider: 'alpha',
      aliases: { ...CROSS_PROVIDER.aliases, small: { provider: 'ghost', model: 'g' } },
    };
    expect(offer({ profile }).excluded).toEqual({ small: 'unregistered_provider' });
  });

  it('does not change provider where a session continues through the node', () => {
    expect(offer({ profile: CROSS_PROVIDER, sameProviderOnly: true }).excluded).toEqual({
      small: 'session_continuity',
    });
    expect(offer({ sameProviderOnly: true }).offered).toEqual(['small']);
  });

  it('does not move a node off the provider it names', () => {
    const node = agentNode({ provider: 'alpha' });
    expect(offer({ node, profile: CROSS_PROVIDER }).excluded).toEqual({
      small: 'declared_provider',
    });
  });
});

describe('decideTier: deterministic floors', () => {
  const confident = {
    choice: 'small',
    probability: 0.95,
    confidence: 0.9,
    risk: 0.02,
    ambiguity: 0.05,
  };
  const decide = (answers: Partial<typeof confident>): ReturnType<typeof decideTier> =>
    decideTier({ ...confident, ...answers }, 'medium', ['small'], THRESHOLDS);

  it('takes the chosen lower tier when nothing floors it', () => {
    expect(decide({})).toEqual({ source: 'jev', routedTier: 'small', chosenTier: 'small' });
  });

  it.each([
    ['risk at its threshold', { risk: 0.3 }, 'high_risk'],
    ['risk over its threshold', { risk: 0.9 }, 'high_risk'],
    ['ambiguity at its threshold', { ambiguity: 0.5 }, 'ambiguous_or_multi_step'],
    ['probability under its threshold', { probability: 0.69 }, 'low_probability'],
    ['confidence under its threshold', { confidence: 0.49 }, 'low_confidence'],
  ] as [string, Partial<typeof confident>, string][])(
    'resolves to the ceiling for %s',
    (_label, answers, reason) => {
      expect(decide(answers)).toEqual({
        source: 'jev',
        routedTier: 'medium',
        chosenTier: 'small',
        reason,
      });
    }
  );

  it.each([
    ['risk just under its threshold', { risk: 0.29 }],
    ['ambiguity just under its threshold', { ambiguity: 0.49 }],
    ['probability exactly at its threshold', { probability: 0.7 }],
    ['confidence exactly at its threshold', { confidence: 0.5 }],
  ] as [string, Partial<typeof confident>][])('still lowers for %s', (_label, answers) => {
    expect(decide(answers).routedTier).toBe('small');
  });

  it('checks risk before anything else, so a confident cheap pick cannot outvote it', () => {
    expect(decide({ risk: 1, ambiguity: 1, probability: 0, confidence: 0 }).reason).toBe(
      'high_risk'
    );
  });

  it('keeps the ceiling when the classifier chooses it', () => {
    expect(decide({ choice: 'medium' })).toEqual({
      source: 'jev',
      routedTier: 'medium',
      chosenTier: 'medium',
      reason: 'ceiling_chosen',
    });
  });

  it.each(['large', 'tiny', ''])(
    'treats a choice outside the offered tiers (%p) as no answer',
    choice => {
      expect(decide({ choice })).toEqual({
        source: 'fallback',
        routedTier: 'medium',
        reason: 'unknown_choice',
      });
    }
  );

  it.each([
    ['probability', { probability: 1.2 }],
    ['confidence', { confidence: -0.1 }],
    ['risk', { risk: Number.NaN }],
    ['ambiguity', { ambiguity: 2 }],
  ] as [string, Partial<typeof confident>][])(
    'treats an out-of-range %s as no answer',
    (_l, answers) => {
      expect(decide(answers)).toEqual({
        source: 'fallback',
        routedTier: 'medium',
        reason: 'out_of_range',
      });
    }
  );
});

describe('readRouterSettings', () => {
  it('uses the documented defaults with only a key set', () => {
    expect(readRouterSettings(ENV)).toEqual({
      ok: true,
      settings: { apiKey: API_KEY, ...ROUTER_DEFAULTS },
    });
  });

  it('reads every setting from its variable', () => {
    const result = readRouterSettings({
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: 'https://jev.internal/',
      JEV_MODEL: 'other',
      JEV_ROUTER_TIMEOUT_MS: '900',
      JEV_ROUTER_MIN_PROB: '0.8',
      JEV_ROUTER_MIN_CONFIDENCE: '0.6',
      JEV_ROUTER_RISK_THRESHOLD: '0.2',
      JEV_ROUTER_AMBIGUITY_THRESHOLD: '0.4',
      JEV_ROUTER_MAX_CHARS: '1000',
    });
    expect(result).toEqual({
      ok: true,
      settings: {
        apiKey: API_KEY,
        apiBase: 'https://jev.internal/',
        model: 'other',
        timeoutMs: 900,
        minProbability: 0.8,
        minConfidence: 0.6,
        riskThreshold: 0.2,
        ambiguityThreshold: 0.4,
        maxChars: 1000,
      },
    });
  });

  it.each([
    [{}, 'no_api_key'],
    [{ JEV_API_KEY: '' }, 'no_api_key'],
    [{ ...ENV, JEV_ENABLED: '0' }, 'disabled_by_env'],
    [{ ...ENV, JEV_ENABLED: 'FALSE' }, 'disabled_by_env'],
    [{ ...ENV, JEV_ROUTER_ENABLED: '0' }, 'disabled_by_env'],
    [{ ...ENV, JEV_ROUTER_ENABLED: 'false' }, 'disabled_by_env'],
    [{ ...ENV, JEV_ROUTER_MIN_PROB: '1.5' }, 'invalid_setting:JEV_ROUTER_MIN_PROB'],
    [{ ...ENV, JEV_ROUTER_RISK_THRESHOLD: 'high' }, 'invalid_setting:JEV_ROUTER_RISK_THRESHOLD'],
    [{ ...ENV, JEV_ROUTER_TIMEOUT_MS: '0' }, 'invalid_setting:JEV_ROUTER_TIMEOUT_MS'],
    [{ ...ENV, JEV_ROUTER_MAX_CHARS: '1.5' }, 'invalid_setting:JEV_ROUTER_MAX_CHARS'],
  ] as [Record<string, string>, string][])('is off for %p', (env, reason) => {
    expect(readRouterSettings(env)).toEqual({ ok: false, reason });
  });

  it('leaves a master switch that is on, and one that is unset, alone', () => {
    expect(readRouterSettings({ ...ENV, JEV_ENABLED: '1', JEV_ROUTER_ENABLED: '' }).ok).toBe(true);
  });
});

describe('routeAgentNode', () => {
  it('returns nothing, and calls nothing, for a node the router may not touch', async () => {
    const { fetch, urls } = fakeFetch(answering());
    const { log, calls } = recordingLog();
    const routed = await routeAgentNode(
      candidate({ node: agentNode({ model: 'a-medium' }) }),
      opts({ fetch, log })
    );
    expect(routed).toBeUndefined();
    expect(urls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('lowers in apply mode and records the decision', async () => {
    const { fetch, urls } = fakeFetch(answering());
    const routed = await routeAgentNode(candidate(), opts({ fetch }));
    expect(urls).toEqual([`${ROUTER_DEFAULTS.apiBase}${JEV_ENDPOINT_PATH}`]);
    expect(routed).toEqual({
      stepText: STEP_TEXT,
      route: {
        mode: 'apply',
        source: 'jev',
        authoredTier: 'medium',
        routedTier: 'small',
        applied: true,
        chosenTier: 'small',
        probability: 0.95,
        confidence: 0.9,
        riskNoul: 0.02,
        ambiguityNoul: 0.05,
      },
    });
    expect(routed && nodeRouteSchema.parse(routed.route)).toEqual(routed?.route);
  });

  it('records the same decision in shadow mode without applying it', async () => {
    const { fetch } = fakeFetch(answering());
    const routed = await routeAgentNode(
      candidate({ config: { tiers: ['medium'], mode: 'shadow' } }),
      opts({ fetch })
    );
    expect(routed?.route).toMatchObject({
      mode: 'shadow',
      source: 'jev',
      routedTier: 'small',
      applied: false,
    });
  });

  it('asks its three questions over the step, the task and the features in one request', async () => {
    const node = agentNode({
      allowed_tools: ['Read'],
      mcp: 'servers.json',
      skills: ['lint'],
      mutates_checkout: false,
      output_format: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    });
    const { fetch, bodies } = fakeFetch(answering());
    await routeAgentNode(candidate({ node }), opts({ fetch }));

    expect(bodies).toHaveLength(1);
    const [body] = bodies;
    expect(body.model).toBe(ROUTER_DEFAULTS.model);
    expect(Object.keys(body.questions)).toEqual(['tier', 'high_risk', 'ambiguous_or_multi_step']);
    expect(body.questions.tier.type).toBe('choice');
    // The ceiling is always an option: the classifier must be able to say "do not lower".
    expect(Object.keys(body.questions.tier.criteria as object)).toEqual(['small', 'medium']);
    expect(body.questions.high_risk.type).toBe('noul');
    expect(body.questions.ambiguous_or_multi_step.type).toBe('noul');
    expect(body.state.step).toBe(STEP_TEXT);
    expect(body.state.task).toBe(TASK_TEXT);
    expect(body.state.features).toEqual({
      node_kind: 'inline',
      authored_tier: 'medium',
      has_output_format: true,
      tools_declared: true,
      mcp_present: true,
      skills_present: true,
      mutates_checkout: false,
      context_chars: STEP_TEXT.length + TASK_TEXT.length,
    });
  });

  it('removes planted secrets from the outgoing body and cuts both texts to the cap', async () => {
    const { fetch, raw, bodies } = fakeFetch(answering());
    await routeAgentNode(
      candidate({
        loadStepText: () =>
          Promise.resolve(`Deploy with DEPLOY_TOKEN=step-shaped-secret. ${'s'.repeat(400)}`),
        taskText: () =>
          `Use injected-exact-credential and password: task-shaped-secret, clone https://bot:url-secret@git.example.com/x. ${'t'.repeat(400)}`,
        credentialValues: () => ['injected-exact-credential'],
      }),
      opts({ env: { ...ENV, JEV_ROUTER_MAX_CHARS: '200' }, fetch })
    );
    for (const secret of [
      'step-shaped-secret',
      'injected-exact-credential',
      'task-shaped-secret',
      'url-secret',
    ]) {
      expect(raw[0]).not.toContain(secret);
    }
    expect(bodies[0].state.step).toMatch(/\[truncated \d+ chars\]$/);
    expect(bodies[0].state.task).toMatch(/\[truncated \d+ chars\]$/);
    // The size the classifier is told about is the real one, not the cut one.
    expect(bodies[0].state.features.context_chars).toBeGreaterThan(800);
  });

  it.each([
    [
      'a timeout',
      (): Response => {
        throw new DOMException('timed out', 'TimeoutError');
      },
      'timeout',
    ],
    [
      'a refused connection',
      (): Response => {
        throw new TypeError('fetch failed');
      },
      'network_error',
    ],
    ['a 500', (): Response => new Response('{}', { status: 500 }), 'http_error'],
    [
      'an unreadable body',
      (): Response => new Response('<html>', { status: 200 }),
      'malformed_response',
    ],
    [
      'a missing answer',
      (): Response =>
        new Response(
          JSON.stringify({
            answers: {
              tier: { type: 'choice', choice: 'small', probabilities: { small: 1 }, confidence: 1 },
            },
          }),
          { status: 200 }
        ),
      'malformed_response',
    ],
  ] as [string, () => Response, string][])(
    'keeps the ceiling and records a fallback on %s, without throwing',
    async (_label, respond, reason) => {
      const { fetch, urls } = fakeFetch(respond);
      const { log, calls } = recordingLog();
      const routed = await routeAgentNode(candidate(), opts({ fetch, log }));
      expect(urls).toHaveLength(1);
      expect(routed?.route).toEqual({
        mode: 'apply',
        source: 'fallback',
        authoredTier: 'medium',
        routedTier: 'medium',
        applied: false,
        reason,
      });
      expect(calls.map(([level]) => level)).toEqual(['warn']);
    }
  );

  it.each([
    ['no key', {}, 'no_api_key'],
    ['the Jev master switch off', { ...ENV, JEV_ENABLED: '0' }, 'disabled_by_env'],
    ['the router switch off', { ...ENV, JEV_ROUTER_ENABLED: 'false' }, 'disabled_by_env'],
    [
      'an unusable setting',
      { ...ENV, JEV_ROUTER_MIN_CONFIDENCE: 'x' },
      'invalid_setting:JEV_ROUTER_MIN_CONFIDENCE',
    ],
  ] as [string, Record<string, string>, string][])(
    'keeps the ceiling and calls nothing with %s',
    async (_label, env, reason) => {
      const { fetch, urls } = fakeFetch(answering());
      const routed = await routeAgentNode(candidate(), opts({ env, fetch }));
      expect(urls).toEqual([]);
      expect(routed?.route).toEqual({
        mode: 'apply',
        source: 'disabled',
        authoredTier: 'medium',
        routedTier: 'medium',
        applied: false,
        reason,
      });
    }
  );

  it('calls nothing when no lower tier can be offered', async () => {
    const { fetch, urls } = fakeFetch(answering());
    const { log, calls } = recordingLog();
    const routed = await routeAgentNode(
      candidate({ profile: CROSS_PROVIDER, sameProviderOnly: true }),
      opts({ fetch, log })
    );
    expect(urls).toEqual([]);
    expect(routed?.route).toMatchObject({
      source: 'disabled',
      reason: 'no_lower_tier',
      applied: false,
    });
    expect(calls[0][1].excluded).toEqual({ small: 'session_continuity' });
  });

  it.each([
    ['is unavailable', (): Promise<string | undefined> => Promise.resolve(undefined)],
    ['cannot be loaded', (): Promise<string | undefined> => Promise.reject(new Error('EACCES'))],
  ])(
    'calls nothing, and keeps the ceiling, when the step text %s',
    async (_label, loadStepText) => {
      const { fetch, urls } = fakeFetch(answering());
      const routed = await routeAgentNode(candidate({ loadStepText }), opts({ fetch }));
      expect(urls).toEqual([]);
      expect(routed).toEqual({
        route: {
          mode: 'apply',
          source: 'fallback',
          authoredTier: 'medium',
          routedTier: 'medium',
          applied: false,
          reason: 'step_text_unavailable',
        },
      });
    }
  );

  it('floors a risky answer at the ceiling and keeps what the classifier chose', async () => {
    const { fetch } = fakeFetch(answering({ risk: 0.8 }));
    const routed = await routeAgentNode(candidate(), opts({ fetch }));
    expect(routed?.route).toEqual({
      mode: 'apply',
      source: 'jev',
      authoredTier: 'medium',
      routedTier: 'medium',
      applied: false,
      chosenTier: 'small',
      probability: 0.95,
      confidence: 0.9,
      riskNoul: 0.8,
      ambiguityNoul: 0.05,
      reason: 'high_risk',
    });
  });

  it('never routes above the ceiling, whatever the classifier answers', async () => {
    const { fetch } = fakeFetch(answering({ choice: 'large' }));
    const routed = await routeAgentNode(candidate(), opts({ fetch }));
    expect(routed?.route).toMatchObject({
      source: 'fallback',
      routedTier: 'medium',
      applied: false,
      reason: 'unknown_choice',
    });
  });

  describe('a recorded route from an earlier pass of the same run', () => {
    const recorded: NodeRoute = {
      mode: 'apply',
      source: 'jev',
      authoredTier: 'medium',
      routedTier: 'small',
      applied: true,
      chosenTier: 'small',
      probability: 0.95,
      confidence: 0.9,
      riskNoul: 0.02,
      ambiguityNoul: 0.05,
    };

    it('is reused without classifying again', async () => {
      const { fetch, urls } = fakeFetch(answering({ choice: 'medium' }));
      const { log, calls } = recordingLog();
      const routed = await routeAgentNode(candidate({ recorded }), opts({ fetch, log }));
      expect(urls).toEqual([]);
      expect(routed).toEqual({ route: recorded });
      expect(calls.map(([, , message]) => message)).toEqual(['model_router.route_reused']);
    });

    it.each([
      ['no key', {}],
      ['the router switch off', { ...ENV, JEV_ROUTER_ENABLED: '0' }],
    ] as [string, Record<string, string>][])('is not applied with %s', async (_label, env) => {
      const routed = await routeAgentNode(candidate({ recorded }), opts({ env }));
      expect(routed?.route).toMatchObject({
        source: 'disabled',
        routedTier: 'medium',
        applied: false,
      });
    });

    it('follows the mode the operator has now', async () => {
      const routed = await routeAgentNode(
        candidate({ recorded, config: { tiers: ['medium'], mode: 'shadow' } }),
        opts()
      );
      expect(routed?.route).toEqual({ ...recorded, mode: 'shadow', applied: false });
    });

    it('stays at the ceiling once the node has escalated', async () => {
      const escalated = escalateRoute(recorded, 'output_contract');
      const routed = await routeAgentNode(candidate({ recorded: escalated }), opts());
      expect(routed?.route).toEqual(escalated);
      expect(routed?.route.applied).toBe(false);
    });

    it('falls back to the ceiling when its tier may no longer be offered', async () => {
      const { fetch, urls } = fakeFetch(answering());
      const routed = await routeAgentNode(
        candidate({ recorded, profile: CROSS_PROVIDER, sameProviderOnly: true }),
        opts({ fetch })
      );
      expect(urls).toEqual([]);
      expect(routed?.route).toEqual({
        mode: 'apply',
        source: 'fallback',
        authoredTier: 'medium',
        routedTier: 'medium',
        applied: false,
        reason: 'recorded_route_unavailable',
      });
    });

    it('is ignored when it was decided for a different authored tier', async () => {
      const { fetch, urls } = fakeFetch(answering());
      const routed = await routeAgentNode(
        candidate({ recorded: { ...recorded, authoredTier: 'large' } }),
        opts({ fetch })
      );
      expect(urls).toHaveLength(1);
      expect(routed?.route.source).toBe('jev');
    });
  });

  it('logs one event per decision, with no step text, task text or key in it', async () => {
    for (const respond of [
      answering(),
      answering({ risk: 0.9 }),
      () => new Response('{}', { status: 500 }),
    ]) {
      const { fetch } = fakeFetch(respond);
      const { log, calls } = recordingLog();
      await routeAgentNode(candidate(), opts({ fetch, log }));
      expect(calls).toHaveLength(1);
      const [, data, message] = calls[0];
      expect(message).toBe('model_router.decision');
      expect(data.nodeId).toBe('step');
      expect(typeof data.latencyMs).toBe('number');
      const serialized = JSON.stringify(calls);
      expect(serialized).not.toContain(STEP_TEXT);
      expect(serialized).not.toContain(TASK_TEXT);
      expect(serialized).not.toContain(API_KEY);
    }
  });
});

describe('formatTaskText', () => {
  it('is the message alone when the run has no inputs', () => {
    expect(formatTaskText('fix the login bug', undefined)).toBe('fix the login bug');
    expect(formatTaskText('fix the login bug', {})).toBe('fix the login bug');
  });

  it('appends named inputs, and stands alone when there is no message', () => {
    expect(formatTaskText('ship it', { target: '#12', publish: false })).toBe(
      'ship it\n\nInputs:\ntarget: #12\npublish: false'
    );
    expect(formatTaskText('', { scope: { dir: 'packages/web' } })).toBe(
      'Inputs:\nscope: {"dir":"packages/web"}'
    );
  });
});

describe('escalation', () => {
  const applied: NodeRoute = {
    mode: 'apply',
    source: 'jev',
    authoredTier: 'medium',
    routedTier: 'small',
    applied: true,
    chosenTier: 'small',
    probability: 0.95,
    confidence: 0.9,
    riskNoul: 0.02,
    ambiguityNoul: 0.05,
  };
  const failed = (failureKind?: string): { state: 'failed'; failureKind?: string } => ({
    state: 'failed',
    ...(failureKind !== undefined ? { failureKind } : {}),
  });

  it.each(['output_contract', 'fatal', 'rate_limited', 'transient', 'unknown', 'timeout'])(
    'escalates a down-routed node that failed with %s',
    kind => {
      expect(escalationReason(applied, failed(kind))).toBe(kind as never);
    }
  );

  it.each(['cancelled', 'config', 'exec_failed', 'max_iterations', 'child_failed', 'not-a-kind'])(
    'does not escalate on %s',
    kind => {
      expect(escalationReason(applied, failed(kind))).toBeUndefined();
    }
  );

  it('does not escalate a failure that carries no kind', () => {
    expect(escalationReason(applied, failed())).toBeUndefined();
  });

  it('does not escalate a node that completed', () => {
    expect(escalationReason(applied, { state: 'completed' })).toBeUndefined();
  });

  it.each([
    ['no route', undefined],
    ['a shadow route', { ...applied, mode: 'shadow' as const, applied: false }],
    [
      'a route that kept the ceiling',
      { ...applied, routedTier: 'medium' as TierName, applied: false },
    ],
    ['a route that has already escalated', escalateRoute(applied, 'timeout')],
  ] as [string, NodeRoute | undefined][])('does not escalate with %s', (_label, route) => {
    expect(escalationReason(route, failed('output_contract'))).toBeUndefined();
  });

  it('records where it escalated from and why, and no longer applies a lower tier', () => {
    const escalated = escalateRoute(applied, 'output_contract');
    expect(escalated).toEqual({
      ...applied,
      routedTier: 'medium',
      applied: false,
      escalatedFrom: 'small',
      escalationReason: 'output_contract',
    });
    expect(nodeRouteSchema.parse(escalated)).toEqual(escalated);
  });
});
