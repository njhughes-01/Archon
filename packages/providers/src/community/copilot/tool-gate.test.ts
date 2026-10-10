import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';

import { toCopilotToolAction } from './tool-gate';

const CWD = resolve('/workspace/repo');

function action(toolName: string, toolArgs: unknown): ReturnType<typeof toCopilotToolAction> {
  return toCopilotToolAction({ toolName, toolArgs, cwd: CWD, fromSubagent: false }, []);
}

const patchOf = (...lines: string[]): string =>
  ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

describe('toCopilotToolAction: shell tools', () => {
  // The gate's rules never take PowerShell text as understood; they tell the
  // shell apart by this name. (`bash` and `write_bash` are in provider.test.ts.)
  test.each([
    ['powershell', { command: 'Remove-Item -Recurse x' }, 'Remove-Item -Recurse x'],
    ['write_powershell', { shellId: '1', input: 'y' }, 'y'],
  ])('%s reaches the gate under its own name', (toolName, toolArgs, command) => {
    expect(action(toolName, JSON.stringify(toolArgs))).toEqual({
      toolName,
      kind: 'shell',
      cwd: CWD,
      command,
      input: toolArgs,
    });
  });
});

/**
 * The runtime's editor tools (`create`, `edit`, `str_replace_editor`) take an
 * absolute path as given and resolve any other against the session directory
 * with node's `resolve`: no `~`, `@` or `file://` handling (@github/copilot
 * 1.0.61, app.js, the `str_replace_editor` callback all three go through).
 */
describe('toCopilotToolAction: the path an editor tool writes', () => {
  test.each([
    ['create', { path: 'src/a.ts' }, join(CWD, 'src/a.ts')],
    ['create', { path: '../outside.ts' }, resolve(CWD, '../outside.ts')],
    ['create', { path: '~/.bashrc' }, join(CWD, '~/.bashrc')],
    ['create', { path: '@scope/a.ts' }, join(CWD, '@scope/a.ts')],
    ['create', { path: 'file:///abs/a.ts' }, join(CWD, 'file:/abs/a.ts')],
    ['edit', { path: 'src/b.ts' }, join(CWD, 'src/b.ts')],
    ['edit', { path: '~' }, join(CWD, '~')],
    ['str_replace_editor', { command: 'insert', path: 'src/c.ts' }, join(CWD, 'src/c.ts')],
    ['str_replace_editor', { command: 'create', path: '~/x' }, join(CWD, '~/x')],
  ])('%s %p is judged where the runtime resolves it', (toolName, toolArgs, expected) => {
    expect(action(toolName, JSON.stringify(toolArgs))).toEqual({
      toolName,
      kind: 'file_write',
      cwd: CWD,
      paths: [expected],
      input: toolArgs,
    });
  });

  test('an absolute path is judged exactly as given', () => {
    const given = `${CWD}${sep}src${sep}..${sep}a.ts`;

    expect(action('create', { path: given })?.paths).toEqual([given]);
  });

  test('a write with no path names no target, so the gate refuses it', () => {
    expect(action('create', '{}')).toEqual({
      toolName: 'create',
      kind: 'file_write',
      cwd: CWD,
      input: {},
    });
  });

  test('viewing through the editor tool is read-only', () => {
    expect(action('str_replace_editor', { command: 'view', path: '~/.bashrc' })).toBeUndefined();
  });
});

