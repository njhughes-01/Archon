/**
 * A structured second opinion: at a checkpoint where a workflow is about to make a
 * judgment call, a classifier answers one bounded question about a piece of evidence, and
 * the agent that follows gets that answer as a hypothesis to check.
 *
 * The answer is advisory, and the result says so in a field of its own. A classifier's
 * confidence is how concentrated its answer was, not whether it is right, so nothing here
 * decides anything: the caller hands the result to an agent that must verify it.
 *
 * This module never fails its caller. With no key, a switch off, an unusable setting,
 * evidence it may not read, or any classifier failure, the result is `unavailable` with
 * the reason named. Nothing here throws on purpose, nothing retries, and nothing is
 * logged: neither the evidence nor the key ever reaches a stream.
 *
 * What may leave the machine is decided here, before the request is built: a bounded tail
 * of the evidence, with recognisable secrets removed. Evidence named by path must be a
 * regular file inside the run's artifacts directory, never a link and never a
 * secret-shaped name.
 *
 * The classifier is any Jev-compatible service; ./jev-client.ts owns the wire format.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSecretPath } from './context-scout.ts';
import { askJevChoice, type Fetch } from './jev-client.ts';
import { readJevAccess, type JevAccess } from './jev-settings.ts';

export interface OpinionSettings extends JevAccess {
  /** Longest the one classifier request may take. */
  timeoutMs: number;
  /** Most characters of evidence sent. The end of the evidence is what is kept. */
  maxEvidenceChars: number;
}

export type OpinionAvailability =
  | { available: true; settings: OpinionSettings }
  | { available: false; reason: string };

/** Every numeric setting: its variable and its default. Each must be a positive integer. */
const NUMBERS = {
  timeoutMs: ['JEV_OPINION_TIMEOUT_MS', 30_000],
  // A failing check's recorded output tail is sixty lines, which this holds with room to
  // spare, and it stays far inside what one classifier request accepts.
  maxEvidenceChars: ['JEV_OPINION_MAX_EVIDENCE_CHARS', 16_000],
} as const satisfies Record<string, readonly [string, number]>;

/**
 * The second opinion's settings, or why it is off.
 *
 * On when `JEV_API_KEY` is set, unless `JEV_ENABLED` (everything Jev) or
 * `JEV_OPINION_ENABLED` (the second opinion alone) is `0` or `false`: see `readJevAccess`.
 *
 * An unusable number turns it off and names the variable, instead of falling back to the
 * default: a mistyped cap must not quietly become another policy on what is sent.
 */
export function readOpinionSettings(env: NodeJS.ProcessEnv): OpinionAvailability {
  const jev = readJevAccess(env, env.JEV_OPINION_ENABLED);
  if (!jev.available) return jev;

  const unusable: string[] = [];
  const number = (key: keyof typeof NUMBERS): number => {
    const [variable, fallback] = NUMBERS[key];
    const raw = env[variable]?.trim() ?? '';
    const value = raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value <= 0) unusable.push(variable);
    return value;
  };
  const settings: OpinionSettings = {
    ...jev.access,
    timeoutMs: number('timeoutMs'),
    maxEvidenceChars: number('maxEvidenceChars'),
  };
  return unusable.length > 0
    ? { available: false, reason: `invalid_setting:${unusable[0]}` }
    : { available: true, settings };
}

export interface SecondOpinion {
  status: 'ok' | 'unavailable';
  /** Empty when ok; otherwise why there is no opinion. */
  reason: string;
  /** The option the classifier picked, or null when there is no opinion. */
  choice: string | null;
  /** The classifier's probability for every option offered. Empty when there is no opinion. */
  probabilities: Record<string, number>;
  /** How concentrated the probabilities are, 0..1. Not the chance the choice is right. */
  confidence: number | null;
  /** Always true: an opinion is a lead for whoever reads it, never a decision. */
  advisory: true;
}

