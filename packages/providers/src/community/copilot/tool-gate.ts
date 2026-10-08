/**
 * Copilot translation of the provider-neutral Tool Action Gate
 * (`AgentRequestOptions.toolGate`): a `hooks.onPreToolUse` handler that asks
 * the gate before a state-changing tool runs and answers `deny` when the gate
 * refuses.
 *
 * Why the hook and not `onPermissionRequest`, which carries the runtime's own
 * parse of a shell command: a permission request is not guaranteed for every
 * call. The runtime's permission service applies approval rules of its own
 * first, among them approvals a user stored for a project location
 * (`tool_approvals` in the bundle), so a gate that lived in the handler could
 * be skipped. The hook runs for every tool call, including a sub-agent's.
 * Asking the gate from both seams would count one call twice, so only the hook
 * asks, and `parsedCommands` is not supplied.
 *
 * What is established, and from where (@github/copilot-sdk 1.0.1 and the
 * @github/copilot 1.0.61 runtime bundle it drives; not from a live run):
 * - `SessionConfigBase.hooks` owns the handler, for created and resumed
 *   sessions alike (typings).
 * - A `deny` settles the call before the tool executes and before any
 *   permission request: the model gets "Denied by preToolUse hook: <reason>"
 *   as the tool result (bundle, `PreToolUseHooksProcessor`).
 * - A hook `allow` marks the call pre-approved, which skips
 *   `onPermissionRequest` (bundle, `requestPermissionWithHooks`). The handler
 *   therefore answers `deny` or nothing, so the chat's file-write rejection in
 *   the permission handler keeps deciding every call the gate lets through.
 * - The SDK swallows a handler that throws and reports no decision
 *   (`session.js` `_handleHooksInvoke`), which the runtime reads as "go
 *   ahead". The handler below never throws: every failure is a `deny`.
 *
 * The SDK does not enumerate the runtime's built-in tools, so the names below
 * are hand-audited against the 1.0.61 bundle. A name that is not listed is
 * gated as `other`, never assumed read-only, so a renamed or new tool is still
 * asked about; refresh the table when bumping the SDK.
 *
 * This module imports types only from the SDK (see provider-lazy-load.test.ts).
 */
import { createLogger } from '@archon/paths';
import type { SessionConfig } from '@github/copilot-sdk';

import type { ToolActionKind, ToolActionRequest } from '../../types';
import {
  askToolGate,
  formatToolGateDenial,
  toolGateFailure,
  type ToolGate,
  type ToolGateDenial,
} from '../../shared/tool-gate';

// `SessionHooks` is declared by the SDK but not re-exported from its barrel.
type PreToolUseHandler = NonNullable<NonNullable<SessionConfig['hooks']>['onPreToolUse']>;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot');
  return cachedLog;
}

/** `read_only` tools are never put to the gate; every other tool is. */
const COPILOT_TOOL_CLASSES: Record<string, ToolActionKind | 'read_only'> = {
  bash: 'shell',
  powershell: 'shell',
  // Text typed into a shell the agent already started.
  write_bash: 'shell',
  write_powershell: 'shell',
  create: 'file_write',
  edit: 'file_write',
  str_replace_editor: 'file_write',
  apply_patch: 'file_write',
  web_fetch: 'network',
  web_search: 'network',
  view: 'read_only',
  grep: 'read_only',
  rg: 'read_only',
  glob: 'read_only',
  search: 'read_only',
  read_bash: 'read_only',
  read_powershell: 'read_only',
  list_bash: 'read_only',
  list_powershell: 'read_only',
};

/** `str_replace_editor` is one tool for reading and writing; this sub-command only reads. */
const EDITOR_VIEW_COMMAND = 'view';

