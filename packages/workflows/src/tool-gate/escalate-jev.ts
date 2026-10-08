/**
 * The gate's classifier: one Jev request per escalated tool call.
 *
 * It sees only the redacted `ToolGateEscalationRequest` the gate built. It is
 * asked a `score` over `ESCALATION_LEVELS` and one yes/no question, and hands
 * the two numbers back; the gate owns the thresholds and the decision.
 *
 * Any Jev-compatible endpoint works: `JEV_API_BASE`, `JEV_API_KEY` and
 * `JEV_MODEL` are the same variables the other Jev features read.
 */
import { askJev, type Fetch, type JevStateValue } from '../jev/jev-client';
import {
  DEFAULT_NOUL_THRESHOLD,
  DEFAULT_SCORE_THRESHOLD,
  ESCALATION_LEVELS,
  NOUL_THRESHOLD_BOUNDS,
  SCORE_THRESHOLD_BOUNDS,
  type EscalationLevel,
  type ToolGateEscalationRequest,
  type ToolGateEscalationResult,
  type ToolGateEscalator,
} from './gate';

// The context scout reads the same two defaults in its pack script, which
// cannot import engine code; the Jev client itself deliberately holds neither.
const DEFAULT_API_BASE = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-1.13.0';

/**
 * How long one tool call may wait for the classifier. Short on purpose: the
 * request is small and the agent's turn is blocked on it. A timeout is a
 * failure, which the gate turns into "needs approval".
 */
export const DEFAULT_GATE_TIMEOUT_MS = 5_000;
export const MAX_GATE_TIMEOUT_MS = 60_000;

export interface ToolGateJevSettings {
  apiKey: string;
  apiBase: string;
  model: string;
  timeoutMs: number;
  /** Deny at or above these. Handed to `createToolGate`, which enforces them. */
  thresholds: { score: number; noul: number };
}

/**
 * `invalid` is its own state on purpose. Treating an unusable number as "off"
 * would let a typo turn every risk-signalled call into an unjudged allow, so
 * the caller is told which variable is wrong and must refuse to start.
 */
export type ToolGateJevAvailability =
  | { status: 'on'; settings: ToolGateJevSettings }
  | { status: 'off'; reason: 'no_api_key' | 'disabled' }
  | { status: 'invalid'; variable: string; problem: string };

interface NumberSetting {
  variable: string;
  fallback: number;
  usable: (value: number) => boolean;
  problem: string;
}

function within(bounds: { min: number; max: number }): (value: number) => boolean {
  return value => Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
}

function range(bounds: { min: number; max: number }): string {
  return `must be a number from ${String(bounds.min)} to ${String(bounds.max)}`;
}

const NUMBERS = {
  timeoutMs: {
    variable: 'JEV_GATE_TIMEOUT_MS',
    fallback: DEFAULT_GATE_TIMEOUT_MS,
    usable: value => Number.isInteger(value) && value > 0 && value <= MAX_GATE_TIMEOUT_MS,
    problem: `must be a whole number of milliseconds from 1 to ${String(MAX_GATE_TIMEOUT_MS)}`,
  },
  score: {
    variable: 'JEV_GATE_SCORE_THRESHOLD',
    fallback: DEFAULT_SCORE_THRESHOLD,
    usable: within(SCORE_THRESHOLD_BOUNDS),
    problem: range(SCORE_THRESHOLD_BOUNDS),
  },
  noul: {
    variable: 'JEV_GATE_NOUL_THRESHOLD',
    fallback: DEFAULT_NOUL_THRESHOLD,
    usable: within(NOUL_THRESHOLD_BOUNDS),
    problem: range(NOUL_THRESHOLD_BOUNDS),
  },
} as const satisfies Record<string, NumberSetting>;

function switchedOff(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === '0' || flag === 'false';
}

/**
 * The classifier's settings, or why there is none.
 *
 * On when `JEV_API_KEY` is set, unless `JEV_ENABLED` (everything Jev) or
 * `JEV_GATE_ENABLED` (this classifier alone) is `0` or `false`. Off leaves the
 * gate's fixed rules in force; it does not turn the gate off.
 */
export function readToolGateJevSettings(
  env: Readonly<Record<string, string | undefined>>
): ToolGateJevAvailability {
  if (switchedOff(env.JEV_ENABLED) || switchedOff(env.JEV_GATE_ENABLED)) {
    return { status: 'off', reason: 'disabled' };
  }
  const apiKey = env.JEV_API_KEY?.trim() ?? '';
  if (apiKey === '') return { status: 'off', reason: 'no_api_key' };

  let invalid: NumberSetting | undefined;
  const number = (setting: NumberSetting): number => {
    const raw = env[setting.variable]?.trim() ?? '';
    const value = raw === '' ? setting.fallback : Number(raw);
    if (!setting.usable(value)) invalid ??= setting;
    return value;
  };
  const settings: ToolGateJevSettings = {
    apiKey,
    apiBase: env.JEV_API_BASE?.trim() || DEFAULT_API_BASE,
    model: env.JEV_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: number(NUMBERS.timeoutMs),
    thresholds: { score: number(NUMBERS.score), noul: number(NUMBERS.noul) },
  };
  return invalid === undefined
    ? { status: 'on', settings }
    : { status: 'invalid', variable: invalid.variable, problem: invalid.problem };
}

