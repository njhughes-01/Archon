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
 *
 * One gate is one attempt of a step: it holds that attempt's denial count and
 * whether its shell may have left the root. A caller builds a new gate for a
 * retry or a loop iteration and shares only the classifier cache between them.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createLogger } from '@archon/paths';
import type {
  AgentRequestOptions,
  ToolActionDecision,
  ToolActionKind,
  ToolActionRequest,
} from '@archon/providers/types';
import type { EscalationFacts } from './escalation-facts';
import { isInside } from './path-resolution';
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
  DENY_RULES,
  evaluateRules,
  type AllowRuleId,
  type DenyRuleId,
  type ReversibleHint,
  type RiskRuleId,
  type RuleContext,
} from './rules';

export type ToolGate = NonNullable<AgentRequestOptions['toolGate']>;

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.tool-gate');
  return cachedLog;
}

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

/** Denials one attempt of a node may collect before every further denial tells the agent to stop. */
export const DEFAULT_MAX_DENIALS_PER_NODE = 3;
export const REPEATED_DENIALS_RULE_ID = 'guard.repeated_denials';
/** Names the denial of a call whose decision the audit sink did not take. It is in no record. */
export const UNRECORDED_DECISION_RULE_ID = 'guard.unrecorded_decision';

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
  /** What the rules know for certain about the call beyond its text. Absent facts were not established. */
  facts: EscalationFacts;
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

/**
 * Most targets the classifier is sent for one call. Their combined length is
 * held to `ESCALATION_TEXT_CAP` as well, the cap the command itself has.
 */
export const MAX_ESCALATION_TARGETS = 20;

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
  /**
   * Why a configured classifier gave no usable answer, redacted and capped.
   * Recorded here and never shown to the agent.
   */
  classifierFailure?: string;
  /**
   * How many calls this record answers. More than one when identical calls
   * were made at the same time and judged once.
   */
  count: number;
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
   * Absolute directories outside the repository the node may also write into,
   * such as the run's own artifacts directory. A write that really lands in one
   * is judged like a write inside the repository, secret-path rules included.
   * Nothing else is widened: a working directory there is still outside the
   * repository, and every other path outside stays denied. A target inside one
   * is shown to the classifier relative to that root. May not exist yet.
   */
  extraWriteRoots?: readonly string[];
  /**
   * Absolute paths no call may write, move or remove, such as a credential
   * file the engine delivered into an extra write root. Reading one is judged
   * by the secret-path vocabulary alone.
   */
  protectedPaths?: readonly string[];
  /**
   * Whether a classifier key is configured. When false the classifier is never
   * called and a risk-signalled call is allowed and recorded as `fallback`.
   * When true and no usable answer comes back, the call is denied.
   */
  classifierConfigured: boolean;
  /** Asks the classifier. Called only for the escalation band, with redacted text. */
  escalate: ToolGateEscalator;
  /**
   * Receives exactly one event per decision. It may return a promise, which the
   * gate waits for before it answers the call. A throw or a rejection denies
   * the call: a decision that could not be recorded is never handed out as an
   * allow. The agent is told only that; the failure is logged here, once, by
   * the name of the error, and the sink is not asked again for that decision.
   * Typed `unknown` so a sink may return whatever its last statement returns;
   * only a promise is looked at.
   */
  record: (event: ToolGateDecisionEvent) => unknown;
  /** Branches a lease-protected forced push may never target. Default: main, master. */
  protectedBranches?: readonly string[];
  /** Command prefixes known to only verify the repository. Default: the usual runner scripts. */
  verificationCommands?: readonly string[];
  /** Exact credential values to mask wherever they appear. */
  credentialValues?: readonly string[];
  /** What `~` and `$HOME` stand for. Default: the engine's own home directory. */
  homeDir?: string;
  thresholds?: { score?: number; noul?: number };
  /** Denials this gate hands out before each further one tells the agent to stop. */
  maxDenialsPerNode?: number;
  /**
   * One sentence added to what the agent is told when a call is denied for
   * writing outside the root, or denied as needing approval. For a caller that
   * knows why nothing is writable here and what the user can do about it.
   */
  outsideRootAdvice?: string;
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
/** The whole of what the agent is told. What the classifier said went wrong is in the record. */
const NO_ANSWER_DENIAL =
  'This call carries a risk signal and the action classifier gave no usable answer, so it needs human approval.';
