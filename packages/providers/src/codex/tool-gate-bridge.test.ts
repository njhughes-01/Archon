/**
 * The bridge and its hook program are tested for real: a real unix socket, and
 * the materialised hook run as a child process the way Codex runs it. Only the
 * Codex binary itself is replaced, by a script that records its arguments.
 */
import { describe, test, expect, mock, afterEach } from 'bun:test';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { removeTempTree } from '@archon/paths/test-utils';
import type { ToolActionDecision, ToolActionRequest } from '../types';
import {
  MIN_GATED_CODEX_VERSION,
  assertCodexSupportsToolGate,
  parseCodexVersion,
  resetCodexVersionCache,
} from './tool-gate-version';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { resolveSdkBundledCodexCommand } from './binary-resolver';
import {
  CODEX_HOOK_TRUST_BYPASS_FLAG,
  openCodexToolGateBridge,
  resolveGateTimeouts,
  type CodexToolGateBridge,
} from './tool-gate-bridge';

type Gate = (request: ToolActionRequest) => Promise<ToolActionDecision>;

const ALLOW: ToolActionDecision = { action: 'allow' };
const DENY: ToolActionDecision = {
  action: 'deny',
  needsApproval: true,
  reason: 'Deleting the repository needs approval.',
  alternatives: ['Delete only the build output', 'Report the work as blocked'],
};
const UNREACHABLE = /tool gate is unreachable/i;

const bridges: CodexToolGateBridge[] = [];
const tempRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'archon-codex-gate-test-'));
  tempRoots.push(root);
  return root;
}

async function openBridge(
  toolGate: Gate,
  overrides: Partial<Parameters<typeof openCodexToolGateBridge>[0]> = {}
): Promise<CodexToolGateBridge> {
  const bridge = await openCodexToolGateBridge({
    toolGate,
    codexCommand: ['/nonexistent/codex'],
    ...overrides,
  });
  bridges.push(bridge);
  return bridge;
}

interface HookHandler {
  type: string;
  command: string;
  timeout: number;
}

function hookHandler(bridge: CodexToolGateBridge): HookHandler {
  const hooks = bridge.configOverrides.hooks as unknown as {
    PreToolUse: { hooks: HookHandler[] }[];
  };
  return hooks.PreToolUse[0].hooks[0];
}

function bashPayload(command: string): Record<string, unknown> {
  return {
    session_id: 's',
    turn_id: 't',
    transcript_path: null,
    cwd: '/repo',
    hook_event_name: 'PreToolUse',
    model: 'gpt-test',
    permission_mode: 'bypassPermissions',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'call-1',
  };
}