function unavailable(reason: string): SecondOpinion {
  return {
    status: 'unavailable',
    reason,
    choice: null,
    probabilities: {},
    confidence: null,
    advisory: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The choices a node was given: JSON text of a list of `{ name, criterion }`, which is how
 * a script node's `with:` carries a map (an object there is reserved for a binding
 * directive). The result maps each name to its criterion, in the order listed.
 *
 * Anything else offers no choices at all, and a question with no choices is not asked: a
 * list with one unreadable entry must not become a narrower question than was authored.
 */
export function parseChoices(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const entries: [string, string][] = [];
  for (const entry of parsed as unknown[]) {
    if (!isRecord(entry)) return {};
    const { name, criterion } = entry;
    if (typeof name !== 'string' || typeof criterion !== 'string') return {};
    if (name.trim() === '' || criterion.trim() === '') return {};
    if (entries.some(([taken]) => taken === name.trim())) return {};
    entries.push([name.trim(), criterion.trim()]);
  }
  return Object.fromEntries(entries);
}

const REDACTED = '[REDACTED]';
const REDACTED_KEY = '[REDACTED PRIVATE KEY]';

/** An armored private key, whole. */
const KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** The end of a key whose start lies before the text: everything up to it may be key. */
const KEY_BLOCK_END = /^[\s\S]*-----END [A-Z0-9 ]*PRIVATE KEY-----/;
/** The start of a key whose end lies after the text. */
const KEY_BLOCK_START = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[\s\S]*$/;

/**
 * An `Authorization` header's value: a scheme and its credential, or one long token. A
 * word after the colon (`Authorization: denied`) is prose and stays.
 */
const AUTHORIZATION =
  /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)(?:(?:bearer|basic|token|digest|negotiate)[ \t]+[^\s"',;]+|[A-Za-z0-9._~+/=-]{16,})/gi;
const BEARER = /\b(bearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** The user and password in front of a URL's host. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/**
 * A value assigned to a secret-named key, in the shapes logs print them: `KEY=value`,
 * `key: value`, `"key": "value"`, `?key=value&`. The name must end in the secret word and
 * be followed by a single `=` or `:`, so a comparison (`token == x`), a path
 * (`auth::token::verify`, `test_token.py::test_x`) and prose (`password authentication
 * failed`) are left alone. The name's length is bounded so a long run of hyphenated text
 * cannot make the search quadratic.
 */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_-]{0,64}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)["']?[ \t]*(?:=(?![=>])|:(?![:=]))[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)/gi;

/** Credentials recognisable by their own shape, wherever they appear. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** A variable whose name has one of these parts holds a credential. */
const SECRET_NAME_PARTS = new Set([
  'KEY',
  'APIKEY',
  'TOKEN',
  'SECRET',
  'SECRETS',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTH',
  'DSN',
]);

/**
 * The shortest value removed by exact match. Below this a value is as likely to be a flag
 * as a credential, and removing every `1` or `true` from a log would leave nothing to read.
 */
const MIN_SECRET_VALUE_CHARS = 8;

/** The values of this process's secret-named variables, longest first. */
function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    const secret = value?.trim() ?? '';
    if (secret.length < MIN_SECRET_VALUE_CHARS) continue;
    const parts = name.toUpperCase().split(/[^A-Z0-9]+/);
    if (parts.some(part => SECRET_NAME_PARTS.has(part))) values.add(secret);
  }
  return [...values].sort((left, right) => right.length - left.length);
}

/**
 * `text` with recognisable secrets replaced by a marker.
 *
 * Two kinds of match. Exact: the value of every secret-named variable in `env`, the
 * classifier key among them, wherever a failing command echoed it. By shape: private-key
 * blocks, `Authorization` and bearer credentials, the user and password of a URL, values
 * assigned to secret-named keys, and well-known token formats.
 *
 * This is a filter, not a guarantee. A credential in a shape none of these describe is
 * sent as it is; the documentation says so, and says what to do where that matters.
 */
