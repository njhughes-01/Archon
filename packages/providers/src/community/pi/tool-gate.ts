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
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '@archon/paths';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';

import type { ToolActionKind, ToolActionRequest } from '../../types';
import {
  askToolGate,
  formatToolGateDenial,
  toolGateFailure,
  type ToolGate,
} from '../../shared/tool-gate';

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

/**
 * The file Pi's `write` and `edit` tools open for a path the model gave: a
 * copy of the SDK's `resolveToCwd` (pi-coding-agent 0.87.1,
 * `dist/core/tools/path-utils.js`, over `normalizePath` and `resolvePath` in
 * `dist/utils/paths.js`), which the package does not export. Those tools turn
 * `~/x` into a file under the home directory, drop a leading `@` and decode a
 * `file://` URL, so the text the model wrote is not the file that is written.
 * tool-gate.test.ts runs the SDK's real tools against this copy.
 *
 * Pi runs in this process, so `homedir()` here is the directory its tools see.
 */
const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Pi's `normalizeWindowsShellPath`: a Git Bash, MSYS, Cygwin or WSL drive path as Windows reads it. */
function piWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) {
    return filePath;
  }
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(filePath);
  if (!match) return filePath;
  const [, drive, rest] = match;
  return `${drive.toUpperCase()}:\\${rest?.replaceAll('/', '\\') ?? ''}`;
}

/**
 * Pi's `normalizePath`. `fromModel` is the pair of options its file tools set
 * for the model's path (`normalizeUnicodeSpaces`, `stripAtPrefix`); the base
 * directory goes through with neither.
 */
function piNormalizePath(input: string, fromModel: boolean): string {
  let normalized = input;
  if (fromModel) {
    normalized = normalized.replace(PI_UNICODE_SPACES, ' ');
    if (normalized.startsWith('@')) normalized = normalized.slice(1);
  }
  const onWindows = process.platform === 'win32';
  if (onWindows) normalized = piWindowsShellPath(normalized);
  if (normalized === '~') return homedir();
  if (normalized.startsWith('~/') || (onWindows && normalized.startsWith('~\\'))) {
    return join(homedir(), normalized.slice(2));
  }
  // Throws for a URL that names no local file; Pi's tool throws on it too.
  if (normalized.startsWith('file://')) return fileURLToPath(normalized);
  return normalized;
}

/**
 * The absolute file a `write` or `edit` call would open, or `undefined` when
 * Pi's own resolution throws. The call then fails inside the tool before it
 * writes anything, and the path goes to the gate as the model wrote it.
 */
function piWriteTarget(filePath: string, cwd: string): string | undefined {
  try {
    const normalized = piNormalizePath(filePath, true);
    const base = piNormalizePath(cwd, false);
    return isAbsolute(normalized) ? resolve(normalized) : resolve(base, normalized);
  } catch {
    return undefined;
  }
}

/** Where the context sits among the arguments Pi passes after `toolCallId` and `params`. */
const CONTEXT_ARGUMENT = 2;

/**
 * The directory a built-in tool works in. Pi's tools read it as
 * `ctx?.cwd || cwd`: the directory of the context Pi passes as the call's last
 * argument when there is one, else the directory the tool was built with.
 * `undefined` when the context names something that is not a directory name.
 */
function piToolCwd(context: unknown, builtCwd: string): string | undefined {
  const fromContext: unknown = isRecord(context) ? context.cwd : undefined;
  if (!fromContext) return builtCwd;
  return typeof fromContext === 'string' ? fromContext : undefined;
}

function gatePiTool<T extends GateablePiTool>(
  tool: T,
  kind: ToolActionKind,
  toolGate: ToolGate,
  builtCwd: string
): T {
  const execute = async (
    toolCallId: string,
    params: unknown,
    ...rest: unknown[]
  ): Promise<unknown> => {
    const cwd = piToolCwd(rest[CONTEXT_ARGUMENT], builtCwd);
    if (cwd === undefined) {
      getLog().error({ toolName: tool.name, kind }, 'pi.tool_gate_cwd_unreadable');
      throw new Error(
        formatToolGateDenial(
          toolGateFailure(
            'The directory this call would run in could not be read, so it was not allowed.'
          )
        )
      );
    }
    const input = isRecord(params) ? params : {};
    const writeTarget =
      kind === 'file_write' && typeof input.path === 'string'
        ? (piWriteTarget(input.path, cwd) ?? input.path)
        : undefined;
    const request: ToolActionRequest = {
      toolName: tool.name,
      kind,
      cwd,
      ...(kind === 'shell' && typeof input.command === 'string' ? { command: input.command } : {}),
      ...(writeTarget !== undefined ? { paths: [writeTarget] } : {}),
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
 * other tool, including a name this table has never seen, is wrapped. `cwd` is
 * the directory the tools were built with: a call is judged in the directory of
 * the context Pi passes with it, and in this one only when there is none.
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
