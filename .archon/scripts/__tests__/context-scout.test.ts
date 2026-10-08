/**
 * The context scout's core, exercised through its real functions with only the network
 * replaced: `fetch` is injected, and every file listing comes from a real git checkout.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  classifyFiles,
  isSecretPath,
  parsePaths,
  planWindows,
  readScoutSettings,
  runScout,
  type ScoutFile,
  type ScoutSettings,
} from '../../workflows/sdlc/.shared/context-scout';
import type { Fetch } from '../../workflows/sdlc/.shared/jev-client';

const trackTempRoot = trackTempRoots();

const QUESTION = 'Does this code validate a login token?';

function settings(overrides: Partial<ScoutSettings> = {}): ScoutSettings {
  const read = readScoutSettings({ JEV_API_KEY: 'test-key', JEV_API_BASE: 'https://jev.example' });
  if (!read.available) throw new Error(`settings unavailable: ${read.reason}`);
  return { ...read.settings, ...overrides };
}

interface SentWindow {
  path: string;
  startLine: number;
  endLine: number;
  code: string;
}

interface FakeJev {
  fetch: Fetch;
  /** Raw request bodies, in the order they were sent. */
  bodies: string[];
  /** Every window sent, across all requests. */
  windows: SentWindow[];
  /** The most requests that were in flight at once. */
  peak: () => number;
}

/**
 * A Jev-compatible endpoint in memory: it answers every noul question in a request with
 * `score(window)`, reading the window the question was asked about out of the request's
 * own state, the way the real service would.
 */
function fakeJev(score: (window: SentWindow) => number, delayMs = 0): FakeJev {
  const bodies: string[] = [];
  const windows: SentWindow[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetch: Fetch = async (_input, init) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const raw = typeof init?.body === 'string' ? init.body : '';
    bodies.push(raw);
    const body = JSON.parse(raw) as {
      state: Record<string, { path: string; start_line: number; end_line: number; code: string }>;
      questions: Record<string, { type: string }>;
    };
    if (delayMs > 0) await Bun.sleep(delayMs);
    const answers: Record<string, { type: 'noul'; noul: number }> = {};
    for (const name of Object.keys(body.questions)) {
      const entry = body.state[name];
      const window = {
        path: entry.path,
        startLine: entry.start_line,
        endLine: entry.end_line,
        code: entry.code,
      };
      windows.push(window);
      answers[name] = { type: 'noul', noul: score(window) };
    }
    inFlight -= 1;
    return new Response(JSON.stringify({ model: 'fake', answers }), { status: 200 });
  };
  return { fetch, bodies, windows, peak: () => peak };
}

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_unused, index) => `${prefix} ${String(index + 1)}`).join(
    '\n'
  );
}