describe('toCopilotToolAction: apply_patch', () => {
  test('names every file the patch adds, updates, moves to or deletes', () => {
    const patch = patchOf(
      '*** Add File: src/new.ts',
      '+export {};',
      '*** Update File: src/old.ts',
      '*** Move to: src/renamed.ts',
      '@@',
      '-a',
      '+b',
      '*** Delete File: ../outside.txt'
    );

    expect(action('apply_patch', patch)).toEqual({
      toolName: 'apply_patch',
      kind: 'file_write',
      cwd: CWD,
      paths: [
        join(CWD, 'src/new.ts'),
        join(CWD, 'src/old.ts'),
        join(CWD, 'src/renamed.ts'),
        resolve(CWD, '../outside.txt'),
      ],
      input: { input: patch },
    });
  });

  test('an indented header after another hunk is a target', () => {
    const patch = patchOf('*** Delete File: d.txt', '  *** Add File: ../out.txt', '+hi');

    expect(action('apply_patch', patch)?.paths).toEqual([
      join(CWD, 'd.txt'),
      resolve(CWD, '../out.txt'),
    ]);
  });

  test('CRLF line ends are not part of a path', () => {
    const patch = '*** Begin Patch\r\n*** Add File: a.ts\r\n+x\r\n*** End Patch\r\n';

    expect(action('apply_patch', patch)).toMatchObject({
      paths: [join(CWD, 'a.ts')],
      input: { input: patch },
    });
  });

  // The 1.0.61 runtime trims the path. Its CLI may be the user's own and
  // newer, so the path is named as written too.
  test('space after the marker is named both trimmed and as written', () => {
    expect(action('apply_patch', patchOf('*** Add File:    a.txt', '+x'))?.paths).toEqual([
      join(CWD, 'a.txt'),
      join(CWD, '   a.txt'),
    ]);
  });

  test.each([
    ['a header in another letter case', '*** delete file: ../x'],
    ['a header with no path', '*** Add File:'],
    ['a bare carriage return before a header', '+hi\r*** Add File: ../out.txt'],
    ['a tab inside a path', '*** Add File: .e\tnv'],
    ['a byte-order mark before a header', '\uFEFF*** Add File: ../out.txt'],
  ])('%s marks the patch unreadable', (_label, line) => {
    const patch = patchOf('*** Add File: ok.txt', '+x', line);

    expect(action('apply_patch', patch)).toEqual({
      toolName: 'apply_patch',
      kind: 'file_write',
      cwd: CWD,
      paths: [join(CWD, 'ok.txt')],
      input: { input: patch, unreadablePatch: true },
    });
  });

  test.each([
    ['text that is not a patch', 'please edit the file'],
    ['no input at all', undefined],
    ['an input that is not text', { input: 7 }],
  ])('%s is marked unreadable and names nothing', (_label, toolArgs) => {
    const request = action('apply_patch', toolArgs);

    expect(request?.kind).toBe('file_write');
    expect(request?.paths).toBeUndefined();
    expect(request?.input.unreadablePatch).toBe(true);
  });

  test("already-parsed arguments are read from 'input', then 'patch', as the runtime does", () => {
    const first = patchOf('*** Add File: first.txt', '+x');
    const second = patchOf('*** Add File: second.txt', '+x');

    expect(action('apply_patch', { input: first, patch: second })?.paths).toEqual([
      join(CWD, 'first.txt'),
    ]);
    expect(action('apply_patch', { patch: second })?.paths).toEqual([join(CWD, 'second.txt')]);
  });

  /**
   * How the 1.0.61 runtime places a patch path (app.js, the function every
   * apply_patch hunk path goes through): an absolute path is taken normalised;
   * a relative path that repeats the session directory, in any letter case, is
   * taken from the session directory; any other is joined to it.
   */
  // The session-directory cases are written for a POSIX directory.
  const posixTest = process.platform === 'win32' ? test.skip : test;
  posixTest.each([
    ['src/a.ts', join(CWD, 'src/a.ts')],
    ['./src/../a.ts', join(CWD, 'a.ts')],
    ['../../a.ts', resolve(CWD, '../../a.ts')],
    ['/abs/else/../a.ts', resolve('/abs/a.ts')],
    ['~/.bashrc', join(CWD, '~/.bashrc')],
    ['@types/x.d.ts', join(CWD, '@types/x.d.ts')],
    ['file:///abs/a.ts', join(CWD, 'file:/abs/a.ts')],
    ['workspace/repo/src/a.ts', join(CWD, 'src/a.ts')],
    ['Workspace/REPO/.git/config', join(CWD, '.git/config')],
    ['workspace/repo', CWD],
    ['workspace\\repo\\a.ts', join(CWD, 'a.ts')],
    ['workspace/repository/a.ts', join(CWD, 'workspace/repository/a.ts')],
    ['other/workspace/repo/a.ts', join(CWD, 'other/workspace/repo/a.ts')],
  ])('a patch path %p is judged where the runtime places it', (given, expected) => {
    expect(action('apply_patch', patchOf(`*** Add File: ${given}`, '+x'))?.paths).toEqual([
      expected,
    ]);
  });
});

/**
 * The runtime's own patch parser, loaded from the native module the installed
 * @github/copilot ships, as the oracle for the shared header reader: whatever
 * file the parser would touch, the gate was told about, or the patch was marked
 * unreadable. Skipped where the runtime has no build for this platform.
 */
interface ParsedHunk {
  path: string;
  move_path?: string | null;
}
interface CopilotRuntime {
  patchParse: (patch: string) => { ok: boolean; patchJson?: string | null };
}

function loadCopilotRuntime(): CopilotRuntime | undefined {
  const require = createRequire(import.meta.url);
  const marker = `${sep}node_modules${sep}`;
  const sdkEntry = require.resolve('@github/copilot-sdk');
  const modulesDir = sdkEntry.slice(0, sdkEntry.lastIndexOf(marker) + marker.length);
  const native = join(
    modulesDir,
    '@github',
    'copilot',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'runtime.node'
  );
  if (!existsSync(native)) return undefined;
  try {
    return require(native) as CopilotRuntime;
  } catch (err) {
    // A build that is present but will not load here: say so, then skip the oracle.
    console.warn(`Copilot runtime at ${native} could not be loaded; oracle skipped:`, err);
    return undefined;
  }
}