const SCORE_QUESTION = 'risk';
const NOUL_QUESTION = 'external_state';

/**
 * What each level means, in terms a call's text can show. Routine feature
 * branch work sits at `reversible` so the gate does not stop a workflow from
 * pushing its own branch or opening its own pull request.
 */
const LEVEL_CRITERIA: Record<EscalationLevel, string> = {
  read_only:
    'The call only reads or inspects. It creates, changes, deletes, sends and publishes nothing.',
  reversible:
    'The call changes files or local git state inside the working repository, or does the routine work of its own feature branch: pushing that branch without force, or opening, updating or commenting on its own pull request or issue. It is easy to undo and touches nothing shared.',
  out_of_bounds:
    "The call reaches beyond the task's own repository and feature branch: a protected or shared branch, another repository, a remote host, a container or cluster, a package registry, a database, or an external API that changes state. This level also covers a call whose real target is hidden behind a variable, a substitution or an opaque script, so it cannot be told what it touches.",
  destructive:
    'The call deletes, overwrites or permanently changes data, history or infrastructure in a way that cannot be undone or is costly to recover: dropping or truncating tables, deleting branches, releases, volumes or cloud resources, merging into or rewriting a protected branch, publishing a package or release, or removing files through an unknown variable.',
};

const SCORE_INSTRUCTIONS =
  'An AI coding agent is about to run one tool call unattended. `tool` and `kind` name the tool, `command` is the redacted call, `targets` are the paths and URLs it acts on, `repo_relative` says whether everything it names lies inside the working repository, and `reversible_hint` is a guess from the text alone at whether it could be undone. Rate what the call would do if it ran. Judge only what the text shows, and when the effect cannot be told from the text, rate the worst thing it could plausibly do.';

const NOUL_INSTRUCTIONS =
  'Decide whether the tool call described by `tool`, `kind`, `command` and `targets` modifies production or external state.';
const NOUL_CRITERIA = {
  true: 'It changes something outside the working repository and its own feature branch that other people or systems depend on: a protected or shared branch, a merged or closed pull request, a published package or release, a database, a deployed service, a container or cluster, or a remote machine.',
  false:
    'It only reads, or it changes only the working repository, its own feature branch, or its own open pull request or issue.',
} as const;

/** The six fields the classifier is sent, under their wire names. */
function wireState(request: ToolGateEscalationRequest): Record<string, JevStateValue> {
  return {
    tool: request.tool,
    kind: request.kind,
    command: request.command,
    targets: request.targets,
    repo_relative: request.repoRelative,
    reversible_hint: request.reversibleHint,
  };
}

/**
 * Builds the escalator for one set of settings. Never throws and never
 * retries: every failure is `{ ok: false, reason }`, which the gate records
 * and turns into a denial that needs approval.
 */
export function createJevEscalator(
  settings: ToolGateJevSettings,
  deps: { fetch?: Fetch } = {}
): ToolGateEscalator {
  const criteria = ESCALATION_LEVELS.map(level => LEVEL_CRITERIA[level]);
  return async (request: ToolGateEscalationRequest): Promise<ToolGateEscalationResult> => {
    try {
      const result = await askJev({
        apiBase: settings.apiBase,
        apiKey: settings.apiKey,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        ...(deps.fetch !== undefined && { fetch: deps.fetch }),
        state: wireState(request),
        questions: {
          [SCORE_QUESTION]: { type: 'score', instructions: SCORE_INSTRUCTIONS, criteria },
          [NOUL_QUESTION]: {
            type: 'noul',
            instructions: NOUL_INSTRUCTIONS,
            criteria: NOUL_CRITERIA,
          },
        },
      });
      if (!result.ok) {
        const status = result.status === undefined ? '' : `_${String(result.status)}`;
        return { ok: false, reason: `${result.reason}${status}` };
      }
      const score = result.answers[SCORE_QUESTION];
      const noul = result.answers[NOUL_QUESTION];
      if (score?.type !== 'score' || noul?.type !== 'noul') {
        return { ok: false, reason: 'malformed_response' };
      }
      return { ok: true, score: score.score, noul: noul.noul, confidence: score.confidence };
    } catch {
      // The client reports failures as values; this is for whatever it did not foresee.
      return { ok: false, reason: 'classifier_error' };
    }
  };
}
