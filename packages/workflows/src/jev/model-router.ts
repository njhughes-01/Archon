/**
 * The cost-aware model router: decides whether one workflow agent node may run on a
 * cheaper model tier than its author declared.
 *
 * The authored tier is the ceiling. The router can only keep it or go below it, and every
 * outcome other than a confident, low-risk, unambiguous pick of an offered lower tier is
 * the ceiling. It never throws and never holds a node for longer than its timeout, so a
 * node resolves exactly as it would with no router whenever the router has nothing to say.
 *
 * Three steps, each a pure function the evaluation runner also calls:
 *  1. `routingCeiling` — may this node be routed at all, and what is its ceiling;
 *  2. `offerTiers`     — which lower tiers could run it without losing anything;
 *  3. `decideTier`     — deterministic floors over the classifier's answers.
 *
 * Operator opt-in comes from `modelRouter:` in the config; the connection and the
 * thresholds come from the environment, like every other Jev feature, because this
 * package cannot import `@archon/core`.
 */
import { createLogger } from '@archon/paths';
import {
  findRequiredPropertyGaps,
  getProviderCapabilities,
  isRegisteredProvider,
} from '@archon/providers';
import { hasOpenAdditionalProperties } from '@archon/providers/structured-output';
import type { ProviderCapabilities } from '@archon/providers/types';
import { unsupportedNodeFields, type NodeCapabilityScope } from '../node-capability-checks';
import type { NodeModelResolution } from '../node-model-resolution';
import { redactForClassifier } from '../redaction';
import { isNodeContextResume, type AgentNode } from '../schemas/dag-node';
import { TIER_NAMES, type ResolvedAiProfile, type TierName } from '../schemas/model-binding';
import type { NodeFailureKind } from '../schemas/node-execution';
import type { ModelRouterConfig, NodeRoute } from '../schemas/model-router';
import { askJev, type Fetch, type JevQuestion, type JevStateValue } from './jev-client';

export const ROUTER_DEFAULTS = {
  apiBase: 'https://api.typesafe.ai',
  model: 'jev-1.13.0',
  /** The longest a node waits for a route before it runs on its authored tier. */
  timeoutMs: 3000,
  /** The chosen tier needs at least this probability. */
  minProbability: 0.75,
  /** The choice needs at least this confidence. */
  minConfidence: 0.5,
  /** A high-risk answer at or above this keeps the ceiling. */
  riskThreshold: 0.3,
  /** An ambiguous-or-multi-step answer at or above this keeps the ceiling. */
  ambiguityThreshold: 0.5,
  /**
   * Most characters of the step's authored text that are sent. Deliberately short: the
   * opening of a command or prompt says what the step is for, and the pages of procedure
   * after it make every step read as long, multi-part work.
   */
  maxStepChars: 1200,
  /** Most characters of the run's task text that are sent. */
  maxTaskChars: 4000,
} as const;

export interface RouterThresholds {
  minProbability: number;
  minConfidence: number;
  riskThreshold: number;
  ambiguityThreshold: number;
}

export interface RouterSettings extends RouterThresholds {
  apiKey: string;
  apiBase: string;
  model: string;
  timeoutMs: number;
  maxStepChars: number;
  maxTaskChars: number;
}

export type RouterEnv = Readonly<Record<string, string | undefined>>;

const isUnit = (value: number): boolean => value >= 0 && value <= 1;
const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** `0`, `false`, `off` or `no` in any case. Unset and empty leave the feature on. */
function isSwitchedOff(raw: string | undefined): boolean {
  return raw !== undefined && OFF_VALUES.has(raw.trim().toLowerCase());
}

/** Why the router makes no request at all in this environment, or `undefined` when it can. */
export function routerInactiveReason(env: RouterEnv): 'disabled_by_env' | 'no_api_key' | undefined {
  // JEV_ENABLED is the switch for every Jev feature; JEV_ROUTER_ENABLED is this one's alone.
  if (isSwitchedOff(env.JEV_ENABLED) || isSwitchedOff(env.JEV_ROUTER_ENABLED)) {
    return 'disabled_by_env';
  }
  return env.JEV_API_KEY ? undefined : 'no_api_key';
}

