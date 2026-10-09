#!/usr/bin/env bun
/**
 * Measures the cost-aware model router against a labelled set of workflow steps.
 *
 * Each case names a real SDLC command, a task the run might be asked to do, and the lowest
 * model tier a person judged sufficient for that step on that task. This runs every case
 * through the router's own code (packages/workflows/src/jev/model-router.ts) and compares
 * the tier it chose with the label.
 *
 * What a pass means, and what it does not. The labels are one person's judgement of
 * "sufficient", so a pass says the router agrees with the labels: it never went below one,
 * and it lowered enough of the routine cases to be worth having. It is a proxy for "no
 * material quality regression", not a measurement of it. That needs paired real runs of
 * the same step on both tiers; the routes recorded in shadow mode are the evidence from
 * real workloads.
 *
 * A live run calls the real classifier, so it needs a key and the network and is not part
 * of `bun run test`. It is a manual command:
 *
 *   bun --env-file="$HOME/.archon/.env" run scripts/model-router-eval.ts
 *
 * which reads JEV_API_KEY and the other JEV_* settings from the file Archon itself reads
 * them from. `--dry` answers from the labels instead of a classifier: no key, nothing
 * sent. It proves the pipeline and the arithmetic, not the classifier.
 *
 * Usage:
 *   bun run scripts/model-router-eval.ts [--dry] [--json] [--ceiling small|medium|large]
 *                                        [--split tuning|heldout|heldout2] [--cases <file>]
 *                                        [--map <tier-map> [--steps a,b]]
 *   bun run scripts/model-router-eval.ts --lowerable <tier-map> [--steps a,b]
 *
 * `--split` runs one half of the set. The questions and thresholds are tuned against the
 * `tuning` half only; a full run reports each half beside the whole, so a change that only
 * fits the cases it was tuned on shows up as a gap between them.
 *
 * `--map <tier-map>` changes what is measured. Without it a case is a stand-in step on one
 * provider that can run anything: agreement with the labels. A case whose command promises
 * to leave the checkout alone is not asked there either, because the router never lowers
 * such a step; it is reported as never asked and left out of the routine share, which
 * measures the classifier. With a map a case's task
 * is put to every step of the pack that runs the case's command and that the router would
 * ask about on that map, on real providers. Each such step is classified with its own
 * text: the command file for a step that names the command, and the compiled prompt for a
 * step that was composed into another workflow, whose text differs because the including
 * workflow's inputs are written into it. The report says which cases could be lowered at
 * all and why the others could not. `--lowerable <tier-map>` prints that for every step of
 * the pack and calls no classifier. `--steps a,b` is the operator's `modelRouter.steps`
 * list for either. Maps: see `model-router-lowerable.ts`.
 *
 * `--ceiling` is the authored tier every case is given (default `large`, so all three
 * tiers are in play; `medium` mirrors the default `modelRouter.tiers`).
 *
 * Exit codes:
 *   0  scored, and it passed: no case routed below its label, and at least
 *      MIN_ROUTINE_LOWERED_SHARE of the extraction and mechanical cases routed below the ceiling
 *   1  scored, and it did not pass
 *   2  not scored: the classifier left a case unanswered, the evaluation could not be
 *      set up (cases file, pack), or bad usage
 *
 * Prints case ids, tiers and numbers only. Never task text, never the key.
 */
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ProviderCapabilities } from '../packages/provider-contract/src/capabilities';
import type { Fetch } from '../packages/workflows/src/jev/jev-client';
import {
  ROUTER_DEFAULTS,
  decideTier,
  readRouterSettings,
  routeAgentNode,
  routerInactiveReason,
  stepExclusion,
  type RouterThresholds,
  type RoutingCandidate,
} from '../packages/workflows/src/jev/model-router';
import { resolveNodeModel } from '../packages/workflows/src/node-model-resolution';
import {
  formatLowerability,
  isTierMapName,
  packInstances,
  type PackInstance,
  type PackOptions,
  type TierMapName,
} from './model-router-lowerable';
import { dagNodeSchema } from '../packages/workflows/src/schemas/dag-node';
import {
  TIER_NAMES,
  type ResolvedAiProfile,
  type TierName,
} from '../packages/workflows/src/schemas/model-binding';

export const EVAL_CASES = resolve(import.meta.dir, 'fixtures/model-router-eval/cases.jsonl');
export const PACK_ROOT = resolve(import.meta.dir, '../.archon/workflows/sdlc');

/**
 * The least of the routine cases a passing run must route below the ceiling. Zero
 * under-routing alone is reached trivially by never lowering anything.
 */
