/**
 * The Jev wire format (TypeSafe System One, docs.typesafe.ai/api.md) — and the only module
 * that knows it. Callers describe `choice`, `noul` or `score` questions and get back typed results,
 * so the endpoint can be any Jev-compatible service: nothing here depends on the host, and
 * the response's `model` and `usage` are not read.
 *
 * Deliberately narrow: three question types, no retries, and no imports at all. A caller
 * that cannot get an answer keeps its behaviour without one, so every failure is a value,
 * never a throw.
 */

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Path of the one endpoint used, appended to the configured base URL. */
export const JEV_ENDPOINT_PATH = '/v1/systemone';

/** Where and how to reach the service. Shared by every question type. */
export interface JevConnection {
  /** Base URL of a Jev-compatible service, with or without a trailing slash. */
  apiBase: string;
  apiKey: string;
  /** Model id sent in the request body. The response is not required to echo it. */
  model: string;
  /** Deadline for the whole exchange, body included. */
  timeoutMs: number;
  fetch?: Fetch;
}

/** `invalid_request` is returned before anything is sent, for a question that cannot be asked. */
export type JevFailureReason =
  | 'timeout'
  | 'http_error'
  | 'malformed_response'
  | 'network_error'
  | 'invalid_request';

export interface JevFailure {
  ok: false;
  reason: JevFailureReason;
  status?: number;
}

/** JSON a caller may place in `state`. Questions name its fields with backticked paths. */
export type JevStateValue =
  | string
  | number
  | boolean
  | null
  | readonly JevStateValue[]
  | { readonly [key: string]: JevStateValue };

export interface JevChoiceRequest extends JevConnection {
  /** Question name; the answer is read back under the same name. */
  name: string;
  instructions: string;
  /** One entry per option: option name to what choosing it means (`null` for none). */
  criteria: Readonly<Record<string, string | null>>;
  /** The facts the question is asked about. */
  state: Readonly<Record<string, string>>;
}

export type JevChoiceFailureReason = JevFailureReason;

