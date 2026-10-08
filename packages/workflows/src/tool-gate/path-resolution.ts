/**
 * Where a path really lands, for a target that may not exist yet.
 *
 * `realpath` fails on a missing file, and `path.resolve` trims `..` as text,
 * which is wrong once a symlink is involved: `link/../x` leaves from the link's
 * target, not from the link. So the path is walked one segment at a time the way
 * the kernel walks it, following each symlink, until a segment is missing; what
 * remains cannot contain a symlink and is appended as written.
 */
import { lstat, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

export type ResolvedPath =
  | {
      ok: true;
      path: string;
      /** False when the walk ended at a missing segment. */ exists: boolean;
    }
  | { ok: false; code: string };

/** The kernel's own limit on symlinks followed in one lookup. */
const MAX_SYMLINK_HOPS = 40;

/**
 * A backslash separates segments only where the platform says so. On POSIX it
 * is an ordinary character: a directory can be named `a\b\c`, and treating it
 * as three levels would let `a\b\c/../../..` climb out of the root unnoticed.
 */
const SEPARATORS = sep === '\\' ? /[\\/]/ : /\//;

function segmentsOf(path: string): string[] {
  return path.split(SEPARATORS).filter(segment => segment !== '' && segment !== '.');
}

/**
 * Paths under `/proc` that mean "this process": its working directory, root and
 * open files. They resolve against the engine, not against the shell the tool
 * will run, so where a write through them lands cannot be known here.
 */
const PROCESS_RELATIVE = /^\/proc\/[^/]+\/(cwd|root|fd|task)(\/|$)/;

/**
 * `/dev/fd/3` and `/dev/stdout` name an open file. Anything written past them
 * (`/dev/fd/../..`) is a walk through the same per-process directory.
 */
function isProcessRelative(path: string): boolean {
  if (PROCESS_RELATIVE.test(path)) return true;
  const [first, second, ...rest] = segmentsOf(path);
  if (first !== 'dev') return false;
  if (second === 'fd') return rest.length !== 1 || !/^\d+$/.test(rest[0] ?? '');
  return ['stdin', 'stdout', 'stderr'].includes(second ?? '') && rest.length > 0;
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : 'EUNKNOWN';
}

/**
 * Resolves `target` (relative to `baseDir`) to its real location. Only a
 * missing segment ends the walk early. Any other failure — a loop, a segment
 * that is a file, a directory that cannot be read — is returned as a failure
 * for the caller to refuse, never guessed around.
 */
export async function resolveRealPath(target: string, baseDir: string): Promise<ResolvedPath> {
  if (!isAbsolute(baseDir)) return { ok: false, code: 'ERELATIVE' };
  const start = isAbsolute(target) ? target : `${baseDir}${sep}${target}`;
  if (isProcessRelative(start)) return { ok: false, code: 'EPROCESS' };
  const { root } = parse(start);
  let current = root;
  let pending = segmentsOf(start.slice(root.length));
  let hops = 0;

  for (;;) {
    const segment = pending.shift();
    if (segment === undefined) return { ok: true, path: current, exists: true };
    if (segment === '..') {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, segment);
    if (PROCESS_RELATIVE.test(candidate)) return { ok: false, code: 'EPROCESS' };
    let isLink: boolean;
    try {
      isLink = (await lstat(candidate)).isSymbolicLink();
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT') return { ok: false, code };
      return { ok: true, path: resolve(candidate, ...pending), exists: false };
    }
    if (!isLink) {
      current = candidate;
      continue;
    }
    hops++;
    if (hops > MAX_SYMLINK_HOPS) return { ok: false, code: 'ELOOP' };
    let link: string;
    try {
      link = await readlink(candidate);
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
    if (isAbsolute(link)) {
      const linkRoot = parse(link).root;
      current = linkRoot;
      pending = [...segmentsOf(link.slice(linkRoot.length)), ...pending];
    } else {
      pending = [...segmentsOf(link), ...pending];
    }
  }
}

/** Whether `path` is `root` or lies under it. Both must already be real paths. */
export function isInside(root: string, path: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
