import { describe, it, expect } from 'bun:test';
import {
  askJevChoice,
  askJevNoul,
  parseJevChoiceResponse,
  parseJevNoulResponse,
  type Fetch,
  type JevChoiceRequest,
  type JevNoulRequest,
} from './jev-client';
import recordedChoiceResponse from './fixtures/choice-response.json';
import recordedNoulResponse from './fixtures/noul-response.json';

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function capturingFetch(respond: () => Response): { fetch: Fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetch: Fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(respond());
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function choiceBody(choice: string, probabilities: Record<string, number>, confidence: number) {
  return {
    model: 'jev-1.13.0',
    answers: { pick: { type: 'choice', choice, probabilities, confidence } },
    usage: { input_tokens: 10, output_tokens: 1 },
  };
}

function request(overrides: Partial<JevChoiceRequest> = {}): JevChoiceRequest {
  return {
    apiBase: 'https://jev.example',
    apiKey: 'secret-key',
    model: 'jev-1.13.0',
    timeoutMs: 1000,
    name: 'pick',
    instructions: 'Pick one.',
    criteria: { a: 'the first', b: null },
    state: { task: 'do a thing' },
    ...overrides,
  };
}

describe('parseJevChoiceResponse', () => {
  // Contract test. The fixture is a real Jev answer recorded 2026-10-08 through the local
  // factory-jev wrapper, which returns `usage.input_tokens` only (no `output_tokens`) and
  // adds its own `ok`/`request_id` keys (not kept in the fixture). If Jev renames or
  // reshapes an answer field, this fails here instead of every route silently degrading
  // to `malformed_response`.
  it('parses the recorded real Jev choice answer', () => {
    expect(parseJevChoiceResponse(recordedChoiceResponse, 'tier')).toEqual({
      ok: true,
      choice: 'small',
      probability: 1,
      confidence: 1,
      probabilities: { small: 1, medium: 0, large: 0 },
    });
  });

  it('tolerates a response with no usage and with extra wrapper keys', () => {
    const body = {
      ok: true,
      request_id: 'r-1',
      model: 'some-other-model',
      answers: {
        pick: { type: 'choice', choice: 'a', probabilities: { a: 0.9 }, confidence: 0.8 },
      },
    };
    expect(parseJevChoiceResponse(body, 'pick')).toEqual({
      ok: true,
      choice: 'a',
      probability: 0.9,
      confidence: 0.8,
      probabilities: { a: 0.9 },
    });
  });

  it('rejects a body whose answer is missing, mistyped, or lacks the chosen probability', () => {
    const malformed = { ok: false, reason: 'malformed_response' } as const;
    expect(parseJevChoiceResponse(null, 'pick')).toEqual(malformed);
    expect(parseJevChoiceResponse({ answers: {} }, 'pick')).toEqual(malformed);
    expect(parseJevChoiceResponse(choiceBody('a', { a: 1 }, 1), 'other')).toEqual(malformed);
    expect(
      parseJevChoiceResponse({ answers: { pick: { type: 'choice', choices: ['a'] } } }, 'pick')
    ).toEqual(malformed);
    expect(
      parseJevChoiceResponse(
        {
          answers: {
            pick: { type: 'choice', choice: 'a', probabilities: { a: '1' }, confidence: 1 },
          },
        },
        'pick'
      )
    ).toEqual(malformed);
    // The chosen option has no probability entry: there is nothing to threshold on.
    expect(parseJevChoiceResponse(choiceBody('a', { b: 1 }, 1), 'pick')).toEqual(malformed);
  });
});

describe('askJevChoice', () => {
  it('sends one choice question in the Jev wire format', async () => {
    const { fetch, calls } = capturingFetch(() => jsonResponse(choiceBody('a', { a: 1, b: 0 }, 1)));

    const result = await askJevChoice(request({ fetch }));

    expect(result).toEqual({
      ok: true,
      choice: 'a',
      probability: 1,
      confidence: 1,
      probabilities: { a: 1, b: 0 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://jev.example/v1/systemone');
    expect(calls[0].init?.method).toBe('POST');
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-key');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      model: 'jev-1.13.0',
      state: { task: 'do a thing' },
      questions: {
        pick: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'the first', b: null } },
      },
    });
  });

  it('sends the configured model and base, and does not require the response to echo the model', async () => {
    const { fetch, calls } = capturingFetch(() =>
      jsonResponse({ ...choiceBody('a', { a: 1 }, 1), model: 'whatever-the-server-runs' })
    );

    const result = await askJevChoice(
      request({ fetch, apiBase: 'http://jev.internal:8080/', model: 'other-model' })
    );

    expect(result.ok).toBe(true);
    // A trailing slash on the base must not produce `//v1/...`.
    expect(calls[0].url).toBe('http://jev.internal:8080/v1/systemone');
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe('other-model');
  });

  it.each([401, 422, 429, 500, 529])(
    'reports HTTP %d as http_error with the status',
    async status => {
      const { fetch } = capturingFetch(() => jsonResponse({ error: { message: 'nope' } }, status));
      expect(await askJevChoice(request({ fetch }))).toEqual({
        ok: false,
        reason: 'http_error',
        status,
      });
    }
  );

  it('reports a non-JSON 200 body as malformed_response', async () => {
    const { fetch } = capturingFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    expect(await askJevChoice(request({ fetch }))).toEqual({
      ok: false,
      reason: 'malformed_response',
    });
  });

  it('reports a wrong-shape 200 body as malformed_response', async () => {
    const { fetch } = capturingFetch(() => jsonResponse({ answers: { pick: { type: 'score' } } }));
    expect(await askJevChoice(request({ fetch }))).toEqual({
      ok: false,
      reason: 'malformed_response',
    });
  });

  it('reports an aborted request as timeout without throwing', async () => {
    // Behaves like a real fetch that never answers: it settles only when the caller's
    // AbortSignal fires, rejecting with the signal's own reason.
    const hangingFetch: Fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => {
          reject(signal.reason);
        });
      });

    expect(await askJevChoice(request({ fetch: hangingFetch, timeoutMs: 20 }))).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('reports a rejected fetch as network_error without throwing', async () => {
    const failingFetch: Fetch = () => Promise.reject(new TypeError('fetch failed'));
    expect(await askJevChoice(request({ fetch: failingFetch }))).toEqual({
      ok: false,
      reason: 'network_error',
    });
  });

  it('reports a synchronously throwing fetch as network_error without throwing', async () => {
    const throwingFetch: Fetch = () => {
      throw new Error('bad url');
    };
    expect(await askJevChoice(request({ fetch: throwingFetch }))).toEqual({
      ok: false,
      reason: 'network_error',
    });
  });
});