export const MIN_ROUTINE_LOWERED_SHARE = 0.5;

const CASE_KINDS = [
  'extraction',
  'mechanical',
  'implementation',
  'architecture',
  'high_risk',
] as const;
type CaseKind = (typeof CASE_KINDS)[number];
const ROUTINE_KINDS: readonly CaseKind[] = ['extraction', 'mechanical'];

/**
 * `tuning` is the half wording and thresholds are tuned against. `heldout` is the other
 * half of the original set, which shares its commands. `heldout2` was written later from
 * commands and phrasings the tuning half does not contain.
 */
const CASE_SPLITS = ['tuning', 'heldout', 'heldout2'] as const;
type CaseSplit = (typeof CASE_SPLITS)[number];

const FEATURE_NAMES = [
  'has_output_format',
  'tools_declared',
  'mcp_present',
  'skills_present',
  'mutates_checkout',
] as const;
type CaseFeatures = Record<(typeof FEATURE_NAMES)[number], boolean>;

export interface EvalCase {
  id: string;
  /** A command the SDLC pack ships; its text is read from the pack. */
  node: string;
  /** What the run was asked to do. Synthetic, but shaped like a real request. */
  task: string;
  /** What the node declares, as the engine would compute it. */
  features: CaseFeatures;
  /** The lowest tier judged sufficient for this step on this task. */
  label_min_tier: TierName;
  kind: CaseKind;
  /**
   * Which half of the set the case belongs to. Wording and thresholds are tuned against
   * `tuning` only, so `heldout` shows whether a change generalises or was fitted.
   */
  split: CaseSplit;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTier(value: unknown): value is TierName {
  return TIER_NAMES.some(tier => tier === value);
}

function parseCase(value: unknown): EvalCase | string {
  if (!isRecord(value)) return 'not an object';
  const { id, node, task, features, label_min_tier: label, kind, split } = value;
  if (typeof id !== 'string' || typeof node !== 'string' || typeof task !== 'string') {
    return '"id", "node" and "task" must be strings';
  }
  if (!isTier(label)) return `"label_min_tier" must be one of ${TIER_NAMES.join(', ')}`;
  const caseKind = CASE_KINDS.find(known => known === kind);
  if (caseKind === undefined) return `"kind" must be one of ${CASE_KINDS.join(', ')}`;
  const caseSplit = CASE_SPLITS.find(known => known === split);
  if (caseSplit === undefined) return `"split" must be one of ${CASE_SPLITS.join(', ')}`;
  if (!isRecord(features)) return '"features" must be an object';
  const parsed = {} as CaseFeatures;
  for (const name of FEATURE_NAMES) {
    const flag = features[name];
    if (typeof flag !== 'boolean') return `"features.${name}" must be true or false`;
    parsed[name] = flag;
  }
  return {
    id,
    node,
    task,
    features: parsed,
    label_min_tier: label,
    kind: caseKind,
    split: caseSplit,
  };
}

/** Read a JSON Lines file of cases. Blank lines are skipped; any bad line fails the read. */
export async function readCases(path: string): Promise<EvalCase[]> {
  const lines = (await Bun.file(path).text()).split('\n');
  const cases: EvalCase[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${String(index + 1)} is not JSON: ${messageOf(error)}`, {
        cause: error,
      });
    }
    const parsed = parseCase(value);
    if (typeof parsed === 'string') throw new Error(`${path}:${String(index + 1)}: ${parsed}`);
    cases.push(parsed);
  });
  if (cases.length === 0) throw new Error(`${path} holds no cases`);
  return cases;
}

const REPO_ROOT = resolve(import.meta.dir, '..');
/** Command folders outside the pack, searched after it: the bundled defaults and the repo's own. */
const EXTRA_COMMAND_DIRS = [
  join(REPO_ROOT, '.archon/commands/defaults'),
  join(REPO_ROOT, '.archon/commands'),
];

/** The text of a command: from a pack workflow's `commands/` directory, or the repo's own. */
async function readCommandText(packRoot: string, node: string): Promise<string> {
  const dirs = (await readdir(packRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => join(packRoot, entry.name, 'commands'));
  for (const dir of [...dirs, ...EXTRA_COMMAND_DIRS]) {
    const file = Bun.file(join(dir, `${node}.md`));
    if (await file.exists()) return file.text();
  }
  throw new Error(`No command named '${node}' under ${packRoot} or the repository's commands`);
}

export interface CaseResult {
  id: string;
  node: string;
  /**
   * Only with a tier map: the step of the pack this row classified, as `workflow/node id`.
   * One case gives one row for each step that runs its command and can be lowered.
   */
  instance?: string;
  kind: CaseKind;
  split: CaseSplit;
  /** The label, capped at the ceiling: no router can route above it. */
  label: TierName;
  routedTier: TierName;
  /**
   * Whether the router would ask about this step at all, and why not. With a tier map it
   * is set on every row. In the agreement run only `false` is recorded, for a case the
   * router's own rules keep on its authored tier whatever the classifier would say.
   */
  offered?: boolean;
  notOfferedReason?: string;
  /** The classifier answered this case. An unanswered case stays at the ceiling. */
  answered: boolean;
  underRouted: boolean;
  source: string;
  reason?: string;
  chosenTier?: TierName;
  probability?: number;
  confidence?: number;
  riskNoul?: number;
  ambiguityNoul?: number;
}

type Confusion = Record<TierName, Record<TierName, number>>;

export interface ThresholdLimits {
  /** The highest risk threshold that still floors every case that would be under-routed without it. */
  maxRiskThreshold: number | null;
  maxAmbiguityThreshold: number | null;
  /** The minimum probability must be above this, or a case is under-routed. */
  probabilityMustExceed: number | null;
  confidenceMustExceed: number | null;
}

export interface EvalScore {
  /** Label (rows) against routed tier (columns). */
  confusion: Confusion;
  underRouted: string[];
  unanswered: string[];
  routineCases: number;
  routineLowered: number;
  /** Null when the set holds no routine case. */
  routineLoweredShare: number | null;
  /** Each limit holds the other thresholds at their configured values. */
  limits: ThresholdLimits;
  /** Every case was answered, so the numbers above measure the classifier. */
  scored: boolean;
  pass: boolean;
}

const rank = (tier: TierName): number => TIER_NAMES.indexOf(tier);

/** Every tier at or below the ceiling other than the ceiling itself, lowest first. */
function tiersBelow(ceiling: TierName): TierName[] {
  return TIER_NAMES.slice(0, rank(ceiling));
}

/** What one answered case would be routed to under `thresholds`. */
function rerouted(
  result: CaseResult,
  ceiling: TierName,
  thresholds: RouterThresholds
): TierName | undefined {
  const { chosenTier, probability, confidence, riskNoul, ambiguityNoul } = result;
  if (
    chosenTier === undefined ||
    probability === undefined ||
    confidence === undefined ||
    riskNoul === undefined ||
    ambiguityNoul === undefined
  ) {
    return undefined;
  }
  return decideTier(
    { choice: chosenTier, probability, confidence, risk: riskNoul, ambiguity: ambiguityNoul },
    ceiling,
    tiersBelow(ceiling),
    thresholds
  ).routedTier;
}

/**
 * The value one threshold must respect for under-routing to stay at zero, found by
 * switching that one floor off and reading the cases that would then go below their
 * label. Uses the router's own `decideTier`, so the limits cannot describe other rules.
 */
function limitFor(
  results: readonly CaseResult[],
  ceiling: TierName,
  thresholds: RouterThresholds,
  floorOff: Partial<RouterThresholds>,
  read: (result: CaseResult) => number | undefined,
  pick: (values: number[]) => number
): number | null {
  const values = results.flatMap(result => {
    const tier = rerouted(result, ceiling, { ...thresholds, ...floorOff });
    const value = read(result);
    return tier !== undefined && value !== undefined && rank(tier) < rank(result.label)
      ? [value]
      : [];
  });
  return values.length === 0 ? null : pick(values);
}

/** A row's name in a report: the case, and the step it was classified as when there is one. */
function rowName(result: Pick<CaseResult, 'id' | 'instance'>): string {
  return result.instance === undefined ? result.id : `${result.id} @ ${result.instance}`;
}

/** Compare routed tiers with labels. Pure: this is all of the arithmetic. */
export function scoreResults(
  results: readonly CaseResult[],
  ceiling: TierName,
  thresholds: RouterThresholds
): EvalScore {
  const confusion = Object.fromEntries(
    TIER_NAMES.map(label => [label, Object.fromEntries(TIER_NAMES.map(routed => [routed, 0]))])
  ) as Confusion;
  for (const result of results) confusion[result.label][result.routedTier] += 1;

  const underRouted = results.filter(result => result.underRouted).map(rowName);
  const unanswered = results.filter(result => !result.answered).map(rowName);
  // The share measures the classifier, so a case it was never asked about is not in it.
  const routine = results.filter(
    result => ROUTINE_KINDS.includes(result.kind) && result.offered !== false
  );
  const routineLowered = routine.filter(result => rank(result.routedTier) < rank(ceiling)).length;
  const routineLoweredShare = routine.length === 0 ? null : routineLowered / routine.length;

  // A floor that never fires is "off" at 2 for the two `>=` thresholds (answers are at
  // most 1) and at 0 for the two minimums.
  const lowest = (values: number[]): number => Math.min(...values);
  const highest = (values: number[]): number => Math.max(...values);
  const limits: ThresholdLimits = {
    maxRiskThreshold: limitFor(
      results,
      ceiling,
      thresholds,
      { riskThreshold: 2 },
      r => r.riskNoul,
      lowest
    ),
    maxAmbiguityThreshold: limitFor(
      results,
      ceiling,
      thresholds,
      { ambiguityThreshold: 2 },
      r => r.ambiguityNoul,
      lowest
    ),
    probabilityMustExceed: limitFor(
      results,
      ceiling,
      thresholds,
      { minProbability: 0 },
      r => r.probability,
      highest
    ),
    confidenceMustExceed: limitFor(
      results,
      ceiling,
      thresholds,
      { minConfidence: 0 },
      r => r.confidence,
      highest
    ),
  };

  const scored = unanswered.length === 0;
  return {
    confusion,
    underRouted,
    unanswered,
    routineCases: routine.length,
    routineLowered,
    routineLoweredShare,
    limits,
    scored,
    pass:
      scored &&
      underRouted.length === 0 &&
      routineLoweredShare !== null &&
      routineLoweredShare >= MIN_ROUTINE_LOWERED_SHARE,
  };
}

/** One provider that can run anything, so the offer never depends on the machine's registry. */
const EVAL_PROVIDER = 'eval';
const EVAL_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
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
const EVAL_PROFILE: ResolvedAiProfile = {
  defaultProvider: EVAL_PROVIDER,
  aliases: Object.fromEntries(
    TIER_NAMES.map(tier => [tier, { provider: EVAL_PROVIDER, model: `eval-${tier}` }])
  ),
};

/** The answer a perfect classifier would give for a case: what `--dry` replies with. */
function labelAnswer(evalCase: EvalCase, ceiling: TierName): Response {
  const choice = rank(evalCase.label_min_tier) < rank(ceiling) ? evalCase.label_min_tier : ceiling;
  return new Response(
    JSON.stringify({
      answers: {
        tier: { type: 'choice', choice, probabilities: { [choice]: 0.99 }, confidence: 0.99 },
        high_risk: { type: 'noul', noul: evalCase.kind === 'high_risk' ? 0.95 : 0.02 },
        ambiguous_or_multi_step: {
          type: 'noul',
          noul: evalCase.kind === 'architecture' ? 0.9 : 0.05,
        },
      },
    }),
    { status: 200 }
  );
}

export interface EvalReport {
  /** True when the answers came from the labels and no classifier was called. */
  dry: boolean;
  classifier: string;
  ceiling: TierName;
  /** The tier map the offer was computed on, when the run used one. */
  map?: TierMapName;
  thresholds: RouterThresholds;
  results: CaseResult[];
  /** Every case that was run, scored together. This decides the exit code. */
  score: EvalScore;
  /** The same arithmetic over each half that had cases in this run. */
  splits: Partial<Record<CaseSplit, EvalScore>>;
}

export interface RunEvalOptions {
  cases: readonly EvalCase[];
  packRoot: string;
  ceiling: TierName;
  env: NodeJS.ProcessEnv;
  dry: boolean;
  /** HTTP boundary for a live run; a dry run never uses it. */
  fetch?: Fetch;
  /**
   * Ask only about the steps the router would ask about on this tier map, using each
   * command's real step in the pack and the registered providers' real capabilities.
   * Without it every case is asked, on one stand-in provider that can run anything: that
   * measures agreement with the labels and nothing about which steps can move.
   */
  map?: TierMapName;
  /** With `map`: the operator's `modelRouter.steps`, the only steps the router may lower. */
  steps?: readonly string[];
}

/** A closed contract every provider enforces as written, so every case can be asked. */
const EVAL_CONTRACT = {
  type: 'object',
  properties: { result: { type: 'string' } },
  required: ['result'],
};

/** The router's input for one case in the agreement run: a stand-in step on one provider. */
function agreementCandidate(evalCase: EvalCase, ceiling: TierName): RoutingCandidate {
  // Production only classifies steps that declare an output contract, so the stand-in
  // always declares one. `features.has_output_format` says what the pack's own step does.
  // A step that promises to leave the checkout alone keeps that promise here, and the
  // router's rule then keeps it on the ceiling without asking.
  const node = dagNodeSchema.parse({
    id: evalCase.id,
    command: evalCase.node,
    model: ceiling,
    output_format: EVAL_CONTRACT,
    ...(evalCase.features.tools_declared ? { allowed_tools: ['Read'] } : {}),
    ...(evalCase.features.mcp_present ? { mcp: 'mcp.json' } : {}),
    ...(evalCase.features.skills_present ? { skills: ['skill'] } : {}),
    ...(evalCase.features.mutates_checkout ? {} : { mutates_checkout: false }),
  });
  if (node.kind !== 'agent') throw new Error(`Case '${evalCase.id}' did not build an agent node`);
  return {
    node,
    resolution: resolveNodeModel(
      node,
      {
        provider: EVAL_PROVIDER,
        model: undefined,
        preset: undefined,
        tier: undefined,
        effort: undefined,
        providerOrigin: 'default assistant',
      },
      {},
      EVAL_PROFILE
    ),
    aiProfile: EVAL_PROFILE,
    config: { tiers: [ceiling], mode: 'apply' },
    isResumeSource: false,
    usesPersistedScope: false,
    sameProviderOnly: true,
    inContainer: false,
    capabilityScope: {
      declaredEffort: undefined,
      workflowFallbackModel: undefined,
      workflowSandbox: undefined,
      webSearchMode: undefined,
      hasEnvVars: false,
    },
  };
}

/** Route every case with the router's own code and score the result. */
export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const { cases, packRoot, dry, map } = options;
  // A dry run needs no key: it switches the router on for itself and answers locally.
  const env: NodeJS.ProcessEnv = dry
    ? { ...options.env, JEV_API_KEY: 'dry-run', JEV_ENABLED: '1', JEV_ROUTER_ENABLED: '1' }
    : options.env;
  const settings = readRouterSettings(env);
  const thresholds: RouterThresholds = settings.ok ? settings.settings : ROUTER_DEFAULTS;
  const inactive = routerInactiveReason(env);
  const quiet = {
    info: (): void => undefined,
    warn: (): void => undefined,
    debug: (): void => undefined,
  };
  // With a map, a case's task is put to every step of the pack that runs its command.
  const packOptions: PackOptions = options.steps !== undefined ? { steps: options.steps } : {};
  const instances =
    map === undefined ? [] : await packInstances(REPO_ROOT, packRoot, map, packOptions);
  // On a map the ceiling is each step's own authored tier, which the router's default
  // config only lowers from medium.
  const ceiling: TierName = map === undefined ? options.ceiling : 'medium';

  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const label = rank(evalCase.label_min_tier) < rank(ceiling) ? evalCase.label_min_tier : ceiling;
    const base = {
      id: evalCase.id,
      node: evalCase.node,
      kind: evalCase.kind,
      split: evalCase.split,
      label,
    };
    const steps = instances.filter(instance => instance.command === evalCase.node);
    const lowerable = steps.filter(instance => instance.lowerable);
    if (map !== undefined && lowerable.length === 0) {
      // The reason of the step that names the command itself, when the pack has one: the
      // composed copies can only add reasons to it.
      const own = steps.find(instance => instance.candidate.node.source.kind === 'command');
      results.push({
        ...base,
        routedTier: ceiling,
        offered: false,
        notOfferedReason: (own ?? steps[0])?.reason ?? 'no_single_shot_step_in_pack',
        // Nothing was asked, so there is no answer to wait for and nothing to score.
        answered: true,
        underRouted: false,
        source: 'not_offered',
      });
      continue;
    }
    // The agreement run has one stand-in step per case. The router's own rules decide
    // whether it would ask about it at all, exactly as they do for a real step.
    const standIn = map === undefined ? agreementCandidate(evalCase, ceiling) : undefined;
    const neverAsked =
      standIn === undefined ? undefined : stepExclusion(standIn.node, standIn.config);
    if (neverAsked !== undefined) {
      results.push({
        ...base,
        routedTier: ceiling,
        offered: false,
        notOfferedReason: neverAsked,
        answered: true,
        underRouted: false,
        source: 'not_offered',
      });
      continue;
    }
    // One row for each step that can be lowered, each asked with the text that step
    // sends in production.
    const asked: (PackInstance | undefined)[] = map === undefined ? [undefined] : lowerable;
    for (const instance of asked) {
      const source = instance?.candidate.node.source;
      const stepText =
        source?.kind === 'inline' ? source.prompt : await readCommandText(packRoot, evalCase.node);
      const routed = await routeAgentNode(
        {
          ...(instance?.candidate ?? standIn ?? agreementCandidate(evalCase, ceiling)),
          loadStepText: () => Promise.resolve(stepText),
          taskText: () => evalCase.task,
          credentialValues: () => [],
        },
        {
          env,
          fetch: dry
            ? (): Promise<Response> => Promise.resolve(labelAnswer(evalCase, ceiling))
            : options.fetch,
          ...(map === undefined
            ? {
                getCapabilities: (provider: string): ProviderCapabilities | undefined =>
                  provider === EVAL_PROVIDER ? EVAL_CAPABILITIES : undefined,
              }
            : {}),
          log: quiet,
        }
      );
      const route = routed?.route;
      results.push({
        ...base,
        ...(instance !== undefined
          ? { instance: `${instance.workflow}/${instance.nodeId}`, offered: true }
          : {}),
        routedTier: route?.routedTier ?? ceiling,
        answered: route?.source === 'jev',
        underRouted: route !== undefined && rank(route.routedTier) < rank(label),
        // No route at all means the router is absent here: no key, or a switch is off.
        source: route?.source ?? 'inactive',
        ...(route === undefined ? { reason: inactive ?? 'not_routable' } : {}),
        ...(route?.reason !== undefined ? { reason: route.reason } : {}),
        ...(route?.chosenTier !== undefined ? { chosenTier: route.chosenTier } : {}),
        ...(route?.probability !== undefined ? { probability: route.probability } : {}),
        ...(route?.confidence !== undefined ? { confidence: route.confidence } : {}),
        ...(route?.riskNoul !== undefined ? { riskNoul: route.riskNoul } : {}),
        ...(route?.ambiguityNoul !== undefined ? { ambiguityNoul: route.ambiguityNoul } : {}),
      });
    }
  }