/**
 * The router's settings, or why it is off. An unusable number turns the router off rather
 * than falling back to a default: a threshold the operator mistyped must not be replaced by
 * one they did not choose, and "off" shows up as the reason on every route record.
 */
export function readRouterSettings(
  env: RouterEnv
): { ok: true; settings: RouterSettings } | { ok: false; reason: string } {
  const inactive = routerInactiveReason(env);
  const apiKey = env.JEV_API_KEY;
  if (inactive !== undefined || !apiKey) return { ok: false, reason: inactive ?? 'no_api_key' };

  const invalid: string[] = [];
  const read = (name: string, fallback: number, isUsable: (value: number) => boolean): number => {
    const raw = env[name];
    // `Number('')` is 0, so an empty variable is treated as unset before it is parsed.
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (Number.isFinite(value) && isUsable(value)) return value;
    invalid.push(name);
    return fallback;
  };
  const settings: RouterSettings = {
    apiKey,
    apiBase: env.JEV_API_BASE?.trim() || ROUTER_DEFAULTS.apiBase,
    model: env.JEV_MODEL?.trim() || ROUTER_DEFAULTS.model,
    timeoutMs: read('JEV_ROUTER_TIMEOUT_MS', ROUTER_DEFAULTS.timeoutMs, isPositiveInteger),
    minProbability: read('JEV_ROUTER_MIN_PROB', ROUTER_DEFAULTS.minProbability, isUnit),
    minConfidence: read('JEV_ROUTER_MIN_CONFIDENCE', ROUTER_DEFAULTS.minConfidence, isUnit),
    riskThreshold: read('JEV_ROUTER_RISK_THRESHOLD', ROUTER_DEFAULTS.riskThreshold, isUnit),
    ambiguityThreshold: read(
      'JEV_ROUTER_AMBIGUITY_THRESHOLD',
      ROUTER_DEFAULTS.ambiguityThreshold,
      isUnit
    ),
    maxStepChars: read(
      'JEV_ROUTER_MAX_STEP_CHARS',
      ROUTER_DEFAULTS.maxStepChars,
      isPositiveInteger
    ),
    maxTaskChars: read(
      'JEV_ROUTER_MAX_TASK_CHARS',
      ROUTER_DEFAULTS.maxTaskChars,
      isPositiveInteger
    ),
  };
  if (invalid.length > 0) return { ok: false, reason: `invalid_setting:${invalid[0]}` };
  return { ok: true, settings };
}

/** A provider's capabilities, or `undefined` when no such provider is registered. */
export type CapabilityLookup = (provider: string) => ProviderCapabilities | undefined;

const registeredCapabilities: CapabilityLookup = provider =>
  isRegisteredProvider(provider) ? getProviderCapabilities(provider) : undefined;

/** Everything about one node that decides whether, and how far, it may be lowered. */
export interface RoutingCandidate {
  node: AgentNode;
  /** The node's resolution with no router, from `resolveNodeModel`. */
  resolution: Pick<NodeModelResolution, 'provider' | 'tier' | 'preset'>;
  aiProfile: ResolvedAiProfile | undefined;
  config: ModelRouterConfig;
  /** Another node resumes this node's session by name (`context: { resume }`). */
  isResumeSource: boolean;
  /** The node's session is stored and resumed across runs (`persist_session`). */
  usesPersistedScope: boolean;
  /**
   * The node's provider must not change, because a session may cross it. False only when
   * the caller has shown both halves: the node starts without a session, and no later node
   * can inherit the one it creates. Anything not shown is `true`.
   */
  sameProviderOnly: boolean;
  /** The run executes inside the container backend. */
  inContainer: boolean;
  capabilityScope: NodeCapabilityScope;
  /**
   * Whether this run may use a provider at all, for conditions no node field expresses.
   * Absent means every registered provider is usable. The tool-action gate supplies it:
   * with the gate on, a provider without the `toolActionGate` capability fails at
   * dispatch, so a tier on such a provider must never be offered.
   */
  providerUsable?: (provider: string) => boolean;
}

