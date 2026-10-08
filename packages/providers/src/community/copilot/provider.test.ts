/**
 * CopilotProvider end-to-end test with a fully mocked @github/copilot-sdk.
 *
 * Covers: streaming chunks flow through the async generator, resume
 * fallback on missing session, abort wiring, unsupported-option log-warn,
 * missing-model throw, terminal result chunk carries sessionId + tokens.
 *
 * Runs in its own bun test invocation — mocks @github/copilot-sdk and
 * @archon/paths process-wide.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionEvent } from '@github/copilot-sdk';

import { createMockLogger } from '../../test/mocks/logger';
import type { ToolActionDecision, ToolActionRequest } from '../../types';

// ─── Mocks ───────────────────────────────────────────────────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

// Minimal fake session. Records prompt, exposes the listener so tests can
// fire events synthetically, and resolves sendAndWait when `resolveSend()` is called.
interface FakeSession {
  sessionId: string;
  prompt?: string;
  sendTimeout?: number;
  aborted: boolean;
  disconnected: boolean;
  listener: ((event: SessionEvent) => void) | undefined;
  fire: (event: SessionEvent) => void;
  resolveSend: (result?: unknown) => void;
  rejectSend: (err: Error) => void;
}

function makeFakeSession(sessionId = 'sess-1'): FakeSession {
  let resolveSend: (v?: unknown) => void = () => undefined;
  let rejectSend: (e: Error) => void = () => undefined;
  const sendPromise = new Promise<unknown>((resolve, reject) => {
    resolveSend = resolve;
    rejectSend = reject;
  });
  const fake: FakeSession = {
    sessionId,
    prompt: undefined,
    aborted: false,
    disconnected: false,
    listener: undefined,
    fire(event) {
      if (this.listener) this.listener(event);
    },
    resolveSend(result) {
      resolveSend(result);
    },
    rejectSend(err) {
      rejectSend(err);
    },
  };
  // Attach the session-shape methods the provider/bridge call:
  const session = fake as FakeSession & {
    on: (h: (e: SessionEvent) => void) => () => void;
    sendAndWait: (opts: { prompt: string }, timeout?: number) => Promise<unknown>;
    disconnect: () => Promise<void>;
    abort: () => Promise<void>;
  };
  session.on = (handler): (() => void) => {
    fake.listener = handler;
    return () => {
      fake.listener = undefined;
    };
  };
  session.sendAndWait = async (opts, timeout): Promise<unknown> => {
    fake.prompt = opts.prompt;
    fake.sendTimeout = timeout;
    return sendPromise;
  };
  session.disconnect = async (): Promise<void> => {
    fake.disconnected = true;
  };
  session.abort = async (): Promise<void> => {
    fake.aborted = true;
  };
  return session as unknown as FakeSession;
}

// Test-controlled fake client. We rebuild it per test via reset().
let nextCreateSessionResult: FakeSession | Error;
let nextResumeSessionResult: FakeSession | Error;
const createSessionSpy = mock((_opts: unknown): Promise<FakeSession> => {
  if (nextCreateSessionResult instanceof Error) {
    return Promise.reject(nextCreateSessionResult);
  }
  return Promise.resolve(nextCreateSessionResult);
});
const resumeSessionSpy = mock((_id: string, _opts: unknown): Promise<FakeSession> => {
  if (nextResumeSessionResult instanceof Error) {
    return Promise.reject(nextResumeSessionResult);
  }
  return Promise.resolve(nextResumeSessionResult);
});

let lastClientOpts: Record<string, unknown> | undefined;
class FakeCopilotClient {
  createSession = createSessionSpy;
  resumeSession = resumeSessionSpy;
  constructor(opts: Record<string, unknown>) {
    lastClientOpts = opts;
  }
}

// Capture the onPermissionRequest passed into createSession.
const approveAllStub = mock(() => ({ kind: 'approved' }));

mock.module('@github/copilot-sdk', () => ({
  CopilotClient: FakeCopilotClient,
  approveAll: approveAllStub,
}));

// Provider imports AFTER mocks are installed.
import { CopilotProvider, resetCopilotSingleton } from './provider';
import { toCopilotToolAction } from './tool-gate';

function evt<T extends SessionEvent['type']>(type: T, data: unknown): SessionEvent {
  return {
    id: 'test',
    timestamp: new Date().toISOString(),
    parentId: null,
    type,
    data,
  } as unknown as SessionEvent;
}

// Drain an async generator (used when the producer feeds events async).
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe('CopilotProvider.getType / getCapabilities', () => {
  test('getType returns copilot', () => {
    expect(new CopilotProvider().getType()).toBe('copilot');
  });

  test('getCapabilities matches COPILOT_CAPABILITIES', () => {
    const c = new CopilotProvider().getCapabilities();
    expect(c.sessionResume).toBe(true);
    expect(c.effortControl).toBe(true);
    expect(c.mcp).toBe(true);
    expect(c.hooks).toBe(false);
  });
});

describe('CopilotProvider.sendQuery', () => {
  beforeEach(() => {
    resetCopilotSingleton();
    createSessionSpy.mockClear();
    resumeSessionSpy.mockClear();
    approveAllStub.mockClear();
    lastClientOpts = undefined;
  });

  test('defaults to model="auto" when none is configured', async () => {
    const session = makeFakeSession('sess-default-auto');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/tmp', undefined, { assistantConfig: {} });

    const firstNext = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.message_delta', { messageId: 'm', deltaContent: 'hi' }));
    session.resolveSend(undefined);
    await firstNext;
    await collect(gen);

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const opts = createSessionSpy.mock.calls[0]![0] as { model: string };
    expect(opts.model).toBe('auto');
  });

  // ─── restrictFileWrites: the provider-neutral "no file writes" intent ────

  async function sessionConfigFor(options: Parameters<CopilotProvider['sendQuery']>[3]): Promise<{
    onPermissionRequest: (request: { kind: string }, invocation: { sessionId: string }) => unknown;
    excludedTools?: string[];
  }> {
    const session = makeFakeSession('sess-restrict');
    nextCreateSessionResult = session;
    const gen = new CopilotProvider().sendQuery('hi', '/tmp', undefined, options);
    const firstNext = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.message_delta', { messageId: 'm', deltaContent: 'hi' }));
    session.resolveSend(undefined);
    await firstNext;
    await collect(gen);
    return createSessionSpy.mock.calls[0]![0] as Awaited<ReturnType<typeof sessionConfigFor>>;
  }

  test('restrictFileWrites rejects file-write permission requests', async () => {
    const config = await sessionConfigFor({ assistantConfig: {}, restrictFileWrites: true });

    const decision = config.onPermissionRequest({ kind: 'write' }, { sessionId: 's' }) as {
      kind: string;
      feedback?: string;
    };

    expect(decision.kind).toBe('reject');
    expect(decision.feedback).toContain('workflow');
    expect(approveAllStub).not.toHaveBeenCalled();
    // The refusal is the permission decision, not a guessed built-in tool name.
    expect(config.excludedTools).toBeUndefined();
  });

  test('restrictFileWrites still approves every other permission kind', async () => {
    const config = await sessionConfigFor({ assistantConfig: {}, restrictFileWrites: true });

    for (const kind of ['shell', 'read', 'mcp', 'url', 'custom-tool']) {
      expect(config.onPermissionRequest({ kind }, { sessionId: 's' })).toEqual({
        kind: 'approved',
      });
    }
    expect(approveAllStub).toHaveBeenCalledTimes(5);
  });

  test('without restrictFileWrites file writes are approved like everything else', async () => {
    const config = await sessionConfigFor({ assistantConfig: {} });

    expect(config.onPermissionRequest({ kind: 'write' }, { sessionId: 's' })).toEqual({
      kind: 'approved',
    });
  });

  // ─── toolGate: the provider-neutral Tool Action Gate ──────────────────
  // The fake runtime below does what the Copilot runtime does with a
  // preToolUse hook: a `deny` settles the call, anything else lets it run.

  type PreToolUseOutput = { permissionDecision?: string; permissionDecisionReason?: string } | void;
  interface GatedSessionConfig {
    hooks?: {
      onPreToolUse?: (
        input: Record<string, unknown>,
        invocation: { sessionId: string }
      ) => Promise<PreToolUseOutput>;
    };
    onPermissionRequest: (request: { kind: string }, invocation: { sessionId: string }) => unknown;
  }
  const gateDenial: ToolActionDecision = {
    action: 'deny',
    needsApproval: true,
    reason: 'It deletes every file under the home directory.',
    alternatives: [
      'Remove one named directory inside the repository.',
      'Report the work as blocked.',
    ],
    ruleId: 'recursive-rm',
  };
  type GateStub = (request: ToolActionRequest) => Promise<ToolActionDecision>;

  async function attemptTool(
    config: GatedSessionConfig,
    call: { toolName: string; toolArgs: unknown; sessionId?: string; workingDirectory?: string }
  ): Promise<{ output: PreToolUseOutput; toolBody: ReturnType<typeof mock> }> {
    const toolBody = mock(() => undefined);
    const output = await config.hooks?.onPreToolUse?.(
      {
        sessionId: call.sessionId ?? 'sess-restrict',
        timestamp: new Date(),
        workingDirectory: call.workingDirectory ?? '/workspace/repo',
        toolName: call.toolName,
        toolArgs: call.toolArgs,
      },
      { sessionId: 'sess-restrict' }
    );
    if (output?.permissionDecision !== 'deny') toolBody();
    return { output, toolBody };
  }

  const destructiveBash = { toolName: 'bash', toolArgs: JSON.stringify({ command: 'rm -rf ~' }) };

  test('declares the toolActionGate capability', () => {
    expect(new CopilotProvider().getCapabilities().toolActionGate).toBe(true);
  });

  test('toolGate: a denied call never runs and the model gets the reason and every alternative', async () => {
    const gate = mock<GateStub>(async () => gateDenial);
    const config = (await sessionConfigFor({
      assistantConfig: {},
      toolGate: gate,
    })) as GatedSessionConfig;

    const { output, toolBody } = await attemptTool(config, destructiveBash);

    expect(toolBody).not.toHaveBeenCalled();
    expect(output?.permissionDecision).toBe('deny');
    expect(output?.permissionDecisionReason).toContain(
      'It deletes every file under the home directory.'
    );
    expect(output?.permissionDecisionReason).toContain(
      'Remove one named directory inside the repository.'
    );
    expect(output?.permissionDecisionReason).toContain('Report the work as blocked.');
  });

  test('toolGate: an allowed call runs and the hook gives no decision of its own', async () => {
    const gate = mock<GateStub>(async () => ({ action: 'allow' }));
    const config = (await sessionConfigFor({
      assistantConfig: {},
      toolGate: gate,
    })) as GatedSessionConfig;

    const { output, toolBody } = await attemptTool(config, destructiveBash);

    expect(gate).toHaveBeenCalledTimes(1);
    expect(toolBody).toHaveBeenCalledTimes(1);
    // An `allow` would pre-approve the call and skip the permission handler.
    expect(output).toBeUndefined();
  });

  test('toolGate: read-only tools never reach the gate', async () => {
    const gate = mock<GateStub>(async () => gateDenial);
    const config = (await sessionConfigFor({
      assistantConfig: {},
      toolGate: gate,
    })) as GatedSessionConfig;

    for (const call of [
      { toolName: 'view', toolArgs: JSON.stringify({ path: '/workspace/repo/.env' }) },
      { toolName: 'grep', toolArgs: JSON.stringify({ pattern: 'x' }) },
      { toolName: 'glob', toolArgs: JSON.stringify({ pattern: '**/*' }) },
      { toolName: 'read_bash', toolArgs: JSON.stringify({ shellId: '1' }) },
      {
        toolName: 'str_replace_editor',
        toolArgs: JSON.stringify({ command: 'view', path: '/workspace/repo/a.ts' }),
      },
    ]) {
      const { toolBody } = await attemptTool(config, call);
      expect(toolBody).toHaveBeenCalledTimes(1);
    }
    expect(gate).not.toHaveBeenCalled();
  });

  test('toolGate: a gate that throws, or answers with neither allow nor deny, is a denial', async () => {
    for (const gate of [
      mock<GateStub>(async () => {
        throw new Error('classifier unreachable');
      }),
      mock<GateStub>(async () => ({ action: 'maybe' }) as never),
    ]) {
      createSessionSpy.mockClear();
      const config = (await sessionConfigFor({
        assistantConfig: {},
        toolGate: gate,
      })) as GatedSessionConfig;

      // The SDK treats a handler that throws as "no decision", so the handler
      // must come back with a denial instead of rejecting.
      const { output, toolBody } = await attemptTool(config, destructiveBash);

      expect(toolBody).not.toHaveBeenCalled();
      expect(output?.permissionDecision).toBe('deny');
      expect(output?.permissionDecisionReason).toContain('tool gate');
    }
  });

  test('toolGate: maps each tool to its kind, command, paths and url', async () => {
    const seen: ToolActionRequest[] = [];
    const gate = mock<GateStub>(async request => {
      seen.push(request);
      return { action: 'allow' };
    });
    const config = (await sessionConfigFor({
      assistantConfig: {},
      toolGate: gate,
    })) as GatedSessionConfig;
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export {};',
      '*** Update File: src/old.ts',
      '*** Move to: src/renamed.ts',
      '*** Delete File: ../outside.txt',
      '*** End Patch',
    ].join('\n');

    for (const call of [
      { toolName: 'bash', toolArgs: JSON.stringify({ command: 'git push', description: 'push' }) },
      // Already-parsed arguments are accepted too.
      { toolName: 'powershell', toolArgs: { command: 'Remove-Item x' } },
      { toolName: 'write_bash', toolArgs: JSON.stringify({ shellId: '1', input: 'y' }) },
      { toolName: 'create', toolArgs: JSON.stringify({ path: '/workspace/repo/a.ts' }) },
      { toolName: 'edit', toolArgs: JSON.stringify({ path: '/workspace/repo/b.ts' }) },
      {
        toolName: 'str_replace_editor',
        toolArgs: JSON.stringify({ command: 'insert', path: '/workspace/repo/c.ts' }),
      },
      // A grammar tool's arguments are raw text, not JSON.
      { toolName: 'apply_patch', toolArgs: patch },
      { toolName: 'web_fetch', toolArgs: JSON.stringify({ url: 'https://example.com/x' }) },
      { toolName: 'web_search', toolArgs: JSON.stringify({ query: 'archon' }) },
      { toolName: 'task', toolArgs: JSON.stringify({ prompt: 'do it' }) },
      { toolName: 'tool_from_a_newer_runtime', toolArgs: undefined },
      { toolName: 'constructor', toolArgs: '{}' },
    ]) {
      await attemptTool(config, call);
    }

    const cwd = '/workspace/repo';
    expect(seen).toEqual([
      {
        toolName: 'bash',
        kind: 'shell',
        cwd,
        command: 'git push',
        input: { command: 'git push', description: 'push' },
      },
      {
        toolName: 'powershell',
        kind: 'shell',
        cwd,
        command: 'Remove-Item x',
        input: { command: 'Remove-Item x' },
      },
      {
        toolName: 'write_bash',
        kind: 'shell',
        cwd,
        command: 'y',
        input: { shellId: '1', input: 'y' },
      },
      {
        toolName: 'create',
        kind: 'file_write',
        cwd,
        paths: ['/workspace/repo/a.ts'],
        input: { path: '/workspace/repo/a.ts' },
      },
      {
        toolName: 'edit',
        kind: 'file_write',
        cwd,
        paths: ['/workspace/repo/b.ts'],
        input: { path: '/workspace/repo/b.ts' },
      },
      {
        toolName: 'str_replace_editor',
        kind: 'file_write',
        cwd,
        paths: ['/workspace/repo/c.ts'],
        input: { command: 'insert', path: '/workspace/repo/c.ts' },
      },
      {
        toolName: 'apply_patch',
        kind: 'file_write',
        cwd,
        paths: ['src/new.ts', 'src/old.ts', 'src/renamed.ts', '../outside.txt'],
        input: { input: patch },
      },
      {
        toolName: 'web_fetch',
        kind: 'network',
        cwd,
        url: 'https://example.com/x',
        input: { url: 'https://example.com/x' },
      },
      { toolName: 'web_search', kind: 'network', cwd, input: { query: 'archon' } },
      { toolName: 'task', kind: 'other', cwd, input: { prompt: 'do it' } },
      // A name the audit has never seen is gated, never assumed read-only.
      { toolName: 'tool_from_a_newer_runtime', kind: 'other', cwd, input: {} },
      { toolName: 'constructor', kind: 'other', cwd, input: {} },
    ]);
  });

  test("toolGate: a configured MCP server's tool is reported as mcp", () => {
    const call = { toolArgs: '{}', cwd: '/workspace/repo', fromSubagent: false };

    expect(
      toCopilotToolAction({ ...call, toolName: 'github-create_issue' }, ['github'])?.kind
    ).toBe('mcp');
    expect(
      toCopilotToolAction({ ...call, toolName: 'github/create_issue' }, ['github'])?.kind
    ).toBe('mcp');
    // Without the server on this request the name says nothing about its origin.
    expect(toCopilotToolAction({ ...call, toolName: 'github-create_issue' }, [])?.kind).toBe(
      'other'
    );
  });

  test("toolGate: a sub-agent's tool call is gated and flagged", async () => {
    const seen: ToolActionRequest[] = [];
    const gate = mock<GateStub>(async request => {
      seen.push(request);
      return gateDenial;
    });
    const config = (await sessionConfigFor({
      assistantConfig: {},
      toolGate: gate,
    })) as GatedSessionConfig;

    const sub = await attemptTool(config, { ...destructiveBash, sessionId: 'sub-agent-session' });
    const main = await attemptTool(config, destructiveBash);

    expect(sub.toolBody).not.toHaveBeenCalled();
    expect(main.toolBody).not.toHaveBeenCalled();
    expect(seen.map(request => request.fromSubagent)).toEqual([true, undefined]);
  });

  test('toolGate works together with restrictFileWrites', async () => {
    const gate = mock<GateStub>(async () => ({ action: 'allow' }));
    const config = (await sessionConfigFor({
      assistantConfig: {},
      toolGate: gate,
      restrictFileWrites: true,
    })) as GatedSessionConfig;

    // The gate lets the edit through without pre-approving it, so the chat's
    // write rejection in the permission handler still refuses it.
    const { output } = await attemptTool(config, {
      toolName: 'edit',
      toolArgs: JSON.stringify({ path: '/workspace/repo/a.ts' }),
    });
    expect(output).toBeUndefined();
    expect(config.onPermissionRequest({ kind: 'write' }, { sessionId: 's' })).toMatchObject({
      kind: 'reject',
    });
    expect(config.onPermissionRequest({ kind: 'shell' }, { sessionId: 's' })).toEqual({
      kind: 'approved',
    });
  });

  test('without toolGate the session config carries no hooks', async () => {
    const config = (await sessionConfigFor({ assistantConfig: {} })) as GatedSessionConfig;

    expect('hooks' in config).toBe(false);
  });

  test('toolGate: a resumed session gets the hook too', async () => {
    const session = makeFakeSession('sess-resumed');
    nextResumeSessionResult = session;
    const gate = mock<GateStub>(async () => gateDenial);
    const gen = new CopilotProvider().sendQuery('hi', '/tmp', 'sess-resumed', {
      assistantConfig: {},
      toolGate: gate,
    });
    const firstNext = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.message_delta', { messageId: 'm', deltaContent: 'hi' }));
    session.resolveSend(undefined);
    await firstNext;
    await collect(gen);

    const config = resumeSessionSpy.mock.calls[0]![1] as GatedSessionConfig;
    const { toolBody } = await attemptTool(config, destructiveBash);
    expect(toolBody).not.toHaveBeenCalled();
  });

  test('passes model + streaming=true + workingDirectory to createSession', async () => {
    const session = makeFakeSession('sess-1');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hello', '/work/dir', undefined, { model: 'gpt-5' });

    // Drive: start iteration (kicks off createSession); fire a tiny stream
    // and resolve sendAndWait so the generator completes.
    const firstNext = gen.next();
    // Give the async chain a tick so createSession resolves.
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.message_delta', { messageId: 'm', deltaContent: 'hi' }));
    session.resolveSend(undefined);
    const chunks = [(await firstNext).value, ...(await collect(gen))];

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const opts = createSessionSpy.mock.calls[0]![0] as {
      model: string;
      streaming: boolean;
      workingDirectory: string;
    };
    expect(opts.model).toBe('gpt-5');
    expect(opts.streaming).toBe(true);
    expect(opts.workingDirectory).toBe('/work/dir');
    expect(session.prompt).toBe('hello');
    expect(chunks.some(c => c && typeof c === 'object' && 'type' in c && c.type === 'result')).toBe(
      true
    );
  });

  test('reasoningEffort from nodeConfig.effort passes through', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      nodeConfig: { effort: 'high' },
    });

    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    const opts = createSessionSpy.mock.calls[0]![0] as { reasoningEffort?: string };
    expect(opts.reasoningEffort).toBe('high');
  });

  test.each(['max', 'ultra', 'persistent'] as const)(
    'workflow `effort: %s` maps to SDK `xhigh`',
    async effort => {
      const session = makeFakeSession();
      nextCreateSessionResult = session;

      const p = new CopilotProvider();
      const gen = p.sendQuery('hi', '/w', undefined, {
        model: 'gpt-5',
        nodeConfig: { effort },
      });
      const first = gen.next();
      await new Promise(resolve => setTimeout(resolve, 5));
      session.resolveSend(undefined);
      await first;
      await collect(gen);

      const opts = createSessionSpy.mock.calls[0]![0] as { reasoningEffort?: string };
      expect(opts.reasoningEffort).toBe('xhigh');
    }
  );

  // #2556: `minimal` is a rung on Archon's shared ladder that Copilot's SDK
  // lacks, so it clamps to the SDK's shallowest — the same treatment `max`
  // already gets at the top end. Only a value that is not a rung at all is
  // dropped.
  test('effort: minimal clamps to the SDK shallowest rung', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      nodeConfig: { effort: 'minimal' },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    const opts = createSessionSpy.mock.calls[0]![0] as { reasoningEffort?: string };
    expect(opts.reasoningEffort).toBe('low');
  });

  test('systemPrompt wraps to systemMessage with append mode', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      systemPrompt: 'Be concise.',
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    const opts = createSessionSpy.mock.calls[0]![0] as {
      systemMessage?: { content: string; mode: string };
    };
    expect(opts.systemMessage).toEqual({ content: 'Be concise.', mode: 'append' });
  });

  test('resume failure falls back to createSession with warning chunk', async () => {
    const session = makeFakeSession('sess-new');
    nextResumeSessionResult = new Error('session not found');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', 'sess-missing', { model: 'gpt-5' });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    const chunks = [(await first).value, ...(await collect(gen))];

    expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const systemChunk = chunks.find(
      c => c && typeof c === 'object' && 'type' in c && c.type === 'system'
    ) as { content: string } | undefined;
    expect(systemChunk?.content).toContain('Could not resume');
  });

  test('forkSession=true with resumeSessionId creates fresh session (SDK has no fork)', async () => {
    const session = makeFakeSession('sess-fresh');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', 'sess-prior', {
      model: 'gpt-5',
      forkSession: true,
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    const chunks = [(await first).value, ...(await collect(gen))];

    // resumeSession MUST NOT be called — we fork to fresh instead.
    expect(resumeSessionSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const systemChunk = chunks.find(
      c => c && typeof c === 'object' && 'type' in c && c.type === 'system'
    ) as { content: string } | undefined;
    expect(systemChunk?.content).toContain('does not support session forking');
  });

  test('resumeSessionId without forkSession resumes in place (node-to-node continuation)', async () => {
    const session = makeFakeSession('sess-resumed');
    nextResumeSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', 'sess-prior', {
      model: 'gpt-5',
      forkSession: false,
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  test('sendAndWait receives explicit timeout > SDK default of 60s', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, { model: 'gpt-5' });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(session.sendTimeout).toBeDefined();
    expect(session.sendTimeout!).toBeGreaterThan(60_000);
  });

  test('terminal result chunk carries sessionId and tokens from usage event', async () => {
    const session = makeFakeSession('sess-42');
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, { model: 'gpt-5' });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.fire(evt('assistant.usage', { model: 'gpt-5', inputTokens: 10, outputTokens: 3 }));
    session.resolveSend(undefined);
    const chunks = [(await first).value, ...(await collect(gen))];

    const result = chunks.find(
      c => c && typeof c === 'object' && 'type' in c && c.type === 'result'
    ) as { sessionId?: string; tokens?: { input: number; output: number } } | undefined;
    expect(result?.sessionId).toBe('sess-42');
    expect(result?.tokens).toEqual({ input: 10, output: 3 });
  });

  test('abort signal triggers session.abort', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const ac = new AbortController();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      abortSignal: ac.signal,
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    ac.abort();
    // Give the abort listener a tick to run session.abort().
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(session.aborted).toBe(true);
  });

  test('session.disconnect is called in finally (even on success)', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, { model: 'gpt-5' });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(session.disconnected).toBe(true);
  });

  test('forkSession + persistSession boolean flags logged at debug (not thrown)', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      persistSession: false,
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    // No throw, and no warn-level log for persistSession — debug is fine.
    const warnCalls = mockLogger.warn.mock.calls;
    const sawUnsupported = warnCalls.some(args => args[1] === 'copilot.option_not_supported');
    expect(sawUnsupported).toBe(false);
  });

  test('GH_TOKEN is ignored by default (logged-in user wins)', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      env: { GH_TOKEN: 'ghp_testtoken' },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(lastClientOpts?.gitHubToken).toBeUndefined();
    expect(lastClientOpts?.useLoggedInUser).toBe(true);
    // copilot-sdk 1.0 rename guard: sessions must run in the request cwd via
    // `workingDirectory` (was `cwd` pre-1.0 — a silent revert would strand
    // sessions in the server's cwd).
    expect(lastClientOpts?.workingDirectory).toBe('/w');
    // Dev mode resolves no custom CLI binary → no stdio connection override
    // (the SDK uses its bundled runtime).
    expect(lastClientOpts?.connection).toBeUndefined();
  });

  test('configDir override → client baseDirectory (COPILOT_HOME), sdk-1.0 placement', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      assistantConfig: { configDir: '/custom/copilot-home' },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(lastClientOpts?.baseDirectory).toBe('/custom/copilot-home');
  });

  test('COPILOT_GITHUB_TOKEN is always used (intent signal)', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      env: { COPILOT_GITHUB_TOKEN: 'ghp_copilot' },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(lastClientOpts?.gitHubToken).toBe('ghp_copilot');
    expect(lastClientOpts?.useLoggedInUser).toBe(false);
  });

  test('useLoggedInUser:false opts into generic GH_TOKEN', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      env: { GH_TOKEN: 'ghp_testtoken' },
      assistantConfig: { useLoggedInUser: false },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(lastClientOpts?.gitHubToken).toBe('ghp_testtoken');
    expect(lastClientOpts?.useLoggedInUser).toBe(false);
  });

  test('assistantConfig.useLoggedInUser=true overrides env token', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, {
      model: 'gpt-5',
      env: { GH_TOKEN: 'ghp_testtoken' },
      assistantConfig: { useLoggedInUser: true },
    });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.resolveSend(undefined);
    await first;
    await collect(gen);

    expect(lastClientOpts?.gitHubToken).toBeUndefined();
    expect(lastClientOpts?.useLoggedInUser).toBe(true);
  });

  test('sendAndWait rejection propagates as thrown error', async () => {
    const session = makeFakeSession();
    nextCreateSessionResult = session;

    const p = new CopilotProvider();
    const gen = p.sendQuery('hi', '/w', undefined, { model: 'gpt-5' });
    const first = gen.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    session.rejectSend(new Error('kaboom'));

    await expect(
      (async () => {
        await first;
        for await (const _ of gen) {
          /* drain */
        }
      })()
    ).rejects.toThrow('kaboom');
  });
});