  return {
    dry,
    classifier: dry
      ? 'none (dry run: answers come from the labels)'
      : `${settings.ok ? settings.settings.model : ROUTER_DEFAULTS.model} at ${settings.ok ? settings.settings.apiBase : ROUTER_DEFAULTS.apiBase}`,
    ceiling,
    ...(map !== undefined ? { map } : {}),
    thresholds: {
      minProbability: thresholds.minProbability,
      minConfidence: thresholds.minConfidence,
      riskThreshold: thresholds.riskThreshold,
      ambiguityThreshold: thresholds.ambiguityThreshold,
    },
    results,
    score: scoreResults(results, ceiling, thresholds),
    splits: Object.fromEntries(
      CASE_SPLITS.filter(split => results.some(result => result.split === split)).map(split => [
        split,
        scoreResults(
          results.filter(result => result.split === split),
          ceiling,
          thresholds
        ),
      ])
    ),
  };
}

/**
 * How every result line starts. The last line of a report gets pasted on its own, and a
 * dry run's must never read as a classifier's.
 */
function resultLabel(report: EvalReport): string {
  return report.dry
    ? 'RESULT (dry run: the answers came from the labels, not from a classifier):'
    : 'RESULT:';
}

const fixed = (value: number | undefined): string =>
  value === undefined ? ' -  ' : value.toFixed(2);
