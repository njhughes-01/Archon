/**
 * The context scout: before an agent reads a checkout, a classifier answers one yes/no
 * question about every candidate file, in line windows, and the result names the files
 * and lines worth opening first.
 *
 * Optional by construction. With no key, either switch off, an unusable setting, a
 * checkout git cannot list, or any classifier failure, the result is `unavailable` with
 * the reason named, and the caller carries on without it. Nothing here throws on purpose
 * and nothing retries.
 *
 * What may leave the machine is decided here, before any request is built: only files git
 * tracks and does not ignore, never a secret-shaped path or a private key, never a
 * symlink, a binary or an oversized file. A hard budget bounds the rest. A file the
 * budget cut is counted as unclassified and left out of the list; it is never reported as
 * not relevant.
 *
 * The classifier is any Jev-compatible service; ./jev-client.ts owns the wire format.
 */

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { askJevNoul, type Fetch, type JevNoulQuestion } from './jev-client.ts';

export interface ScoutSettings {
  apiKey: string;
  apiBase: string;
  model: string;
  /** Longest one classifier request may take. */
  timeoutMs: number;
  /** Longest the whole classification may take before it stands down. */
  deadlineMs: number;
  /** A file is relevant when its best window scores at least this (0..1). */
  threshold: number;
  windowLines: number;
  /** Lines each window repeats from the one before it. */
  windowOverlap: number;
  /** Classifier requests in flight at once. */
  parallelism: number;
  maxFiles: number;
  maxWindows: number;
  /** Most characters of code and question text sent in one run. */
  maxChars: number;
  maxFileBytes: number;
  /** Most characters of code and question text in one request. */
  maxRequestChars: number;
}

export type ScoutAvailability =
  | { available: true; settings: ScoutSettings }
  | { available: false; reason: string };

const DEFAULT_API_BASE = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-1.13.0';

type Check = (value: number) => boolean;
const positiveInteger: Check = value => Number.isInteger(value) && value > 0;
const wholeNumber: Check = value => Number.isInteger(value) && value >= 0;
const probability: Check = value => value >= 0 && value <= 1;

/**
 * Every numeric setting: its variable, its default, and what makes a value usable.
 *
 * The request timeout is the scout's own variable on purpose. `JEV_TIMEOUT_MS` bounds how
 * long a workflow step waits for a model-routing answer, which is a far smaller request;
 * sharing it would make every scout request time out.
 */
const NUMBERS = {
  timeoutMs: ['JEV_SCOUT_TIMEOUT_MS', 30_000, positiveInteger],
  deadlineMs: ['JEV_SCOUT_DEADLINE_MS', 120_000, positiveInteger],
  // Low on purpose: a missed file costs more than an extra one the agent glances at.
  threshold: ['JEV_SCOUT_THRESHOLD', 0.3, probability],
  windowLines: ['JEV_SCOUT_WINDOW_LINES', 120, positiveInteger],
  windowOverlap: ['JEV_SCOUT_WINDOW_OVERLAP', 20, wholeNumber],
  parallelism: ['JEV_SCOUT_PARALLELISM', 4, positiveInteger],
  maxFiles: ['JEV_SCOUT_MAX_FILES', 60, positiveInteger],
  maxWindows: ['JEV_SCOUT_MAX_WINDOWS', 240, positiveInteger],
  maxChars: ['JEV_SCOUT_MAX_CHARS', 600_000, positiveInteger],
  maxFileBytes: ['JEV_SCOUT_MAX_FILE_BYTES', 200_000, positiveInteger],
  // Jev accepts 32k tokens of state plus the longest question. Code runs near three
  // characters a token, so this stays well inside that without a tokenizer.
  maxRequestChars: ['JEV_SCOUT_MAX_REQUEST_CHARS', 40_000, positiveInteger],
} as const satisfies Record<string, readonly [string, number, Check]>;

type NumericSetting = keyof typeof NUMBERS;

function switchedOff(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === '0' || flag === 'false';
}

