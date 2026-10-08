import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { isInside, resolveRealPath } from './path-resolution';

const trackTempRoot = trackTempRoots();

interface Tree {
  base: string;
  root: string;
  outside: string;
}

function makeTree(): Tree {
  const base = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tool-gate-paths-'))));
  const root = join(base, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(outside, 'deep'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), '');
  writeFileSync(join(outside, 'data.txt'), '');
  return { base, root, outside };
}

describe.skipIf(process.platform === 'win32')('resolveRealPath', () => {
  test('an existing file resolves to itself', async () => {
    const { root } = makeTree();
    expect(await resolveRealPath('src/app.ts', root)).toEqual({
      ok: true,
      path: join(root, 'src', 'app.ts'),
      exists: true,
    });
  });

  test('a target that does not exist yet keeps its remaining segments', async () => {
    const { root } = makeTree();
    expect(await resolveRealPath('src/new/deep/file.ts', root)).toEqual({
      ok: true,
      path: join(root, 'src', 'new', 'deep', 'file.ts'),
      exists: false,
    });
  });

  test('.. past the root is followed, not trimmed', async () => {
    const { root, outside } = makeTree();
    expect(await resolveRealPath('src/../../outside/data.txt', root)).toMatchObject({
      path: join(outside, 'data.txt'),
    });
    expect(await resolveRealPath('new/../../outside/x', root)).toMatchObject({
      path: join(outside, 'x'),
      exists: false,
    });
  });

  test('a symlinked directory is followed to where it really points', async () => {
    const { root, outside } = makeTree();
    symlinkSync('../outside', join(root, 'link'));
    expect(await resolveRealPath('link/new.txt', root)).toMatchObject({
      path: join(outside, 'new.txt'),
      exists: false,
    });
  });

  test('.. after a symlink leaves from the link target, not from the link', async () => {
    const { base, root } = makeTree();
    symlinkSync('../outside/deep', join(root, 'link'));
    // Lexically `link/../x` is `repo/x`. The kernel resolves `link` first, so it is `outside/x`.
    expect(await resolveRealPath('link/../x', root)).toMatchObject({
      path: join(base, 'outside', 'x'),
    });
  });

  test('a dangling symlink resolves to the file a write would create', async () => {
    const { root, outside } = makeTree();
    symlinkSync('../outside/not-yet.txt', join(root, 'dangling'));
    expect(await resolveRealPath('dangling', root)).toEqual({
      ok: true,
      path: join(outside, 'not-yet.txt'),
      exists: false,
    });
  });

  test('an absolute symlink target is followed', async () => {
    const { root, outside } = makeTree();
    symlinkSync(join(outside, 'data.txt'), join(root, 'abs'));
    expect(await resolveRealPath('abs', root)).toMatchObject({ path: join(outside, 'data.txt') });
  });

  test('a symlink chain is followed link by link', async () => {
    const { root, outside } = makeTree();
    symlinkSync('second', join(root, 'first'));
    symlinkSync('../outside', join(root, 'second'));
    expect(await resolveRealPath('first/data.txt', root)).toMatchObject({
      path: join(outside, 'data.txt'),
      exists: true,
    });
  });

  test('a symlink loop is refused', async () => {
    const { root } = makeTree();
    symlinkSync('b', join(root, 'a'));
    symlinkSync('a', join(root, 'b'));
    expect(await resolveRealPath('a/file', root)).toEqual({ ok: false, code: 'ELOOP' });
  });

  test('a path through a regular file is refused', async () => {
    const { root } = makeTree();
    expect(await resolveRealPath('src/app.ts/child', root)).toEqual({ ok: false, code: 'ENOTDIR' });
  });

  test('the base directory is resolved too', async () => {
    const { root, outside } = makeTree();
    symlinkSync('../outside', join(root, 'link'));
    expect(await resolveRealPath('data.txt', join(root, 'link'))).toMatchObject({
      path: join(outside, 'data.txt'),
    });
  });

  test('a relative base directory is refused', async () => {
    expect(await resolveRealPath('x', 'not/absolute')).toEqual({ ok: false, code: 'ERELATIVE' });
  });
});

describe.skipIf(process.platform === 'win32')('isInside', () => {
  test('the root contains itself and its descendants', () => {
    expect(isInside('/a/repo', '/a/repo')).toBe(true);
    expect(isInside('/a/repo', '/a/repo/src/x.ts')).toBe(true);
  });

  test('a sibling sharing the prefix is outside', () => {
    expect(isInside('/a/repo', '/a/repo-other/x')).toBe(false);
    expect(isInside('/a/repo', '/a')).toBe(false);
    expect(isInside('/', '/anything')).toBe(true);
  });
});