/**
 * The ceiling a node's own definition and the operator's config give it, or `undefined`
 * when they rule routing out. This is everything a dry run can know; `routingCeiling`
 * adds what only a run knows.
 *
 * Only a tier keyword the operator named is a ceiling. A literal model and an `@alias` are
 * the author pinning one exact model, so they resolve with no `tier` and never get here.
 */
export function authoredCeiling(
  node: Pick<AgentNode, 'context'>,
  resolution: Pick<NodeModelResolution, 'tier' | 'preset'>,
  config: ModelRouterConfig
): TierName | undefined {
  const ceiling = resolution.tier;
  if (ceiling === undefined || resolution.preset === undefined) return undefined;
  if (config.mode === 'off' || !config.tiers.includes(ceiling)) return undefined;
  // The consumer of a named session resume must run on its source's provider.
  if (isNodeContextResume(node.context)) return undefined;
  return ceiling;
}

/**
 * The tier a node may be lowered from, or `undefined` when the router must leave it alone.
 *
 * A node in a named resume pair or with a persisted session is left alone entirely: its
 * session outlives the attempt, and the provider and model that own a session are not the
 * router's to change.
 */
export function routingCeiling(
  candidate: RoutingCandidate,
  getCapabilities: CapabilityLookup = registeredCapabilities
): TierName | undefined {
  const { node, resolution, aiProfile, config } = candidate;
  const ceiling = authoredCeiling(node, resolution, config);
  if (aiProfile === undefined || ceiling === undefined) return undefined;
  if (candidate.isResumeSource || candidate.usesPersistedScope) return undefined;
  // An unregistered ceiling fails the node today. Routing it elsewhere would turn that
  // failure into a success on a provider the author never named.
  if (getCapabilities(resolution.provider) === undefined) return undefined;
  return ceiling;
}

/**
 * Why a provider cannot be trusted to show that it got the node wrong, or `undefined` when
 * it can. A node is lowered only where escalation could catch a bad result, and the one
 * thing escalation can see is a failed output contract. So the target must enforce the
 * node's `output_format` as written: grammar-constrained decoding, every property required
 * where the provider demands it, and no open `additionalProperties` that a strict provider
 * would silently close.
 */
function unverifiableOn(node: AgentNode, caps: ProviderCapabilities): string | undefined {
  if (node.output_format === undefined) return 'unverifiable';
  if (caps.structuredOutput !== 'enforced') return 'structured_output';
  if (!caps.requiresAllPropertiesRequired) return undefined;
  // The run-start strict-schema check only looked at the authored tier's provider.
  if (findRequiredPropertyGaps(node.output_format, 'output_format').length > 0) {
    return 'strict_schema';
  }
  return hasOpenAdditionalProperties(node.output_format) ? 'open_schema' : undefined;
}

/** Why a provider other than the ceiling's cannot take the node, or `undefined` when it can. */
function crossProviderExclusion(
  candidate: RoutingCandidate,
  provider: string,
  caps: ProviderCapabilities,
  ceilingCaps: ProviderCapabilities
): string | undefined {
  const { node, capabilityScope } = candidate;
  if (candidate.sameProviderOnly) return 'session_continuity';
  // A node that names its provider would get a new "model resolves to another provider"
  // warning, and the author's stated provider would lose to the router's.
  if (node.provider !== undefined && node.provider !== provider) return 'declared_provider';
  // A node that promises to leave the checkout alone fails outright if a lower tier on
  // another provider writes to it, and no second attempt can undo the write.
  if (node.mutates_checkout === false) return 'read_only_node';
  // The run-start container pre-scan only looked at the authored tier's provider.
  if (candidate.inContainer && !caps.containerExec) return 'container_exec';
  // A field the ceiling honours and this provider would silently ignore: a dropped tool
  // restriction is a broadened permission, a dropped sandbox or spend limit a lost guard.
  const ceilingUnsupported = new Set(
    unsupportedNodeFields(node, candidate.resolution.provider, ceilingCaps, capabilityScope)
  );
  const lost = unsupportedNodeFields(node, provider, caps, capabilityScope).find(
    field => !ceilingUnsupported.has(field)
  );
  return lost !== undefined ? `unsupported:${lost}` : undefined;
}