const limit = (value: number | null, none: string): string =>
  value === null ? none : String(value);

/** The report as text: case ids, tiers and numbers only. */
export function formatReport(report: EvalReport): string {
  const { score, thresholds } = report;
  const lines = [
    'Model router evaluation',
    ...(report.dry
      ? ['DRY RUN: every answer below comes from the labels. No classifier was called.']
      : []),
    `classifier: ${report.classifier}`,
    `ceiling:    ${report.ceiling}`,
    ...(report.map !== undefined
      ? [
          `tier map:   ${report.map} (each step the router would ask about on it is classified with its own text)`,
        ]
      : []),
    `thresholds: risk>=${String(thresholds.riskThreshold)} ambiguity>=${String(thresholds.ambiguityThreshold)} keep the ceiling; probability>=${String(thresholds.minProbability)} confidence>=${String(thresholds.minConfidence)} needed to lower`,
    report.map === undefined
      ? `cases: ${String(report.results.length)}`
      : `rows: ${String(report.results.length)} (${String(new Set(report.results.map(r => r.id)).size)} cases, one row for each step asked about)`,
    '',
    'label    routed   chosen   prob  conf  risk  ambig  kind            case',
  ];
  for (const result of report.results) {
    lines.push(
      [
        result.label.padEnd(7),
        result.routedTier.padEnd(7),
        (result.chosenTier ?? '-').padEnd(7),
        fixed(result.probability),
        fixed(result.confidence),
        fixed(result.riskNoul),
        fixed(result.ambiguityNoul).padEnd(5),
        result.kind.padEnd(14),
        `${rowName(result)}${result.underRouted ? '  UNDER-ROUTED' : ''}${result.answered ? '' : `  no answer (${result.reason ?? result.source})`}${result.offered === false ? `  not offered (${result.notOfferedReason ?? ''})` : ''}`,
      ].join('  ')
    );
  }
  const matrix = (heading: string, part: EvalScore): void => {
    lines.push('', heading, `         ${TIER_NAMES.map(tier => tier.padStart(7)).join('')}`);
    for (const label of TIER_NAMES) {
      lines.push(
        `${label.padEnd(9)}${TIER_NAMES.map(routed => String(part.confusion[label][routed]).padStart(7)).join('')}`
      );
    }
  };
  matrix('Confusion matrix (rows: label, columns: routed)', score);
  // Each half on its own, so a change tuned on one can be seen to hold on the other.
  for (const split of CASE_SPLITS) {
    const part = report.splits[split];
    if (part === undefined || Object.keys(report.splits).length < 2) continue;
    matrix(`${split} half`, part);
    lines.push(
      `  under-routed: ${String(part.underRouted.length)}${part.underRouted.length > 0 ? ` (${part.underRouted.join(', ')})` : ''}` +
        `; routine routed below the ceiling: ${String(part.routineLowered)} of ${String(part.routineCases)}` +
        `; ${part.pass ? 'passes' : 'does not pass'} on its own`
    );
  }
  lines.push(
    '',
    `under-routed: ${String(score.underRouted.length)}${score.underRouted.length > 0 ? ` (${score.underRouted.join(', ')})` : ''}`,
    `routine cases routed below the ceiling: ${String(score.routineLowered)} of ${String(score.routineCases)}` +
      (score.routineLoweredShare === null
        ? ''
        : ` (${score.routineLoweredShare.toFixed(2)}; needs ${String(MIN_ROUTINE_LOWERED_SHARE)})`),
    '',
    'Limits that keep under-routing at zero on this set, each with the other thresholds as configured:',
    `  risk threshold at most:      ${limit(score.limits.maxRiskThreshold, 'no limit found')}`,
    `  ambiguity threshold at most: ${limit(score.limits.maxAmbiguityThreshold, 'no limit found')}`,
    `  min probability above:       ${limit(score.limits.probabilityMustExceed, 'no limit found')}`,
    `  min confidence above:        ${limit(score.limits.confidenceMustExceed, 'no limit found')}`,
    '',
    'A pass means the router agrees with the labels. It is a proxy for quality, not a measurement of it.'
  );

  const result = resultLabel(report);
  if (report.map !== undefined) {
    // Two separate facts. How many steps can move at all on this map is a property of the
    // pack and the providers; whether the ones that can were routed sensibly is the
    // classifier's. The routine-share bar belongs to the agreement run, not to this one.
    const offered = report.results.filter(r => r.offered === true);
    const notOffered = new Map<string, number>();
    for (const r of report.results.filter(other => other.offered === false)) {
      const reason = r.notOfferedReason ?? 'unknown';
      notOffered.set(reason, (notOffered.get(reason) ?? 0) + 1);
    }
    lines.push(
      '',
      `Can be lowered on this map: ${String(new Set(offered.map(r => r.id)).size)} of ${String(new Set(report.results.map(r => r.id)).size)} cases, as ${String(offered.length)} step instances (${[...new Set(offered.map(r => r.node))].sort().join(', ') || 'no commands'})`,
      `Routed below the ceiling: ${String(offered.filter(r => rank(r.routedTier) < rank(report.ceiling)).length)} of ${String(offered.length)} step instances asked`,
      'Not offered, by reason:',
      ...[...notOffered]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `  ${String(count).padStart(3)}  ${reason}`)
    );
    if (!score.scored) {
      lines.push(
        `${result} NOT SCORED. ${String(score.unanswered.length)} step instance(s) got no answer from the classifier.`
      );
    } else if (score.underRouted.length > 0) {
      lines.push(
        `${result} FAIL. ${String(score.underRouted.length)} step instance(s) were routed below their label.`
      );
    } else {
      lines.push(`${result} PASS. No step instance was routed below its case's label.`);
    }
    return lines.join('\n');
  }
  const neverAsked = report.results.filter(r => r.offered === false);
  if (neverAsked.length > 0) {
    lines.push(
      `Never asked, by the router's own rules (${[...new Set(neverAsked.map(r => r.notOfferedReason ?? 'unknown'))].join(', ')}): ` +
        `${String(neverAsked.length)} of ${String(report.results.length)} cases, ${String(neverAsked.filter(r => ROUTINE_KINDS.includes(r.kind)).length)} of them routine. They stay on the ceiling and are not in the routine share.`
    );
  }
  if (!score.scored) {
    const reasons = [
      ...new Set(report.results.filter(r => !r.answered).map(r => r.reason ?? r.source)),
    ];
    lines.push(
      `${result} NOT SCORED. ${String(score.unanswered.length)} of ${String(report.results.length)} case(s) got no answer from the classifier (${reasons.join(', ')}).`
    );
  } else if (score.underRouted.length > 0) {
    lines.push(
      `${result} FAIL. ${String(score.underRouted.length)} case(s) were routed below their label.`
    );
  } else if (!score.pass) {
    lines.push(
      `${result} FAIL. Nothing was routed below its label, but too few routine cases were routed below the ceiling: ` +
        `${String(score.routineLowered)} of ${String(score.routineCases)}, and at least ${String(MIN_ROUTINE_LOWERED_SHARE * 100)}% are needed.`
    );
  } else {
    lines.push(
      `${result} PASS. No case was routed below its label, and ${String(score.routineLowered)} of ${String(score.routineCases)} routine cases were routed below the ceiling.`
    );
  }
  return lines.join('\n');
}

