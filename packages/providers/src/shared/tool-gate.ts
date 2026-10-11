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

/** Space, control and format characters: none of them is part of a header's words. */
const PATCH_INVISIBLE_CHARACTERS = /[\s\p{Cc}\p{Cf}]/gu;

/**
 * A line that, with those characters taken out, reads as one of the file
 * headers or as the header that sends the patch to another environment, in any
 * letter case.
 */
const PATCH_HEADER_LIKE = /^\*{3}(?:addfile|updatefile|deletefile|moveto|environmentid)/i;

/**
 * Characters the two `apply_patch` parsers read differently around a header:
 * Copilot ends a line at a bare carriage return, which Codex drops; Codex
 * trims U+0085 where Copilot does not, and the reverse for U+FEFF.
 */
const PATCH_AMBIGUOUS_CHARACTERS = /[\r\u0085\u2028\u2029\uFEFF\0]/;

/**
 * Control and format characters inside a path. Codex CLI 0.157.0 drops a tab
 * and a carriage return from anywhere in a path, so `.\t./x` is written as
 * `../x`; Copilot keeps the tab. What other versions do with the rest of these
 * is not known, so none of them is read as part of a file name.
 */
const PATCH_PATH_UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

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
 * It errs toward naming too much, and toward `unreadable`. Inside an update
 * hunk a line that starts with a space is context to both parsers, but is read
 * here as a header when it looks like one, so a patch to a file that quotes
 * patch headers can name a target it does not write. A line that only
 * resembles a header (another letter case, other spacing, a character hidden
 * in the marker) is rejected by both parsers today and is not trusted to stay
 * rejected.
 */
export function readPatchTargets(patch: string): PatchReading {
  const targets = new Set<string>();
  let unreadable = false;
  for (const rawLine of patch.split('\n')) {
    if (!rawLine.includes('*')) continue;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.includes('***') && PATCH_AMBIGUOUS_CHARACTERS.test(line)) {
      unreadable = true;
      continue;
    }
    if (!PATCH_HEADER_LIKE.test(line.replace(PATCH_INVISIBLE_CHARACTERS, ''))) continue;
    const trimmed = line.trim();
    const header = PATCH_TARGET_HEADERS.find(prefix => trimmed.startsWith(prefix));
    const target = header === undefined ? undefined : trimmed.slice(header.length);
    if (target === undefined || PATCH_PATH_UNSAFE_CHARACTERS.test(target)) unreadable = true;
    else targets.add(target);
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