/** Recorded when the escalator hands back something that is not a result at all. */
const MALFORMED_ESCALATION = 'malformed_escalation';
/** The whole of what the agent is told. What the sink threw is named in the log and nowhere else. */
const UNRECORDED_DENIAL =
  'The decision for this call could not be recorded, and a call with no audit record may not run.';
const UNRECORDED_ALTERNATIVES: readonly string[] = [
  'Report the work as blocked in your output and say that the tool gate could not record its decisions.',
];

type Denied = Extract<ToolActionDecision, { action: 'deny' }>;
interface Refusal {
  needsApproval: boolean;
  reason: string;
  alternatives: readonly string[];
}

/** Every kind the contract names. A request with any other value cannot be judged. */
const TOOL_ACTION_KINDS = {
  shell: true,
  file_write: true,
  network: true,
  mcp: true,
  other: true,
} as const satisfies Record<ToolActionKind, true>;

function isToolActionKind(kind: unknown): kind is ToolActionKind {
  return typeof kind === 'string' && Object.hasOwn(TOOL_ACTION_KINDS, kind);
}

type FieldCheck = (value: unknown) => boolean;
const isText: FieldCheck = value => typeof value === 'string';
const isOptionalText: FieldCheck = value => value === undefined || isText(value);
const isOptionalTextList: FieldCheck = value =>
  value === undefined || (Array.isArray(value) && value.every(isText));
const isRecord: FieldCheck = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * How each field the gate reads has to arrive. The request type promises this
 * shape, but a request is built by a provider from what a model and an SDK sent,
 * and nothing checks it at runtime before here. `kind` is checked on its own,
 * since a request that is sound apart from its kind can still be described.
 * The gate never reads the two fields left out.
 */
const REQUEST_SHAPE = {
  toolName: isText,
  cwd: isText,
  command: isOptionalText,
  paths: isOptionalTextList,
  url: isOptionalText,
  input: isRecord,
  parsedCommands: isOptionalTextList,
} as const satisfies Record<
  Exclude<keyof ToolActionRequest, 'kind' | 'toolCallId' | 'fromSubagent'>,
  FieldCheck
>;

/** Names a call in its record when the request does not say which tool it is. */
const UNNAMED_TOOL = 'unknown';

