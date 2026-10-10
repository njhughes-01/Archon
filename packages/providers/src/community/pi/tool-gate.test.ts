/**
 * The gate must judge the file Pi's own tool will write. The path cases below
 * run Pi's real `write` and `edit` tools (with their filesystem operations
 * replaced by recorders) behind the gate, and compare the path the gate was
 * asked about with the path the tool then wrote: the copy of Pi's path
 * resolution in tool-gate.ts is held to the SDK's own.
 */
import { describe, expect, mock, test } from 'bun:test';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEditTool, createWriteTool } from '@earendil-works/pi-coding-agent';

import type { ToolActionDecision, ToolActionRequest } from '../../types';
import { gatePiBuiltinTools, gatePiNativeTools } from './tool-gate';

const BUILD_CWD = resolve('/workspace/repo');
const ON_WINDOWS = process.platform === 'win32';

/** Pi calls a tool with more arguments than `AgentTool` declares: the last is its context. */
type PiExecute = (
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown
) => Promise<unknown>;

type Gate = (request: ToolActionRequest) => Promise<ToolActionDecision>;

function recordingGate(seen: ToolActionRequest[]): Gate {
  return async request => {
    seen.push(request);
    return { action: 'allow' };
  };
}

interface GatedRun {
  /** What the gate was asked, if it was asked. */
  judged: ToolActionRequest | undefined;
  /** Every path the tool's own filesystem operations were given. */
  touched: string[];
  error: unknown;
}

async function writeThroughGate(path: unknown, ctx?: unknown): Promise<GatedRun> {
  const touched: string[] = [];
  const tool = createWriteTool(BUILD_CWD, {
    operations: {
      writeFile: async absolutePath => {
        touched.push(absolutePath);
      },
      mkdir: async () => undefined,
    },
  });
  const seen: ToolActionRequest[] = [];
  const [gated] = gatePiBuiltinTools([tool], recordingGate(seen), BUILD_CWD);
  let error: unknown;
  try {
    await (gated.execute as PiExecute)('call-1', { path, content: 'x' }, undefined, undefined, ctx);
  } catch (err) {
    error = err;
  }
  return { judged: seen[0], touched, error };
}

async function editThroughGate(path: string, ctx?: unknown): Promise<GatedRun> {
  const touched: string[] = [];
  const tool = createEditTool(BUILD_CWD, {
    operations: {
      access: async absolutePath => {
        touched.push(absolutePath);
      },
      readFile: async () => Buffer.from('old\n'),
      writeFile: async absolutePath => {
        touched.push(absolutePath);
      },
    },
  });
  const seen: ToolActionRequest[] = [];
  const [gated] = gatePiBuiltinTools([tool], recordingGate(seen), BUILD_CWD);
  let error: unknown;
  try {
    await (gated.execute as PiExecute)(
      'call-1',
      { path, edits: [{ oldText: 'old', newText: 'new' }] },
      undefined,
      undefined,
      ctx
    );
  } catch (err) {
    error = err;
  }
  return { judged: seen[0], touched, error };
}

