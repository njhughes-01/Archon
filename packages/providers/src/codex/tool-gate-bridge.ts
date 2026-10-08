/**
 * Per-run channel between Codex's PreToolUse hook and the provider's
 * `toolGate` callback.
 *
 * Codex has no in-process approval callback, so the gate is reached the way
 * Codex offers: a command hook it runs before each tool call. The hook is a
 * separate process; this module gives it a way back into the provider — a unix
 * socket in a directory only this user can enter — and writes the two small
 * programs the run needs (see tool-gate-hook.ts). Nothing is written to
 * `~/.codex`, and everything is removed when the run ends.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexOptions } from '@openai/codex-sdk';
import { createLogger } from '@archon/paths';
import type { ToolActionDecision, ToolActionRequest } from '../types';
import {
  renderCodexLauncher,
  renderHookProgram,
  renderHookWrapper,
  shellQuote,
} from './tool-gate-hook';
import {
  describeDenialForModel,
  translateCodexHookCall,
  type CodexHookTranslation,
  type CodexToolCategory,
} from './tool-gate-request';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex.tool-gate');
  return cachedLog;
}

type CodexConfigOverrides = NonNullable<CodexOptions['config']>;
type ToolGate = (request: ToolActionRequest) => Promise<ToolActionDecision>;

/**
 * `codex exec` runs a hook only once the user has reviewed and trusted it in
 * the interactive `/hooks` screen; an untrusted hook is skipped without an
 * error. This flag is Codex's documented way for automation that supplies its
 * own hook to run it for one invocation, with nothing persisted.
 */
export const CODEX_HOOK_TRUST_BYPASS_FLAG = '--dangerously-bypass-hook-trust';

/** How long the gate callback may take before the call is denied. */
export const DEFAULT_GATE_DECISION_TIMEOUT_MS = 60_000;

/** Room for a process to start and an answer to travel, on a loaded host. */
const TIMEOUT_MARGIN_MS = 15_000;

/** A unix socket path must fit `sun_path`: 104 bytes on macOS, 108 on Linux. */
const MAX_SOCKET_PATH_BYTES = 100;

/** Far above any real tool call; bounds what an unauthenticated peer can make the provider buffer. */
const MAX_REQUEST_CHARS = 32 * 1024 * 1024;

const GATE_FAILED_REASON =
  "Archon's tool gate could not decide on this action, so it was not run. Do not retry it; report the work as blocked in your output.";

const GATE_TIMED_OUT_REASON =
  "Archon's tool gate did not answer in time, so this action was not run. Do not retry it; report the work as blocked in your output.";

export interface GateTimeouts {
  decisionTimeoutMs: number;
  hookDeadlineMs: number;
  /** The `timeout` Codex is given for the hook, in seconds. */
  codexHookTimeoutSec: number;
}

/**
 * Three deadlines, each strictly inside the next: the gate callback, the hook
 * program, and Codex's own limit on the hook. Codex runs the tool when it
 * times a hook out, so the hook must always have answered — with a denial if
 * need be — before Codex gives up on it.
 */
export function resolveGateTimeouts(
  decisionTimeoutMs: number = DEFAULT_GATE_DECISION_TIMEOUT_MS,
  hookDeadlineMs: number = decisionTimeoutMs + TIMEOUT_MARGIN_MS
): GateTimeouts {
  return {
    decisionTimeoutMs,
    hookDeadlineMs,
    codexHookTimeoutSec: Math.ceil((hookDeadlineMs + TIMEOUT_MARGIN_MS) / 1000),
  };
}

export interface CodexToolGateBridgeOptions {
  toolGate: ToolGate;
  /** The real Codex command line prefix, e.g. `['/usr/local/bin/codex']`. */
  codexCommand: readonly string[];
  /** The JavaScript runtime that runs the hook. Defaults to the one running Archon. */
  runtimePath?: string;
  decisionTimeoutMs?: number;
  hookDeadlineMs?: number;
}

export interface CodexToolGateBridge {
  /** The run's private directory. */
  readonly directory: string;
  /** Pass as `codexPathOverride`: runs the real Codex with hooks enabled for this invocation. */
  readonly launcherPath: string;
  /** Merge into the run's Codex config: installs the hook and closes the ungated shell path. */
  readonly configOverrides: CodexConfigOverrides;
  /** Hook calls received so far that carried the run's token, by kind of tool. */
  hookCallCounts(): Readonly<Record<CodexToolCategory, number>>;
  /** Stops answering, denies calls still waiting, and removes the directory. Safe to call twice. */
  close(): Promise<void>;
}