export function redactEvidence(text: string, env: NodeJS.ProcessEnv): string {
  let redacted = text;
  for (const value of secretValues(env)) redacted = redacted.replaceAll(value, REDACTED);
  redacted = redacted
    .replace(KEY_BLOCK, REDACTED_KEY)
    .replace(KEY_BLOCK_END, REDACTED_KEY)
    .replace(KEY_BLOCK_START, REDACTED_KEY)
    .replace(AUTHORIZATION, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(SECRET_ASSIGNMENT, (_match, assigned: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
      return `${assigned}${quote}${REDACTED}${quote}`;
    });
  for (const shape of TOKEN_SHAPES) redacted = redacted.replace(shape, REDACTED);
  return redacted;
}

/**
 * How much more than the cap is read before redacting. Redaction runs on more text than is
 * sent, so the cut that follows lands in text that is already clean and a secret is never
 * split by it. Four bytes is the longest a UTF-8 character gets.
 */
const WINDOW_BYTES_PER_CHAR = 4;
const WINDOW_MARGIN = 8192;

function windowSize(maxEvidenceChars: number): number {
  return maxEvidenceChars * WINDOW_BYTES_PER_CHAR + WINDOW_MARGIN;
}

interface Refused {
  refused: string;
}

function refused(reason: string): Refused {
  return { refused: reason };
}

/** Text that starts partway through a longer one, without its cut first line. */
function withoutPartialFirstLine(text: string): string {
  const newline = text.indexOf('\n');
  // One line longer than the window has no whole line to start from.
  return newline === -1 ? text : text.slice(newline + 1);
}

/**
 * The end of a file inside the artifacts directory, or why it may not be read.
 *
 * Nothing here follows a link. The path must resolve inside the directory, its own
 * directory must still be inside once links are resolved, and the file is opened with
 * `O_NOFOLLOW` and judged from the open descriptor, which is the file the bytes then come
 * from. A secret-shaped name is refused from the name alone, before the file is touched.
 */
function readEvidenceFile(
  path: string,
  artifactsDir: string | undefined,
  windowBytes: number
): { text: string } | Refused {
  const requested = path.trim();
  if (requested === '') return refused('no_evidence');
  const base = artifactsDir?.trim() ?? '';
  if (base === '') return refused('no_artifacts_dir');
  let root: string;
  try {
    // The directory itself may be reached through a link (a relocated Archon home).
    root = realpathSync(base);
  } catch {
    return refused('no_artifacts_dir');
  }

  // An absolute path may name the directory as given or as resolved.
  const absolute = resolve(base, requested);
  const inside = [base, root]
    .map(from => relative(from, absolute))
    .find(candidate => !candidate.startsWith('..') && !isAbsolute(candidate));
  if (inside === undefined) return refused('evidence_outside_artifacts');
  if (isSecretPath(inside.split(sep).join('/'))) return refused('evidence_secret_path');

  const target = join(root, inside);
  let bytes: Buffer;
  let cut: boolean;
  let descriptor: number | undefined;
  try {
    const directory = realpathSync(dirname(target));
    if (directory !== root && !directory.startsWith(root + sep)) {
      return refused('evidence_outside_artifacts');
    }
    // Windows has no O_NOFOLLOW (the constant is absent and ORs in as nothing), so the
    // link check that works everywhere comes first and the atomic one backs it.
    if (!lstatSync(target).isFile()) return refused('evidence_not_regular_file');
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return refused('evidence_not_regular_file');
    const length = Math.min(stat.size, windowBytes);
    const start = stat.size - length;
    bytes = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const count = readSync(descriptor, bytes, filled, length - filled, start + filled);
      if (count === 0) break;
      filled += count;
    }
    bytes = bytes.subarray(0, filled);
    cut = start > 0;
  } catch {
    // Missing, a link, a directory, or unreadable: there is nothing to send.
    return refused('evidence_not_regular_file');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (bytes.includes(0)) return refused('evidence_binary');
  const text = new TextDecoder('utf-8').decode(bytes);
  return { text: cut ? withoutPartialFirstLine(text) : text };
}

/**
 * The last `maxChars` characters of `text`, starting on a whole line when one fits. A
 * single line longer than the cap is cut where the cap falls.
 */
function keepTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const start = text.length - maxChars;
  if (text[start - 1] === '\n') return text.slice(start);
  const newline = text.indexOf('\n', start);
  return newline === -1 || newline === text.length - 1
    ? text.slice(start)
    : text.slice(newline + 1);
}

/** Evidence given as text, or as the path of a file inside the run's artifacts directory. */
export type OpinionEvidence = { text: string } | { path: string };