/** The file headers of the `apply_patch` envelope, each followed by one path. */
const PATCH_FILE_HEADERS = [
  '*** Add File: ',
  '*** Update File: ',
  '*** Delete File: ',
  '*** Move to: ',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The runtime hands over a function tool's arguments as the model's JSON text
 * and a grammar tool's (apply_patch) as raw text. Both become a record; text
 * that is not a JSON object is kept whole under `input`.
 */
function toInputRecord(toolArgs: unknown): Record<string, unknown> {
  if (isRecord(toolArgs)) return toolArgs;
  if (typeof toolArgs !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(toolArgs);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Not JSON: a raw patch or other free-form tool input.
  }
  return { input: toolArgs };
}

function patchTargets(input: Record<string, unknown>): string[] {
  const text = [input.input, input.patch].find(
    (value): value is string => typeof value === 'string'
  );
  if (text === undefined) return [];
  const targets = new Set<string>();
  for (const line of text.split('\n')) {
    const header = PATCH_FILE_HEADERS.find(prefix => line.startsWith(prefix));
    if (header) targets.add(line.slice(header.length).trim());
  }
  return [...targets];
}

function writeTargets(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === 'apply_patch') return patchTargets(input);
  return typeof input.path === 'string' ? [input.path] : [];
}

/** The name the model sees for an MCP server's tools starts with the server's name. */
function isToolOfServer(toolName: string, serverName: string): boolean {
  const sanitized = serverName.replace(/[^a-zA-Z0-9_-]/g, '-');
  return toolName.startsWith(`${sanitized}-`) || toolName.startsWith(`${serverName}/`);
}

/**
 * Describe a tool call in the gate's terms, or `undefined` for a read-only
 * tool, which the gate is never asked about. `mcpServerNames` are the servers
 * this request configured; a tool of a server Copilot discovered on its own is
 * not recognisable by name and is reported as `other`.
 */
export function toCopilotToolAction(
  call: { toolName: string; toolArgs: unknown; cwd: string; fromSubagent: boolean },
  mcpServerNames: readonly string[]
): ToolActionRequest | undefined {
  const input = toInputRecord(call.toolArgs);
  const listed = Object.hasOwn(COPILOT_TOOL_CLASSES, call.toolName)
    ? COPILOT_TOOL_CLASSES[call.toolName]
    : undefined;
  const kind =
    listed ?? (mcpServerNames.some(name => isToolOfServer(call.toolName, name)) ? 'mcp' : 'other');
  if (kind === 'read_only') return undefined;
  if (call.toolName === 'str_replace_editor' && input.command === EDITOR_VIEW_COMMAND) {
    return undefined;
  }

  const shellText = [input.command, input.input].find(
    (value): value is string => typeof value === 'string'
  );
  const paths = kind === 'file_write' ? writeTargets(call.toolName, input) : [];
  return {
    toolName: call.toolName,
    kind,
    cwd: call.cwd,
    ...(kind === 'shell' && shellText !== undefined ? { command: shellText } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(kind === 'network' && typeof input.url === 'string' ? { url: input.url } : {}),
    input,
    ...(call.fromSubagent ? { fromSubagent: true } : {}),
  };
}

/**
 * Build the `onPreToolUse` handler for one request. `requestCwd` is used only
 * when the runtime's hook input carries no working directory.
 */
export function buildToolGateHook(
  toolGate: ToolGate,
  requestCwd: string,
  mcpServerNames: readonly string[]
): PreToolUseHandler {
  return async (input, invocation) => {
    let denial: ToolGateDenial | undefined;
    try {
      const request = toCopilotToolAction(
        {
          toolName: input.toolName,
          toolArgs: input.toolArgs,
          cwd: typeof input.workingDirectory === 'string' ? input.workingDirectory : requestCwd,
          // A sub-agent's hook reports its own runtime session, not the one
          // this handler was registered on.
          fromSubagent: input.sessionId !== invocation.sessionId,
        },
        mcpServerNames
      );
      if (!request) return undefined;
      const decision = await askToolGate(toolGate, request, getLog(), 'copilot');
      if (decision.action === 'allow') return undefined;
      denial = decision;
    } catch (err) {
      getLog().error({ err }, 'copilot.tool_gate_hook_failed');
      denial = toolGateFailure('The tool gate failed, so this call was not allowed.');
    }
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: formatToolGateDenial(denial),
    };
  };
}
