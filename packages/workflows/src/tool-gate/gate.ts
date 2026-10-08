/**
 * The tool gate: rules first and final, then the classifier for what the rules
 * could only flag.
 *
 * No network code lives here. The classifier is an injected function, the audit
 * trail an injected sink, and neither ever sees raw tool input: only redacted,
 * truncated text built from a fixed set of fields.
 *
 * The classifier can add a denial and never remove one. A rule's deny is
 * returned without asking it, and its confidence is recorded but not used.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import type {
  AgentRequestOptions,
  ToolActionDecision,
  ToolActionKind,
  ToolActionRequest,
} from '@archon/providers/types';
import {
  ESCALATION_TEXT_CAP,
  PREVIEW_TEXT_CAP,
  redactInput,
  redactText,
  type RedactOptions,
} from './redact';
import {
  DEFAULT_PROTECTED_BRANCHES,
  DEFAULT_VERIFICATION_COMMANDS,
  evaluateRules,
  type AllowRuleId,
  type DenyRuleId,
  type ReversibleHint,
  type RiskRuleId,
  type RuleContext,
} from './rules';

export type ToolGate = NonNullable<AgentRequestOptions['toolGate']>;

/**
 * The classifier's score scale, low to high. The score is a 0-based,
 * probability-weighted mean over these levels, so it can be fractional.
 */
export const ESCALATION_LEVELS = [
  'read_only',
  'reversible',
  'out_of_bounds',
  'destructive',
] as const;
export type EscalationLevel = (typeof ESCALATION_LEVELS)[number];

/** The lowest level that needs approval. */
const FIRST_DENIED_LEVEL: EscalationLevel = 'out_of_bounds';
/** Half a level: the point where a weighted mean is as near the denied level as the one below. */
const HALF_LEVEL = 0.5;

/** A score threshold outside the scale could never, or would always, fire. */
export const SCORE_THRESHOLD_BOUNDS = { min: 0, max: ESCALATION_LEVELS.length - 1 } as const;
/** Deny at or above this score. */
export const DEFAULT_SCORE_THRESHOLD = ESCALATION_LEVELS.indexOf(FIRST_DENIED_LEVEL) - HALF_LEVEL;

/** The noul is a probability. */
export const NOUL_THRESHOLD_BOUNDS = { min: 0, max: 1 } as const;
/** Deny at or above this likelihood that the call modifies production or external state. */
export const DEFAULT_NOUL_THRESHOLD = (NOUL_THRESHOLD_BOUNDS.min + NOUL_THRESHOLD_BOUNDS.max) / 2;

/** Denials one node may collect before every further denial tells the agent to stop. */
export const DEFAULT_MAX_DENIALS_PER_NODE = 3;
export const REPEATED_DENIALS_RULE_ID = 'guard.repeated_denials';

/** What the classifier is asked about: redacted, truncated, and nothing else. */
export interface ToolGateEscalationRequest {
  tool: string;
  kind: ToolActionKind;
  /** Shell text, or the tool's input as JSON when there is none. */
  command: string;
  /** Paths (repository-relative when inside the root) and URLs the call acts on. */
  targets: string[];
  repoRelative: boolean;
  reversibleHint: ReversibleHint;
  /** Every risk signal that fired, strongest first. */
  signals: RiskRuleId[];
}

export interface ToolGateClassifierAnswer {
  /** Probability-weighted mean over `ESCALATION_LEVELS`, 0-based. */
  score: number;
  /** Likelihood that the call modifies production or external state. */
  noul: number;
  /** Logged only. It never lowers or raises a decision. */
  confidence: number;
}

export type ToolGateEscalationResult =
  | ({ ok: true } & ToolGateClassifierAnswer)
  | { ok: false; reason: string };

export type ToolGateEscalator = (
  request: ToolGateEscalationRequest
) => Promise<ToolGateEscalationResult>;

export type ToolGateDecisionSource = 'rule' | 'jev' | 'fallback';

/** One audit record per decision. Carries no raw command or input. */
export interface ToolGateDecisionEvent {
  tool: string;
  kind: ToolActionKind;
  decision: ToolActionDecision['action'];
  needsApproval: boolean;
  source: ToolGateDecisionSource;
  ruleId: AllowRuleId | DenyRuleId | RiskRuleId | typeof REPEATED_DENIALS_RULE_ID;
  score?: number;
  noul?: number;
  confidence?: number;
  latencyMs: number;
  /** SHA-256 of the raw request, so repeats can be matched without storing it. */
  commandHash: string;
  redactedPreview: string;
}

/** Classifier answers kept for one run, so a repeated call is not asked about twice. */
export interface ToolGateCache {
  get(key: string): ToolGateClassifierAnswer | undefined;
  set(key: string, answer: ToolGateClassifierAnswer): void;
}

export function createToolGateCache(): ToolGateCache {
  return new Map<string, ToolGateClassifierAnswer>();
}

