/**
 * Where a path really lands, for a target that may not exist yet.
 *
 * `realpath` fails on a missing file, and `path.resolve` trims `..` as text,
 * which is wrong once a symlink is involved: `link/../x` leaves from the link's
 * target, not from the link. So the path is walked one segment at a time the way
 * the kernel walks it, following each symlink, until a segment is missing; what
 * remains cannot contain a symlink and is appended as written.
 */
import { lstatSync, readlinkSync } from 'node:fs';
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
/** What one directory entry was found to be: a link and where it points, or a failure code. */
type Entry = { kind: 'plain' } | { kind: 'link'; target: string } | { kind: 'error'; code: string };

/**
 * What the walk has already learned about entries, for a caller that resolves
 * many paths in one go (every operand of one command). It must not outlive the
 * call it was made for: the filesystem moves on.
 */
export type PathEntryCache = Map<string, Entry>;

/**
 * Tells the walk about a symlink that does not exist yet: one a command of the
 * call being judged is about to make. `target` is what the link will hold, as
 * written; `undefined` when that cannot be read, which makes every path through
 * the link a failure instead of a guess.
 */
export function rememberLink(
  cache: PathEntryCache,
  link: string,
  target: string | undefined
): void {
  cache.set(
    link,
    target === undefined ? { kind: 'error', code: 'EUNKNOWNLINK' } : { kind: 'link', target }
  );
}

/**
 * Reads one entry with the synchronous calls, on purpose. A call can name
 * hundreds of paths and each is one `lstat` of a local directory entry: a few
 * microseconds done in place, against tens of microseconds of scheduling each
 * when handed to the thread pool, which is what made such a call slow. The
 * number of entries one call may read is bounded by its caller.
 */
function readEntry(candidate: string, cache: PathEntryCache | undefined): Entry {
  const known = cache?.get(candidate);
  if (known !== undefined) return known;
  let entry: Entry;
  try {
    entry = lstatSync(candidate).isSymbolicLink()
      ? { kind: 'link', target: readlinkSync(candidate) }
      : { kind: 'plain' };
  } catch (error) {
    entry = { kind: 'error', code: errorCode(error) };
  }
  cache?.set(candidate, entry);
  return entry;
}

/** Linux PATH_MAX and NAME_MAX: no lookup can succeed on a longer path or segment. */
const MAX_PATH_BYTES = 4096;
const MAX_SEGMENT_BYTES = 255;

/**
 * Whether the kernel would refuse `path` outright. Checked before the walk, so
 * a path of hundreds of kilobytes is never walked segment by segment.
 */
export function exceedsPathLimits(path: string): boolean {
  // UTF-8 is at most three bytes per UTF-16 unit, so short text needs no count.
  if (path.length * 3 <= MAX_PATH_BYTES) return false;
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) return true;
  return path.split(SEPARATORS).some(segment => Buffer.byteLength(segment) > MAX_SEGMENT_BYTES);
}

export async function resolveRealPath(
  target: string,
  baseDir: string,
  cache?: PathEntryCache
): Promise<ResolvedPath> {
  if (!isAbsolute(baseDir)) return { ok: false, code: 'ERELATIVE' };
  if (exceedsPathLimits(target)) return { ok: false, code: 'ENAMETOOLONG' };
  const start = isAbsolute(target) ? target : `${baseDir}${sep}${target}`;
  if (isProcessRelative(start)) return { ok: false, code: 'EPROCESS' };
  const { root } = parse(start);
  let current = root;
  let pending = segmentsOf(start.slice(root.length));
  let hops = 0;
  // Past the first missing segment nothing is on disk, so nothing is read from
  // it. A link the caller remembered can still stand there (`mkdir d && ln -s
  // / d/r`), and the walk goes on following those.
  let missing = false;

  for (;;) {
    const segment = pending.shift();
    if (segment === undefined) return { ok: true, path: current, exists: !missing };
    if (segment === '..') {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, segment);
    if (PROCESS_RELATIVE.test(candidate)) return { ok: false, code: 'EPROCESS' };
    const entry: Entry = missing
      ? (cache?.get(candidate) ?? { kind: 'error', code: 'ENOENT' })
      : readEntry(candidate, cache);
    if (entry.kind === 'error') {
      if (entry.code !== 'ENOENT') return { ok: false, code: entry.code };
      // With no remembered links there is nothing left that could redirect the rest.
      if (cache === undefined)
        return { ok: true, path: resolve(candidate, ...pending), exists: false };
      missing = true;
      current = candidate;
      continue;
    }
    if (entry.kind === 'plain') {
      current = candidate;
      continue;
    }
    hops++;
    if (hops > MAX_SYMLINK_HOPS) return { ok: false, code: 'ELOOP' };
    const link = entry.target;
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