/** [what the model wrote, the file Pi 0.87.1 writes for it] */
const PATH_CASES: [string, string][] = [
  ['a.txt', join(BUILD_CWD, 'a.txt')],
  ['src/../a.txt', join(BUILD_CWD, 'a.txt')],
  ['../outside.txt', resolve(BUILD_CWD, '../outside.txt')],
  ['/abs/elsewhere/a.txt', resolve('/abs/elsewhere/a.txt')],
  // A leading `~` is the home directory, alone or before a slash only.
  ['~', homedir()],
  ['~/.bashrc', join(homedir(), '.bashrc')],
  ['~/a/../b.txt', join(homedir(), 'b.txt')],
  ['~user/x.txt', join(BUILD_CWD, '~user/x.txt')],
  ['a/~/x.txt', join(BUILD_CWD, 'a/~/x.txt')],
  // One leading `@` is dropped before anything else is read.
  ['@a.txt', join(BUILD_CWD, 'a.txt')],
  ['@/abs/outside.txt', resolve('/abs/outside.txt')],
  ['@~/.bashrc', join(homedir(), '.bashrc')],
  ['@@scope/x.txt', join(BUILD_CWD, '@scope/x.txt')],
  ['src/@types/x.d.ts', join(BUILD_CWD, 'src/@types/x.d.ts')],
  // A `file://` URL is decoded to the path it names.
  [pathToFileURL(resolve('/abs/outside.txt')).href, resolve('/abs/outside.txt')],
  [pathToFileURL(resolve('/abs/with space.txt')).href, resolve('/abs/with space.txt')],
  [`@${pathToFileURL(resolve('/abs/outside.txt')).href}`, resolve('/abs/outside.txt')],
  ['docs/file://x.txt', join(BUILD_CWD, 'docs/file:/x.txt')],
  // Git Bash, WSL and Cygwin drive paths are Windows paths on Windows only.
  ['/c/repo/a.txt', ON_WINDOWS ? 'C:\\repo\\a.txt' : resolve('/c/repo/a.txt')],
  ['/mnt/d/x.txt', ON_WINDOWS ? 'D:\\x.txt' : resolve('/mnt/d/x.txt')],
  ['/cygdrive/e/dir/y.txt', ON_WINDOWS ? 'E:\\dir\\y.txt' : resolve('/cygdrive/e/dir/y.txt')],
  ['~\\x.txt', ON_WINDOWS ? join(homedir(), 'x.txt') : join(BUILD_CWD, '~\\x.txt')],
  // Unicode spaces become plain ones, before `@` and `~` are looked for.
  ['docs/a\u00A0b.md', join(BUILD_CWD, 'docs/a b.md')],
  ['~/a\u202Fb.md', join(homedir(), 'a b.md')],
  ['\u00A0~/x.txt', join(BUILD_CWD, ' ~/x.txt')],
  ['\u3000@a.txt', join(BUILD_CWD, ' @a.txt')],
  // Nothing is trimmed.
  [' ~/x.txt', join(BUILD_CWD, ' ~/x.txt')],
  ['a.txt ', join(BUILD_CWD, 'a.txt ')],
];

describe('gatePiBuiltinTools: the path the gate judges', () => {
  test.each(PATH_CASES)('write %p is judged as the file Pi writes', async (given, expected) => {
    const run = await writeThroughGate(given);

    expect(run.error).toBeUndefined();
    // The oracle: Pi's own tool wrote exactly the path the gate was asked about.
    expect(run.touched).toEqual([expected]);
    expect(run.judged).toEqual({
      toolName: 'write',
      kind: 'file_write',
      cwd: BUILD_CWD,
      paths: [expected],
      input: { path: given, content: 'x' },
      toolCallId: 'call-1',
    });
  });

  test.each(PATH_CASES)('edit %p is judged as the file Pi edits', async (given, expected) => {
    const run = await editThroughGate(given);

    expect(run.error).toBeUndefined();
    expect(new Set(run.touched)).toEqual(new Set([expected]));
    expect(run.judged?.paths).toEqual([expected]);
  });

  // On POSIX a file URL that names a host cannot be turned into a path: Pi's
  // tool throws before it writes. The gate is handed the text unchanged, which
  // its rules refuse as a form only the tool could resolve.
  test.skipIf(ON_WINDOWS)(
    'a file URL Pi cannot decode reaches the gate unchanged and is never written',
    async () => {
      const run = await writeThroughGate('file://remote-host/share/x.txt');

      expect(run.judged?.paths).toEqual(['file://remote-host/share/x.txt']);
      expect(run.touched).toEqual([]);
      expect(run.error).toBeInstanceOf(Error);
    }
  );

  test('a path that is not text names no target, so the gate refuses the write', async () => {
    const run = await writeThroughGate(7);

    expect(run.judged).toEqual({
      toolName: 'write',
      kind: 'file_write',
      cwd: BUILD_CWD,
      input: { path: 7, content: 'x' },
      toolCallId: 'call-1',
    });
  });
});