/** All that is kept of a request that did not arrive in the contract's shape. */
interface UnreadableRequest {
  /** The tool's name when the request has one, redacted and capped. */
  tool: string;
  /** Stands in for the hash of the raw request, which may not be serialisable. */
  commandHash: string;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * `undefined` for a request in the contract's shape. Otherwise what its record
 * may hold: the tool's name, and a hash over that name and the type of each
 * field, so the same malformed call from one tool hashes the same. No field's
 * value is read beyond its type, and nothing here can throw: a request whose
 * properties cannot even be read is the unnamed one.
 */
function unreadableRequest(
  request: unknown,
  redaction: RedactOptions
): UnreadableRequest | undefined {
  let tool = UNNAMED_TOOL;
  let shape: string = typeName(request);
  try {
    if (typeof request === 'object' && request !== null) {
      const fields = request as Record<string, unknown>;
      const checks = Object.entries(REQUEST_SHAPE);
      if (checks.every(([name, fits]) => fits(fields[name]))) return undefined;
      if (typeof fields.toolName === 'string') tool = redactText(fields.toolName, redaction);
      shape = checks.map(([name]) => `${name}:${typeName(fields[name])}`).join(',');
    }
  } catch {
    tool = UNNAMED_TOOL;
  }
  return { tool, commandHash: sha256(JSON.stringify(['unreadable request', tool, shape])) };
}

/**
 * An escalator is injected code: whatever it resolves to is read as untrusted.
 * Anything that is not one of the two result shapes becomes a failure, so the
 * call is denied and recorded instead of crashing the gate.
 */
function normaliseEscalation(result: unknown): ToolGateEscalationResult {
  if (typeof result !== 'object' || result === null) {
    return { ok: false, reason: MALFORMED_ESCALATION };
  }
  const { ok, reason, score, noul, confidence } = result as Record<string, unknown>;
  if (ok === false && typeof reason === 'string') return { ok: false, reason };
  if (
    ok === true &&
    typeof score === 'number' &&
    typeof noul === 'number' &&
    typeof confidence === 'number'
  ) {
    return { ok: true, score, noul, confidence };
  }
  return { ok: false, reason: MALFORMED_ESCALATION };
}

/** The targets as the classifier is sent them: redacted, then cut by count and by total length. */
function boundedTargets(targets: readonly string[], redaction: RedactOptions): string[] {
  const sent: string[] = [];
  let length = 0;
  for (const target of targets) {
    const text = redactText(target, redaction);
    if (sent.length === MAX_ESCALATION_TARGETS || length + text.length > ESCALATION_TEXT_CAP) break;
    sent.push(text);
    length += text.length;
  }
  const dropped = targets.length - sent.length;
  return dropped === 0 ? sent : [...sent, `… [${String(dropped)} more targets]`];
}

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
 * Where a path that may not exist yet really is: its nearest existing ancestor
 * resolved, with the missing remainder appended. Nothing below a missing
 * directory can be a symlink, so this is where a later write there lands.
 */
function realPathAllowingMissing(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch (error) {
      const parent = dirname(current);
      // Anything but a missing segment (a loop, a file in the way) is a path the
      // gate cannot place, and the filesystem root always exists.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function realPaths(name: string, paths: readonly string[] | undefined): string[] {
  return (paths ?? []).map(path => {
    if (!isAbsolute(path)) throw new Error(`toolGate ${name} must be absolute paths, got ${path}`);
    return realPathAllowingMissing(path);
  });
}

/**
 * Builds the gate for one attempt of one node. Throws on a configuration the
 * gate could not honour, so a bad threshold or root fails at dispatch instead
 * of at the first tool call.
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
    extraWriteRoots: realPaths('extraWriteRoots', options.extraWriteRoots),
    protectedPaths: realPaths('protectedPaths', options.protectedPaths),
  };
  // A root that holds the home directory (the filesystem root included) would
  // turn "outside the repository" into nearly nothing.
  const tooWide = context.extraWriteRoots?.find(
    root => dirname(root) === root || isInside(root, context.homeDir)
  );
  if (tooWide !== undefined) {
    throw new Error(
      `toolGate extraWriteRoots may not contain the home directory or be a filesystem root, got ${tooWide}`
    );
  }
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
  // Set once a shell call that left the root was allowed. A provider whose
  // shell keeps its working directory between calls may be standing there from
  // then on, while each request still reports the directory the step started
  // in, so the rules are told not to place relative paths by it. This is
  // conservative for a provider whose shell starts afresh on every call, and it
  // is the only handling there is: the gate reads each call's text and cannot
  // observe where a persistent shell stands. It lasts as long as this gate.
  let cwdUntrusted = false;

  /** Counts a denial and words it, or tells the agent to stop once there were too many. */
  const refuse = (refusal: Refusal, ruleId: string): Denied => {
    denials++;
    if (denials > maxDenials) {
      // The loop guard: the agent kept asking after being told no.
      return {
        action: 'deny',
        needsApproval: refusal.needsApproval,
        reason:
          `Stop calling tools that get denied: ${String(maxDenials)} calls were already ` +
          `denied in this step, the latest by ${ruleId}. Report the work as blocked in ` +
          'your output and end the step.',
        alternatives: [
          'End the step now and list the denied actions in your output so a human can decide.',
        ],
        ruleId: REPEATED_DENIALS_RULE_ID,
      };
    }
    return {
      action: 'deny',
      needsApproval: refusal.needsApproval,
      reason: `${refusal.reason} ${DENIAL_GUIDANCE}`,
      alternatives: [...refusal.alternatives],
      ruleId,
    };
  };

  /** An escalator that fails by throwing is the same as one that reports a failure. */
  const ask = async (request: ToolGateEscalationRequest): Promise<ToolGateEscalationResult> => {
    try {
      return normaliseEscalation(await options.escalate(request));
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'classifier threw' };
    }
  };