export interface ToolGateOptions {
  /** The repository the node works in. Absolute and existing; every path is judged against it. */
  repoRoot: string;
  /**
   * Whether a classifier key is configured. When false the classifier is never
   * called and a risk-signalled call is allowed and recorded as `fallback`.
   * When true and no usable answer comes back, the call is denied.
   */
  classifierConfigured: boolean;
  /** Asks the classifier. Called only for the escalation band, with redacted text. */
  escalate: ToolGateEscalator;
  /** Receives exactly one event per decision. A throw fails the call. */
  record: (event: ToolGateDecisionEvent) => void;
  /** Branches a lease-protected forced push may never target. Default: main, master. */
  protectedBranches?: readonly string[];
  /** Command prefixes known to only verify the repository. Default: the usual runner scripts. */
  verificationCommands?: readonly string[];
  /** Exact credential values to mask wherever they appear. */
  credentialValues?: readonly string[];
  /** What `~` and `$HOME` stand for. Default: the engine's own home directory. */
  homeDir?: string;
  thresholds?: { score?: number; noul?: number };
  maxDenialsPerNode?: number;
  /** Share one cache across the gates of a run. Default: a cache private to this gate. */
  cache?: ToolGateCache;
  /** Clock for `latencyMs`. */
  now?: () => number;
}

const DENIAL_GUIDANCE =
  'This answer is final for this call: do not retry or rephrase it. Use an alternative, or report the work as blocked in your output.';

const APPROVAL_ALTERNATIVES: readonly string[] = [
  'Use a narrower or reversible action that stays inside the repository.',
  'Report the work as blocked in your output and name the exact action a human should approve or run.',
];
const CLASSIFIER_DENIAL =
  'The action classifier rated this call as out of bounds, destructive, or changing production or external state, so it needs human approval.';
const NO_ANSWER_DENIAL =
  'This call carries a risk signal and the action classifier gave no usable answer, so it needs human approval.';
/** How much of a classifier failure reason is shown to the agent. */
const FAILURE_REASON_CAP = 120;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function inputJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    // Circular or otherwise unserialisable: its keys still tell requests apart.
    return Object.keys(input).join(',');
  }
}

function hashRequest(request: ToolActionRequest): string {
  return sha256(
    JSON.stringify([
      request.kind,
      request.toolName,
      request.cwd,
      request.command ?? null,
      request.paths ?? null,
      request.url ?? null,
      request.parsedCommands ?? null,
      inputJson(request.input),
    ])
  );
}

function previewOf(request: ToolActionRequest, redaction: RedactOptions): string {
  if (request.command !== undefined) return redactText(request.command, redaction);
  if (request.paths !== undefined && request.paths.length > 0) {
    return redactText(request.paths.join(' '), redaction);
  }
  if (request.url !== undefined) return redactText(request.url, redaction);
  // No text of its own: name the tool and the input fields, never their values.
  return redactText(`${request.toolName}(${Object.keys(request.input).join(', ')})`, redaction);
}

function inBounds(value: number, bounds: { min: number; max: number }): boolean {
  return Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
}

function threshold(
  name: 'score' | 'noul',
  configured: number | undefined,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const value = configured ?? fallback;
  if (!inBounds(value, bounds)) {
    throw new Error(
      `toolGate ${name} threshold must be between ${String(bounds.min)} and ${String(bounds.max)}, got ${String(value)}`
    );
  }
  return value;
}

function usableAnswer(answer: ToolGateClassifierAnswer): boolean {
  return (
    inBounds(answer.score, SCORE_THRESHOLD_BOUNDS) &&
    inBounds(answer.noul, NOUL_THRESHOLD_BOUNDS) &&
    inBounds(answer.confidence, NOUL_THRESHOLD_BOUNDS)
  );
}

function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A home directory that does not exist cannot be a symlink either: use it as given.
    return path;
  }
}

/**
 * Builds the gate for one node. Throws on a configuration the gate could not
 * honour, so a bad threshold or root fails at dispatch instead of at the first
 * tool call.
 */