export interface TierOffer {
  /** Lower tiers the node could run on, lowest first. */
  offered: TierName[];
  /** Lower tiers that were not offered, and why. */
  excluded: Partial<Record<TierName, string>>;
}

/**
 * The tiers below `ceiling` that could run the node. A tier is offered only when it has a
 * preset of its own (a missing tier falls back to a higher one, which would raise the
 * node), differs from the ceiling's preset, names a provider this run may use and that
 * enforces the node's output contract, and, on another provider, can run everything the
 * ceiling's provider can. A tier on the ceiling's own provider needs no capability
 * comparison: capabilities belong to the provider, not the model.
 */
export function offerTiers(
  candidate: RoutingCandidate,
  ceiling: TierName,
  getCapabilities: CapabilityLookup = registeredCapabilities
): TierOffer {
  const offer: TierOffer = { offered: [], excluded: {} };
  const ceilingPreset = candidate.resolution.preset;
  const ceilingCaps = getCapabilities(candidate.resolution.provider);
  if (
    candidate.aiProfile === undefined ||
    ceilingPreset === undefined ||
    ceilingCaps === undefined
  ) {
    return offer;
  }
  for (const tier of TIER_NAMES.slice(0, TIER_NAMES.indexOf(ceiling))) {
    const preset = Object.hasOwn(candidate.aiProfile.aliases, tier)
      ? candidate.aiProfile.aliases[tier]
      : undefined;
    let exclusion: string | undefined;
    if (preset === undefined) {
      exclusion = 'no_preset';
    } else if (
      preset.provider === ceilingPreset.provider &&
      preset.model === ceilingPreset.model &&
      preset.effort === ceilingPreset.effort
    ) {
      exclusion = 'same_as_ceiling';
    } else {
      const caps = getCapabilities(preset.provider);
      if (caps === undefined) exclusion = 'unregistered_provider';
      else if (candidate.providerUsable?.(preset.provider) === false) {
        exclusion = 'provider_unusable';
      } else {
        exclusion =
          (preset.provider !== ceilingPreset.provider
            ? crossProviderExclusion(candidate, preset.provider, caps, ceilingCaps)
            : undefined) ?? unverifiableOn(candidate.node, caps);
      }
    }
    if (exclusion === undefined) offer.offered.push(tier);
    else offer.excluded[tier] = exclusion;
  }
  return offer;
}

/** What the classifier said, before any threshold is applied. */
export interface ClassifierAnswers {
  choice: string;
  probability: number;
  confidence: number;
  risk: number;
  ambiguity: number;
}

export interface TierDecision {
  source: 'jev' | 'fallback';
  routedTier: TierName;
  chosenTier?: TierName;
  reason?: string;
}

/**
 * Apply the deterministic floors to one set of answers. Risk and ambiguity are checked
 * first, so a confident "small" can never outvote "this touches production". A threshold
 * is met at equality: risk at its threshold floors, probability at its minimum passes.
 */
export function decideTier(
  answers: ClassifierAnswers,
  ceiling: TierName,
  offered: readonly TierName[],
  thresholds: RouterThresholds
): TierDecision {
  const keep = (reason: string, chosenTier?: TierName): TierDecision => ({
    source: chosenTier === undefined ? 'fallback' : 'jev',
    routedTier: ceiling,
    ...(chosenTier !== undefined ? { chosenTier } : {}),
    reason,
  });
  // An answer that names no offered tier, or carries a number that is not a probability,
  // is not an answer: reported as a failed call, since no threshold would have used it.
  const chosenTier = [...offered, ceiling].find(tier => tier === answers.choice);
  if (chosenTier === undefined) return keep('unknown_choice');
  const numbers = [answers.probability, answers.confidence, answers.risk, answers.ambiguity];
  if (!numbers.every(isUnit)) return keep('out_of_range');

  if (answers.risk >= thresholds.riskThreshold) return keep('high_risk', chosenTier);
  if (answers.ambiguity >= thresholds.ambiguityThreshold) {
    return keep('ambiguous_or_multi_step', chosenTier);
  }
  if (answers.probability < thresholds.minProbability) return keep('low_probability', chosenTier);
  if (answers.confidence < thresholds.minConfidence) return keep('low_confidence', chosenTier);
  if (chosenTier === ceiling) return keep('ceiling_chosen', chosenTier);
  return { source: 'jev', routedTier: chosenTier, chosenTier };
}