  // Identical calls still being judged share that one judgement: one pass over
  // the rules, one classifier request, one record and one count toward the
  // repeated-denial guard. A batch of the same call must not trip the guard by
  // itself, and must not multiply classifier requests. The batch closes when
  // its record is handed over, so the record's `count` is exact and the same
  // call made from then on is judged afresh.
  interface Batch {
    callers: number;
    decision: Promise<ToolActionDecision> | undefined;
  }
  const inFlight = new Map<string, Batch>();
  const close = (commandHash: string, batch: Batch): void => {
    if (inFlight.get(commandHash) === batch) inFlight.delete(commandHash);
  };

  const decide = async (
    request: ToolActionRequest,
    unreadable: UnreadableRequest | undefined,
    commandHash: string,
    batch: Batch
  ): Promise<ToolActionDecision> => {
    const started = now();
    const tool = unreadable === undefined ? request.toolName : unreadable.tool;
    const knownKind = unreadable === undefined && isToolActionKind(request.kind);
    const redactedPreview =
      unreadable === undefined
        ? previewOf(request, forPreview)
        : redactText(`${unreadable.tool} [unreadable request]`, forPreview);

    const finish = async (
      verdict: { action: 'allow' } | ({ action: 'deny' } & Refusal),
      source: ToolGateDecisionSource,
      ruleId: AllowRuleId | DenyRuleId | RiskRuleId,
      answer?: ToolGateClassifierAnswer,
      classifierFailure?: string
    ): Promise<ToolActionDecision> => {
      let decision: ToolActionDecision;
      if (verdict.action === 'allow') {
        decision = verdict;
      } else {
        const advised =
          options.outsideRootAdvice !== undefined &&
          (ruleId === 'deny.path_outside_root' || verdict.needsApproval);
        const advice = advised ? ` ${String(options.outsideRootAdvice)}` : '';
        decision = refuse({ ...verdict, reason: `${verdict.reason}${advice}` }, ruleId);
      }
      const stopped = decision.action === 'deny' && decision.ruleId === REPEATED_DENIALS_RULE_ID;
      close(commandHash, batch);
      try {
        await options.record({
          tool,
          // The record's vocabulary is the contract's: a value outside it is not copied in.
          kind: knownKind ? request.kind : 'other',
          decision: decision.action,
          needsApproval: decision.action === 'deny' && decision.needsApproval,
          source,
          ruleId: stopped ? REPEATED_DENIALS_RULE_ID : ruleId,
          ...(answer !== undefined && {
            score: answer.score,
            noul: answer.noul,
            confidence: answer.confidence,
          }),
          ...(classifierFailure !== undefined && { classifierFailure }),
          count: batch.callers,
          latencyMs: now() - started,
          commandHash,
          redactedPreview,
        });
      } catch (error) {
        // The error's message and stack may quote the row that was not written,
        // and the event holds the preview: neither is logged. The hash is the
        // one any other record of the same call carries.
        getLog().error(
          {
            errorName: error instanceof Error ? error.name : typeof error,
            decision: decision.action,
            ruleId,
            commandHash,
          },
          'tool_gate.decision_record_failed'
        );
        // A denial stays the denial it was, already counted. An allow that
        // nobody can audit is not handed out: it needs a human instead.
        if (decision.action === 'deny') return decision;
        return refuse(
          { needsApproval: true, reason: UNRECORDED_DENIAL, alternatives: UNRECORDED_ALTERNATIVES },
          UNRECORDED_DECISION_RULE_ID
        );
      }
      return decision;
    };

    if (!knownKind) {
      // The rules read these fields and switch on the kind. A request that is
      // not in that shape, or a kind they do not know, must not fall through
      // them unjudged, whatever the rest of it says.
      const rule = DENY_RULES['deny.unreadable_request'];
      return finish(
        {
          action: 'deny',
          needsApproval: false,
          reason: rule.reason,
          alternatives: rule.alternatives,
        },
        'rule',
        'deny.unreadable_request'
      );
    }

    const isShell = request.kind === 'shell';
    const outcome = await evaluateRules(request, context, {
      cwdUntrusted: isShell && cwdUntrusted,
    });
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

    // Whoever lets the call through, it then runs: see `cwdUntrusted`. An allow
    // that could not be recorded was turned into a denial and changes nothing.
    const leavesRoot = isShell && outcome.signals.includes('risk.cwd_outside_root');
    const allow = async (
      source: ToolGateDecisionSource,
      answer?: ToolGateClassifierAnswer
    ): Promise<ToolActionDecision> => {
      const decision = await finish({ action: 'allow' }, source, outcome.ruleId, answer);
      if (leavesRoot && decision.action === 'allow') cwdUntrusted = true;
      return decision;
    };

    // Escalation band. With no classifier configured the rules are the whole
    // gate: the call goes ahead and the record says no one judged it.
    if (!options.classifierConfigured) return allow('fallback');

    const escalation: ToolGateEscalationRequest = {
      tool: request.toolName,
      kind: request.kind,
      command:
        request.command === undefined
          ? redactInput(request.input, forClassifier)
          : redactText(request.command, forClassifier),
      targets: boundedTargets(outcome.targets, forPreview),
      repoRelative: outcome.repoRelative,
      reversibleHint: outcome.reversibleHint,
      signals: outcome.signals,
      facts: outcome.facts,
    };
    // The key covers the raw request and what the rules found on disk this time.
    const cacheKey = sha256(`${commandHash}\n${JSON.stringify(escalation)}`);
    let answer = cache.get(cacheKey);
    if (answer === undefined) {
      const result = await ask(escalation);
      if (!result.ok || !usableAnswer(result)) {
        // A configured classifier that cannot answer must not become a silent allow.
        const why = result.ok ? 'answer out of range' : result.reason;
        return finish(
          {
            action: 'deny',
            needsApproval: true,
            reason: NO_ANSWER_DENIAL,
            alternatives: APPROVAL_ALTERNATIVES,
          },
          'fallback',
          outcome.ruleId,
          undefined,
          redactText(why, forPreview)
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
    return allow('jev', answer);
  };

  return async (request: ToolActionRequest): Promise<ToolActionDecision> => {
    // Before anything reads the request: hashing or previewing one that is not
    // in the contract's shape would throw, and the call would leave no record.
    const unreadable = unreadableRequest(request, forPreview);
    const commandHash = unreadable === undefined ? hashRequest(request) : unreadable.commandHash;
    const running = inFlight.get(commandHash);
    if (running?.decision !== undefined) {
      running.callers++;
      return running.decision;
    }
    const batch: Batch = { callers: 1, decision: undefined };
    // Registered before the judgement starts, which may reach its record at once.
    inFlight.set(commandHash, batch);
    batch.decision = decide(request, unreadable, commandHash, batch).finally(() => {
      close(commandHash, batch);
    });
    return batch.decision;
  };
}