function noulBody(answers: Record<string, number>): unknown {
  return {
    model: 'jev-1.13.0',
    answers: Object.fromEntries(
      Object.entries(answers).map(([name, noul]) => [name, { type: 'noul', noul }])
    ),
    usage: { input_tokens: 10 },
  };
}

function noulRequest(overrides: Partial<JevNoulRequest> = {}): JevNoulRequest {
  return {
    apiBase: 'https://jev.example',
    apiKey: 'secret-key',
    model: 'jev-1.13.0',
    timeoutMs: 1000,
    state: { first: { code: 'a()' }, second: { code: 'b()' } },
    questions: {
      first: {
        instructions: 'Is `first.code` relevant?',
        criteria: { true: 'It is.', false: 'It is not.' },
      },
      second: { instructions: 'Is `second.code` relevant?' },
    },
    ...overrides,
  };
}

describe('parseJevNoulResponse', () => {
  // Contract test. The fixture is a real Jev noul answer recorded 2026-10-01 through the
  // local factory-jev wrapper, which reports `usage.input_tokens` only. If Jev renames or
  // reshapes the answer, this fails here instead of every caller silently degrading to
  // `malformed_response`.
  it('parses the recorded real Jev noul answer', () => {
    expect(parseJevNoulResponse(recordedNoulResponse, ['ready'])).toEqual({
      ok: true,
      answers: { ready: 0.56 },
    });
  });

  it('returns the asked answers only, ignoring wrapper keys and other answers', () => {
    const body = {
      ok: true,
      request_id: 'r-1',
      answers: {
        first: { type: 'noul', noul: 0 },
        second: { type: 'noul', noul: 1 },
        unasked: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 },
      },
    };
    expect(parseJevNoulResponse(body, ['first', 'second'])).toEqual({
      ok: true,
      answers: { first: 0, second: 1 },
    });
  });

  it('rejects a body that lacks an asked answer or carries an unusable probability', () => {
    const malformed = { ok: false, reason: 'malformed_response' } as const;
    expect(parseJevNoulResponse(null, ['first'])).toEqual(malformed);
    expect(parseJevNoulResponse({ answers: [] }, ['first'])).toEqual(malformed);
    expect(parseJevNoulResponse(noulBody({ first: 0.5 }), ['first', 'second'])).toEqual(malformed);
    expect(
      parseJevNoulResponse({ answers: { first: { type: 'choice', noul: 0.5 } } }, ['first'])
    ).toEqual(malformed);
    expect(
      parseJevNoulResponse({ answers: { first: { type: 'noul', noul: '0.5' } } }, ['first'])
    ).toEqual(malformed);
    // A probability outside 0..1 cannot be thresholded, so it is not passed on.
    expect(parseJevNoulResponse(noulBody({ first: 1.2 }), ['first'])).toEqual(malformed);
    expect(parseJevNoulResponse(noulBody({ first: -0.1 }), ['first'])).toEqual(malformed);
  });
});

