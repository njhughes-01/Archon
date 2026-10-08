/**
 * Claude translation of the provider-neutral Tool Action Gate
 * (`AgentRequestOptions.toolGate`): a PreToolUse hook that asks the gate before
 * a state-changing tool runs and answers `deny` when the gate refuses.
 *
 * Why a hook and not `canUseTool`: the provider runs in `bypassPermissions`,
 * where the SDK never consults `canUseTool`, while PreToolUse hooks still fire.
 *
 * What the SDK guarantees, from its hooks reference (not from its typings, which
 * only describe the shapes): a `deny` from any PreToolUse hook outranks every
 * other hook's answer (`deny` > `defer` > `ask` > `allow`), its reason is shown
 * to the model, and a callback hook that outlives its timeout blocks the call.
 * The hook answers `deny` or nothing. It never answers `allow`, which would
 * skip permission rules the user configured, and never `ask`, which nobody can
 * answer in an unattended run.
 *
 * Limits: a hook from the user's own Claude settings files runs beside this one
 * and cannot be wrapped. Its `allow` cannot override a denial, but an
 * `updatedInput` it returns replaces the input this gate examined.
 */
import type {
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  Options,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@archon/paths';

import type { ToolActionDecision, ToolActionKind, ToolActionRequest } from '../types';
import type { ClaudeKnownToolName } from './capabilities';
import { ARCHON_TOOL_SERVER } from './native-tools';

type ToolGate = (request: ToolActionRequest) => Promise<ToolActionDecision>;
type ToolGateDenial = Extract<ToolActionDecision, { action: 'deny' }>;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
}

/**
 * How the gate treats each built-in. Keyed by the audited vocabulary, so a tool
 * added to that list does not compile until it is classified here. `read_only`
 * tools are never put to the gate; every other tool is.
 */
export const CLAUDE_TOOL_CLASSES: Record<ClaudeKnownToolName, ToolActionKind | 'read_only'> = {
  Agent: 'other',
  AskUserQuestion: 'other',
  Bash: 'shell',
  Edit: 'file_write',
  ExitPlanMode: 'other',
  Glob: 'read_only',
  Grep: 'read_only',
  ListMcpResourcesTool: 'read_only',
  NotebookEdit: 'file_write',
  PowerShell: 'shell',
  Read: 'read_only',
  ReadMcpResourceTool: 'read_only',
  Skill: 'other',
  SlashCommand: 'other',
  TaskCreate: 'other',
  TaskGet: 'read_only',
  TaskList: 'read_only',
  TaskStop: 'other',
  TaskUpdate: 'other',
  TodoWrite: 'other',
  WebFetch: 'network',
  WebSearch: 'network',
  Write: 'file_write',
};

const MCP_TOOL_PREFIX = 'mcp__';
const ARCHON_NATIVE_TOOL_PREFIX = `${MCP_TOOL_PREFIX}${ARCHON_TOOL_SERVER}__`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyClaudeTool(
  toolName: string,
  archonNativeTools: boolean
): ToolActionKind | 'read_only' {
  if (Object.hasOwn(CLAUDE_TOOL_CLASSES, toolName)) {
    return CLAUDE_TOOL_CLASSES[toolName as ClaudeKnownToolName];
  }
  if (toolName.startsWith(MCP_TOOL_PREFIX)) {
    // Archon's in-process native tools reach Claude through an SDK MCP server,
    // but they are not an external MCP server: every provider reports them as
    // `other`. The prefix means that only while this request registered them.
    return archonNativeTools && toolName.startsWith(ARCHON_NATIVE_TOOL_PREFIX) ? 'other' : 'mcp';
  }
  // A name this audit has never seen (a newer SDK, a plugin tool) is gated.
  return 'other';
}

/**
 * Describe a PreToolUse call in the gate's terms, or `undefined` for a
 * read-only tool, which the gate is never asked about.
 */
