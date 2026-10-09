/**
 * Tool Action Gate: the engine's side of `AgentRequestOptions.toolGate`.
 *
 * `createToolGate` returns the callback a provider asks before each tool call
 * that can change state. It is defence in depth, not a sandbox: it reads the
 * text of a call and cannot see what a script, an interpreter one-liner, a
 * Makefile or package script, or an MCP tool does once it runs. The parser's
 * limits are listed in `shell-tokens.ts`.
 */
export {
  createToolGate,
  createToolGateCache,
  DEFAULT_MAX_DENIALS_PER_NODE,
  DEFAULT_NOUL_THRESHOLD,
  DEFAULT_SCORE_THRESHOLD,
  ESCALATION_LEVELS,
  MAX_ESCALATION_TARGETS,
  NOUL_THRESHOLD_BOUNDS,
  REPEATED_DENIALS_RULE_ID,
  SCORE_THRESHOLD_BOUNDS,
} from './gate';
export type {
  EscalationLevel,
  ToolGate,
  ToolGateCache,
  ToolGateClassifierAnswer,
  ToolGateDecisionEvent,
  ToolGateDecisionSource,
  ToolGateEscalationRequest,
  ToolGateEscalationResult,
  ToolGateEscalator,
  ToolGateOptions,
} from './gate';
export {
  ALLOW_RULE_IDS,
  DEFAULT_PROTECTED_BRANCHES,
  DEFAULT_VERIFICATION_COMMANDS,
  DENY_RULES,
  evaluateRules,
  RISK_RULE_IDS,
} from './rules';
export type {
  AllowRuleId,
  DenyRuleId,
  ReversibleHint,
  RiskRuleId,
  RuleContext,
  RuleOutcome,
} from './rules';
export { ESCALATION_TEXT_CAP, PREVIEW_TEXT_CAP, redactInput, redactText } from './redact';
export type { RedactOptions } from './redact';
export { collectCredentialValues, redactCredentialValues } from './credential-values';
export { ESCALATION_FACT_VALUES } from './escalation-facts';
export type { EscalationFactName, EscalationFacts } from './escalation-facts';
export { mergeToolGateConfig, parseToolGateConfig } from './config';
export type { ToolGateConfig, ToolGateConfigInput } from './config';
export {
  createJevEscalator,
  DEFAULT_GATE_TIMEOUT_MS,
  MAX_GATE_TIMEOUT_MS,
  readToolGateJevSettings,
} from './escalate-jev';
export type { ToolGateJevAvailability, ToolGateJevSettings } from './escalate-jev';
export {
  assertProviderHonoursToolGate,
  createRunToolGate,
  createWorkflowRunToolGate,
  emptyToolGateRoot,
  providerHonoursToolGate,
  providersUsableUnderToolGate,
  workflowToolGateRecorder,
} from './run-gate';
export type { RunToolGate, RunToolGateInput, WorkflowRunToolGateInput } from './run-gate';
export { isSecretPath } from './secret-paths';