type HookAnswer = { decision: 'allow' } | { decision: 'deny'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokensMatch(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isDecision(value: unknown): value is ToolActionDecision {
  if (!isRecord(value)) return false;
  if (value.action === 'allow') return true;
  return (
    value.action === 'deny' &&
    typeof value.reason === 'string' &&
    Array.isArray(value.alternatives) &&
    value.alternatives.every(item => typeof item === 'string')
  );
}

/** Asks the gate; anything but a well-formed decision in time is a denial. */
async function askGate(
  toolGate: ToolGate,
  request: ToolActionRequest,
  decisionTimeoutMs: number
): Promise<HookAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, decisionTimeoutMs);
  });
  try {
    const decision = await Promise.race([toolGate(request), timedOut]);
    if (decision === 'timeout') {
      getLog().error(
        { toolName: request.toolName, kind: request.kind, decisionTimeoutMs },
        'codex.tool_gate_timeout'
      );
      return { decision: 'deny', reason: GATE_TIMED_OUT_REASON };
    }
    if (!isDecision(decision)) {
      getLog().error(
        { toolName: request.toolName, kind: request.kind },
        'codex.tool_gate_invalid_decision'
      );
      return { decision: 'deny', reason: GATE_FAILED_REASON };
    }
    if (decision.action === 'allow') return { decision: 'allow' };
    return { decision: 'deny', reason: describeDenialForModel(decision) };
  } catch (error) {
    // A rejected gate is a gate failure, never permission (see `toolGate` in types.ts).
    getLog().error(
      { err: error, toolName: request.toolName, kind: request.kind },
      'codex.tool_gate_failed'
    );
    return { decision: 'deny', reason: GATE_FAILED_REASON };
  } finally {
    clearTimeout(timer);
  }
}

async function decide(
  translation: CodexHookTranslation,
  toolGate: ToolGate,
  decisionTimeoutMs: number
): Promise<HookAnswer> {
  if (translation.outcome === 'allow') return { decision: 'allow' };
  if (translation.outcome === 'deny') return { decision: 'deny', reason: translation.reason };
  const answer = await askGate(toolGate, translation.request, decisionTimeoutMs);
  getLog().debug(
    {
      toolName: translation.request.toolName,
      kind: translation.request.kind,
      decision: answer.decision,
    },
    'codex.tool_gate_decision'
  );
  return answer;
}

/**
 * Opens the channel for one gated request. The caller must `close()` it when
 * the request ends, however it ends.
 */
export async function openCodexToolGateBridge(
  options: CodexToolGateBridgeOptions
): Promise<CodexToolGateBridge> {
  const timeouts = resolveGateTimeouts(options.decisionTimeoutMs, options.hookDeadlineMs);
  const directory = await mkdtemp(join(tmpdir(), 'archon-codex-gate-'));
  const sockets = new Set<Socket>();
  const counts: Record<CodexToolCategory, number> = {
    command: 0,
    file_change: 0,
    mcp: 0,
    other: 0,
  };

  const token = randomBytes(32).toString('hex');

  async function answer(line: string): Promise<string | undefined> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      getLog().warn('codex.tool_gate_request_not_json');
      return undefined;
    }
    if (
      !isRecord(message) ||
      typeof message.token !== 'string' ||
      !tokensMatch(message.token, token)
    ) {
      // Not this run's hook. Saying nothing makes a real hook deny; replying
      // would hand the token to whoever asked.
      getLog().warn('codex.tool_gate_bad_token');
      return undefined;
    }
    const translation = translateCodexHookCall(message.payload);
    counts[translation.category] += 1;
    const verdict = await decide(translation, options.toolGate, timeouts.decisionTimeoutMs);
    return `${JSON.stringify({ token, ...verdict })}\n`;
  }

  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let received = false;
    socket.on('data', (chunk: string) => {
      if (received) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_CHARS) {
        received = true;
        getLog().warn('codex.tool_gate_request_too_large');
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      received = true;
      void answer(buffer.slice(0, end)).then(reply => {
        if (socket.destroyed) return;
        if (reply === undefined) socket.destroy();
        else socket.end(reply);
      });
    });
    // The hook process went away; there is nobody left to answer.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  // The channel must never be what keeps the Archon process alive.
  server.unref();

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    // A hook still waiting sees its connection drop and denies.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => {
      server.close(() => {
        resolve();
      });
    });
    await rm(directory, { recursive: true, force: true });
  }

  try {
    // mkdtemp already creates the directory 0700; stated here because the
    // token and socket rely on it.
    await chmod(directory, 0o700);
    const socketPath = join(directory, 'gate.sock');
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `Codex tool gate: the temporary directory path is too long for a unix socket (${socketPath}). Set TMPDIR to a shorter path.`
      );
    }
    await writeFile(join(directory, 'token'), `${token}\n`, { mode: 0o600 });

    const programPath = join(directory, 'hook.mjs');
    await writeFile(programPath, renderHookProgram(), { mode: 0o600 });
    const hookPath = join(directory, 'hook');
    await writeFile(
      hookPath,
      renderHookWrapper({
        directory,
        runtimePath: options.runtimePath ?? process.execPath,
        programPath,
        deadlineMs: timeouts.hookDeadlineMs,
      }),
      { mode: 0o700 }
    );
    const launcherPath = join(directory, 'codex');
    await writeFile(
      launcherPath,
      renderCodexLauncher({
        codexCommand: options.codexCommand,
        flag: CODEX_HOOK_TRUST_BYPASS_FLAG,
      }),
      { mode: 0o700 }
    );

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const configOverrides: CodexConfigOverrides = {
      hooks: {
        // No `matcher`: Codex then runs the hook before every tool, so which
        // tools need the gate is decided in one place (tool-gate-request.ts).
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                // Codex runs this through the user's shell (`$SHELL -lc`).
                command: shellQuote(hookPath),
                timeout: timeouts.codexHookTimeoutSec,
              },
            ],
          },
        ],
      },
      // Unified exec lets the model start a shell through one hooked call and
      // then feed it commands with `write_stdin`, which runs no hook. With it
      // off, every command is its own hooked call.
      features: { unified_exec: false },
    };

    return {
      directory,
      launcherPath,
      configOverrides,
      hookCallCounts: () => ({ ...counts }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