const USAGE =
  'Usage: bun run scripts/model-router-eval.ts [--dry] [--json] [--ceiling small|medium|large] [--split tuning|heldout|heldout2] [--map <tier-map> [--steps a,b]] [--cases <file>]\n       bun run scripts/model-router-eval.ts --lowerable <tier-map> [--steps a,b]';

/** The command. Returns the exit code; `write` receives each output line. */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (line: string) => void,
  fetch?: Fetch
): Promise<number> {
  let dry = false;
  let json = false;
  let ceiling: TierName = 'large';
  let casesPath = EVAL_CASES;
  let split: CaseSplit | undefined;
  let map: TierMapName | undefined;
  let lowerable: TierMapName | undefined;
  let steps: string[] | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--dry') dry = true;
    else if (argument === '--json') json = true;
    else if (argument === '--ceiling' && isTier(value)) ceiling = argv[++index] as TierName;
    else if (argument === '--split' && CASE_SPLITS.some(known => known === value)) {
      split = argv[++index] as CaseSplit;
    } else if (argument === '--map' && isTierMapName(value)) {
      map = value;
      index++;
    } else if (argument === '--lowerable' && isTierMapName(value)) {
      lowerable = value;
      index++;
    } else if (argument === '--steps' && value !== undefined) {
      // The operator's `modelRouter.steps`, comma-separated. `--steps ''` is the empty list.
      steps = value
        .split(',')
        .map(step => step.trim())
        .filter(step => step !== '');
      index++;
    } else if (argument === '--cases' && value !== undefined) {
      casesPath = resolve(argv[++index]);
    } else {
      write(`Unsupported argument: ${argument}`);
      write(USAGE);
      return 2;
    }
  }

  if (steps !== undefined && map === undefined && lowerable === undefined) {
    write('--steps needs --map or --lowerable: the agreement run asks every case.');
    write(USAGE);
    return 2;
  }
  const packOptions: PackOptions = steps !== undefined ? { steps } : {};
  if (lowerable !== undefined) {
    // A report about the pack and the providers. No classifier is called.
    try {
      write(
        formatLowerability(
          await packInstances(REPO_ROOT, PACK_ROOT, lowerable, packOptions),
          lowerable,
          packOptions
        )
      );
      return 0;
    } catch (error) {
      write(`Cannot build the report: ${messageOf(error)}`);
      return 2;
    }
  }

  let report: EvalReport;
  try {
    const cases = await readCases(casesPath);
    report = await runEval({
      cases: split === undefined ? cases : cases.filter(evalCase => evalCase.split === split),
      packRoot: PACK_ROOT,
      ceiling,
      env,
      dry,
      fetch,
      ...(map !== undefined ? { map } : {}),
      ...(steps !== undefined ? { steps } : {}),
    });
  } catch (error) {
    // Deliberately every error: exit 1 means "the classifier was measured and fell
    // short", and nothing that stops the run before a score may be mistaken for that.
    write(`Cannot run the evaluation: ${messageOf(error)}`);
    return 2;
  }
  write(json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (!report.score.scored) return 2;
  if (report.map !== undefined) return report.score.underRouted.length === 0 ? 0 : 1;
  return report.score.pass ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2), process.env, line => {
    console.log(line);
  });
}
