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
import { isAbsolute, join, normalize, resolve } from 'node:path';

import { createLogger } from '@archon/paths';
import type { SessionConfig } from '@github/copilot-sdk';

import type { ToolActionKind, ToolActionRequest } from '../../types';
import {
  askToolGate,
  formatToolGateDenial,
  readPatchTargets,
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

const PATCH_TOOL = 'apply_patch';

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

const withoutLeadingSeparators = (path: string): string => path.replace(/^[\\/]+/, '');

/** A path with `/` separators and neither a drive letter nor a leading separator. */
function rootlessPath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  return withoutLeadingSeparators(/^[a-zA-Z]:/.test(slashed) ? slashed.slice(2) : slashed);
}

/**
 * Where the runtime places an `apply_patch` path: a copy of the function every
 * hunk path goes through in the @github/copilot 1.0.61 bundle (app.js, called
 * with the session directory and the path the parser read). An absolute path
 * is taken normalised; a relative path that repeats the session directory, in
 * any letter case, is taken from that directory; any other is joined to it. A
 * leading `~` or `@` and a `file://` URL are ordinary names to it.
 */
function resolvePatchPath(cwd: string, path: string): string {
  const base = normalize(cwd);
  const given = normalize(path);
  if (isAbsolute(given)) return given;
  const baseKey = rootlessPath(base);
  const givenKey = rootlessPath(given);
  if (baseKey !== '' && givenKey !== '') {
    const lowerBase = baseKey.toLowerCase();
    const lowerGiven = givenKey.toLowerCase();
    if (
      lowerGiven.startsWith(lowerBase) &&
      (lowerGiven.length === lowerBase.length || lowerGiven[lowerBase.length] === '/')
    ) {
      const rest = withoutLeadingSeparators(givenKey.slice(baseKey.length));
      return rest === '' ? base : join(base, rest);
    }
  }
  return join(base, given);
}

/**
 * The files an `apply_patch` call would write, delete or move to, and whether
 * the patch has a header that could not be read. A call with no readable
 * target at all is unreadable too.
 *
 * The runtime reads the patch from `input`, then `patch`, when the arguments
 * are an object, and trims each path (1.0.61 bundle; its parser is the oracle
 * in tool-gate.test.ts). The CLI may be the user's own and newer, so a path
 * with space in front is named as written as well.
 */
function patchWriteTargets(
  input: Record<string, unknown>,
  cwd: string
): { paths: string[]; unreadable: boolean } {
  const text = [input.input, input.patch].find(
    (value): value is string => typeof value === 'string'
  );
  const { targets, unreadable } =
    text === undefined ? { targets: [], unreadable: true } : readPatchTargets(text);
  const paths = new Set<string>();
  for (const target of targets) {
    paths.add(resolvePatchPath(cwd, target.trimStart()));
    paths.add(resolvePatchPath(cwd, target));
  }
  return { paths: [...paths], unreadable: unreadable || paths.size === 0 };
}

/**
 * The file an editor tool (`create`, `edit`, `str_replace_editor`) would write.
 * The runtime takes an absolute path exactly as given and resolves any other
 * against the session directory with node's `resolve` (1.0.61 bundle, the
 * `str_replace_editor` callback all three tools go through): a leading `~` or
 * `@` and a `file://` URL are ordinary names to it.
 */
function editorWriteTarget(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
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
  let paths: string[] = [];
  let unreadablePatch = false;
  if (kind === 'file_write' && call.toolName === PATCH_TOOL) {
    const patch = patchWriteTargets(input, call.cwd);
    paths = patch.paths;
    unreadablePatch = patch.unreadable;
  } else if (kind === 'file_write' && typeof input.path === 'string') {
    paths = [editorWriteTarget(input.path, call.cwd)];
  }
  return {
    toolName: call.toolName,
    kind,
    cwd: call.cwd,
    ...(kind === 'shell' && shellText !== undefined ? { command: shellText } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(kind === 'network' && typeof input.url === 'string' ? { url: input.url } : {}),
    // The mark goes on a copy: the gate's rules refuse a patch that carries it.
    input: unreadablePatch ? { ...input, unreadablePatch: true } : input,
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
