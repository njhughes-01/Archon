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
import { resolve } from 'node:path';
import type { ToolActionDecision, ToolActionRequest } from '../types';
import { pathLikeInputTargets, readPatchTargets } from '../shared/tool-gate';

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

/** Codex applies nothing without this line, in an `apply_patch` call or piped in the shell. */
const PATCH_BEGIN = '*** Begin Patch';

/** The shell tool's own argument for the directory a command runs in. */
const SHELL_DIRECTORY_FIELDS = ['workdir', 'cwd'] as const;

/**
 * The files an `apply_patch` envelope would write, delete or move to, as
 * absolute paths, and whether it has a header that could not be read.
 *
 * Codex resolves a patch path against the working directory as it is written:
 * `~/x`, `@x` and `file:///x` name files under the working directory (CLI
 * 0.157.0 wrote `~/new.txt`, `@new.txt` and `file:/x/new.txt` there), and the
 * space between a marker and its path is part of the file name (it wrote
 * `   a.txt` for `*** Add File:    a.txt`). The CLI is the user's own and may
 * be newer than the one this was run against, so a path with such space is
 * named in both spellings.
 */
export function readApplyPatch(
  patch: string,
  cwd: string
): { paths: string[]; unreadable: boolean } {
  const { targets, unreadable } = readPatchTargets(patch);
  const paths = new Set<string>();
  for (const target of targets) {
    paths.add(resolve(cwd, target));
    paths.add(resolve(cwd, target.trimStart()));
  }
  return { paths: [...paths], unreadable };
}

/**
 * The directory a shell call runs in: the one the model set on the call, when
 * the payload carries it, resolved against the hook's own. `undefined` when the
 * field holds something that is not a directory name.
 *
 * A known limit: Codex's shell tool takes a `workdir` argument, so the model
 * can run a command somewhere else, and the hook is not told. In a real run
 * with CLI 0.159.3 a call that set `workdir` to `/` ran there, while the hook's
 * `tool_input` held only `command` and its `cwd` was the turn's directory. Such
 * a call is therefore judged against the turn's directory, not where it runs.
 * The fields are still read, so a CLI that starts sending one is honoured.
 */
function shellCallCwd(input: Record<string, unknown>, cwd: string): string | undefined {
  for (const field of SHELL_DIRECTORY_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    return typeof value === 'string' ? resolve(cwd, value) : undefined;
  }
  return cwd;
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
    const callCwd = shellCallCwd(input, cwd);
    if (callCwd === undefined) return { outcome: 'deny', category, reason: UNREADABLE_CALL };
    // Codex applies a patch piped to `apply_patch` in the shell itself, as a
    // file edit. Naming its targets lets the gate's path rules see them too.
    const patch = command.includes(PATCH_BEGIN)
      ? readApplyPatch(command, callCwd)
      : { paths: [], unreadable: false };
    // The gate's rules refuse the `unreadablePatch` mark on a file write only,
    // so a shell command whose patch could not be read is refused here: what
    // it would write is unknown.
    if (patch.unreadable) return { outcome: 'deny', category, reason: UNREADABLE_CALL };
    return {
      outcome: 'ask',
      category,
      request: {
        ...base,
        cwd: callCwd,
        kind: 'shell',
        command,
        ...(patch.paths.length > 0 ? { paths: patch.paths } : {}),
      },
    };
  }

  if (category === 'file_change') {
    const patch =
      typeof input.command === 'string'
        ? readApplyPatch(input.command, cwd)
        : { paths: [], unreadable: false };
    // A header that could not be read goes to the gate marked, with the
    // targets that could: the gate refuses the mark and records the refusal.
    if (patch.unreadable) {
      return {
        outcome: 'ask',
        category,
        request: {
          ...base,
          input: { ...input, unreadablePatch: true },
          kind: 'file_write',
          ...(patch.paths.length > 0 ? { paths: patch.paths } : {}),
        },
      };
    }
    // A patch with no target at all cannot be judged; asking the gate with an
    // empty path list would describe a write to nowhere.
    if (patch.paths.length === 0) return { outcome: 'deny', category, reason: UNREADABLE_CALL };
    return {
      outcome: 'ask',
      category,
      request: { ...base, kind: 'file_write', paths: patch.paths },
    };
  }

  if (category === 'mcp') return { outcome: 'ask', category, request: { ...base, kind: 'mcp' } };

  // A tool this table does not know may still name the file it writes.
  const paths = pathLikeInputTargets(input);
  return {
    outcome: 'ask',
    category,
    request: { ...base, kind: 'other', ...(paths.length > 0 ? { paths } : {}) },
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