/**
 * Facts about a step computed in code, so the classifier need not infer them from prose.
 *
 * Nothing here depends on how the step reached the run. A command run by its own workflow
 * and the same command composed into another through `include:` differ in node id and in
 * source kind, and must look identical to the classifier, so neither is sent. The authored
 * tier is not sent either: the offered tiers are already the question's options, and
 * naming the one the author picked anchors the answer there. Whether the step declares an
 * output format is not a fact worth sending, because only steps that do are classified.
 */
export interface RouteFeatures {
  [key: string]: JevStateValue;
  tools_declared: boolean;
  mcp_present: boolean;
  skills_present: boolean;
  /**
   * The node declares `mutates_checkout: false`, so the engine fails it if it changes the
   * working tree. Named for what is known: a node that does not declare it may still be
   * read-only by its instructions, so the reverse (`mutates_checkout: true`) would claim
   * more than the engine knows.
   */
  read_only_enforced: boolean;
  /** Characters of step and task text before either is cut. */
  context_chars: number;
}

export function routeFeatures(node: AgentNode, stepText: string, taskText: string): RouteFeatures {
  return {
    tools_declared: node.allowed_tools !== undefined || node.denied_tools !== undefined,
    mcp_present: node.mcp !== undefined,
    skills_present: node.skills !== undefined && node.skills.length > 0,
    read_only_enforced: node.mutates_checkout === false,
    context_chars: stepText.length + taskText.length,
  };
}