const runtime = loadCopilotRuntime();

/** The files the runtime's parser would touch, or `undefined` when it rejects the patch. */
function parsedPaths(patch: string): string[] | undefined {
  const result = runtime?.patchParse(patch);
  if (!result?.ok || typeof result.patchJson !== 'string') return undefined;
  const { hunks } = JSON.parse(result.patchJson) as { hunks: ParsedHunk[] };
  return hunks.flatMap(hunk =>
    typeof hunk.move_path === 'string' ? [hunk.path, hunk.move_path] : [hunk.path]
  );
}

/** True when the gate was told about every file the parser would touch. */
function gateCovers(patch: string): boolean {
  const touched = parsedPaths(patch);
  if (touched === undefined) return true;
  const request = action('apply_patch', patch);
  if (request?.input.unreadablePatch === true) return true;
  return touched.every(path => request?.paths?.includes(join(CWD, path)) === true);
}

describe.skipIf(runtime === undefined)("the runtime's own patch parser", () => {
  test.each([
    ['plain headers', patchOf('*** Add File: a.txt', '+x', '*** Delete File: b.txt')],
    [
      'an indented header after a hunk',
      patchOf('*** Add File: a.txt', '+x', '   *** Add File: b.txt', '+y'),
    ],
    ['a tab-indented header', patchOf('\t*** Delete File: a.txt')],
    ['space around the path', patchOf('*** Add File:    a.txt   ', '+x')],
    [
      'an update with a move',
      patchOf('*** Update File: a.txt', '*** Move to: b.txt', '@@', '-x', '+y'),
    ],
    [
      'an indented move',
      patchOf('*** Update File: a.txt', '  *** Move to: b.txt', '@@', '-x', '+y'),
    ],
    ['CRLF line ends', '*** Begin Patch\r\n*** Add File: a.txt\r\n+x\r\n*** End Patch\r\n'],
    ['a heredoc wrapper', `<<'EOF'\n${patchOf('*** Add File: a.txt', '+x')}\nEOF`],
  ])('%s: the gate is told exactly the files the parser touches', (_label, patch) => {
    const touched = parsedPaths(patch);
    const request = action('apply_patch', patch);

    expect(touched).toBeDefined();
    expect(request?.input.unreadablePatch).toBeUndefined();
    // The path as written is named too when it has space in front; the parser's own must be there.
    for (const path of touched ?? []) expect(request?.paths).toContain(join(CWD, path));
    expect(request?.paths?.length).toBeGreaterThanOrEqual(new Set(touched).size);
  });

  test.each([
    [
      'a bare carriage return before a header',
      patchOf('*** Add File: a.txt', '+x\r*** Add File: ../out.txt', '+y'),
    ],
    [
      'lines ended by carriage returns alone',
      '*** Begin Patch\r*** Add File: ../out.txt\r+x\r*** End Patch',
    ],
    [
      'a byte-order mark before a header',
      patchOf('*** Add File: a.txt', '+x', '\uFEFF*** Add File: ../out.txt', '+y'),
    ],
    [
      'a line separator inside a path',
      patchOf('*** Add File: a.txt\u2028*** Add File: ../out.txt', '+x'),
    ],
    [
      'a header-looking context line',
      patchOf('*** Update File: a.txt', '@@', '-x', '+y', ' *** Add File: b.txt'),
    ],
  ])('%s: nothing the parser touches escapes the gate', (_label, patch) => {
    expect(gateCovers(patch)).toBe(true);
  });

  test('no control, format or space character hides a file from the gate', () => {
    const shapes: ((ch: string) => string)[] = [
      ch => `*** Add File: ${ch}../out.txt`,
      ch => `*** Add File: .${ch}./out.txt`,
      ch => `*** Add File: ../out.txt${ch}`,
      ch => `${ch}*** Add File: ../out.txt`,
      ch => `**${ch}* Add File: ../out.txt`,
      ch => `***${ch} Add File: ../out.txt`,
      ch => `*** Add${ch}File: ../out.txt`,
      ch => `*** Add File:${ch}../out.txt`,
      ch => `+x${ch}*** Add File: ../out.txt`,
    ];
    const escaped: string[] = [];
    for (let codePoint = 1; codePoint <= 0xffff; codePoint++) {
      const ch = String.fromCodePoint(codePoint);
      if (ch === '\n' || !/[\p{Cc}\p{Cf}\p{Z}]/u.test(ch)) continue;
      shapes.forEach((shape, index) => {
        const patch = patchOf('*** Add File: a.txt', '+x', shape(ch), '+y');
        if (!gateCovers(patch)) escaped.push(`U+${codePoint.toString(16)} in shape ${index}`);
      });
    }

    expect(escaped).toEqual([]);
  });
});