interface HookRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the hook the way Codex does: the configured command string through a shell, payload on stdin. */
async function runHook(
  bridge: CodexToolGateBridge,
  stdin: string,
  options: { cwd?: string } = {}
): Promise<HookRun> {
  const child = Bun.spawn(['/bin/sh', '-c', hookHandler(bridge).command], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  child.stdin.write(stdin);
  await child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Replaces the bridge's listener with one the test controls, at the same socket path. */
async function replaceListener(
  bridge: CodexToolGateBridge,
  reply: (requestLine: string) => string | undefined
): Promise<void> {
  const socketPath = join(bridge.directory, 'gate.sock');
  rmSync(socketPath);
  const server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      const answer = reply(buffer.slice(0, end));
      if (answer !== undefined) socket.end(answer);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
}

describe('openCodexToolGateBridge', () => {
  test('keeps its files in a private directory and removes them on close', async () => {
    const bridge = await openBridge(mock<Gate>(() => Promise.resolve(ALLOW)));
    const directory = bridge.directory;

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'gate.sock')).isSocket()).toBe(true);
    expect(bridge.launcherPath.startsWith(directory)).toBe(true);

    await bridge.close();
    expect(existsSync(directory)).toBe(false);
    // Closing twice is safe: the provider closes in a finally that can follow an earlier close.
    await bridge.close();
  });

  test('installs one PreToolUse command hook for every tool, without the token in its text', async () => {
    const bridge = await openBridge(mock<Gate>(() => Promise.resolve(ALLOW)));
    const token = readFileSync(join(bridge.directory, 'token'), 'utf8').trim();

    const hooks = bridge.configOverrides.hooks as unknown as {
      PreToolUse: Record<string, unknown>[];
    };
    expect(hooks.PreToolUse).toHaveLength(1);
    // No matcher: Codex then runs the hook for every tool, so a tool this
    // provider has never heard of still reaches the gate.
    expect('matcher' in hooks.PreToolUse[0]).toBe(false);
    const handler = hookHandler(bridge);
    expect(handler.type).toBe('command');
    expect(handler.command.includes(bridge.directory)).toBe(true);
    // Config overrides travel on the Codex command line, which other local users can read.
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(bridge.configOverrides).includes(token)).toBe(false);
  });

  test('turns off TTY sessions, so a running command cannot be fed unhooked input', async () => {
    const bridge = await openBridge(mock<Gate>(() => Promise.resolve(ALLOW)));

    expect(bridge.configOverrides.features).toMatchObject({ unified_exec_tty: false });
  });

  test('forces Codex hooks on for the run, whatever the user configured', async () => {
    const bridge = await openBridge(mock<Gate>(() => Promise.resolve(ALLOW)));

    expect(bridge.configOverrides.features).toEqual({ unified_exec_tty: false, hooks: true });
  });

  test('gives Codex longer than the hook needs, and the hook longer than the gate', async () => {
    const timeouts = resolveGateTimeouts(20_000);
    const bridge = await openBridge(
      mock<Gate>(() => Promise.resolve(ALLOW)),
      {
        decisionTimeoutMs: 20_000,
      }
    );

    // A hook Codex times out counts as failed and the tool runs, so the hook
    // must always answer first.
    expect(timeouts.hookDeadlineMs).toBeGreaterThan(timeouts.decisionTimeoutMs);
    expect(timeouts.codexHookTimeoutSec * 1000).toBeGreaterThan(timeouts.hookDeadlineMs);
    expect(hookHandler(bridge).timeout).toBe(timeouts.codexHookTimeoutSec);
    expect(readFileSync(join(bridge.directory, 'hook'), 'utf8')).toContain(
      `'${String(timeouts.hookDeadlineMs)}'`
    );
  });
});

