/**
 * What every provider's tool-gate translation does the same way: ask the gate
 * so that anything but a well-formed `allow` is a denial, and word a denial for
 * the model. How a provider intercepts a tool call and hands the denial back is
 * its own (`<provider>/tool-gate.ts`).
 */
import type { createLogger } from '@archon/paths';
import type { ToolActionDecision, ToolActionRequest } from '../types';

export type ToolGate = (request: ToolActionRequest) => Promise<ToolActionDecision>;
export type ToolGateDenial = Extract<ToolActionDecision, { action: 'deny' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The denial a provider answers with when the gate itself could not be asked or understood. */
export function toolGateFailure(reason: string): ToolGateDenial {
  return {
    action: 'deny',
    needsApproval: false,
    reason,
    alternatives: [
      'Continue with work that does not need this tool call.',
      'Report the work as blocked.',
    ],
  };
}

/** The denial as the model reads it: the reason, then each alternative on its own line. */
export function formatToolGateDenial(denial: ToolGateDenial): string {
  const lines = [`Blocked by the tool gate: ${denial.reason}`];
  if (denial.alternatives.length > 0) {
    lines.push('Alternatives:', ...denial.alternatives.map(alternative => `- ${alternative}`));
  }
  return lines.join('\n');
}

/**
 * Ask the gate. Anything other than a well-formed `allow` is a denial: a
 * rejected promise and a malformed answer are gate failures, never permission.
 * Failures are logged as `<provider>.tool_gate_malformed` and
 * `<provider>.tool_gate_failed`.
 */
export async function askToolGate(
  toolGate: ToolGate,
  request: ToolActionRequest,
  log: Pick<ReturnType<typeof createLogger>, 'error'>,
  provider: string
): Promise<ToolActionDecision> {
  try {
    const decision: unknown = await toolGate(request);
    if (isRecord(decision)) {
      if (decision.action === 'allow') return { action: 'allow' };
      if (
        decision.action === 'deny' &&
        typeof decision.reason === 'string' &&
        Array.isArray(decision.alternatives)
      ) {
        return decision as ToolGateDenial;
      }
    }
    log.error(
      { toolName: request.toolName, kind: request.kind },
      `${provider}.tool_gate_malformed`
    );
    return toolGateFailure('The tool gate gave no usable answer, so this call was not allowed.');
  } catch (err) {
    // The request is not logged: its input can hold secrets.
    log.error(
      { err, toolName: request.toolName, kind: request.kind },
      `${provider}.tool_gate_failed`
    );
    return toolGateFailure('The tool gate failed, so this call was not allowed.');
  }
}
