/**
 * The Jev wire format (TypeSafe System One, docs.typesafe.ai/api.md) — and the only module
 * that knows it. Callers describe `choice` or `noul` questions and get back typed results,
 * so the endpoint can be any Jev-compatible service: nothing here depends on the host, and
 * the response's `model` and `usage` are not read.
 *
 * Deliberately narrow: two question types, no retries, and no imports at all. A caller
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

export type JevFailureReason = 'timeout' | 'http_error' | 'malformed_response' | 'network_error';

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

const MALFORMED: JevFailure = { ok: false, reason: 'malformed_response' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'number');
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

/** Read the answer to the choice question called `name` out of a parsed response body. */
export function parseJevChoiceResponse(body: unknown, name: string): JevChoiceResult {
  const answer = readAnswer(body, name, 'choice');
  if (answer === null) return MALFORMED;
  const { choice, probabilities, confidence } = answer;
  if (typeof choice !== 'string' || typeof confidence !== 'number') return MALFORMED;
  if (!isNumberRecord(probabilities) || !Object.hasOwn(probabilities, choice)) return MALFORMED;
  return { ok: true, choice, probability: probabilities[choice], confidence, probabilities };
}

/**
 * Read the answers to the noul questions called `names`. One missing or unusable answer
 * makes the whole response malformed: a caller that asked N questions cannot act on N-1.
 */
export function parseJevNoulResponse(body: unknown, names: readonly string[]): JevNoulResult {
  const answers: Record<string, number> = {};
  for (const name of names) {
    const noul = readAnswer(body, name, 'noul')?.noul;
    if (typeof noul !== 'number' || !(noul >= 0 && noul <= 1)) return MALFORMED;
    answers[name] = noul;
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