/**
 * The scout's settings, or why it is off.
 *
 * On when `JEV_API_KEY` is set, unless `JEV_ENABLED` (everything Jev) or
 * `JEV_SCOUT_ENABLED` (the scout alone) is `0` or `false`. A container run receives none
 * of the host's environment, so there it is simply off.
 *
 * An unusable number turns the scout off and names the variable, instead of falling back
 * to the default: a mistyped threshold or budget must not quietly become another policy.
 */
export function readScoutSettings(env: NodeJS.ProcessEnv): ScoutAvailability {
  if (switchedOff(env.JEV_ENABLED) || switchedOff(env.JEV_SCOUT_ENABLED)) {
    return { available: false, reason: 'disabled' };
  }
  const apiKey = env.JEV_API_KEY?.trim() ?? '';
  if (apiKey === '') return { available: false, reason: 'no_api_key' };

  const unusable: string[] = [];
  const number = (key: NumericSetting): number => {
    const [variable, fallback, usable] = NUMBERS[key];
    const raw = env[variable]?.trim() ?? '';
    const value = raw === '' ? fallback : Number(raw);
    if (!usable(value)) unusable.push(variable);
    return value;
  };
  const settings: ScoutSettings = {
    apiKey,
    apiBase: env.JEV_API_BASE?.trim() || DEFAULT_API_BASE,
    model: env.JEV_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: number('timeoutMs'),
    deadlineMs: number('deadlineMs'),
    threshold: number('threshold'),
    windowLines: number('windowLines'),
    windowOverlap: number('windowOverlap'),
    parallelism: number('parallelism'),
    maxFiles: number('maxFiles'),
    maxWindows: number('maxWindows'),
    maxChars: number('maxChars'),
    maxFileBytes: number('maxFileBytes'),
    maxRequestChars: number('maxRequestChars'),
  };
  // A window must add at least one new line, or the windows never reach the end.
  if (settings.windowOverlap >= settings.windowLines) unusable.push(NUMBERS.windowOverlap[0]);
  return unusable.length > 0
    ? { available: false, reason: `invalid_setting:${unusable[0]}` }
    : { available: true, settings };
}

/** Most paths one run considers. A longer list is cut, in order, to this many. */
const MAX_PATHS = 50;

/**
 * The candidate paths a node was given: a JSON list of git pathspecs (a directory, a
 * file, or a glob), or one pathspec as plain text. Empty means the whole checkout.
 */
export function parsePaths(raw: string): string[] {
  const text = raw.trim();
  if (text === '') return [];
  let entries: unknown = [text];
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      // Not JSON: `[abc]*.ts` is a glob that happens to start with a bracket.
    }
  }
  const paths: string[] = [];
  for (const entry of entries as unknown[]) {
    const path = typeof entry === 'string' ? entry.trim() : '';
    if (path !== '' && !paths.includes(path)) paths.push(path);
  }
  return paths.slice(0, MAX_PATHS);
}

const SECRET_DIRECTORIES = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.gcloud',
  '.azure',
  '.kube',
  '.docker',
  'secrets',
  '.secrets',
]);
const SECRET_NAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials',
  'authorized_keys',
  'known_hosts',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
/** A file named exactly this, whatever its extension, is a store of secrets. */
const SECRET_STEMS = new Set(['credentials', 'credential', 'secrets', 'secret']);
const SECRET_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.kdbx',
  '.ppk',
  '.gpg',
  '.asc',
  '.crt',
  '.cer',
  '.der',
  '.tfvars',
  '.tfstate',
]);

/**
 * Whether a path is shaped like a secret: an env file, a key, a credential store, or
 * anything inside a directory that holds them. Decided from the path alone, so the file
 * is never opened. Source files that merely handle secrets (`token-validator.ts`) stay.
 */
