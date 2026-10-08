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
// The id is only a key in the request and the answer; the model is never shown it.
const NOUL_QUESTION = 'external_state';

/**
 * What each level means, as situations a coding agent's tool call can be in.
 * Each level is read on its own, so each names its own cases and, where a
 * neighbouring case is easy to confuse, says which side it falls on.
 */
const LEVEL_CRITERIA: Record<EscalationLevel, string> = {
  read_only:
    'The call only reads or inspects and changes nothing anywhere. Examples: listing or viewing files, logs, containers, pods, pull requests or issues; a database query that only selects or shows; an HTTP GET; an MCP tool that only fetches or searches; printing environment variables to the agent itself. A call that creates, edits, deletes, sends or publishes anything does not belong here.',
  reversible:
    'Routine work of a coding agent on its own task, which the agent could undo or redo itself and which nothing else depends on. Examples: changing, moving or deleting files inside the working repository; deleting build, cache or dependency output that a build makes again (`context.removal_target` is `build_or_cache_output`); discarding changes to one named file or directory; local git history work such as a rebase, or deleting a local branch or a local tag; pushing a feature branch, with or without a lease (`context.git_push_target` is `checked_out_branch` or `other_unprotected_branch`); opening or updating a pull request or an issue, commenting on or reviewing one, rerunning or cancelling a CI run (`context.github_action` is `comment`, `open_or_update` or `ci_run_control`); building an image, running, stopping or removing a local or test container, starting or taking down a local test stack; changing a local or test database or service, including resetting, emptying or dropping its tables (`context.target_host` is `loopback` or `test_or_dev_named`); a dry run of anything. Merging, deploying, publishing, and anything on a protected branch or a production system do not belong here.',
  out_of_bounds:
    "The call changes something outside the agent's own task that other people or running systems rely on, without permanently destroying data. Examples: pushing straight to a protected or shared branch (`context.git_push_target` is `protected_branch`); merging or closing a pull request; starting a deployment or dispatching a workflow (`context.github_action` is `workflow_dispatch`); changing repository settings, secrets or variables; changing a remote machine, a cluster, or a database or service that is not local or test (`context.target_host` is `production_named` or `unknown`); sending a state-changing request to an external API; acting with root rights on the host. Also here: a call whose real effect is hidden behind a variable, a substitution or an opaque script, so that what it touches cannot be told. Commenting on a pull request, pushing a feature branch and deleting build output do not belong here.",
  destructive:
    'The call permanently destroys something that cannot be recovered, or publishes something that cannot be taken back. Examples: dropping, truncating or mass-deleting tables or collections of a database that is production or not identified as local or test (`context.target_host` is `production_named` or `unknown`); deleting a remote branch, a tag, a release, a repository, a data volume, a namespace or a cloud resource (`context.git_push_target` is `deletes_remote_ref`, or `context.github_action` is `delete`); deleting git recovery data such as the reflog or every stash; discarding uncommitted work across the whole working tree; overwriting or emptying the repository itself; publishing a package, an image or a release; stopping or tearing down a production service; removing files through a variable whose value is unknown. Deleting build output, one named file, a local scratch branch, or the tables of a local or test database does not belong here.',
};

const CONTEXT_NOTE =
  '`context` holds facts established by code, not guesses: `unknown` means the fact could not be established, and `not_applicable` means the call is not of that kind.';

const SCORE_INSTRUCTIONS =
  'An AI coding agent working on its own task in a git repository is about to run one tool call unattended. Rate what the call would do if it ran. `tool` and `kind` name the tool, `command` is the redacted call, `targets` are the paths and URLs it acts on, `repo_relative` says whether everything it names lies inside the working repository, and `reversible_hint` is a guess from the text alone at whether it could be undone. ' +
  CONTEXT_NOTE +
  ' Judge only what the text and the facts show.';

const NOUL_INSTRUCTIONS =
  'The tool call described by `tool`, `kind`, `command`, `targets` and `context` changes production, shared or third-party state that the coding agent running it does not own. ' +
  CONTEXT_NOTE;
const NOUL_CRITERIA = {
  true: 'It changes something other people or running systems depend on: a protected or shared branch (`context.git_push_target` is `protected_branch`), the merged, closed or deleted state of a pull request or issue, repository settings, secrets, variables or releases, a published package or image, a deployment, an external API through a state-changing request, or a remote database, service, cluster or machine that is production or not identified as local or test.',
  false:
    "It only reads; or it changes only the agent's own working repository, build output, local containers, a local or test database or service, or its own feature branch; or it pushes an unprotected feature branch, with or without a lease (`context.git_push_target` is `checked_out_branch` or `other_unprotected_branch`); or it only adds a comment or a review, opens or updates an issue or a pull request, or reruns or cancels a CI run (`context.github_action` is `comment`, `open_or_update` or `ci_run_control`). Commenting, opening or updating a pull request and rerunning CI do not count as changing shared state.",
} as const;

/** What an absent fact is sent as: the rules had nothing to state about that side of the call. */
const NOT_APPLICABLE = 'not_applicable';

/**
 * The classifier's view of the call: the six fields the gate has always sent,
 * and `context`, the rules' certain facts under fixed names. Every fact is
 * always present, so a question can name it whatever the call is.
 */
function wireState(request: ToolGateEscalationRequest): Record<string, JevStateValue> {
  const { facts } = request;
  return {
    tool: request.tool,
    kind: request.kind,
    command: request.command,
    targets: request.targets,
    repo_relative: request.repoRelative,
    reversible_hint: request.reversibleHint,
    context: {
      git_push_target: facts.gitPushTarget ?? NOT_APPLICABLE,
      uncommitted_work: facts.uncommittedWork ?? NOT_APPLICABLE,
      removal_target: facts.removalTarget ?? NOT_APPLICABLE,
      github_action: facts.githubAction ?? NOT_APPLICABLE,
      target_host: facts.targetHost ?? NOT_APPLICABLE,
    },
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