/** The run's task input as one text: the triggering message, then its named inputs. */
export function formatTaskText(
  userMessage: string,
  inputs: Readonly<Record<string, unknown>> | undefined
): string {
  const lines = Object.entries(inputs ?? {}).map(
    ([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
  );
  const parts = [userMessage.trim(), lines.length > 0 ? `Inputs:\n${lines.join('\n')}` : ''];
  return parts.filter(part => part.length > 0).join('\n\n');
}

const TIER_QUESTION = 'tier';
const RISK_QUESTION = 'high_risk';
const AMBIGUITY_QUESTION = 'ambiguous_or_multi_step';

/**
 * What each tier is for. Keyed by `TierName`, so a new tier cannot be offered undescribed.
 *
 * Each entry stands on its own: what the work is, kinds of work that are it, and what it
 * is not. The examples name kinds of work, never the steps of any one workflow pack: a
 * description that lists a pack's own steps would only teach the classifier that pack.
 */
const TIER_CRITERIA: Record<TierName, string> = {
  small:
    'Collecting, listing, sorting or restating facts that already exist, by following fixed instructions. Examples: reading files or command output and listing what they define; putting an observed result into one of a few given categories; writing a short description of a small, single-purpose change from material already at hand. Not for work whose answer depends on weighing trade-offs, on understanding unfamiliar code in depth, or on a sensitive subject.',
  medium:
    'Engineering judgement on a clearly stated task within one part of a system. Examples: examining a change for defects; finding the cause of a defect that has a known symptom in one area; assessing a request and deciding what it needs next; making a well-specified change; condensing a large, multi-part body of work from several sources. Not for collecting or restating known facts, and not for design decisions or sensitive changes.',
  large:
    'Hard or consequential reasoning. Examples: architecture or design decisions; requirements that are unclear or conflict; diagnosing a problem that has no reproduction or several possible causes across components; changes to security, data schemas, deletion or money; work that spans several systems.',
};

/**
 * The three judgments, asked together over one state. Each is one narrow question about
 * the task or the step, and each says what does not count, because the two failure modes
 * seen in evaluation were reading a long fixed procedure as ambiguity and reading a
 * routine push or pull-request description as risk.
 */
function buildQuestions(tiers: readonly TierName[]): Record<string, JevQuestion> {
  return {
    [TIER_QUESTION]: {
      type: 'choice',
      instructions:
        "A workflow engine is about to run one step. `task` is what this run was asked to do. `step` is the opening of the step's fixed instructions, and `features` are facts about the step. Which is the smallest model tier that can do this step well for this task? Judge the thinking the step needs, not the length of its instructions: a step that follows a fixed procedure is not harder because the procedure has many parts.",
      criteria: Object.fromEntries(tiers.map(tier => [tier, TIER_CRITERIA[tier]])),
    },
    [RISK_QUESTION]: {
      type: 'noul',
      instructions:
        'Is the subject of `task` a sensitive area where a wrong result is costly or hard to undo: authentication or authorization, credentials or secrets, database schemas or migrations, deleting data or files, money or billing, or a change made directly to production systems or data?',
      criteria: {
        true: 'The task is about one of those sensitive areas, so a mistake could open a security hole, lose data, charge someone wrongly or break production. This holds even when the step only reviews, describes or summarises such a change.',
        false:
          'The task is about ordinary code, tests, documentation or tooling. Pushing a work-in-progress branch, or writing or updating a pull-request description or a report, does not make a task sensitive by itself.',
      },
    },
    [AMBIGUITY_QUESTION]: {
      type: 'noul',
      instructions:
        'Does `task` leave open what should be done: is it under-specified, open to more than one reasonable reading, or does it leave a design decision across several parts of a system to whoever does the work?',
      criteria: {
        true: 'A careful engineer would have to guess the intent, choose between designs, or settle requirements before starting.',
        false:
          'The task says what is wanted. A step whose fixed instructions list several things to do, in order, is not unclear for that reason.',
      },
    },
  };
}

/** The route for a decision that keeps the ceiling without a classifier answer. */
function ceilingRoute(
  mode: NodeRoute['mode'],
  ceiling: TierName,
  source: NodeRoute['source'],
  reason: string
): NodeRoute {
  return { mode, source, authoredTier: ceiling, routedTier: ceiling, applied: false, reason };
}

export interface RouteAgentNodeInput extends RoutingCandidate {
  /** The route an earlier pass of this run recorded for this node, if any. */
  recorded?: NodeRoute;
  /**
   * The node's authored command or prompt text, before any run data is substituted into
   * it. Resolves `undefined`, or rejects, when the text cannot be had; the node then keeps
   * its ceiling and its own execution reports the cause.
   */
  loadStepText: () => Promise<string | undefined>;
  /** The run's task input. Called only when a request will be sent. */
  taskText: () => string;
  /** Exact credential values to remove from both texts. Called only when a request will be sent. */
  credentialValues: () => readonly string[];
}

export interface RouterLog {
  info: (data: Record<string, unknown>, message: string) => void;
  warn: (data: Record<string, unknown>, message: string) => void;
  debug: (data: Record<string, unknown>, message: string) => void;
}

export interface RouteOptions {
  /** Configuration source; defaults to `process.env`. */
  env?: RouterEnv;
  /** HTTP boundary; defaults to the global `fetch`. */
  fetch?: Fetch;
  getCapabilities?: CapabilityLookup;
  log?: RouterLog;
}

export interface RoutedNode {
  route: NodeRoute;
  /** The step text, when it was loaded to classify the node, so the caller need not read it again. */
  stepText?: string;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): RouterLog {
  cachedLog ??= createLogger('workflow.model-router');
  return cachedLog;
}

/**
 * Decide one agent node's route. Returns `undefined` when the router may not touch the
 * node; such a node gets no route record and no log line, exactly as with no router.
 *
 * Otherwise the result is always a route, and every route other than a confident pick of
 * an offered lower tier is the ceiling. Logs one event per decision: tiers, numbers and
 * reasons only, never the step text, the task text or the key.
 */
export async function routeAgentNode(
  input: RouteAgentNodeInput,
  options: RouteOptions = {}
): Promise<RoutedNode | undefined> {
  const getCapabilities = options.getCapabilities ?? registeredCapabilities;
  const log = options.log ?? getLog();
  const env = options.env ?? process.env;
  // With no key, or with a switch off, the router is absent: no route, no record, whatever
  // an earlier pass of the run decided. This is what "optional" means for a config block
  // that is present on a machine that cannot or may not classify.
  if (routerInactiveReason(env) !== undefined) return undefined;
  const ceiling = routingCeiling(input, getCapabilities);
  if (ceiling === undefined) return undefined;
  const mode = input.config.mode === 'apply' ? 'apply' : 'shadow';
  try {
    return await decideRoute(input, ceiling, mode, env, options.fetch, getCapabilities, log);
  } catch (error) {
    // Routing is advice. Whatever goes wrong inside it (a caller's loader, a provider
    // lookup, a malformed node) must leave the node on its authored tier, never fail it.
    const route = ceilingRoute(mode, ceiling, 'fallback', 'router_error');
    log.warn(
      {
        nodeId: input.node.id,
        ...route,
        errorName: error instanceof Error ? error.name : 'unknown',
      },
      'model_router.decision'
    );
    return { route };
  }
}

async function decideRoute(
  input: RouteAgentNodeInput,
  ceiling: TierName,
  mode: NodeRoute['mode'],
  env: RouterEnv,
  fetch: Fetch | undefined,
  getCapabilities: CapabilityLookup,
  log: RouterLog
): Promise<RoutedNode> {
  const nodeId = input.node.id;
  const offer = offerTiers(input, ceiling, getCapabilities);

  const startedAt = Date.now();
  const finish = (route: NodeRoute, extra: Record<string, unknown> = {}): NodeRoute => {
    const fields = { nodeId, ...route, latencyMs: Date.now() - startedAt, ...extra };
    // Keeping the ceiling is the documented outcome of every unusable answer, so it is
    // logged rather than raised. Not configured is quiet; a failed call is the one an
    // operator must see without asking.
    if (route.source === 'fallback') log.warn(fields, 'model_router.decision');
    else if (route.source === 'disabled') log.debug(fields, 'model_router.decision');
    else log.info(fields, 'model_router.decision');
    return route;
  };

  // Only an unusable setting reaches here as "not ok": the operator meant the router to
  // run and mistyped a number, which they need to see on the record.
  const read = readRouterSettings(env);
  if (!read.ok) return { route: finish(ceilingRoute(mode, ceiling, 'disabled', read.reason)) };
  const { settings } = read;

  // A node with no output contract gives escalation nothing to check, so a weak answer
  // from a lower tier would pass unseen. It is never lowered, on any provider, and the
  // classifier is not asked.
  if (input.node.output_format === undefined) {
    return { route: finish(ceilingRoute(mode, ceiling, 'disabled', 'unverifiable')) };
  }

  // A resumed or restarted run keeps the route its first pass recorded: the same node of
  // the same run must not be classified twice, and a node that escalated stays escalated.
  // The offer and the mode are checked again because config may have changed in between.
  const { recorded } = input;
  if (recorded?.authoredTier === ceiling) {
    const stillOffered =
      recorded.routedTier === ceiling || offer.offered.includes(recorded.routedTier);
    const route: NodeRoute = stillOffered
      ? { ...recorded, mode, applied: mode === 'apply' && recorded.routedTier !== ceiling }
      : ceilingRoute(mode, ceiling, 'fallback', 'recorded_route_unavailable');
    log.info(
      { nodeId, mode, authoredTier: ceiling, routedTier: route.routedTier, applied: route.applied },
      'model_router.route_reused'
    );
    return { route };
  }

  // Nothing to choose between, so asking would spend a call to learn nothing.
  if (offer.offered.length === 0) {
    return {
      route: finish(ceilingRoute(mode, ceiling, 'disabled', 'no_lower_tier'), {
        excluded: offer.excluded,
      }),
    };
  }

  // The loader is the caller's and may fail for reasons the node's own execution reports
  // properly (a missing command file fails the node as `config`). Routing must not turn
  // that into a different failure, so any miss here just keeps the ceiling.
  let stepText: string | undefined;
  try {
    stepText = await input.loadStepText();
  } catch {
    stepText = undefined;
  }
  if (stepText === undefined) {
    return { route: finish(ceilingRoute(mode, ceiling, 'fallback', 'step_text_unavailable')) };
  }
  const taskText = input.taskText();
  const credentialValues = input.credentialValues();

  const result = await askJev({
    apiBase: settings.apiBase,
    apiKey: settings.apiKey,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    fetch,
    questions: buildQuestions([...offer.offered, ceiling]),
    // The task and the computed facts come first and the step text is only its opening:
    // what the run was asked to do decides the tier far more than the step's procedure.
    state: {
      task: redactForClassifier(taskText, credentialValues, settings.maxTaskChars),
      features: routeFeatures(input.node, stepText, taskText),
      step: redactForClassifier(stepText, credentialValues, settings.maxStepChars),
    },
  });
  if (!result.ok) {
    return {
      stepText,
      route: finish(
        ceilingRoute(mode, ceiling, 'fallback', result.reason),
        result.status !== undefined ? { status: result.status } : {}
      ),
    };
  }

  const tier = result.answers[TIER_QUESTION];
  const risk = result.answers[RISK_QUESTION];
  const ambiguity = result.answers[AMBIGUITY_QUESTION];
  // The client returns each answer under the type it was asked as; this only narrows.
  if (tier.type !== 'choice' || risk.type !== 'noul' || ambiguity.type !== 'noul') {
    return {
      stepText,
      route: finish(ceilingRoute(mode, ceiling, 'fallback', 'malformed_response')),
    };
  }
  const answers: ClassifierAnswers = {
    choice: tier.choice,
    probability: tier.probability,
    confidence: tier.confidence,
    risk: risk.noul,
    ambiguity: ambiguity.noul,
  };
  const decision = decideTier(answers, ceiling, offer.offered, settings);
  if (decision.source === 'fallback') {
    return {
      stepText,
      route: finish(ceilingRoute(mode, ceiling, 'fallback', decision.reason ?? 'unusable_answer')),
    };
  }
  return {
    stepText,
    route: finish(
      {
        mode,
        source: 'jev',
        authoredTier: ceiling,
        routedTier: decision.routedTier,
        applied: mode === 'apply' && decision.routedTier !== ceiling,
        ...(decision.chosenTier !== undefined ? { chosenTier: decision.chosenTier } : {}),
        probability: answers.probability,
        confidence: answers.confidence,
        riskNoul: answers.risk,
        ambiguityNoul: answers.ambiguity,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      },
      { excluded: offer.excluded }
    ),
  };
}

/**
 * Whether a lower-tier attempt that ended in each failure kind is retried once on the
 * authored tier. A full record, so a new failure kind cannot be added without deciding.
 *
 * `output_contract` is the verification failure: the cheaper model's output did not meet
 * the node's declared contract. The provider-error kinds are here too, because an error
 * from the cheaper model or its provider (no access, quota, an outage) must not fail a run
 * that would have succeeded with no router. `cancelled` is the operator's decision and
 * `config` is a fault in the node itself, which the authored tier would hit identically.
 * The rest cannot come from an agent node.
 */
const ESCALATES: Record<NodeFailureKind, boolean> = {
  output_contract: true,
  fatal: true,
  transient: true,
  rate_limited: true,
  unknown: true,
  timeout: true,
  cancelled: false,
  config: false,
  exec_failed: false,
  max_iterations: false,
  child_failed: false,
};

function escalates(kind: string): kind is NodeFailureKind {
  return Object.hasOwn(ESCALATES, kind) && ESCALATES[kind as NodeFailureKind];
}

/**
 * The failure kind that sends a node back to its authored tier, or `undefined` when it
 * should not escalate. Only a node that actually ran on a lower tier escalates, and only
 * on a failure kind recorded where the failure happened: never on error text.
 */
export function escalationReason(
  route: NodeRoute | undefined,
  output: { state: string; failureKind?: string }
): NodeFailureKind | undefined {
  if (route?.applied !== true || output.state !== 'failed') return undefined;
  const kind = output.failureKind;
  return kind !== undefined && escalates(kind) ? kind : undefined;
}

/** The route of the one escalation attempt: the ceiling, with where it came from and why. */
export function escalateRoute(route: NodeRoute, reason: NodeFailureKind): NodeRoute {
  return {
    ...route,
    routedTier: route.authoredTier,
    applied: false,
    escalatedFrom: route.routedTier,
    escalationReason: reason,
  };
}