export function isSecretPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const name = segments.pop() ?? '';
  if (segments.some(segment => SECRET_DIRECTORIES.has(segment))) return true;
  if (name.startsWith('.env') || name.endsWith('.env')) return true;
  if (SECRET_NAMES.has(name.replace(/\.pub$/, ''))) return true;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  return SECRET_STEMS.has(stem) || SECRET_EXTENSIONS.has(extension);
}

/** An armored private key, wherever it was pasted. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/;

/** Git and editors both call a file binary when a NUL appears this early. */
const BINARY_SNIFF_BYTES = 8000;

export interface ScoutFile {
  path: string;
  text: string;
}

export type ExclusionReason =
  | 'ignored'
  | 'secret'
  | 'not_regular_file'
  | 'too_large'
  | 'binary'
  | 'empty';

type Exclusions = Record<ExclusionReason, number>;

function noExclusions(): Exclusions {
  return { ignored: 0, secret: 0, not_regular_file: 0, too_large: 0, binary: 0, empty: 0 };
}

interface Listing {
  /** Tracked paths the candidate paths selected. */
  candidates: number;
  /** The files that may be sent, in candidate order, at most `maxFiles` of them. */
  files: ScoutFile[];
  excluded: Exclusions;
  /** Candidates the file budget stopped before reading. */
  unread: number;
}

/** `git ls-files -z` with these arguments, or null when git refuses. */
function gitPaths(cwd: string, args: readonly string[]): string[] | null {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (listed.exitCode !== 0) return null;
  return listed.stdout.toString().split('\0').filter(Boolean);
}

/**
 * One file's text when it may be sent, or the reason it may not.
 *
 * `lstat`, not `stat`: a tracked symlink can point anywhere on the host, and following it
 * would send a file git never held.
 */
function readEligible(
  cwd: string,
  path: string,
  maxFileBytes: number
): { text: string } | { excluded: ExclusionReason } {
  const excluded = (reason: ExclusionReason): { excluded: ExclusionReason } => ({
    excluded: reason,
  });
  if (isSecretPath(path)) return excluded('secret');
  const absolute = join(cwd, path);
  let bytes: Uint8Array;
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile()) return excluded('not_regular_file');
    if (stat.size > maxFileBytes) return excluded('too_large');
    bytes = readFileSync(absolute);
  } catch {
    // Tracked but gone from the worktree, or unreadable: there is nothing to send.
    return excluded('not_regular_file');
  }
  // The stat and the read are two looks at a file that can change in between.
  if (bytes.length > maxFileBytes) return excluded('too_large');
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return excluded('binary');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return excluded('binary');
  }
  if (PRIVATE_KEY_BLOCK.test(text)) return excluded('secret');
  return text.trim() === '' ? excluded('empty') : { text };
}

/**
 * The files the candidate paths select that may be sent, or null when git cannot list
 * the checkout (not a repository, or a path that reaches outside it).
 *
 * `git ls-files` is the whole selection: it lists tracked files only, so an untracked
 * file is never a candidate, and it resolves directories and globs itself. Paths are
 * listed one at a time so the candidates keep the order the paths were given in, which
 * is the order a budget cuts from the end of.
 */
function listFiles(cwd: string, paths: readonly string[], settings: ScoutSettings): Listing | null {
  const specs = paths.length === 0 ? [[]] : paths.map(path => ['--', path]);
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const listed = gitPaths(cwd, spec);
    if (listed === null) return null;
    for (const path of listed) {
      if (!seen.has(path)) {
        seen.add(path);
        candidates.push(path);
      }
    }
  }
  // Tracked files an ignore rule matches: someone force-added what the project hides.
  const ignored = gitPaths(cwd, ['--cached', '--ignored', '--exclude-standard']);
  if (ignored === null) return null;
  const hidden = new Set(ignored);

  const listing: Listing = {
    candidates: candidates.length,
    files: [],
    excluded: noExclusions(),
    unread: 0,
  };
  for (const [index, path] of candidates.entries()) {
    if (listing.files.length === settings.maxFiles) {
      listing.unread = candidates.length - index;
      break;
    }
    const read = hidden.has(path)
      ? { excluded: 'ignored' as const }
      : readEligible(cwd, path, settings.maxFileBytes);
    if ('excluded' in read) listing.excluded[read.excluded] += 1;
    else listing.files.push({ path, text: read.text });
  }
  return listing;
}

