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
 *   bun run scripts/model-router-eval.ts [--dry] [--json] [--ceiling small|medium|large] [--cases <file>]
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
  type RouterThresholds,
} from '../packages/workflows/src/jev/model-router';
import { resolveNodeModel } from '../packages/workflows/src/node-model-resolution';
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
  const { id, node, task, features, label_min_tier: label, kind } = value;
  if (typeof id !== 'string' || typeof node !== 'string' || typeof task !== 'string') {
    return '"id", "node" and "task" must be strings';
  }
  if (!isTier(label)) return `"label_min_tier" must be one of ${TIER_NAMES.join(', ')}`;
  const caseKind = CASE_KINDS.find(known => known === kind);
  if (caseKind === undefined) return `"kind" must be one of ${CASE_KINDS.join(', ')}`;
  if (!isRecord(features)) return '"features" must be an object';
  const parsed = {} as CaseFeatures;
  for (const name of FEATURE_NAMES) {
    const flag = features[name];
    if (typeof flag !== 'boolean') return `"features.${name}" must be true or false`;
    parsed[name] = flag;
  }
  return { id, node, task, features: parsed, label_min_tier: label, kind: caseKind };
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

/** The text of a pack command, searched for in every workflow's `commands/` directory. */
async function readCommandText(packRoot: string, node: string): Promise<string> {
  for (const entry of await readdir(packRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = Bun.file(join(packRoot, entry.name, 'commands', `${node}.md`));
    if (await file.exists()) return file.text();
  }
  throw new Error(`No command named '${node}' under ${packRoot}`);
}

export interface CaseResult {
  id: string;
  node: string;
  kind: CaseKind;
  /** The label, capped at the ceiling: no router can route above it. */
  label: TierName;
  routedTier: TierName;
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

  const underRouted = results.filter(result => result.underRouted).map(result => result.id);
  const unanswered = results.filter(result => !result.answered).map(result => result.id);
  const routine = results.filter(result => ROUTINE_KINDS.includes(result.kind));
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
  thresholds: RouterThresholds;
  results: CaseResult[];
  score: EvalScore;
}

export interface RunEvalOptions {
  cases: readonly EvalCase[];
  packRoot: string;
  ceiling: TierName;
  env: NodeJS.ProcessEnv;
  dry: boolean;
  /** HTTP boundary for a live run; a dry run never uses it. */
  fetch?: Fetch;
}

/** Route every case with the router's own code and score the result. */
export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const { cases, packRoot, ceiling, dry } = options;
  // A dry run needs no key: it switches the router on for itself and answers locally.
  const env: NodeJS.ProcessEnv = dry
    ? { ...options.env, JEV_API_KEY: 'dry-run', JEV_ENABLED: '1', JEV_ROUTER_ENABLED: '1' }
    : options.env;
  const settings = readRouterSettings(env);
  const thresholds: RouterThresholds = settings.ok ? settings.settings : ROUTER_DEFAULTS;
  const quiet = {
    info: (): void => undefined,
    warn: (): void => undefined,
    debug: (): void => undefined,
  };

  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const stepText = await readCommandText(packRoot, evalCase.node);
    const node = dagNodeSchema.parse({
      id: evalCase.id,
      command: evalCase.node,
      model: ceiling,
      ...(evalCase.features.has_output_format
        ? {
            output_format: {
              type: 'object',
              properties: { result: { type: 'string' } },
              required: ['result'],
            },
          }
        : {}),
      ...(evalCase.features.tools_declared ? { allowed_tools: ['Read'] } : {}),
      ...(evalCase.features.mcp_present ? { mcp: 'mcp.json' } : {}),
      ...(evalCase.features.skills_present ? { skills: ['skill'] } : {}),
      ...(evalCase.features.mutates_checkout ? {} : { mutates_checkout: false }),
    });
    if (node.kind !== 'agent') throw new Error(`Case '${evalCase.id}' did not build an agent node`);
    const routed = await routeAgentNode(
      {
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
        loadStepText: () => Promise.resolve(stepText),
        taskText: () => evalCase.task,
        credentialValues: () => [],
      },
      {
        env,
        fetch: dry
          ? (): Promise<Response> => Promise.resolve(labelAnswer(evalCase, ceiling))
          : options.fetch,
        getCapabilities: provider => (provider === EVAL_PROVIDER ? EVAL_CAPABILITIES : undefined),
        log: quiet,
      }
    );
    if (routed === undefined) throw new Error(`Case '${evalCase.id}' was not routable`);
    const { route } = routed;
    const label = rank(evalCase.label_min_tier) < rank(ceiling) ? evalCase.label_min_tier : ceiling;
    results.push({
      id: evalCase.id,
      node: evalCase.node,
      kind: evalCase.kind,
      label,
      routedTier: route.routedTier,
      answered: route.source === 'jev',
      underRouted: rank(route.routedTier) < rank(label),
      source: route.source,
      ...(route.reason !== undefined ? { reason: route.reason } : {}),
      ...(route.chosenTier !== undefined ? { chosenTier: route.chosenTier } : {}),
      ...(route.probability !== undefined ? { probability: route.probability } : {}),
      ...(route.confidence !== undefined ? { confidence: route.confidence } : {}),
      ...(route.riskNoul !== undefined ? { riskNoul: route.riskNoul } : {}),
      ...(route.ambiguityNoul !== undefined ? { ambiguityNoul: route.ambiguityNoul } : {}),
    });
  }

  return {
    dry,
    classifier: dry
      ? 'none (dry run: answers come from the labels)'
      : `${settings.ok ? settings.settings.model : ROUTER_DEFAULTS.model} at ${settings.ok ? settings.settings.apiBase : ROUTER_DEFAULTS.apiBase}`,
    ceiling,
    thresholds: {
      minProbability: thresholds.minProbability,
      minConfidence: thresholds.minConfidence,
      riskThreshold: thresholds.riskThreshold,
      ambiguityThreshold: thresholds.ambiguityThreshold,
    },
    results,
    score: scoreResults(results, ceiling, thresholds),
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
    `thresholds: risk>=${String(thresholds.riskThreshold)} ambiguity>=${String(thresholds.ambiguityThreshold)} keep the ceiling; probability>=${String(thresholds.minProbability)} confidence>=${String(thresholds.minConfidence)} needed to lower`,
    `cases: ${String(report.results.length)}`,
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
        `${result.id}${result.underRouted ? '  UNDER-ROUTED' : ''}${result.answered ? '' : `  no answer (${result.reason ?? result.source})`}`,
      ].join('  ')
    );
  }
  lines.push(
    '',
    'Confusion matrix (rows: label, columns: routed)',
    `         ${TIER_NAMES.map(tier => tier.padStart(7)).join('')}`
  );
  for (const label of TIER_NAMES) {
    lines.push(
      `${label.padEnd(9)}${TIER_NAMES.map(routed => String(score.confusion[label][routed]).padStart(7)).join('')}`
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
  'Usage: bun run scripts/model-router-eval.ts [--dry] [--json] [--ceiling small|medium|large] [--cases <file>]';

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
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--dry') dry = true;
    else if (argument === '--json') json = true;
    else if (argument === '--ceiling' && isTier(value)) ceiling = argv[++index] as TierName;
    else if (argument === '--cases' && value !== undefined) casesPath = resolve(argv[++index]);
    else {
      write(`Unsupported argument: ${argument}`);
      write(USAGE);
      return 2;
    }
  }

  let report: EvalReport;
  try {
    report = await runEval({
      cases: await readCases(casesPath),
      packRoot: PACK_ROOT,
      ceiling,
      env,
      dry,
      fetch,
    });
  } catch (error) {
    // Deliberately every error: exit 1 means "the classifier was measured and fell
    // short", and nothing that stops the run before a score may be mistaken for that.
    write(`Cannot run the evaluation: ${messageOf(error)}`);
    return 2;
  }
  write(json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (!report.score.scored) return 2;
  return report.score.pass ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2), process.env, line => {
    console.log(line);
  });
}
