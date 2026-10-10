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

/** Input fields in which a tool commonly names the one file it writes. */
const PATH_FIELDS = [
  'file_path',
  'path',
  'filePath',
  'filename',
  'notebook_path',
  'target_file',
  'destination',
] as const;

/** Input fields in which a tool commonly lists several files. */
const PATH_LIST_FIELDS = ['paths', 'files'] as const;

/**
 * The files a tool outside a provider's audited table may write, read from the
 * fields such tools commonly use. A provider reports that tool as `other` and
 * hands these over as `paths`, so the gate judges them as write targets
 * instead of seeing a call with no target at all. The values are the tool's
 * own text: how an unknown tool resolves a path is not known.
 */
export function pathLikeInputTargets(input: Record<string, unknown>): string[] {
  const targets = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value !== '') targets.add(value);
  };
  for (const field of PATH_FIELDS) add(input[field]);
  for (const field of PATH_LIST_FIELDS) {
    const list = input[field];
    if (Array.isArray(list)) list.forEach(add);
  }
  return [...targets];
}

/** The `apply_patch` headers that name a file the patch writes, deletes or moves to. */
const PATCH_TARGET_HEADERS = [
  '*** Add File: ',
  '*** Update File: ',
  '*** Delete File: ',
  '*** Move to: ',
] as const;

/**
 * A line that reads as one of those headers, or as the header that sends the
 * patch to another environment, in any letter case or spacing.
 */
const PATCH_HEADER_LIKE = /^\*{3}\s*(?:add file|update file|delete file|move to|environment id)\b/i;

/**
 * Characters the two `apply_patch` parsers read differently: one ends a line
 * at a bare carriage return and the other keeps it inside a path; one trims
 * U+0085 and the other U+FEFF.
 */
const PATCH_AMBIGUOUS_CHARACTERS = /[\r\u0085\u2028\u2029\uFEFF\0]/;

export interface PatchReading {
  /**
   * The text after each file header, in patch order, each once. The line's
   * trailing space is gone; space between the marker and the path is kept,
   * because the parsers differ on whether it belongs to the file name.
   */
  targets: string[];
  /**
   * The patch has a line that reads as a file header but could not be turned
   * into a path. The targets are then not the whole truth: a provider marks the
   * request `unreadablePatch` so the gate refuses it.
   */
  unreadable: boolean;
}

/**
 * The files an `apply_patch` envelope names. Mirrors what the tools' own
 * parsers accept, settled by running patches through them (Codex CLI 0.157.0's
 * `apply_patch`, and the `patchParse` of the @github/copilot 1.0.61 runtime,
 * which community/copilot/tool-gate.test.ts runs as an oracle): a header line
 * is trimmed before it is matched, so indentation does not hide one; markers
 * are matched in exact letter case and need the space before the path; `\r\n`
 * ends a line.
 *
 * It errs toward naming too much. Inside an update hunk a line that starts
 * with a space is context to both parsers, but is read here as a header when
 * it looks like one, so a patch to a file that quotes patch headers can name
 * a target it does not write.
 */
export function readPatchTargets(patch: string): PatchReading {
  const targets = new Set<string>();
  let unreadable = false;
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.includes('***') && PATCH_AMBIGUOUS_CHARACTERS.test(line)) {
      unreadable = true;
      continue;
    }
    const trimmed = line.trim();
    const header = PATCH_TARGET_HEADERS.find(prefix => trimmed.startsWith(prefix));
    if (header !== undefined) targets.add(trimmed.slice(header.length));
    else if (PATCH_HEADER_LIKE.test(trimmed)) unreadable = true;
  }
  return { targets: [...targets], unreadable };
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