describe('askJevNoul', () => {
  it('sends every question in one request over one shared state', async () => {
    const { fetch, calls } = capturingFetch(() =>
      jsonResponse(noulBody({ first: 0.9, second: 0.1 }))
    );

    const result = await askJevNoul(noulRequest({ fetch }));

    expect(result).toEqual({ ok: true, answers: { first: 0.9, second: 0.1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://jev.example/v1/systemone');
    expect(calls[0].init?.method).toBe('POST');
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-key');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    // A question without criteria is sent without the key, not with an empty one.
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      model: 'jev-1.13.0',
      state: { first: { code: 'a()' }, second: { code: 'b()' } },
      questions: {
        first: {
          type: 'noul',
          instructions: 'Is `first.code` relevant?',
          criteria: { true: 'It is.', false: 'It is not.' },
        },
        second: { type: 'noul', instructions: 'Is `second.code` relevant?' },
      },
    });
  });

  it('reports an answer set that misses an asked question as malformed_response', async () => {
    const { fetch } = capturingFetch(() => jsonResponse(noulBody({ first: 0.9 })));
    expect(await askJevNoul(noulRequest({ fetch }))).toEqual({
      ok: false,
      reason: 'malformed_response',
    });
  });

  it('reports HTTP 500 as http_error with the status', async () => {
    const { fetch } = capturingFetch(() => jsonResponse({ error: { message: 'nope' } }, 500));
    expect(await askJevNoul(noulRequest({ fetch }))).toEqual({
      ok: false,
      reason: 'http_error',
      status: 500,
    });
  });

  it('reports a non-JSON 200 body as malformed_response', async () => {
    const { fetch } = capturingFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    expect(await askJevNoul(noulRequest({ fetch }))).toEqual({
      ok: false,
      reason: 'malformed_response',
    });
  });

  it('reports an aborted request as timeout without throwing', async () => {
    const hangingFetch: Fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => {
          reject(signal.reason);
        });
      });

    expect(await askJevNoul(noulRequest({ fetch: hangingFetch, timeoutMs: 20 }))).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('reports a rejected or throwing fetch as network_error without throwing', async () => {
    const failingFetch: Fetch = () => Promise.reject(new TypeError('fetch failed'));
    const throwingFetch: Fetch = () => {
      throw new Error('bad url');
    };
    const networkError = { ok: false, reason: 'network_error' } as const;
    expect(await askJevNoul(noulRequest({ fetch: failingFetch }))).toEqual(networkError);
    expect(await askJevNoul(noulRequest({ fetch: throwingFetch }))).toEqual(networkError);
  });
});
