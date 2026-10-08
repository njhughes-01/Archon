/**
 * Which of a node's declared fields a provider cannot honour.
 *
 * One list with two readers: the executor warns the user that the fields will be ignored,
 * and the model router refuses to move a node onto a provider that would ignore a field
 * its authored provider honours. Both read this function so the two cannot disagree about
 * what "the provider can run this node" means.
 */
import type { ProviderCapabilities } from '@archon/providers/types';
import type { DagNode, EffortLevel } from './schemas';

/** Workflow- and install-level values a node inherits, as the executor already resolved them. */
export interface NodeCapabilityScope {
  /** Reasoning depth the author declared on the node or its workflow, before any preset. */
  declaredEffort: EffortLevel | undefined;
  workflowFallbackModel: unknown;
  workflowSandbox: unknown;
  /** Workflow-level `webSearchMode:`; see `providerReadsWebSearchMode`. */
  webSearchMode: unknown;
  /** Workflow-level `betas:`; see `providerReadsBetas`. */
  workflowBetas: unknown;
  /** The install injects environment variables into provider subprocesses. */
  hasEnvVars: boolean;
}

/**
 * `webSearchMode:` is Codex's alone. No other provider reads it, and #2556 decided it
 * keeps no node-level form, so it is the one workflow-level field with no per-node
 * counterpart. There is deliberately no ProviderCapabilities axis for one provider's one
 * field.
 */
export function providerReadsWebSearchMode(provider: string): boolean {
  return provider === 'codex';
}

/**
 * `betas:` names Claude SDK beta features. Only the Claude provider reads it, and like
 * `webSearchMode:` it has no ProviderCapabilities axis.
 */
export function providerReadsBetas(provider: string): boolean {
  return provider === 'claude';
}

/** Field names as the author wrote them, in a stable order. Empty when all are honoured. */
export function unsupportedNodeFields(
  node: DagNode,
  provider: string,
  caps: ProviderCapabilities,
  scope: NodeCapabilityScope
): string[] {
  const checks: [field: string, cap: keyof ProviderCapabilities, isSet: boolean][] = [
    [
      'allowed_tools/denied_tools',
      'toolRestrictions',
      node.allowed_tools !== undefined || node.denied_tools !== undefined,
    ],
    ['hooks', 'hooks', node.hooks !== undefined],
    ['mcp', 'mcp', node.mcp !== undefined],
    ['skills', 'skills', node.skills !== undefined && node.skills.length > 0],
    ['agents', 'agents', node.agents !== undefined],
    ['effort', 'effortControl', scope.declaredEffort !== undefined],
    ['maxBudgetUsd', 'costControl', node.maxBudgetUsd !== undefined],
    [
      'fallbackModel',
      'fallbackModel',
      (node.fallbackModel ?? scope.workflowFallbackModel) !== undefined,
    ],
    ['sandbox', 'sandbox', (node.sandbox ?? scope.workflowSandbox) !== undefined],
    ['settingSources', 'settingSources', node.settingSources !== undefined],
    ['env', 'envInjection', scope.hasEnvVars],
  ];
  const unsupported = checks
    .filter(([, cap, isSet]) => isSet && !caps[cap])
    .map(([field]) => field);

  // No capability flag covers `webSearchMode:`, so the list above cannot see it. Reported
  // here so a workflow that declares it for a provider that cannot read it gets the same
  // loud mismatch as every other field.
  if (!providerReadsWebSearchMode(provider) && scope.webSearchMode !== undefined) {
    unsupported.push('webSearchMode');
  }
  if (!providerReadsBetas(provider) && (node.betas ?? scope.workflowBetas) !== undefined) {
    unsupported.push('betas');
  }
  return unsupported;
}