export type JevChoiceResult =
  | {
      ok: true;
      choice: string;
      /** Probability Jev assigned to `choice`. */
      probability: number;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | JevFailure;

/** A yes/no question. The answer is the probability of yes. */
export interface JevNoulQuestion {
  instructions: string;
  /** What yes and what no mean, when the instructions alone leave room. */
  criteria?: Readonly<{ true: string; false: string }>;
}

export interface JevNoulRequest extends JevConnection {
  /** Question name to question. Every question is answered over the same `state`. */
  questions: Readonly<Record<string, JevNoulQuestion>>;
  state: Readonly<Record<string, JevStateValue>>;
}

export type JevNoulResult =
  | {
      ok: true;
      /** Question name to the probability of yes, 0..1. Exactly the names asked. */
      answers: Record<string, number>;
    }
  | JevFailure;

/** A rating question. `criteria` is ordered low to high; level `i` is `criteria[i]`. */
export interface JevScoreQuestion {
  instructions: string;
  /** 2 to 10 level descriptions, lowest first. */
  criteria: readonly string[];
}

export interface JevScoreRequest extends JevConnection, JevScoreQuestion {
  /** Question name; the answer is read back under the same name. */
  name: string;
  state: Readonly<Record<string, JevStateValue>>;
}

export type JevScoreResult =
  | {
      ok: true;
      /** Probability-weighted mean level, 0-based, so it may be fractional. */
      score: number;
      legend?: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | JevFailure;

/** Smallest and largest number of levels a score question may have. */
export const JEV_SCORE_MIN_LEVELS = 2;
export const JEV_SCORE_MAX_LEVELS = 10;

/** One question of a mixed call, tagged with its wire `type`. */
export type JevQuestion =
  | {
      type: 'choice';
      instructions: string;
      criteria: Readonly<Record<string, string | null>>;
    }
  | ({ type: 'noul' } & JevNoulQuestion)
  | ({ type: 'score' } & JevScoreQuestion);

/** The answer to a `JevQuestion` of the same `type`. */
export type JevAnswer =
  | {
      type: 'choice';
      choice: string;
      probability: number;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | { type: 'noul'; noul: number }
  | {
      type: 'score';
      score: number;
      legend?: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface JevRequest extends JevConnection {
  /** Question name to question. Every question is answered over the same `state`. */
  questions: Readonly<Record<string, JevQuestion>>;
  state: Readonly<Record<string, JevStateValue>>;
}

export type JevResult =
  | {
      ok: true;
      /** Question name to its answer. Exactly the names asked, each of its own type. */
      answers: Record<string, JevAnswer>;
    }
  | JevFailure;

const MALFORMED: JevFailure = { ok: false, reason: 'malformed_response' };
const INVALID_REQUEST: JevFailure = { ok: false, reason: 'invalid_request' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'number');
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}

/**
 * The answer called `name` when it is of the asked `type`. Only what a caller reads is
 * checked: other answers and wrapper keys pass through, and `model`/`usage` are ignored
 * because nothing consumes them.
 */
function readAnswer(body: unknown, name: string, type: string): Record<string, unknown> | null {
  if (!isRecord(body) || !isRecord(body.answers)) return null;
  if (!Object.hasOwn(body.answers, name)) return null;
  const answer = body.answers[name];
  return isRecord(answer) && answer.type === type ? answer : null;
}

type ChoiceAnswer = Extract<JevAnswer, { type: 'choice' }>;
type ScoreAnswer = Extract<JevAnswer, { type: 'score' }>;

function toChoiceAnswer(answer: Record<string, unknown>): ChoiceAnswer | null {
  const { choice, probabilities, confidence } = answer;
  if (typeof choice !== 'string' || !isUnit(confidence)) return null;
  if (!isNumberRecord(probabilities) || !Object.hasOwn(probabilities, choice)) return null;
  return {
    type: 'choice',
    choice,
    probability: probabilities[choice],
    confidence,
    probabilities,
  };
}

function toScoreAnswer(answer: Record<string, unknown>, levels: number): ScoreAnswer | null {
  const { score, legend, probabilities, confidence } = answer;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > levels - 1) {
    return null;
  }
  if (!isUnit(confidence)) return null;
  if (!isNumberRecord(probabilities) || !Object.values(probabilities).every(isUnit)) return null;
  if (legend === undefined) return { type: 'score', score, probabilities, confidence };
  if (!isStringRecord(legend)) return null;
  return { type: 'score', score, legend, probabilities, confidence };
}

/** Read the answer to the choice question called `name` out of a parsed response body. */
export function parseJevChoiceResponse(body: unknown, name: string): JevChoiceResult {
  const answer = readAnswer(body, name, 'choice');
  const parsed = answer === null ? null : toChoiceAnswer(answer);
  if (parsed === null) return MALFORMED;
  return {
    ok: true,
    choice: parsed.choice,
    probability: parsed.probability,
    confidence: parsed.confidence,
    probabilities: parsed.probabilities,
  };
}

/**
 * Read the answers to the noul questions called `names`. One missing or unusable answer
 * makes the whole response malformed: a caller that asked N questions cannot act on N-1.
 */
export function parseJevNoulResponse(body: unknown, names: readonly string[]): JevNoulResult {
  const answers: Record<string, number> = {};
  for (const name of names) {
    const noul = readAnswer(body, name, 'noul')?.noul;
    if (!isUnit(noul)) return MALFORMED;
    answers[name] = noul;
  }
  return { ok: true, answers };
}

/**
 * Read the answer to the score question called `name`, asked with `levels` levels. The
 * score must lie within the asked range, so a response for a different question is refused.
 */
export function parseJevScoreResponse(body: unknown, name: string, levels: number): JevScoreResult {
  const answer = readAnswer(body, name, 'score');
  const parsed = answer === null ? null : toScoreAnswer(answer, levels);
  if (parsed === null) return MALFORMED;
  return {
    ok: true,
    score: parsed.score,
    ...(parsed.legend ? { legend: parsed.legend } : {}),
    probabilities: parsed.probabilities,
    confidence: parsed.confidence,
  };
}

/**
 * Read the answer to every question in `questions`, each as its own type. One missing,
 * mistyped or unusable answer makes the whole response malformed.
 */
export function parseJevResponse(
  body: unknown,
  questions: Readonly<Record<string, JevQuestion>>
): JevResult {
  const answers: Record<string, JevAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = readAnswer(body, name, question.type);
    if (answer === null) return MALFORMED;
    let parsed: JevAnswer | null;
    if (question.type === 'choice') parsed = toChoiceAnswer(answer);
    else if (question.type === 'score') parsed = toScoreAnswer(answer, question.criteria.length);
    else parsed = isUnit(answer.noul) ? { type: 'noul', noul: answer.noul } : null;
    if (parsed === null) return MALFORMED;
    answers[name] = parsed;
  }
  return { ok: true, answers };
}

/** `AbortSignal.timeout` aborts with a DOMException named `TimeoutError`. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/** One POST to the endpoint. Never throws: every failure comes back as a `JevFailure`. */
async function postJev(
  connection: JevConnection,
  state: Readonly<Record<string, JevStateValue>>,
  questions: Readonly<Record<string, unknown>>
): Promise<{ ok: true; body: unknown } | JevFailure> {
  const send = connection.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await send(`${connection.apiBase.replace(/\/+$/, '')}${JEV_ENDPOINT_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: connection.model, state, questions }),
      signal: AbortSignal.timeout(connection.timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: isTimeout(err) ? 'timeout' : 'network_error' };
  }

  if (!response.ok) return { ok: false, reason: 'http_error', status: response.status };

  try {
    return { ok: true, body: await response.json() };
  } catch (err) {
    // The deadline covers the body too, so a stalled body is still a timeout.
    return isTimeout(err) ? { ok: false, reason: 'timeout' } : MALFORMED;
  }
}

/**
 * Ask one `choice` question. Never throws: a timeout, a refused connection, a non-2xx
 * status and an unreadable body each come back as `{ ok: false, reason }`.
 */
export async function askJevChoice(request: JevChoiceRequest): Promise<JevChoiceResult> {
  const posted = await postJev(request, request.state, {
    [request.name]: {
      type: 'choice',
      instructions: request.instructions,
      criteria: request.criteria,
    },
  });
  return posted.ok ? parseJevChoiceResponse(posted.body, request.name) : posted;
}

/**
 * Ask several `noul` questions over one shared state, in one request. Never throws, and
 * never returns a partial answer set: see `parseJevNoulResponse`.
 */
export async function askJevNoul(request: JevNoulRequest): Promise<JevNoulResult> {
  const names = Object.keys(request.questions);
  const questions = Object.fromEntries(
    names.map(name => {
      const { instructions, criteria } = request.questions[name];
      return [name, { type: 'noul', instructions, ...(criteria ? { criteria } : {}) }];
    })
  );
  const posted = await postJev(request, request.state, questions);
  return posted.ok ? parseJevNoulResponse(posted.body, names) : posted;
}

function hasValidLevels(question: JevScoreQuestion): boolean {
  return (
    question.criteria.length >= JEV_SCORE_MIN_LEVELS &&
    question.criteria.length <= JEV_SCORE_MAX_LEVELS
  );
}

/**
 * Ask one `score` question. A level count outside 2..10 comes back as `invalid_request`
 * without a request being sent; every other failure is as for `askJevChoice`.
 */
export async function askJevScore(request: JevScoreRequest): Promise<JevScoreResult> {
  if (!hasValidLevels(request)) return INVALID_REQUEST;
  const posted = await postJev(request, request.state, {
    [request.name]: {
      type: 'score',
      instructions: request.instructions,
      criteria: request.criteria,
    },
  });
  return posted.ok
    ? parseJevScoreResponse(posted.body, request.name, request.criteria.length)
    : posted;
}

/**
 * Ask questions of any mix of types over one shared state, in one request. Never throws,
 * and never returns a partial answer set: see `parseJevResponse`. No questions, or a score
 * question with fewer than 2 or more than 10 levels, is `invalid_request` and sends nothing.
 */
export async function askJev(request: JevRequest): Promise<JevResult> {
  const names = Object.keys(request.questions);
  if (names.length === 0) return INVALID_REQUEST;
  for (const name of names) {
    const question = request.questions[name];
    if (question.type === 'score' && !hasValidLevels(question)) return INVALID_REQUEST;
  }
  const questions = Object.fromEntries(
    names.map(name => {
      const question = request.questions[name];
      if (question.type === 'noul' && question.criteria === undefined) {
        return [name, { type: 'noul', instructions: question.instructions }];
      }
      return [name, question];
    })
  );
  const posted = await postJev(request, request.state, questions);
  return posted.ok ? parseJevResponse(posted.body, request.questions) : posted;
}