export function toClaudeToolAction(
  input: PreToolUseHookInput,
  archonNativeTools: boolean
): ToolActionRequest | undefined {
  const kind = classifyClaudeTool(input.tool_name, archonNativeTools);
  if (kind === 'read_only') return undefined;

  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  const writeTarget = toolInput.file_path ?? toolInput.notebook_path;
  return {
    toolName: input.tool_name,
    kind,
    cwd: input.cwd,
    ...(kind === 'shell' && typeof toolInput.command === 'string'
      ? { command: toolInput.command }
      : {}),
    ...(kind === 'file_write' && typeof writeTarget === 'string' ? { paths: [writeTarget] } : {}),
    ...(kind === 'network' && typeof toolInput.url === 'string' ? { url: toolInput.url } : {}),
    input: toolInput,
    toolCallId: input.tool_use_id,
    // `agent_id` is present only when the call comes from inside a subagent.
    ...(input.agent_id !== undefined ? { fromSubagent: true } : {}),
  };
}

function gateFailure(reason: string): ToolGateDenial {
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
 */
async function askToolGate(
  toolGate: ToolGate,
  request: ToolActionRequest
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
    getLog().error(
      { toolName: request.toolName, kind: request.kind },
      'claude.tool_gate_malformed'
    );
    return gateFailure('The tool gate gave no usable answer, so this call was not allowed.');
  } catch (err) {
    // The request is not logged: its input can hold secrets.
    getLog().error(
      { err, toolName: request.toolName, kind: request.kind },
      'claude.tool_gate_failed'
    );
    return gateFailure('The tool gate failed, so this call was not allowed.');
  }
}

function denyOutput(denial: ToolGateDenial): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: formatToolGateDenial(denial),
    },
  };
}

/** The input a hook's answer would swap in for the model's, when it carries one. */
function rewrittenInput(output: unknown): Record<string, unknown> | undefined {
  if (!isRecord(output) || !isRecord(output.hookSpecificOutput)) return undefined;
  const { updatedInput } = output.hookSpecificOutput;
  return isRecord(updatedInput) ? updatedInput : undefined;
}

/**
 * Add the gate to a query's hooks. Called last, after the capture hooks and the
 * node's own YAML hooks are in place, so it can see every PreToolUse hook Archon
 * registers.
 *
 * The gate is asked once per tool call, and every Archon-registered PreToolUse
 * hook that fires for a denied call answers `deny`. That makes the denial hold
 * without leaning on how the SDK ranks one hook's `allow` against another's
 * `deny`. A node hook that rewrites the input has the rewritten call put to the
 * gate as well, because that is the call that would run.
 */
export function withToolGateHooks(
  hooks: Options['hooks'],
  toolGate: ToolGate,
  archonNativeTools: boolean
): NonNullable<Options['hooks']> {
  const verdicts = new Map<string, Promise<ToolActionDecision>>();

  const verdictFor = (
    input: PreToolUseHookInput,
    signal: AbortSignal
  ): Promise<ToolActionDecision> => {
    const request = toClaudeToolAction(input, archonNativeTools);
    if (!request) return Promise.resolve({ action: 'allow' });
    if (signal.aborted) {
      return Promise.resolve(gateFailure('The run was cancelled before this call was checked.'));
    }
    const known = verdicts.get(input.tool_use_id);
    if (known) return known;
    const asked = askToolGate(toolGate, request);
    verdicts.set(input.tool_use_id, asked);
    return asked;
  };

  const gateHook: HookCallback = async (input, _toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const verdict = await verdictFor(input, signal);
    return verdict.action === 'deny' ? denyOutput(verdict) : { continue: true };
  };

  const guarded =
    (hook: HookCallback): HookCallback =>
    async (input, toolUseId, options) => {
      const output = await hook(input, toolUseId, options);
      if (input.hook_event_name !== 'PreToolUse') return output;

      const verdict = await verdictFor(input, options.signal);
      if (verdict.action === 'deny') return denyOutput(verdict);

      const rewritten = rewrittenInput(output);
      if (rewritten) {
        const request = toClaudeToolAction({ ...input, tool_input: rewritten }, archonNativeTools);
        const rewrittenVerdict = request
          ? await askToolGate(toolGate, request)
          : ({ action: 'allow' } as const);
        if (rewrittenVerdict.action === 'deny') return denyOutput(rewrittenVerdict);
      }
      return output;
    };

  const existing: HookCallbackMatcher[] = hooks?.PreToolUse ?? [];
  return {
    ...hooks,
    PreToolUse: [
      { hooks: [gateHook] },
      ...existing.map(matcher => ({ ...matcher, hooks: matcher.hooks.map(guarded) })),
    ],
  };
}