describe('the hook program', () => {
  test('allow: exits 0 and prints nothing', async () => {
    const gate = mock<Gate>(() => Promise.resolve(ALLOW));
    const bridge = await openBridge(gate);

    const run = await runHook(bridge, JSON.stringify(bashPayload('git status')));

    expect(run).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate.mock.calls[0][0]).toEqual({
      toolName: 'Bash',
      kind: 'shell',
      cwd: '/repo',
      command: 'git status',
      input: { command: 'git status' },
      toolCallId: 'call-1',
    });
  });

  test('deny: exits 2 with the reason and alternatives on stderr', async () => {
    const bridge = await openBridge(mock<Gate>(() => Promise.resolve(DENY)));

    const run = await runHook(bridge, JSON.stringify(bashPayload('rm -rf .')));

    // Exit 2 is Codex's blocking exit: it takes the reason from stderr and
    // ignores stdout, so noise a login shell prints cannot turn a denial into a pass.
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(
      'Deleting the repository needs approval.\nSafer alternatives:\n- Delete only the build output\n- Report the work as blocked\n'
    );
  });

  test('a gate that throws is a denial', async () => {
    const bridge = await openBridge(mock<Gate>(() => Promise.reject(new Error('classifier down'))));

    const run = await runHook(bridge, JSON.stringify(bashPayload('git push')));

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/could not decide/i);
    // The gate's own error text can hold command fragments; it is not shown to the model.
    expect(run.stderr.includes('classifier down')).toBe(false);
    // The failure is logged with the tool's name and kind, never its command.
    const logged = mockLogger.error.mock.calls.find(call => call[1] === 'codex.tool_gate_failed');
    expect(Object.keys(logged?.[0] as object).sort()).toEqual(['err', 'kind', 'toolName']);
  });

  test('a gate that returns something that is not a decision is a denial', async () => {
    const bridge = await openBridge(
      mock<Gate>(() => Promise.resolve({ action: 'maybe' } as unknown as ToolActionDecision))
    );

    const run = await runHook(bridge, JSON.stringify(bashPayload('git push')));

    expect(run.exitCode).toBe(2);
  });

  test('a gate that does not answer in time is a denial', async () => {
    const bridge = await openBridge(
      mock<Gate>(() => new Promise<ToolActionDecision>(() => undefined)),
      { decisionTimeoutMs: 50 }
    );

    const run = await runHook(bridge, JSON.stringify(bashPayload('git push')));

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/did not answer in time/i);
  });

  test('a read-only tool is allowed without asking the gate', async () => {
    const gate = mock<Gate>(() => Promise.resolve(DENY));
    const bridge = await openBridge(gate);

    const run = await runHook(
      bridge,
      JSON.stringify({ ...bashPayload('x'), tool_name: 'update_plan', tool_input: { plan: [] } })
    );

    expect(run.exitCode).toBe(0);
    expect(gate).not.toHaveBeenCalled();
  });

  test('an unreadable tool call is denied without asking the gate', async () => {
    const gate = mock<Gate>(() => Promise.resolve(ALLOW));
    const bridge = await openBridge(gate);

    const run = await runHook(
      bridge,
      JSON.stringify({ ...bashPayload('x'), tool_input: { command: 42 } })
    );

    expect(run.exitCode).toBe(2);
    expect(gate).not.toHaveBeenCalled();
  });

  test('input that is not JSON is denied', async () => {
    const gate = mock<Gate>(() => Promise.resolve(ALLOW));
    const bridge = await openBridge(gate);

    const run = await runHook(bridge, 'not json');

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(UNREACHABLE);
    expect(gate).not.toHaveBeenCalled();
  });

  test('channel absent: denies', async () => {
    const gate = mock<Gate>(() => Promise.resolve(ALLOW));
    const bridge = await openBridge(gate);
    rmSync(join(bridge.directory, 'gate.sock'));

    const run = await runHook(bridge, JSON.stringify(bashPayload('git status')));

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(UNREACHABLE);
    expect(gate).not.toHaveBeenCalled();
  });

  test('wrong token from the hook: the bridge does not answer, so the hook denies', async () => {
    const gate = mock<Gate>(() => Promise.resolve(ALLOW));
    const bridge = await openBridge(gate);
    writeFileSync(join(bridge.directory, 'token'), 'f'.repeat(64));

    const run = await runHook(bridge, JSON.stringify(bashPayload('git status')));

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(UNREACHABLE);
    expect(gate).not.toHaveBeenCalled();
    expect(bridge.allowedCallCounts().command).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith('codex.tool_gate_bad_token');
  });

  test('an answer without the token is not the gate: denies', async () => {
    const bridge = await openBridge(mock<Gate>(() => Promise.resolve(ALLOW)));
    await replaceListener(
      bridge,
      () => JSON.stringify({ token: 'guess', decision: 'allow' }) + '\n'
    );

    const run = await runHook(bridge, JSON.stringify(bashPayload('git status')));

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(UNREACHABLE);
  });

  test.each([
    ['not JSON', (): string => 'allow\n'],
    [
      'an unknown decision',
      (token: string): string => JSON.stringify({ token, decision: 'ok' }) + '\n',
    ],
    [
      'a denial with no reason',
      (token: string): string => JSON.stringify({ token, decision: 'deny', reason: '' }) + '\n',
    ],
    ['a closed connection', (): string => ''],
  ])('malformed answer (%s): denies', async (_label, answer) => {
    const bridge = await openBridge(mock<Gate>(() => Promise.resolve(ALLOW)));
    const token = readFileSync(join(bridge.directory, 'token'), 'utf8').trim();
    await replaceListener(bridge, () => answer(token));

    const run = await runHook(bridge, JSON.stringify(bashPayload('git status')));

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(UNREACHABLE);
  });

  test('no answer before the hook deadline: denies', async () => {
    const bridge = await openBridge(
      mock<Gate>(() => Promise.resolve(ALLOW)),
      {
        hookDeadlineMs: 200,
      }
    );
    await replaceListener(bridge, () => undefined);

    const run = await runHook(bridge, JSON.stringify(bashPayload('git status')));

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(UNREACHABLE);
  });

  test('a runtime that cannot start: the wrapper denies', async () => {
    const gate = mock<Gate>(() => Promise.resolve(ALLOW));
    const bridge = await openBridge(gate, { runtimePath: '/nonexistent/bun' });

    const run = await runHook(bridge, JSON.stringify(bashPayload('git status')));

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(UNREACHABLE);
    expect(gate).not.toHaveBeenCalled();
  });

  test('a hook that fails before reading still takes all of its input', async () => {
    // Codex writes the payload to the hook's stdin. A hook that exits first
    // breaks that pipe, and what Codex does with a hook it could not write to
    // is not something to depend on. Larger than a pipe buffer, so an unread
    // payload cannot be written at all.
    const bridge = await openBridge(
      mock<Gate>(() => Promise.resolve(ALLOW)),
      {
        runtimePath: '/nonexistent/bun',
      }
    );

    const run = await runHook(bridge, JSON.stringify(bashPayload('x'.repeat(1024 * 1024))));

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(UNREACHABLE);
  });

  test('a runtime that dies without deciding: the wrapper denies', async () => {
    const dir = await tempDir();
    const crashing = join(dir, 'crashing-runtime');
    await writeFile(crashing, '#!/bin/sh\nkill -9 $$\n');
    chmodSync(crashing, 0o755);

    const bridge = await openBridge(
      mock<Gate>(() => Promise.resolve(ALLOW)),
      {
        runtimePath: crashing,
      }
    );
    const run = await runHook(bridge, JSON.stringify(bashPayload('git status')));

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(UNREACHABLE);
  });

  test('does not load code from the directory the tool call runs in', async () => {
    // Codex runs hooks in the repository. Bun reads bunfig.toml from its working
    // directory, so a preload planted there by an allowed write would otherwise
    // run inside every later hook, next to the token.
    const repo = await tempDir();
    const marker = join(repo, 'preload-ran');
    await writeFile(
      join(repo, 'preload.ts'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`
    );
    await writeFile(join(repo, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
    const bridge = await openBridge(mock<Gate>(() => Promise.resolve(ALLOW)));

    const run = await runHook(bridge, JSON.stringify(bashPayload('git status')), { cwd: repo });

    expect(run.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test('counts the calls it lets through, by the kind of tool', async () => {
    const gate = mock<Gate>(request =>
      Promise.resolve(request.command === 'rm -rf .' ? DENY : ALLOW)
    );
    const bridge = await openBridge(gate);
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch';

    await runHook(bridge, JSON.stringify(bashPayload('ls')));
    await runHook(bridge, JSON.stringify(bashPayload('ls -la')));
    await runHook(bridge, JSON.stringify(bashPayload('rm -rf .')));
    await runHook(
      bridge,
      JSON.stringify({
        ...bashPayload('x'),
        tool_name: 'apply_patch',
        tool_input: { command: patch },
      })
    );
    await runHook(
      bridge,
      JSON.stringify({ ...bashPayload('x'), tool_name: 'mcp__fs__write', tool_input: { p: 1 } })
    );
    await runHook(
      bridge,
      JSON.stringify({ ...bashPayload('x'), tool_name: 'update_plan', tool_input: {} })
    );

    // A denied call is not counted: it leaves no tool item in Codex's stream,
    // so counting it would let a later, unasked tool call pass as covered.
    expect(bridge.allowedCallCounts()).toEqual({ command: 2, file_change: 1, mcp: 1, other: 1 });
  });

  test('answers concurrent calls independently', async () => {
    const gate = mock<Gate>(async request => {
      await new Promise(resolve => setTimeout(resolve, request.command === 'slow' ? 150 : 0));
      return request.command === 'slow' ? DENY : ALLOW;
    });
    const bridge = await openBridge(gate);

    const [slow, fast] = await Promise.all([
      runHook(bridge, JSON.stringify(bashPayload('slow'))),
      runHook(bridge, JSON.stringify(bashPayload('fast'))),
    ]);

    expect(slow.exitCode).toBe(2);
    expect(fast.exitCode).toBe(0);
  });

  test('a call still waiting when the bridge closes is denied', async () => {
    const gate = mock<Gate>(() => new Promise<ToolActionDecision>(() => undefined));
    const bridge = await openBridge(gate);
    const pending = runHook(bridge, JSON.stringify(bashPayload('git push')));
    while (gate.mock.calls.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    await bridge.close();

    const run = await pending;
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(UNREACHABLE);
  });
});

describe('resolveSdkBundledCodexCommand', () => {
  test('finds the Codex CLI entry the SDK depends on, to be run by this runtime', () => {
    const [runtime, entry, ...rest] = resolveSdkBundledCodexCommand();

    expect(rest).toEqual([]);
    expect(runtime).toBe(process.execPath);
    expect(entry.endsWith(join('@openai', 'codex', 'bin', 'codex.js'))).toBe(true);
    expect(existsSync(entry)).toBe(true);
  });
});

describe('the Codex version floor', () => {
  /** A stand-in Codex binary whose `--version` output and exit status the test sets. */
  async function versionedCodex(output: string, exitCode = 0): Promise<string[]> {
    const dir = await tempDir();
    const path = join(dir, 'codex');
    await writeFile(join(dir, 'version.txt'), output);
    await writeFile(
      path,
      [
        '#!/bin/sh',
        'here=$(dirname "$0")',
        'echo "$*" >> "$here/calls.txt"',
        'cat "$here/version.txt"',
        `exit ${String(exitCode)}`,
        '',
      ].join('\n')
    );
    chmodSync(path, 0o755);
    return [path];
  }

  test.each([
    ['codex-cli 0.159.3', [0, 159, 3]],
    ['codex-cli 0.157.0\n', [0, 157, 0]],
    ['codex-cli 1.2.10', [1, 2, 10]],
    ['codex-cli 0.160.0-alpha.3', [0, 160, 0]],
    ['codex-cli unknown', undefined],
    ['', undefined],
  ])('reads the version out of %j', (output, expected) => {
    expect(parseCodexVersion(output)).toEqual(expected as never);
  });

  test('the floor is the oldest version the gate was proven on', () => {
    expect(MIN_GATED_CODEX_VERSION).toEqual([0, 157, 0]);
  });

  test.each(['codex-cli 0.157.0', 'codex-cli 0.159.3', 'codex-cli 1.0.0'])(
    'accepts %s',
    async output => {
      resetCodexVersionCache();
      await expect(
        assertCodexSupportsToolGate(await versionedCodex(output))
      ).resolves.toBeUndefined();
    }
  );

  test.each(['codex-cli 0.156.9', 'codex-cli 0.99.99'])('refuses %s', async output => {
    resetCodexVersionCache();
    await expect(assertCodexSupportsToolGate(await versionedCodex(output))).rejects.toThrow(
      /needs Codex CLI 0\.157\.0 or newer/
    );
  });

  test('refuses a CLI whose version cannot be read', async () => {
    resetCodexVersionCache();
    await expect(
      assertCodexSupportsToolGate(await versionedCodex('something else entirely'))
    ).rejects.toThrow(/could not read/);
    await expect(
      assertCodexSupportsToolGate(await versionedCodex('codex-cli 0.159.3', 1))
    ).rejects.toThrow(/could not be read/);
    await expect(assertCodexSupportsToolGate(['/nonexistent/codex'])).rejects.toThrow(
      /could not be read/
    );
  });

  test('asks each binary once, and asks again after a failed read', async () => {
    resetCodexVersionCache();
    const good = await versionedCodex('codex-cli 0.159.3');
    await assertCodexSupportsToolGate(good);
    await assertCodexSupportsToolGate(good);
    expect(readFileSync(join(good[0], '..', 'calls.txt'), 'utf8')).toBe('--version\n');

    const broken = await versionedCodex('codex-cli 0.159.3', 1);
    await assertCodexSupportsToolGate(broken).catch(() => undefined);
    await assertCodexSupportsToolGate(broken).catch(() => undefined);
    expect(readFileSync(join(broken[0], '..', 'calls.txt'), 'utf8')).toBe('--version\n--version\n');
  });

  test('passes the launch command through, for a CLI started by a runtime', async () => {
    resetCodexVersionCache();
    const [script] = await versionedCodex('codex-cli 0.159.3');

    await assertCodexSupportsToolGate(['/bin/sh', script]);

    expect(readFileSync(join(script, '..', 'calls.txt'), 'utf8')).toBe('--version\n');
  });
});

describe('the Codex launcher', () => {
  /** A stand-in Codex binary that records its arguments, one per line. */
  async function fakeCodex(dirName = 'bin'): Promise<{ path: string; argsFile: string }> {
    const root = await tempDir();
    const dir = join(root, dirName);
    await mkdir(dir, { recursive: true });
    const argsFile = join(root, 'args.txt');
    const path = join(dir, 'codex');
    await writeFile(
      path,
      [
        '#!/bin/sh',
        `for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(argsFile)}; done`,
        'cat > /dev/null',
        `printf '%s\\n' '{"type":"thread.started","thread_id":"t-1"}'`,
        `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}'`,
        '',
      ].join('\n')
    );
    chmodSync(path, 0o755);
    return { path, argsFile };
  }

  async function launch(launcherPath: string, args: string[]): Promise<HookRun> {
    const child = Bun.spawn([launcherPath, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  test('the flag is the one Codex documents for running hooks without persisted trust', () => {
    expect(CODEX_HOOK_TRUST_BYPASS_FLAG).toBe('--dangerously-bypass-hook-trust');
  });

  test('runs the real binary with the trust flag right after the exec subcommand', async () => {
    const codex = await fakeCodex();
    const bridge = await openBridge(
      mock<Gate>(() => Promise.resolve(ALLOW)),
      {
        codexCommand: [codex.path],
      }
    );

    const run = await launch(bridge.launcherPath, [
      'exec',
      '--experimental-json',
      '--config',
      'a="b c"',
      'resume',
      'thread-9',
    ]);

    expect(run.exitCode).toBe(0);
    expect((await readFile(codex.argsFile, 'utf8')).trimEnd().split('\n')).toEqual([
      'exec',
      CODEX_HOOK_TRUST_BYPASS_FLAG,
      '--experimental-json',
      '--config',
      'a="b c"',
      'resume',
      'thread-9',
    ]);
  });

  test('passes a multi-part command and awkward paths through unchanged', async () => {
    const codex = await fakeCodex("we ird'dir");
    const bridge = await openBridge(
      mock<Gate>(() => Promise.resolve(ALLOW)),
      {
        codexCommand: ['/bin/sh', codex.path],
      }
    );

    const run = await launch(bridge.launcherPath, ['exec', '--model', 'm']);

    expect(run.exitCode).toBe(0);
    expect((await readFile(codex.argsFile, 'utf8')).trimEnd().split('\n')).toEqual([
      'exec',
      CODEX_HOOK_TRUST_BYPASS_FLAG,
      '--model',
      'm',
    ]);
  });

  test('refuses anything but the exec subcommand instead of passing it through ungated', async () => {
    const codex = await fakeCodex();
    const bridge = await openBridge(
      mock<Gate>(() => Promise.resolve(ALLOW)),
      {
        codexCommand: [codex.path],
      }
    );

    const run = await launch(bridge.launcherPath, ['app-server', '--listen']);

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/exec/);
    expect(existsSync(codex.argsFile)).toBe(false);
  });

  test('the real SDK, given the launcher and the hook config, produces the gated command line', async () => {
    const codex = await fakeCodex();
    const bridge = await openBridge(
      mock<Gate>(() => Promise.resolve(ALLOW)),
      {
        codexCommand: [codex.path],
      }
    );
    const client = new Codex({
      codexPathOverride: bridge.launcherPath,
      config: bridge.configOverrides,
    });

    const { events } = await client
      .startThread({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' })
      .runStreamed('hello');
    const types: string[] = [];
    for await (const event of events) types.push(event.type);

    expect(types).toEqual(['thread.started', 'turn.completed']);
    const args = (await readFile(codex.argsFile, 'utf8')).trimEnd().split('\n');
    const handler = hookHandler(bridge);
    expect(args.slice(0, 3)).toEqual(['exec', CODEX_HOOK_TRUST_BYPASS_FLAG, '--experimental-json']);
    // The exact text Codex parses as TOML: one hook group, no matcher, one command handler.
    expect(args).toContain(
      `hooks.PreToolUse=[{hooks = [{type = "command", command = ${JSON.stringify(handler.command)}, timeout = ${String(handler.timeout)}}]}]`
    );
    expect(args).toContain('features.unified_exec_tty=false');
    expect(args).toContain('features.hooks=true');
    expect(args).toContain('approval_policy="never"');
  });
});
