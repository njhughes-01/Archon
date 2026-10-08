/**
 * Pi translation of the provider-neutral Tool Action Gate
 * (`AgentRequestOptions.toolGate`): each state-changing tool Archon hands to Pi
 * has its `execute` wrapped, so the gate is asked first and a refused call
 * never reaches the tool body.
 *
 * A denial is thrown, not returned: Pi's agent loop turns an `execute` that
 * throws into an error tool result carrying the message, the same path Pi's own
 * blocked tool calls take (pi-agent-core `agent-loop.js`, 0.87.1). The model
 * reads the reason and the alternatives as that tool's result.
 *
 * Limit: only tools Archon builds are wrapped. Tools registered by the user's
 * own Pi extensions are user-owned provider configuration, are loaded by Pi
 * itself, and run without the gate.
 *
 * This module imports types only from the Pi SDK, so the provider can import
 * it statically (see the lazy-load note in provider.ts).
 */
import { createLogger } from '@archon/paths';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';

import type { ToolActionKind, ToolActionRequest } from '../../types';
import { askToolGate, formatToolGateDenial, type ToolGate } from '../../shared/tool-gate';

/**
 * Pi's built-in tool names, taken from the SDK's own tool-call event union
 * because the package does not export its `ToolName` type. The union's
 * custom-tool member names its tool `string`; that one is dropped, which leaves
 * the literal names.
 */
type LiteralToolName<E> = E extends { toolName: infer N } ? (string extends N ? never : N) : never;
type PiBuiltinToolName = LiteralToolName<ToolCallEvent>;

/** The part of a Pi tool the gate needs: both `AgentTool` and `ToolDefinition` fit. */
interface GateablePiTool {
  name: string;
  execute: (toolCallId: string, params: never, ...rest: never[]) => Promise<unknown>;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi');
  return cachedLog;
}

/**
 * How the gate treats each Pi built-in. Keyed by Pi's whole vocabulary, so a
 * tool the SDK adds does not compile until it is classified here. `read_only`
 * tools are never put to the gate; every other tool is.
 */
const PI_TOOL_CLASSES: Record<PiBuiltinToolName, ToolActionKind | 'read_only'> = {
  read: 'read_only',
  bash: 'shell',
  powershell: 'shell',
  edit: 'file_write',
  write: 'file_write',
  grep: 'read_only',
  find: 'read_only',
  ls: 'read_only',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gatePiTool<T extends GateablePiTool>(
  tool: T,
  kind: ToolActionKind,
  toolGate: ToolGate,
  cwd: string
): T {
  const execute = async (
    toolCallId: string,
    params: unknown,
    ...rest: unknown[]
  ): Promise<unknown> => {
    const input = isRecord(params) ? params : {};
    const request: ToolActionRequest = {
      toolName: tool.name,
      kind,
      cwd,
      ...(kind === 'shell' && typeof input.command === 'string' ? { command: input.command } : {}),
      ...(kind === 'file_write' && typeof input.path === 'string' ? { paths: [input.path] } : {}),
      input,
      toolCallId,
    };
    const decision = await askToolGate(toolGate, request, getLog(), 'pi');
    if (decision.action === 'deny') throw new Error(formatToolGateDenial(decision));
    // Every argument Pi passed goes through unchanged, including the ones a
    // `ToolDefinition` takes beyond an `AgentTool` (the extension context).
    return tool.execute(toolCallId, params as never, ...(rest as never[]));
  };
  // The wrapper takes and returns exactly what `tool.execute` does; the type
  // system cannot see that through the rest parameters.
  return { ...tool, execute: execute as T['execute'] };
}

/**
 * Gate Pi's built-in tools. Read-only tools are returned as they are; every
 * other tool, including a name this table has never seen, is wrapped.
 */
export function gatePiBuiltinTools<T extends GateablePiTool>(
  tools: readonly T[],
  toolGate: ToolGate,
  cwd: string
): T[] {
  return tools.map(tool => {
    const kind = Object.hasOwn(PI_TOOL_CLASSES, tool.name)
      ? PI_TOOL_CLASSES[tool.name as PiBuiltinToolName]
      : 'other';
    return kind === 'read_only' ? tool : gatePiTool(tool, kind, toolGate, cwd);
  });
}

/**
 * Gate Archon's own in-process native tools. They are not Pi built-ins, so
 * their names are never looked up in the built-in table: every provider
 * reports them to the gate as `other`.
 */
export function gatePiNativeTools<T extends GateablePiTool>(
  tools: readonly T[],
  toolGate: ToolGate,
  cwd: string
): T[] {
  return tools.map(tool => gatePiTool(tool, 'other', toolGate, cwd));
}
