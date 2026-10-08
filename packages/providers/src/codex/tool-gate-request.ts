/**
 * Translation between Codex's PreToolUse hook payload and Archon's
 * provider-neutral tool gate request. Pure: no I/O, no logging.
 *
 * Verified against codex-cli 0.159.3 (its embedded `pre-tool-use.command.input`
 * schema and real runs): `tool_name` is `Bash` for every shell command,
 * `apply_patch` for every file edit, `mcp__<server>__<tool>` for MCP tools and
 * the function name for other local tools. Hosted tools (web search) never
 * reach a hook.
 */
import { isAbsolute, resolve } from 'node:path';
import type { ToolActionDecision, ToolActionRequest } from '../types';

/** The Codex stream item a hooked tool call shows up as; `other` has no item. */
export type CodexToolCategory = 'command' | 'file_change' | 'mcp' | 'other';

export type CodexHookTranslation =
  /** The call can change something: ask the gate. */
  | { outcome: 'ask'; category: CodexToolCategory; request: ToolActionRequest }
  /** A read-only tool: runs without asking. */
  | { outcome: 'allow'; category: CodexToolCategory }
  /** The call could not be read, so it cannot be judged: refuse it. */
  | { outcome: 'deny'; category: CodexToolCategory; reason: string };

const SHELL_TOOL = 'Bash';
const PATCH_TOOL = 'apply_patch';
const MCP_PREFIX = 'mcp__';

/**
 * Local Codex tools that change nothing outside the conversation. Everything
 * not named here and not matched above goes to the gate as `other`, so a tool
 * Codex adds later is judged rather than waved through.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['update_plan', 'view_image']);

const UNREADABLE_CALL =
  'Archon could not read this tool call, so it was not run. Do not retry it unchanged; report the work as blocked in your output.';

const FALLBACK_DENIAL = "Archon's tool gate denied this action.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function categoryOf(toolName: string): CodexToolCategory {
  if (toolName === SHELL_TOOL) return 'command';
  if (toolName === PATCH_TOOL) return 'file_change';
  if (toolName.startsWith(MCP_PREFIX)) return 'mcp';
  return 'other';
}

const PATCH_TARGET_HEADERS = [
  '*** Add File: ',
  '*** Update File: ',
  '*** Delete File: ',
  '*** Move to: ',
] as const;

/**
 * The files an `apply_patch` call would write, delete or move to, as absolute
 * paths. Header lines start in column 0; patch content is always prefixed with
 * `+`, `-` or a space, so content cannot pose as a header.
 */
export function parseApplyPatchTargets(patch: string, cwd: string): string[] {
  const targets = new Set<string>();
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const header = PATCH_TARGET_HEADERS.find(prefix => line.startsWith(prefix));
    if (header === undefined) continue;
    const target = line.slice(header.length).trim();
    if (target === '') continue;
    targets.add(isAbsolute(target) ? resolve(target) : resolve(cwd, target));
  }
  return [...targets];
}

/** Maps one PreToolUse hook payload to what the gate should be asked, if anything. */
export function translateCodexHookCall(payload: unknown): CodexHookTranslation {
  if (!isRecord(payload) || payload.hook_event_name !== 'PreToolUse') {
    return { outcome: 'deny', category: 'other', reason: UNREADABLE_CALL };
  }
  const toolName = payload.tool_name;
  if (typeof toolName !== 'string' || toolName === '') {
    return { outcome: 'deny', category: 'other', reason: UNREADABLE_CALL };
  }
  const category = categoryOf(toolName);
  const cwd = payload.cwd;
  if (typeof cwd !== 'string' || cwd === '') {
    return { outcome: 'deny', category, reason: UNREADABLE_CALL };
  }
  if (READ_ONLY_TOOLS.has(toolName)) return { outcome: 'allow', category };

  const toolInput = payload.tool_input;
  const input = isRecord(toolInput) ? toolInput : { value: toolInput };
  const base = {
    toolName,
    cwd,
    input,
    ...(typeof payload.tool_use_id === 'string' ? { toolCallId: payload.tool_use_id } : {}),
    // Codex sets agent_id only on calls made by a spawned sub-agent.
    ...(typeof payload.agent_id === 'string' ? { fromSubagent: true } : {}),
  };

  if (category === 'command') {
    const command = input.command;
    if (typeof command !== 'string' || command.trim() === '') {
      return { outcome: 'deny', category, reason: UNREADABLE_CALL };
    }
    // Codex applies a patch piped to `apply_patch` in the shell itself, as a
    // file edit. Naming its targets lets the gate's path rules see them too.
    const patchTargets = parseApplyPatchTargets(command, cwd);
    return {
      outcome: 'ask',
      category,
      request: {
        ...base,
        kind: 'shell',
        command,
        ...(patchTargets.length > 0 ? { paths: patchTargets } : {}),
      },
    };
  }

  if (category === 'file_change') {
    const patch = input.command;
    const paths = typeof patch === 'string' ? parseApplyPatchTargets(patch, cwd) : [];
    // A patch with no readable target cannot be judged; asking the gate with an
    // empty path list would describe a write to nowhere.
    if (paths.length === 0) return { outcome: 'deny', category, reason: UNREADABLE_CALL };
    return { outcome: 'ask', category, request: { ...base, kind: 'file_write', paths } };
  }

  return {
    outcome: 'ask',
    category,
    request: { ...base, kind: category === 'mcp' ? 'mcp' : 'other' },
  };
}

/**
 * The text Codex shows the model for a denied call. Never empty: Codex treats
 * a denial without a reason as a failed hook and runs the tool.
 */
export function describeDenialForModel(
  decision: Extract<ToolActionDecision, { action: 'deny' }>
): string {
  const reason = decision.reason.trim() === '' ? FALLBACK_DENIAL : decision.reason.trim();
  const alternatives = decision.alternatives.map(text => text.trim()).filter(text => text !== '');
  if (alternatives.length === 0) return reason;
  return `${reason}\nSafer alternatives:\n${alternatives.map(text => `- ${text}`).join('\n')}`;
}