/** What is sent: read, redacted, then cut to the cap, in that order. */
function prepareEvidence(
  evidence: OpinionEvidence,
  env: NodeJS.ProcessEnv,
  maxEvidenceChars: number
): { text: string } | Refused {
  const size = windowSize(maxEvidenceChars);
  let window: string;
  if ('path' in evidence) {
    const read = readEvidenceFile(evidence.path, env.ARTIFACTS_DIR, size);
    if ('refused' in read) return read;
    window = read.text;
  } else {
    const { text } = evidence;
    window = text.length > size ? withoutPartialFirstLine(text.slice(-size)) : text;
  }
  const text = keepTail(redactEvidence(window, env).trimEnd(), maxEvidenceChars).trim();
  return text === '' ? refused('no_evidence') : { text };
}

/** Jev accepts up to 255 options on one choice question; fewer than two is no question. */
const MIN_CHOICES = 2;
const MAX_CHOICES = 255;

/** The question's name in the request. Jev never sees it; the answer is read back under it. */
const QUESTION_NAME = 'opinion';

/** Appended to every question, so the classifier knows what its one state field holds. */
const EVIDENCE_NOTE =
  'Judge only from the text in `evidence`. It can be the end of a longer record, and ' +
  '`[REDACTED]` marks text that was removed before you saw it.';

export interface SecondOpinionRequest {
  /** One question with a bounded set of answers. */
  question: string;
  /** Option name to the criterion for choosing it: what in the evidence indicates it. */
  choices: Readonly<Record<string, string>>;
  evidence: OpinionEvidence;
  /** Settings, the artifacts directory (`ARTIFACTS_DIR`), and the values to redact. */
  env: NodeJS.ProcessEnv;
  /** Replaces the network. Tests inject it. */
  fetch?: Fetch;
}

/**
 * One second opinion: settings, the evidence that may be sent, one `choice` question.
 * Never throws; every way it cannot answer is an `unavailable` result naming why.
 */
export async function askSecondOpinion(request: SecondOpinionRequest): Promise<SecondOpinion> {
  try {
    const read = readOpinionSettings(request.env);
    if (!read.available) return unavailable(read.reason);
    const { settings } = read;

    const question = request.question.trim();
    if (question === '') return unavailable('no_question');
    const offered = Object.keys(request.choices);
    if (
      offered.length < MIN_CHOICES ||
      offered.length > MAX_CHOICES ||
      offered.some(name => name.trim() === '' || request.choices[name].trim() === '')
    ) {
      return unavailable('invalid_choices');
    }

    const evidence = prepareEvidence(request.evidence, request.env, settings.maxEvidenceChars);
    if ('refused' in evidence) return unavailable(evidence.refused);

    const answered = await askJevChoice({
      apiBase: settings.apiBase,
      apiKey: settings.apiKey,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      fetch: request.fetch,
      name: QUESTION_NAME,
      instructions: `${question}\n\n${EVIDENCE_NOTE}`,
      criteria: request.choices,
      state: { evidence: evidence.text },
    });
    if (!answered.ok) {
      return unavailable(
        `classifier_${answered.reason}` +
          (answered.status === undefined ? '' : `:${String(answered.status)}`)
      );
    }
    // The client checks the answer against itself, not against what was asked.
    if (!offered.includes(answered.choice)) return unavailable('classifier_unknown_choice');
    const probabilities: Record<string, number> = {};
    for (const name of offered) {
      const probability: unknown = Object.hasOwn(answered.probabilities, name)
        ? answered.probabilities[name]
        : undefined;
      if (typeof probability !== 'number' || !(probability >= 0 && probability <= 1)) {
        return unavailable('classifier_malformed_response');
      }
      probabilities[name] = probability;
    }
    if (Object.keys(answered.probabilities).length !== offered.length) {
      return unavailable('classifier_malformed_response');
    }
    return {
      status: 'ok',
      reason: '',
      choice: answered.choice,
      probabilities,
      confidence: answered.confidence,
      advisory: true,
    };
  } catch (error) {
    // Deliberately broad: the opinion is advisory, so a bug in it costs the run a hint and
    // not the run. Only the error's class is reported, because its message can quote the
    // evidence.
    const kind = error instanceof Error ? error.name : 'unknown';
    return unavailable(`internal_error:${kind}`);
  }
}