export interface LineWindow {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

/**
 * Windows of `size` lines over a file of `lineCount` lines, each repeating `overlap`
 * lines of the one before, so a function that straddles a boundary is whole in one of
 * them. Every line is in at least one window and the last window ends on the last line.
 */
export function planWindows(lineCount: number, size: number, overlap: number): LineWindow[] {
  const windows: LineWindow[] = [];
  const stride = size - overlap;
  for (let startLine = 1; startLine <= lineCount; startLine += stride) {
    const endLine = Math.min(startLine + size - 1, lineCount);
    windows.push({ startLine, endLine });
    if (endLine === lineCount) break;
  }
  return windows;
}

/** What yes and no mean for every window. Leans to yes: the scout is tuned for recall. */
const CRITERIA = {
  true: 'This code implements, calls, configures or tests what the question asks about, so a person answering the question should read it.',
  false: 'This code has nothing to do with what the question asks about.',
} as const;

interface PlannedWindow extends LineWindow {
  /** Index into the planned files. */
  file: number;
  code: string;
  /** Characters this window adds to a request: its code and its question text. */
  chars: number;
}

/**
 * The question as asked about one window. The window's code, path and line range are
 * state fields named with backticked paths, which is how Jev ties a question to the part
 * of a shared state it is about.
 */
function windowQuestion(question: string, name: string): JevNoulQuestion {
  return {
    instructions:
      `${question}\n\n` +
      `Answer for the code in \`${name}.code\` only: lines \`${name}.start_line\` to ` +
      `\`${name}.end_line\` of the file \`${name}.path\`.`,
    criteria: CRITERIA,
  };
}

function questionChars(question: string): number {
  const { instructions, criteria } = windowQuestion(question, 'w0000');
  return instructions.length + (criteria?.true.length ?? 0) + (criteria?.false.length ?? 0);
}

export interface ScoutFileResult {
  path: string;
  relevant: boolean;
  /** The best window's probability of yes, 0..1. */
  confidence: number;
  /** The best window: where to start reading. */
  evidence: LineWindow;
}

export type ScoutStatus = 'ok' | 'unavailable' | 'truncated';

interface ClassificationCounts {
  /** Files with an answer. */
  classified: number;
  relevant: number;
  /** Files that may be sent but were not answered: a budget, or a failed run. */
  unclassified: number;
  /** Windows whose answers are in this result. */
  windows: number;
  /** Classifier requests started. */
  requests: number;
  /** Characters of code and question text in the requests started. */
  charsSent: number;
}

export interface ScoutClassification {
  status: ScoutStatus;
  /** Empty when ok; otherwise the budget that was hit or why the classifier is unavailable. */
  reason: string;
  /** Relevant files first, most confident first. */
  files: ScoutFileResult[];
  counts: ClassificationCounts;
}

export interface ClassifyInput {
  /** One yes/no question about a piece of code. */
  question: string;
  files: readonly ScoutFile[];
  settings: ScoutSettings;
  fetch?: Fetch;
  /** Milliseconds, for the deadline. A seam for tests. */
  now?: () => number;
}

interface Plan {
  /** Files that will be classified, in input order. */
  paths: string[];
  windows: PlannedWindow[];
  /** The first limit that kept a file out, or empty. */
  cut: string;
}

/**
 * Decide what is sent, before anything is. Files are taken in order until a budget would
 * be passed, and the plan stops there: a file is classified whole or not at all, because
 * its evidence is its best window and a file with windows missing has no best.
 *
 * A file with a window too big for any request is passed over on its own. No budget can
 * make room for it, so the files after it are still worth asking about.
 */
function plan(question: string, files: readonly ScoutFile[], settings: ScoutSettings): Plan {
  const perQuestion = questionChars(question);
  const planned: Plan = { paths: [], windows: [], cut: '' };
  let chars = 0;
  for (const file of files) {
    if (planned.paths.length === settings.maxFiles) {
      planned.cut = 'max_files';
      break;
    }
    const lines = file.text.replace(/\r?\n$/, '').split(/\r?\n/);
    const windows = planWindows(lines.length, settings.windowLines, settings.windowOverlap).map(
      (window): PlannedWindow => {
        const code = lines.slice(window.startLine - 1, window.endLine).join('\n');
        return { ...window, file: planned.paths.length, code, chars: code.length + perQuestion };
      }
    );
    if (windows.some(window => window.chars > settings.maxRequestChars)) {
      planned.cut ||= 'window_too_large';
      continue;
    }
    const fileChars = windows.reduce((sum, window) => sum + window.chars, 0);
    if (planned.windows.length + windows.length > settings.maxWindows) {
      planned.cut = 'max_windows';
      break;
    }
    if (chars + fileChars > settings.maxChars) {
      planned.cut = 'max_chars';
      break;
    }
    chars += fileChars;
    planned.paths.push(file.path);
    planned.windows.push(...windows);
  }
  return planned;
}

interface PlannedRequest {
  /** Index of this request's first window in the plan. */
  first: number;
  windows: PlannedWindow[];
  chars: number;
}

/** Greedy packing, in order: a request takes windows until the next would pass the size. */
function pack(windows: readonly PlannedWindow[], maxRequestChars: number): PlannedRequest[] {
  const requests: PlannedRequest[] = [];
  for (const [index, window] of windows.entries()) {
    const current = requests.at(-1);
    if (current === undefined || current.chars + window.chars > maxRequestChars) {
      requests.push({ first: index, windows: [window], chars: window.chars });
    } else {
      current.windows.push(window);
      current.chars += window.chars;
    }
  }
  return requests;
}

/**
 * Ask the question about every file, or as many as the budget allows.
 *
 * All or nothing past the plan: when any request fails, the answers already received are
 * discarded and the result is `unavailable`. A list that silently lacked some files'
 * answers would read as complete.
 */
export async function classifyFiles(input: ClassifyInput): Promise<ScoutClassification> {
  const { question, files, settings } = input;
  const now = input.now ?? Date.now;
  const startedAt = now();
  const planned = plan(question, files, settings);
  const requests = pack(planned.windows, settings.maxRequestChars);
  const scores = new Array<number>(planned.windows.length).fill(0);

  let next = 0;
  let started = 0;
  let charsSent = 0;
  let failure = '';
  // The whole limiter: each worker takes the next request until none is left or one
  // failed. JavaScript runs one of them at a time, so the shared counters need no lock.
  const worker = async (): Promise<void> => {
    while (failure === '' && next < requests.length) {
      if (now() - startedAt > settings.deadlineMs) {
        failure = 'deadline';
        return;
      }
      const request = requests[next++];
      started += 1;
      charsSent += request.chars;
      // A window is named by its place in the plan, so an answer finds its way back.
      const names = request.windows.map(
        (_window, index) => `w${String(request.first + index).padStart(4, '0')}`
      );
      const answered = await askJevNoul({
        apiBase: settings.apiBase,
        apiKey: settings.apiKey,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        fetch: input.fetch,
        state: Object.fromEntries(
          request.windows.map((window, index) => [
            names[index],
            {
              path: planned.paths[window.file],
              start_line: window.startLine,
              end_line: window.endLine,
              code: window.code,
            },
          ])
        ),
        questions: Object.fromEntries(names.map(name => [name, windowQuestion(question, name)])),
      });
      if (!answered.ok) {
        failure ||=
          `classifier_${answered.reason}` +
          (answered.status === undefined ? '' : `:${String(answered.status)}`);
        return;
      }
      for (const [index, name] of names.entries()) {
        scores[request.first + index] = answered.answers[name];
      }
    }
  };
  await Promise.all(Array.from({ length: settings.parallelism }, worker));

  if (failure !== '') {
    return {
      status: 'unavailable',
      reason: failure,
      files: [],
      counts: {
        classified: 0,
        relevant: 0,
        unclassified: files.length,
        windows: 0,
        requests: started,
        charsSent,
      },
    };
  }

  const results = planned.paths.map(
    (path): ScoutFileResult => ({
      path,
      relevant: false,
      confidence: -1,
      evidence: { startLine: 1, endLine: 1 },
    })
  );
  for (const [index, window] of planned.windows.entries()) {
    const result = results[window.file];
    if (scores[index] > result.confidence) {
      result.confidence = scores[index];
      result.evidence = { startLine: window.startLine, endLine: window.endLine };
      result.relevant = scores[index] >= settings.threshold;
    }
  }
  results.sort(
    (left, right) => right.confidence - left.confidence || left.path.localeCompare(right.path)
  );

  return {
    status: planned.cut === '' ? 'ok' : 'truncated',
    reason: planned.cut,
    files: results,
    counts: {
      classified: results.length,
      relevant: results.filter(result => result.relevant).length,
      unclassified: files.length - results.length,
      windows: planned.windows.length,
      requests: started,
      charsSent,
    },
  };
}

/** A question longer than this is a paragraph, and every window would pay for it. */
const MAX_QUESTION_CHARS = 600;

export interface ScoutResult extends ScoutClassification {
  question: string;
  /** The candidate paths considered. Empty means the whole checkout. */
  paths: string[];
  counts: ClassificationCounts & {
    /** Tracked files the paths selected. */
    candidates: number;
    /** Candidates never sent, by the rule that kept them back. */
    excluded: Exclusions;
  };
}

export interface ScoutRun {
  question: string;
  /** See `parsePaths`. */
  paths: string;
  /** The checkout to scout. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  fetch?: Fetch;
}

function unavailable(question: string, paths: string[], reason: string): ScoutResult {
  return {
    status: 'unavailable',
    reason,
    question,
    paths,
    files: [],
    counts: {
      candidates: 0,
      excluded: noExclusions(),
      classified: 0,
      relevant: 0,
      unclassified: 0,
      windows: 0,
      requests: 0,
      charsSent: 0,
    },
  };
}

/**
 * One scout run over a checkout: settings, the files that may be sent, the answers.
 * Never throws; every way it cannot answer is an `unavailable` result naming why.
 */
export async function runScout(run: ScoutRun): Promise<ScoutResult> {
  const question = run.question.trim();
  const paths = parsePaths(run.paths);
  try {
    const read = readScoutSettings(run.env);
    if (!read.available) return unavailable(question, paths, read.reason);
    if (question === '') return unavailable(question, paths, 'no_question');
    if (question.length > MAX_QUESTION_CHARS) {
      return unavailable(question.slice(0, MAX_QUESTION_CHARS), paths, 'question_too_long');
    }
    const listing = listFiles(run.cwd, paths, read.settings);
    if (listing === null) return unavailable(question, paths, 'git_failed');

    const classified = await classifyFiles({
      question,
      files: listing.files,
      settings: read.settings,
      fetch: run.fetch,
    });
    const truncatedByListing = classified.status === 'ok' && listing.unread > 0;
    return {
      ...classified,
      status: truncatedByListing ? 'truncated' : classified.status,
      reason: truncatedByListing ? 'max_files' : classified.reason,
      question,
      paths,
      counts: {
        ...classified.counts,
        candidates: listing.candidates,
        excluded: listing.excluded,
        unclassified: classified.counts.unclassified + listing.unread,
      },
    };
  } catch (error) {
    // Deliberately broad: the scout is advisory, so a bug in it costs the run a hint and
    // not the run. Only the error's class is reported, because its message can quote a
    // file.
    const kind = error instanceof Error ? error.name : 'unknown';
    return unavailable(question, paths, `internal_error:${kind}`);
  }
}