describe('gatePiBuiltinTools: the directory a call runs in', () => {
  const OTHER_CWD = resolve('/workspace/other');

  test("a relative write is resolved against the context's directory, as Pi's tool does", async () => {
    const run = await writeThroughGate('a.txt', { cwd: OTHER_CWD });

    expect(run.touched).toEqual([join(OTHER_CWD, 'a.txt')]);
    expect(run.judged?.cwd).toBe(OTHER_CWD);
    expect(run.judged?.paths).toEqual([join(OTHER_CWD, 'a.txt')]);
  });

  test("a relative edit is resolved against the context's directory too", async () => {
    const run = await editThroughGate('../a.txt', { cwd: OTHER_CWD });

    expect(new Set(run.touched)).toEqual(new Set([resolve(OTHER_CWD, '../a.txt')]));
    expect(run.judged?.cwd).toBe(OTHER_CWD);
    expect(run.judged?.paths).toEqual([resolve(OTHER_CWD, '../a.txt')]);
  });

  test.each([
    ['no context', undefined],
    ['a context with no directory', {}],
    ['a context with an empty directory', { cwd: '' }],
  ])('%s falls back to the directory the tool was built with', async (_label, ctx) => {
    const run = await writeThroughGate('a.txt', ctx);

    expect(run.touched).toEqual([join(BUILD_CWD, 'a.txt')]);
    expect(run.judged?.cwd).toBe(BUILD_CWD);
    expect(run.judged?.paths).toEqual([join(BUILD_CWD, 'a.txt')]);
  });

  test('a context directory that is not text is refused without asking or running', async () => {
    const run = await writeThroughGate('a.txt', { cwd: 7 });

    expect(run.judged).toBeUndefined();
    expect(run.touched).toEqual([]);
    expect(run.error).toBeInstanceOf(Error);
    expect((run.error as Error).message).toContain('Blocked by the tool gate');
  });

  test("a shell call is judged in the context's directory", async () => {
    const body = mock(async (..._args: unknown[]) => 'ran');
    const seen: ToolActionRequest[] = [];
    const [bash] = gatePiBuiltinTools(
      [{ name: 'bash', execute: body as PiExecute }],
      recordingGate(seen),
      BUILD_CWD
    );
    const ctx = { cwd: OTHER_CWD };

    await bash.execute('call-1', { command: 'touch x' }, undefined, undefined, ctx);

    expect(seen).toEqual([
      {
        toolName: 'bash',
        kind: 'shell',
        cwd: OTHER_CWD,
        command: 'touch x',
        input: { command: 'touch x' },
        toolCallId: 'call-1',
      },
    ]);
    // Pi's own arguments reach the tool untouched, the context among them.
    expect(body.mock.calls[0]).toEqual([
      'call-1',
      { command: 'touch x' },
      undefined,
      undefined,
      ctx,
    ]);
  });
});

// How each built-in is named and classed for the gate (PowerShell under its own
// name among them) is covered in options-translator.test.ts.
describe('gatePiBuiltinTools: tools outside the table', () => {
  test('a tool the table has never seen is gated as other, with its input as given', async () => {
    const body = mock(async (..._args: unknown[]) => 'ran');
    const seen: ToolActionRequest[] = [];
    const [unknown] = gatePiBuiltinTools(
      [{ name: 'multi_edit', execute: body as PiExecute }],
      recordingGate(seen),
      BUILD_CWD
    );

    await unknown.execute('call-1', { path: '~/x.txt' });

    // How an unknown tool resolves a path is not known: the text is not touched.
    expect(seen).toEqual([
      {
        toolName: 'multi_edit',
        kind: 'other',
        cwd: BUILD_CWD,
        input: { path: '~/x.txt' },
        toolCallId: 'call-1',
      },
    ]);
  });
});

describe('gatePiNativeTools', () => {
  test("a native tool is gated as other, in the context's directory", async () => {
    const body = mock(async (..._args: unknown[]) => 'ran');
    const seen: ToolActionRequest[] = [];
    const [native] = gatePiNativeTools(
      [{ name: 'manage_run', execute: body as PiExecute }],
      recordingGate(seen),
      BUILD_CWD
    );

    await native.execute('call-1', { action: 'start' }, undefined, undefined, {
      cwd: resolve('/workspace/other'),
    });

    expect(seen).toEqual([
      {
        toolName: 'manage_run',
        kind: 'other',
        cwd: resolve('/workspace/other'),
        input: { action: 'start' },
        toolCallId: 'call-1',
      },
    ]);
  });
});