export function createToolGate(options: ToolGateOptions): ToolGate {
  if (!isAbsolute(options.repoRoot)) {
    throw new Error('toolGate repoRoot must be an absolute path');
  }
  const context: RuleContext = {
    repoRoot: realpathSync(options.repoRoot),
    homeDir: realPathOr(options.homeDir ?? homedir()),
    protectedBranches: options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES,
    verificationCommands: options.verificationCommands ?? DEFAULT_VERIFICATION_COMMANDS,
  };
  const scoreThreshold = threshold(
    'score',
    options.thresholds?.score,
    DEFAULT_SCORE_THRESHOLD,
    SCORE_THRESHOLD_BOUNDS
  );
  const noulThreshold = threshold(
    'noul',
    options.thresholds?.noul,
    DEFAULT_NOUL_THRESHOLD,
    NOUL_THRESHOLD_BOUNDS
  );
  const maxDenials = options.maxDenialsPerNode ?? DEFAULT_MAX_DENIALS_PER_NODE;
  if (!Number.isInteger(maxDenials) || maxDenials < 1) {
    throw new Error(
      `toolGate maxDenialsPerNode must be a positive whole number, got ${String(maxDenials)}`
    );
  }

  const credentialValues = options.credentialValues ?? [];
  const forClassifier: RedactOptions = { credentialValues, cap: ESCALATION_TEXT_CAP };
  const forPreview: RedactOptions = { credentialValues, cap: PREVIEW_TEXT_CAP };
  const cache = options.cache ?? createToolGateCache();
  const now = options.now ?? ((): number => performance.now());
  let denials = 0;

  /** An escalator that fails by throwing is the same as one that reports a failure. */
  const ask = async (request: ToolGateEscalationRequest): Promise<ToolGateEscalationResult> => {
    try {
      return await options.escalate(request);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'classifier threw' };
    }
  };

  return async (request: ToolActionRequest): Promise<ToolActionDecision> => {
    const started = now();
    const commandHash = hashRequest(request);
    const redactedPreview = previewOf(request, forPreview);

    const finish = (
      verdict:
        | { action: 'allow' }
        | {
            action: 'deny';
            needsApproval: boolean;
            reason: string;
            alternatives: readonly string[];
          },
      source: ToolGateDecisionSource,
      ruleId: AllowRuleId | DenyRuleId | RiskRuleId,
      answer?: ToolGateClassifierAnswer
    ): ToolActionDecision => {
      let decision: ToolActionDecision;
      let recordedRule: ToolGateDecisionEvent['ruleId'] = ruleId;
      if (verdict.action === 'allow') {
        decision = verdict;
      } else {
        denials++;
        if (denials > maxDenials) {
          // The loop guard: the agent kept asking after being told no.
          recordedRule = REPEATED_DENIALS_RULE_ID;
          decision = {
            action: 'deny',
            needsApproval: verdict.needsApproval,
            reason:
              `Stop calling tools that get denied: ${String(maxDenials)} calls were already ` +
              `denied in this step, the latest by ${ruleId}. Report the work as blocked in ` +
              'your output and end the step.',
            alternatives: [
              'End the step now and list the denied actions in your output so a human can decide.',
            ],
            ruleId: REPEATED_DENIALS_RULE_ID,
          };
        } else {
          decision = {
            action: 'deny',
            needsApproval: verdict.needsApproval,
            reason: `${verdict.reason} ${DENIAL_GUIDANCE}`,
            alternatives: [...verdict.alternatives],
            ruleId,
          };
        }
      }
      options.record({
        tool: request.toolName,
        kind: request.kind,
        decision: decision.action,
        needsApproval: decision.action === 'deny' && decision.needsApproval,
        source,
        ruleId: recordedRule,
        ...(answer !== undefined && {
          score: answer.score,
          noul: answer.noul,
          confidence: answer.confidence,
        }),
        latencyMs: now() - started,
        commandHash,
        redactedPreview,
      });
      return decision;
    };

    const outcome = await evaluateRules(request, context);
    if (outcome.outcome === 'allow') return finish({ action: 'allow' }, 'rule', outcome.ruleId);
    if (outcome.outcome === 'deny') {
      // A fixed rule refused it: no approval path in this version, so not "needs approval".
      const { reason, alternatives } = outcome;
      return finish(
        { action: 'deny', needsApproval: false, reason, alternatives },
        'rule',
        outcome.ruleId
      );
    }

    // Escalation band. With no classifier configured the rules are the whole
    // gate: the call goes ahead and the record says no one judged it.
    if (!options.classifierConfigured) {
      return finish({ action: 'allow' }, 'fallback', outcome.ruleId);
    }

    const escalation: ToolGateEscalationRequest = {
      tool: request.toolName,
      kind: request.kind,
      command:
        request.command === undefined
          ? redactInput(request.input, forClassifier)
          : redactText(request.command, forClassifier),
      targets: outcome.targets.map(target => redactText(target, forPreview)),
      repoRelative: outcome.repoRelative,
      reversibleHint: outcome.reversibleHint,
      signals: outcome.signals,
    };
    // The key covers the raw request and what the rules found on disk this time.
    const cacheKey = sha256(`${commandHash}\n${JSON.stringify(escalation)}`);
    let answer = cache.get(cacheKey);
    if (answer === undefined) {
      const result = await ask(escalation);
      if (!result.ok || !usableAnswer(result)) {
        // A configured classifier that cannot answer must not become a silent allow.
        const why = result.ok ? 'answer out of range' : result.reason;
        const shown = redactText(why, { credentialValues, cap: FAILURE_REASON_CAP });
        return finish(
          {
            action: 'deny',
            needsApproval: true,
            reason: `${NO_ANSWER_DENIAL} (Classifier: ${shown}.)`,
            alternatives: APPROVAL_ALTERNATIVES,
          },
          'fallback',
          outcome.ruleId
        );
      }
      answer = { score: result.score, noul: result.noul, confidence: result.confidence };
      cache.set(cacheKey, answer);
    }

    if (answer.score >= scoreThreshold || answer.noul >= noulThreshold) {
      return finish(
        {
          action: 'deny',
          needsApproval: true,
          reason: CLASSIFIER_DENIAL,
          alternatives: APPROVAL_ALTERNATIVES,
        },
        'jev',
        outcome.ruleId,
        answer
      );
    }
    return finish({ action: 'allow' }, 'jev', outcome.ruleId, answer);
  };
}