function file(path: string, lineCount: number): ScoutFile {
  return { path, text: lines(lineCount, path) };
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

/** A real git checkout holding `tracked`, committed. Returns its root. */
function repo(tracked: Record<string, string | Uint8Array>): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'context-scout-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [path, content] of Object.entries(tracked)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, 'add', '--force', '--all');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

const ENV = { JEV_API_KEY: 'test-key', JEV_API_BASE: 'https://jev.example' };

describe('readScoutSettings', () => {
  it('is unavailable without a key, and when either switch turns it off', () => {
    expect(readScoutSettings({})).toEqual({ available: false, reason: 'no_api_key' });
    expect(readScoutSettings({ JEV_API_KEY: '  ' })).toEqual({
      available: false,
      reason: 'no_api_key',
    });
    for (const off of ['0', 'false', 'FALSE']) {
      expect(readScoutSettings({ JEV_API_KEY: 'k', JEV_ENABLED: off })).toEqual({
        available: false,
        reason: 'disabled',
      });
      expect(readScoutSettings({ JEV_API_KEY: 'k', JEV_SCOUT_ENABLED: off })).toEqual({
        available: false,
        reason: 'disabled',
      });
    }
  });

  it('applies the documented defaults and reads every override', () => {
    const defaults = readScoutSettings({ JEV_API_KEY: 'k' });
    expect(defaults).toEqual({
      available: true,
      settings: {
        apiKey: 'k',
        apiBase: 'https://api.typesafe.ai',
        model: 'jev-1.13.0',
        timeoutMs: 30_000,
        deadlineMs: 120_000,
        threshold: 0.3,
        windowLines: 120,
        windowOverlap: 20,
        parallelism: 4,
        maxFiles: 60,
        maxWindows: 240,
        maxChars: 600_000,
        maxFileBytes: 200_000,
        maxRequestChars: 40_000,
      },
    });

    const overridden = readScoutSettings({
      JEV_API_KEY: 'k',
      JEV_API_BASE: 'http://laya.internal:8080',
      JEV_MODEL: 'laya-1',
      JEV_SCOUT_TIMEOUT_MS: '500',
      JEV_SCOUT_DEADLINE_MS: '9000',
      JEV_SCOUT_THRESHOLD: '0.45',
      JEV_SCOUT_WINDOW_LINES: '40',
      JEV_SCOUT_WINDOW_OVERLAP: '0',
      JEV_SCOUT_PARALLELISM: '2',
      JEV_SCOUT_MAX_FILES: '5',
      JEV_SCOUT_MAX_WINDOWS: '6',
      JEV_SCOUT_MAX_CHARS: '7000',
      JEV_SCOUT_MAX_FILE_BYTES: '8000',
      JEV_SCOUT_MAX_REQUEST_CHARS: '9000',
    });
    expect(overridden).toEqual({
      available: true,
      settings: {
        apiKey: 'k',
        apiBase: 'http://laya.internal:8080',
        model: 'laya-1',
        timeoutMs: 500,
        deadlineMs: 9000,
        threshold: 0.45,
        windowLines: 40,
        windowOverlap: 0,
        parallelism: 2,
        maxFiles: 5,
        maxWindows: 6,
        maxChars: 7000,
        maxFileBytes: 8000,
        maxRequestChars: 9000,
      },
    });
  });

  // A mistyped number must not quietly become a different policy: the scout stands down
  // and names the variable, and the run continues without it.
  it.each([
    ['JEV_SCOUT_THRESHOLD', 'o.3'],
    ['JEV_SCOUT_THRESHOLD', '1.5'],
    ['JEV_SCOUT_WINDOW_LINES', '0'],
    ['JEV_SCOUT_WINDOW_LINES', '12.5'],
    ['JEV_SCOUT_PARALLELISM', '-1'],
    ['JEV_SCOUT_MAX_FILES', 'many'],
  ])('is unavailable when %s is %s', (name, value) => {
    expect(readScoutSettings({ JEV_API_KEY: 'k', [name]: value })).toEqual({
      available: false,
      reason: `invalid_setting:${name}`,
    });
  });

  it('is unavailable when the overlap is not smaller than the window', () => {
    expect(
      readScoutSettings({
        JEV_API_KEY: 'k',
        JEV_SCOUT_WINDOW_LINES: '10',
        JEV_SCOUT_WINDOW_OVERLAP: '10',
      })
    ).toEqual({ available: false, reason: 'invalid_setting:JEV_SCOUT_WINDOW_OVERLAP' });
  });
});

describe('parsePaths', () => {
  it('reads a JSON list, a single glob, and nothing', () => {
    expect(parsePaths('["src/auth", "lib/**/*.py"]')).toEqual(['src/auth', 'lib/**/*.py']);
    expect(parsePaths('src/**/*.ts')).toEqual(['src/**/*.ts']);
    expect(parsePaths('')).toEqual([]);
    expect(parsePaths('  ')).toEqual([]);
    expect(parsePaths('[]')).toEqual([]);
  });

  it('drops blanks, duplicates and non-strings, keeping the first-seen order', () => {
    expect(parsePaths('["b", "", "a", "b", 3, null, " a "]')).toEqual(['b', 'a']);
  });

  it('treats text that only looks like a list as one path', () => {
    expect(parsePaths('[abc]/*.ts')).toEqual(['[abc]/*.ts']);
  });
});

describe('isSecretPath', () => {
  it.each([
    '.env',
    '.env.production',
    '.envrc',
    'deploy/prod.env',
    'packages/api/.env.local',
    'id_rsa',
    'home/.ssh/config',
    'keys/id_ed25519.pub',
    'certs/server.pem',
    'certs/server.key',
    'store/release.jks',
    'config/credentials.json',
    'config/secrets.yaml',
    'app/Secrets.ts',
    '.aws/config',
    '.npmrc',
    '.netrc',
    'infra/prod.tfvars',
    'infra/terraform.tfstate',
    'k8s/secrets/db.yaml',
  ])('excludes %s', path => {
    expect(isSecretPath(path)).toBe(true);
  });

  it.each([
    'src/auth/token-validator.ts',
    'src/auth/credential_check.py',
    'lib/secret_rotation/handler.go',
    'docs/environment.md',
    'src/keyboard.ts',
    'src/env.ts',
    'README.md',
  ])('keeps %s', path => {
    expect(isSecretPath(path)).toBe(false);
  });
});

describe('planWindows', () => {
  it.each([
    [1, 120, 20],
    [119, 120, 20],
    [120, 120, 20],
    [121, 120, 20],
    [1000, 120, 20],
    [37, 10, 3],
    [50, 10, 0],
    [9, 2, 1],
  ])(
    'covers every one of %d lines with windows of %d overlapping by %d',
    (count, size, overlap) => {
      const windows = planWindows(count, size, overlap);
      const stride = size - overlap;

      expect(windows[0].startLine).toBe(1);
      expect(windows.at(-1)?.endLine).toBe(count);
      for (const [index, window] of windows.entries()) {
        expect(window.startLine).toBe(1 + index * stride);
        expect(window.endLine).toBe(Math.min(window.startLine + size - 1, count));
        // Each window repeats exactly `overlap` lines of the one before it.
        if (index > 0) {
          expect(windows[index - 1].endLine - window.startLine + 1).toBe(overlap);
        }
      }

      // The lines a window adds beyond its predecessor partition the file: every line is
      // new in exactly one window, so none is skipped and only the overlap is repeated.
      const firstSeen = new Array<number>(count).fill(0);
      let covered = 0;
      for (const window of windows) {
        for (let line = Math.max(window.startLine, covered + 1); line <= window.endLine; line++) {
          firstSeen[line - 1] += 1;
        }
        covered = Math.max(covered, window.endLine);
      }
      expect(firstSeen.every(times => times === 1)).toBe(true);
    }
  );

  it('plans nothing for an empty file', () => {
    expect(planWindows(0, 120, 20)).toEqual([]);
  });
});

describe('classifyFiles', () => {
  it('reports the best window of each file as its evidence and confidence', async () => {
    const jev = fakeJev(window =>
      window.path === 'auth.ts' && window.startLine === 21 ? 0.9 : 0.1
    );

    const result = await classifyFiles({
      question: QUESTION,
      files: [file('auth.ts', 50), file('other.ts', 5)],
      settings: settings({ windowLines: 20, windowOverlap: 0 }),
      fetch: jev.fetch,
    });

    expect(result).toEqual({
      status: 'ok',
      reason: '',
      files: [
        {
          path: 'auth.ts',
          relevant: true,
          confidence: 0.9,
          evidence: { startLine: 21, endLine: 40 },
        },
        {
          path: 'other.ts',
          relevant: false,
          confidence: 0.1,
          evidence: { startLine: 1, endLine: 5 },
        },
      ],
      counts: {
        classified: 2,
        relevant: 1,
        unclassified: 0,
        windows: 4,
        requests: 1,
        charsSent: result.counts.charsSent,
      },
    });
    expect(result.counts.charsSent).toBeGreaterThan(0);
  });

  it('sends each window with its path and line range, and asks the question about it', async () => {
    const jev = fakeJev(() => 0.5);

    await classifyFiles({
      question: QUESTION,
      files: [file('a.ts', 3)],
      settings: settings(),
      fetch: jev.fetch,
    });

    expect(jev.windows).toEqual([
      { path: 'a.ts', startLine: 1, endLine: 3, code: 'a.ts 1\na.ts 2\na.ts 3' },
    ]);
    const body = JSON.parse(jev.bodies[0]) as {
      model: string;
      questions: Record<string, { type: string; instructions: string }>;
    };
    expect(body.model).toBe('jev-1.13.0');
    const [name] = Object.keys(body.questions);
    expect(body.questions[name].type).toBe('noul');
    expect(body.questions[name].instructions).toContain(QUESTION);
    expect(body.questions[name].instructions).toContain(`\`${name}.code\``);
  });

  it('selects at the threshold and rejects just below it', async () => {
    const scores: Record<string, number> = { 'at.ts': 0.3, 'below.ts': 0.29, 'above.ts': 0.31 };
    const jev = fakeJev(window => scores[window.path]);

    const result = await classifyFiles({
      question: QUESTION,
      files: [file('at.ts', 2), file('below.ts', 2), file('above.ts', 2)],
      settings: settings({ threshold: 0.3 }),
      fetch: jev.fetch,
    });

    expect(result.files.map(entry => [entry.path, entry.relevant])).toEqual([
      ['above.ts', true],
      ['at.ts', true],
      ['below.ts', false],
    ]);
  });

  it('moves with the configured threshold', async () => {
    const jev = fakeJev(() => 0.5);
    const input = { question: QUESTION, files: [file('a.ts', 2)], fetch: jev.fetch };

    expect(
      (await classifyFiles({ ...input, settings: settings({ threshold: 0.5 }) })).files[0].relevant
    ).toBe(true);
    expect(
      (await classifyFiles({ ...input, settings: settings({ threshold: 0.51 }) })).files[0].relevant
    ).toBe(false);
  });

  it('stops at the file budget and marks the result truncated', async () => {
    const jev = fakeJev(() => 0.9);

    const result = await classifyFiles({
      question: QUESTION,
      files: [file('a.ts', 2), file('b.ts', 2), file('c.ts', 2)],
      settings: settings({ maxFiles: 2 }),
      fetch: jev.fetch,
    });

    expect(result.status).toBe('truncated');
    expect(result.reason).toBe('max_files');
    // A file the budget cut is absent, never listed as not relevant.
    expect(result.files.map(entry => entry.path)).toEqual(['a.ts', 'b.ts']);
    expect(result.counts.unclassified).toBe(1);
    expect(jev.windows.map(window => window.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('stops at the window budget without splitting a file', async () => {
    const jev = fakeJev(() => 0.9);

    const result = await classifyFiles({
      question: QUESTION,
      // a.ts is 2 windows, b.ts is 3: together they pass a budget of 4.
      files: [file('a.ts', 20), file('b.ts', 30), file('c.ts', 5)],
      settings: settings({ windowLines: 10, windowOverlap: 0, maxWindows: 4 }),
      fetch: jev.fetch,
    });

    expect(result.status).toBe('truncated');
    expect(result.reason).toBe('max_windows');
    expect(result.files.map(entry => entry.path)).toEqual(['a.ts']);
    expect(result.counts).toMatchObject({ classified: 1, unclassified: 2, windows: 2 });
  });

  it('stops at the character budget and reports what it sent', async () => {
    const jev = fakeJev(() => 0.9);
    const one = await classifyFiles({
      question: QUESTION,
      files: [file('a.ts', 10)],
      settings: settings(),
      fetch: fakeJev(() => 0.9).fetch,
    });

    const result = await classifyFiles({
      question: QUESTION,
      files: [file('a.ts', 10), file('b.ts', 10)],
      // Room for the first file, not for the second.
      settings: settings({ maxChars: one.counts.charsSent + 10 }),
      fetch: jev.fetch,
    });

    expect(result.status).toBe('truncated');
    expect(result.reason).toBe('max_chars');
    expect(result.files.map(entry => entry.path)).toEqual(['a.ts']);
    expect(result.counts.charsSent).toBe(one.counts.charsSent);
    expect(result.counts.charsSent).toBeLessThanOrEqual(one.counts.charsSent + 10);
  });

  it('packs windows into requests up to the request size, and never past it', async () => {
    const jev = fakeJev(() => 0.1);
    const files = Array.from({ length: 12 }, (_unused, index) => file(`f${String(index)}.ts`, 40));

    const result = await classifyFiles({
      question: QUESTION,
      files,
      settings: settings({ maxRequestChars: 3000 }),
      fetch: jev.fetch,
    });

    expect(result.status).toBe('ok');
    expect(result.counts.requests).toBe(jev.bodies.length);
    expect(jev.bodies.length).toBeGreaterThan(1);
    expect(jev.bodies.length).toBeLessThan(12);
    expect(jev.windows).toHaveLength(12);
  });

  it('leaves out a file whose single window cannot fit in one request', async () => {
    const jev = fakeJev(() => 0.9);

    const result = await classifyFiles({
      question: QUESTION,
      files: [{ path: 'wide.ts', text: 'x'.repeat(5000) }, file('a.ts', 2)],
      settings: settings({ maxRequestChars: 2000 }),
      fetch: jev.fetch,
    });

    expect(result.status).toBe('truncated');
    expect(result.reason).toBe('window_too_large');
    expect(result.files.map(entry => entry.path)).toEqual(['a.ts']);
    expect(result.counts.unclassified).toBe(1);
    expect(jev.bodies.join('')).not.toContain('xxxxxxxxxx');
  });

  it('never runs more requests at once than the configured parallelism', async () => {
    const jev = fakeJev(() => 0.1, 15);
    const files = Array.from({ length: 12 }, (_unused, index) => file(`f${String(index)}.ts`, 40));

    const result = await classifyFiles({
      question: QUESTION,
      files,
      // One window per request, so there are 12 requests to schedule.
      settings: settings({ maxRequestChars: 1000, parallelism: 3 }),
      fetch: jev.fetch,
    });

    expect(result.status).toBe('ok');
    expect(result.counts.requests).toBe(12);
    expect(jev.peak()).toBe(3);
  });

  it('runs one request at a time when parallelism is 1', async () => {
    const jev = fakeJev(() => 0.1, 5);
    const files = Array.from({ length: 4 }, (_unused, index) => file(`f${String(index)}.ts`, 40));

    await classifyFiles({
      question: QUESTION,
      files,
      settings: settings({ maxRequestChars: 1000, parallelism: 1 }),
      fetch: jev.fetch,
    });

    expect(jev.peak()).toBe(1);
  });

  it.each([
    [
      'an HTTP 500',
      (): Response => new Response('{}', { status: 500 }),
      'classifier_http_error:500',
    ],
    [
      'an HTTP 401',
      (): Response => new Response('{}', { status: 401 }),
      'classifier_http_error:401',
    ],
    [
      'a non-JSON body',
      (): Response => new Response('<html>', { status: 200 }),
      'classifier_malformed_response',
    ],
    [
      'an answer set with a question missing',
      (): Response => new Response(JSON.stringify({ answers: {} }), { status: 200 }),
      'classifier_malformed_response',
    ],
  ])('is unavailable, with nothing selected, on %s', async (_label, respond, reason) => {
    const fetch: Fetch = () => Promise.resolve(respond());

    const result = await classifyFiles({
      question: QUESTION,
      files: [file('a.ts', 2), file('b.ts', 2)],
      settings: settings(),
      fetch,
    });

    expect(result).toEqual({
      status: 'unavailable',
      reason,
      files: [],
      counts: {
        classified: 0,
        relevant: 0,
        unclassified: 2,
        windows: 0,
        requests: 1,
        charsSent: result.counts.charsSent,
      },
    });
  });

  it('is unavailable on a classifier timeout', async () => {
    const hanging: Fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => {
          // The signal's own reason, as a real fetch rejects with: a TimeoutError.
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        });
      });

    const result = await classifyFiles({
      question: QUESTION,
      files: [file('a.ts', 2)],
      settings: settings({ timeoutMs: 20 }),
      fetch: hanging,
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('classifier_timeout');
    expect(result.files).toEqual([]);
  });

  it('is unavailable on a network error', async () => {
    const failing: Fetch = () => Promise.reject(new TypeError('fetch failed'));

    const result = await classifyFiles({
      question: QUESTION,
      files: [file('a.ts', 2)],
      settings: settings(),
      fetch: failing,
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('classifier_network_error');
  });

  // One failed request among many must not leave a list that looks complete: the answers
  // that did arrive are discarded, and no further request is started.
  it('discards the answers it has when one request fails, and stops asking', async () => {
    let calls = 0;
    const flaky: Fetch = async (input, init) => {
      calls += 1;
      if (calls === 2) return new Response('{}', { status: 503 });
      return fakeJev(() => 0.9).fetch(input, init);
    };
    const files = Array.from({ length: 8 }, (_unused, index) => file(`f${String(index)}.ts`, 40));

    const result = await classifyFiles({
      question: QUESTION,
      files,
      settings: settings({ maxRequestChars: 1000, parallelism: 1 }),
      fetch: flaky,
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('classifier_http_error:503');
    expect(result.files).toEqual([]);
    expect(calls).toBe(2);
  });

  it('is unavailable once its deadline has passed, without starting another request', async () => {
    const jev = fakeJev(() => 0.9);
    let clock = 0;
    const files = Array.from({ length: 4 }, (_unused, index) => file(`f${String(index)}.ts`, 40));

    const result = await classifyFiles({
      question: QUESTION,
      files,
      settings: settings({ maxRequestChars: 1000, parallelism: 1, deadlineMs: 100 }),
      fetch: jev.fetch,
      // Each look at the clock moves it 60 ms: the first request starts in time, the
      // second does not.
      now: () => (clock += 60),
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('deadline');
    expect(result.files).toEqual([]);
    expect(jev.bodies.length).toBeLessThan(4);
  });

  it('is ok with nothing to do when there are no files', async () => {
    const jev = fakeJev(() => 0.9);

    const result = await classifyFiles({
      question: QUESTION,
      files: [],
      settings: settings(),
      fetch: jev.fetch,
    });

    expect(result.status).toBe('ok');
    expect(result.files).toEqual([]);
    expect(jev.bodies).toEqual([]);
  });
});

describe('runScout', () => {
  it('classifies the tracked files the paths select, most likely path first', async () => {
    const root = repo({
      'src/auth/token.ts': lines(5, 'verify token'),
      'src/auth/session.py': lines(5, 'check session'),
      'src/billing/invoice.ts': lines(5, 'invoice'),
      'docs/readme.md': lines(5, 'readme'),
    });
    const jev = fakeJev(window => (window.path.startsWith('src/auth/') ? 0.8 : 0.05));

    const result = await runScout({
      question: QUESTION,
      paths: '["src/billing", "src/auth/*.ts", "src/auth"]',
      cwd: root,
      env: ENV,
      fetch: jev.fetch,
    });

    expect(result.status).toBe('ok');
    expect(result.question).toBe(QUESTION);
    expect(result.paths).toEqual(['src/billing', 'src/auth/*.ts', 'src/auth']);
    // Sent in path order, each file once even though two paths select token.ts.
    expect(jev.windows.map(window => window.path)).toEqual([
      'src/billing/invoice.ts',
      'src/auth/token.ts',
      'src/auth/session.py',
    ]);
    expect(result.files.map(entry => [entry.path, entry.relevant])).toEqual([
      ['src/auth/session.py', true],
      ['src/auth/token.ts', true],
      ['src/billing/invoice.ts', false],
    ]);
    expect(result.counts).toMatchObject({
      candidates: 3,
      classified: 3,
      relevant: 2,
      unclassified: 0,
    });
  });

  it('considers the whole checkout when no path is given', async () => {
    const root = repo({ 'a.ts': 'a', 'deep/b.ts': 'b' });
    const jev = fakeJev(() => 0.9);

    const result = await runScout({
      question: QUESTION,
      paths: '',
      cwd: root,
      env: ENV,
      fetch: jev.fetch,
    });

    expect(result.files.map(entry => entry.path).sort()).toEqual(['a.ts', 'deep/b.ts']);
  });

  // The filter runs before any request is built, so nothing in an excluded file can reach
  // the classifier. Every forbidden class plants its own marker; none may appear in a body.
  it('never sends an excluded file, whichever class excludes it', async () => {
    const outside = trackTempRoot(mkdtempSync(join(tmpdir(), 'context-scout-outside-')));
    writeFileSync(join(outside, 'host-secret.txt'), 'PLANTED_SYMLINK_TARGET\n');
    const root = repo({
      'src/app.ts': 'export const visible = "SENT_MARKER";\n',
      '.env': 'TOKEN=PLANTED_DOTENV\n',
      'config/.env.production': 'TOKEN=PLANTED_DOTENV_VARIANT\n',
      'deploy/id_rsa': 'PLANTED_SSH_KEY\n',
      'certs/server.pem': 'PLANTED_PEM\n',
      'config/credentials.json': '{"password":"PLANTED_CREDENTIALS"}\n',
      'src/embedded.ts': 'const k = `-----BEGIN RSA PRIVATE KEY-----\nPLANTED_KEY_BLOCK\n`;\n',
      'assets/logo.bin': new Uint8Array([80, 76, 65, 78, 84, 69, 68, 0, 1, 2, 66, 73, 78]),
      'assets/latin1.txt': new Uint8Array([80, 76, 65, 78, 84, 0xe9, 0xff, 0xfe, 68]),
      'src/huge.ts': `// PLANTED_OVERSIZE\n${'x'.repeat(4000)}\n`,
      'src/empty.ts': '',
      '.gitignore': 'generated/\n',
      // Tracked despite the ignore rule (force-added by the fixture).
      'generated/build.ts': 'export const built = "PLANTED_IGNORED";\n',
    });
    writeFileSync(join(root, 'src/untracked.ts'), 'export const draft = "PLANTED_UNTRACKED";\n');
    symlinkSync(join(outside, 'host-secret.txt'), join(root, 'src/link.ts'));
    git(root, 'add', '--force', 'src/link.ts');
    git(root, 'commit', '-q', '-m', 'link');
    const jev = fakeJev(() => 0.9);

    const result = await runScout({
      question: QUESTION,
      paths: '',
      cwd: root,
      env: { ...ENV, JEV_SCOUT_MAX_FILE_BYTES: '2000' },
      fetch: jev.fetch,
    });

    const sent = jev.bodies.join('\n');
    expect(sent).toContain('SENT_MARKER');
    expect(sent).not.toContain('PLANT');
    expect(result.status).toBe('ok');
    expect(result.files.map(entry => entry.path).sort()).toEqual(['.gitignore', 'src/app.ts']);
    expect(result.counts.excluded).toEqual({
      ignored: 1,
      secret: 6,
      not_regular_file: 1,
      too_large: 1,
      binary: 2,
      empty: 1,
    });
    // 14 tracked paths: the two classified and the twelve excluded. The untracked file is
    // never a candidate at all.
    expect(result.counts.candidates).toBe(14);
    expect(jev.windows.map(window => window.path)).not.toContain('src/untracked.ts');
  });

  it('never puts the API key in a request body or in its own result', async () => {
    const root = repo({ 'a.ts': 'a' });
    const jev = fakeJev(() => 0.9);

    const result = await runScout({
      question: QUESTION,
      paths: '',
      cwd: root,
      env: { ...ENV, JEV_API_KEY: 'sk-PLANTED-KEY' },
      fetch: jev.fetch,
    });

    expect(jev.bodies.join('\n')).not.toContain('sk-PLANTED-KEY');
    expect(JSON.stringify(result)).not.toContain('sk-PLANTED-KEY');
  });

  it('counts the files the file budget never read as unclassified', async () => {
    const root = repo({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c', 'd.ts': 'd' });
    const jev = fakeJev(() => 0.9);

    const result = await runScout({
      question: QUESTION,
      paths: '',
      cwd: root,
      env: { ...ENV, JEV_SCOUT_MAX_FILES: '2' },
      fetch: jev.fetch,
    });

    expect(result.status).toBe('truncated');
    expect(result.reason).toBe('max_files');
    expect(result.files.map(entry => entry.path)).toEqual(['a.ts', 'b.ts']);
    expect(result.counts).toMatchObject({ candidates: 4, classified: 2, unclassified: 2 });
  });

  it.each([
    ['no key', {}, 'no_api_key'],
    ['JEV_ENABLED=0', { ...ENV, JEV_ENABLED: '0' }, 'disabled'],
    ['JEV_SCOUT_ENABLED=false', { ...ENV, JEV_SCOUT_ENABLED: 'false' }, 'disabled'],
    [
      'a bad setting',
      { ...ENV, JEV_SCOUT_THRESHOLD: 'high' },
      'invalid_setting:JEV_SCOUT_THRESHOLD',
    ],
  ])('is unavailable and sends nothing with %s', async (_label, env, reason) => {
    const root = repo({ 'a.ts': 'a' });
    const jev = fakeJev(() => 0.9);

    const result = await runScout({
      question: QUESTION,
      paths: '',
      cwd: root,
      env,
      fetch: jev.fetch,
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(reason);
    expect(result.files).toEqual([]);
    expect(jev.bodies).toEqual([]);
  });

  it('is unavailable and sends nothing without a question', async () => {
    const root = repo({ 'a.ts': 'a' });
    const jev = fakeJev(() => 0.9);

    const result = await runScout({
      question: '  ',
      paths: '',
      cwd: root,
      env: ENV,
      fetch: jev.fetch,
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('no_question');
    expect(jev.bodies).toEqual([]);
  });

  it('is unavailable when the checkout cannot be listed', async () => {
    const notARepo = trackTempRoot(mkdtempSync(join(tmpdir(), 'context-scout-plain-')));
    writeFileSync(join(notARepo, 'a.ts'), 'a');
    const jev = fakeJev(() => 0.9);

    const result = await runScout({
      question: QUESTION,
      paths: '',
      cwd: notARepo,
      env: ENV,
      fetch: jev.fetch,
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('git_failed');
    expect(jev.bodies).toEqual([]);
  });

  it('is unavailable when a path reaches outside the checkout', async () => {
    const root = repo({ 'a.ts': 'a' });
    const jev = fakeJev(() => 0.9);

    const result = await runScout({
      question: QUESTION,
      paths: '["../"]',
      cwd: root,
      env: ENV,
      fetch: jev.fetch,
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('git_failed');
    expect(jev.bodies).toEqual([]);
  });

  it('reports a classifier failure as unavailable rather than throwing', async () => {
    const root = repo({ 'a.ts': 'a' });
    const failing: Fetch = () => Promise.resolve(new Response('nope', { status: 500 }));

    const result = await runScout({
      question: QUESTION,
      paths: '',
      cwd: root,
      env: ENV,
      fetch: failing,
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('classifier_http_error:500');
    expect(result.counts.candidates).toBe(1);
  });
});
