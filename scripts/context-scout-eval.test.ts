import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { Fetch } from '../.archon/workflows/sdlc/.shared/jev-client.ts';
import type { ScoutResult } from '../.archon/workflows/sdlc/.shared/context-scout.ts';
import {
  EVAL_FIXTURE,
  MAX_SELECTED_SHARE,
  formatReport,
  main,
  oracleFetch,
  readAnswerKey,
  runEval,
  scoreSelection,
  type AnswerKey,
} from './context-scout-eval';

const KEY: AnswerKey = {
  question: 'Is this the thing?',
  paths: [],
  relevant: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
};

function result(
  files: [path: string, confidence: number][],
  overrides: Partial<ScoutResult> = {},
  threshold = 0.3
): ScoutResult {
  return {
    status: 'ok',
    reason: '',
    question: KEY.question,
    paths: [],
    skipped: [],
    files: files.map(([path, confidence]) => ({
      path,
      confidence,
      relevant: confidence >= threshold,
      evidence: { startLine: 1, endLine: 10 },
    })),
    counts: {
      candidates: files.length,
      badPaths: 0,
      excluded: { ignored: 0, secret: 0, not_regular_file: 0, too_large: 0, binary: 0, empty: 0 },
      classified: files.length,
      relevant: files.filter(([, confidence]) => confidence >= threshold).length,
      unclassified: 0,
      windows: files.length,
      requests: 1,
      charsSent: 1234,
    },
    ...overrides,
  };
}

/** Answers yes (0.9) for windows of the listed files and no (0.05) for the rest. */
function sayingYesTo(paths: readonly string[]): Fetch {
  return (_input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      state: Record<string, { path: string }>;
      questions: Record<string, unknown>;
    };
    const answers = Object.fromEntries(
      Object.keys(body.questions).map(name => [
        name,
        { type: 'noul', noul: paths.includes(body.state[name].path) ? 0.9 : 0.05 },
      ])
    );
    return Promise.resolve(Response.json({ answers }));
  };
}

describe('scoreSelection', () => {
  it('counts hits, misses and extras, and derives recall and precision from them', () => {
    const report = scoreSelection(
      KEY,
      result(
        [
          ['a.ts', 0.9], // relevant, selected
          ['b.ts', 0.6], // relevant, selected
          ['x.ts', 0.5], // decoy, selected: a false positive
          ['c.ts', 0.2], // relevant, not selected: a false negative
          ['y.ts', 0.1], // decoy, not selected
        ],
        // d.ts was a candidate the scout never classified.
        { counts: { ...result([]).counts, candidates: 6, classified: 5, unclassified: 1 } }
      )
    );

    expect(report.relevantTotal).toBe(4);
    expect(report.selected).toBe(3);
    expect(report.classifiable).toBe(6);
    expect(report.truePositives).toBe(2);
    expect(report.falsePositives).toEqual(['x.ts']);
    // A relevant file with no answer is a miss, exactly like one answered no.
    expect(report.falseNegatives).toEqual(['c.ts', 'd.ts']);
    expect(report.recall).toBe(2 / 4);
    expect(report.precision).toBe(2 / 3);
    expect(report.pass).toBe(false);
  });

  it('passes at full recall when at most half of the files were selected', () => {
    // Four relevant files among eight: exactly half, which is the most that passes.
    const half = scoreSelection(
      KEY,
      result([
        ['a.ts', 0.9],
        ['b.ts', 0.8],
        ['c.ts', 0.7],
        ['d.ts', 0.6],
        ['w.ts', 0.2],
        ['x.ts', 0.1],
        ['y.ts', 0.1],
        ['z.ts', 0.1],
      ])
    );
    expect(half.recall).toBe(1);
    expect(half.precision).toBe(1);
    expect(half.selected).toBe(4);
    expect(half.classifiable).toBe(8);
    expect(half.pass).toBe(true);
  });

  it('does not pass at full recall when more than half of the files were selected', () => {
    // One decoy too many: five of eight. Selecting most of the repository reaches full
    // recall without narrowing anything worth the name.
    const overHalf = scoreSelection(
      KEY,
      result([
        ['a.ts', 0.9],
        ['b.ts', 0.8],
        ['c.ts', 0.7],
        ['d.ts', 0.6],
        ['w.ts', 0.5],
        ['x.ts', 0.1],
        ['y.ts', 0.1],
        ['z.ts', 0.1],
      ])
    );
    expect(overHalf.recall).toBe(1);
    expect(overHalf.precision).toBe(4 / 5);
    expect(overHalf.selected).toBe(5);
    expect(overHalf.pass).toBe(false);
    expect(MAX_SELECTED_SHARE).toBe(0.5);
  });

  // Files the scout withheld (secrets, binaries) were never its to select, so they do not
  // make a broad selection look narrow.
  it('measures narrowing against the files it could read, not every tracked file', () => {
    const report = scoreSelection(
      { question: 'q', paths: [], relevant: ['a.ts', 'b.ts'] },
      result(
        [
          ['a.ts', 0.9],
          ['b.ts', 0.8],
          ['x.ts', 0.7],
          ['y.ts', 0.1],
        ],
        // Ten tracked files, six of them withheld.
        {
          counts: {
            ...result([]).counts,
            candidates: 10,
            classified: 4,
            excluded: {
              ignored: 0,
              secret: 5,
              not_regular_file: 0,
              too_large: 0,
              binary: 1,
              empty: 0,
            },
          },
        }
      )
    );

    expect(report.recall).toBe(1);
    expect(report.selected).toBe(3);
    expect(report.candidates).toBe(10);
    expect(report.classifiable).toBe(4);
    // Three of the four it could read is not narrowing, though it is under half of ten.
    expect(report.pass).toBe(false);
  });

  it('has no precision when nothing was selected', () => {
    const report = scoreSelection(
      KEY,
      result([
        ['a.ts', 0.1],
        ['x.ts', 0.1],
      ])
    );
    expect(report.selected).toBe(0);
    expect(report.precision).toBeNull();
    expect(report.recall).toBe(0);
  });

  it('finds the highest threshold that still selects every relevant file', () => {
    const report = scoreSelection(
      KEY,
      result([
        ['a.ts', 0.9],
        ['b.ts', 0.8],
        ['x.ts', 0.75],
        ['c.ts', 0.7],
        ['d.ts', 0.45],
        ['y.ts', 0.4],
        ['z.ts', 0.1],
      ])
    );
    // The weakest relevant file scored 0.45; at that threshold x.ts still comes along.
    expect(report.recallSafeThreshold).toEqual({ threshold: 0.45, selected: 5 });
  });

  it('has no recall-safe threshold when a relevant file was never answered', () => {
    const report = scoreSelection(
      KEY,
      result([
        ['a.ts', 0.9],
        ['b.ts', 0.8],
        ['c.ts', 0.7],
      ])
    );
    expect(report.falseNegatives).toEqual(['d.ts']);
    expect(report.recallSafeThreshold).toBeNull();
  });

  it('does not pass an unavailable or truncated run, whatever was selected', () => {
    const files: [string, number][] = [
      ['a.ts', 0.9],
      ['b.ts', 0.9],
      ['c.ts', 0.9],
      ['d.ts', 0.9],
      ['w.ts', 0.1],
      ['x.ts', 0.1],
      ['y.ts', 0.1],
      ['z.ts', 0.1],
    ];
    // The same selection passes when the run is complete, so only the status differs.
    expect(scoreSelection(KEY, result(files)).pass).toBe(true);
    expect(
      scoreSelection(KEY, result(files, { status: 'truncated', reason: 'max_files' })).pass
    ).toBe(false);
    expect(
      scoreSelection(KEY, result([], { status: 'unavailable', reason: 'classifier_timeout' })).pass
    ).toBe(false);
  });
});

describe('the seeded fixture', () => {
  it('has an answer key whose every file is tracked in the fixture repository', async () => {
    const key = await readAnswerKey(join(EVAL_FIXTURE, 'answer-key.json'));
    expect(key.relevant).toHaveLength(7);

    // The oracle answers from the key, so this run also proves the key and repo agree.
    const report = await runEval({ repoDir: join(EVAL_FIXTURE, 'repo'), key, dry: true, env: {} });
    expect(report.status).toBe('ok');
    expect(report.classifiable).toBe(21);
  });

  it('scores a perfect run from the oracle: every relevant file and no decoy', async () => {
    const key = await readAnswerKey(join(EVAL_FIXTURE, 'answer-key.json'));

    const report = await runEval({ repoDir: join(EVAL_FIXTURE, 'repo'), key, dry: true, env: {} });

    expect(report.recall).toBe(1);
    expect(report.precision).toBe(1);
    expect(report.selected).toBe(7);
    expect(report.falseNegatives).toEqual([]);
    expect(report.falsePositives).toEqual([]);
    expect(report.charsSent).toBeGreaterThan(0);
    expect(report.pass).toBe(true);
  });

  it('scores a classifier that misses one file and adds one decoy', async () => {
    const key = await readAnswerKey(join(EVAL_FIXTURE, 'answer-key.json'));
    const missed = 'services/api/utils/helpers.ts';
    const decoy = 'services/api/cache/session_cache.ts';
    const said = [...key.relevant.filter(path => path !== missed), decoy];

    const report = await runEval({
      repoDir: join(EVAL_FIXTURE, 'repo'),
      key,
      env: { JEV_API_KEY: 'test-key', JEV_API_BASE: 'https://jev.example' },
      fetch: sayingYesTo(said),
    });

    expect(report.falseNegatives).toEqual([missed]);
    expect(report.falsePositives).toEqual([decoy]);
    expect(report.recall).toBe(6 / 7);
    expect(report.precision).toBe(6 / 7);
    expect(report.selected).toBe(7);
    expect(report.classifiable).toBe(21);
    expect(report.pass).toBe(false);
  });

  it('reports an unavailable classifier instead of scoring it', async () => {
    const key = await readAnswerKey(join(EVAL_FIXTURE, 'answer-key.json'));

    const report = await runEval({
      repoDir: join(EVAL_FIXTURE, 'repo'),
      key,
      env: { JEV_API_KEY: 'test-key', JEV_API_BASE: 'https://jev.example' },
      fetch: () => Promise.resolve(new Response('down', { status: 503 })),
    });

    expect(report.status).toBe('unavailable');
    expect(report.reason).toBe('classifier_http_error:503');
    expect(report.pass).toBe(false);
  });

  it('refuses an answer key that names a file the repository does not track', async () => {
    const key = await readAnswerKey(join(EVAL_FIXTURE, 'answer-key.json'));
    const stale = { ...key, relevant: [...key.relevant, 'services/api/auth/removed.ts'] };

    expect(
      runEval({ repoDir: join(EVAL_FIXTURE, 'repo'), key: stale, dry: true, env: {} })
    ).rejects.toThrow('services/api/auth/removed.ts');
  });

  it('answers a window from the key alone in the oracle', async () => {
    const fetch = oracleFetch({ question: 'q', paths: [], relevant: ['yes.ts'] });
    const response = await fetch('https://unused.example', {
      body: JSON.stringify({
        state: { w0000: { path: 'yes.ts' }, w0001: { path: 'no.ts' } },
        questions: { w0000: {}, w0001: {} },
      }),
    });
    expect(await response.json()).toEqual({
      answers: { w0000: { type: 'noul', noul: 1 }, w0001: { type: 'noul', noul: 0 } },
    });
  });
});

describe('formatReport', () => {
  it('prints the four measures, the misses and the extras, and no file contents', async () => {
    const key = await readAnswerKey(join(EVAL_FIXTURE, 'answer-key.json'));
    const missed = 'services/gateway/authn.go';
    const report = await runEval({
      repoDir: join(EVAL_FIXTURE, 'repo'),
      key,
      env: { JEV_API_KEY: 'sk-PLANTED-KEY', JEV_API_BASE: 'https://jev.example' },
      fetch: sayingYesTo(key.relevant.filter(path => path !== missed)),
    });

    const text = formatReport(report);

    expect(text).toContain('recall:     0.86  (6 of 7 relevant files selected)');
    expect(text).toContain('precision:  1.00  (6 of 6 selected files are relevant)');
    expect(text).toContain('selected:   6 of 21 files');
    expect(text).toMatch(
      /sent: {7}[\d,]+ characters of code and question text in \d+ requests? \(\d+ windows\)/
    );
    expect(text).toContain(`missed:     ${missed}`);
    expect(text).toContain('RESULT: FAIL');
    // Paths and numbers only: nothing from inside a file, and never the key.
    expect(text).not.toContain('CheckClaims');
    expect(text).not.toContain('sk-PLANTED-KEY');
  });
});

describe('the classifier line', () => {
  it('names the endpoint without any credentials its URL carries', async () => {
    const key = await readAnswerKey(join(EVAL_FIXTURE, 'answer-key.json'));

    const report = await runEval({
      repoDir: join(EVAL_FIXTURE, 'repo'),
      key,
      env: {
        JEV_API_KEY: 'test-key',
        JEV_API_BASE: 'https://user:PLANTED-PASSWORD@jev.example:8443/base?token=PLANTED-QUERY',
      },
      fetch: sayingYesTo(key.relevant),
    });

    expect(report.classifier).toBe('https://jev.example:8443 (jev-1.13.0)');
    expect(formatReport(report)).not.toContain('PLANTED');
  });

  it('does not echo a base URL it cannot parse', async () => {
    const key = await readAnswerKey(join(EVAL_FIXTURE, 'answer-key.json'));

    const report = await runEval({
      repoDir: join(EVAL_FIXTURE, 'repo'),
      key,
      env: { JEV_API_KEY: 'test-key', JEV_API_BASE: 'PLANTED not a url' },
      fetch: sayingYesTo(key.relevant),
    });

    expect(report.classifier).toBe('unparseable JEV_API_BASE (jev-1.13.0)');
  });
});

const trackTempRoot = trackTempRoots();

describe('main', () => {
  it('runs the dry evaluation offline, exits 0, and says on the result line that it was dry', async () => {
    const lines: string[] = [];

    const code = await main(['--dry'], {}, line => lines.push(line));

    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('classifier: dry run');
    expect(text).toContain('recall:     1.00  (7 of 7 relevant files selected)');
    // A pasted last line must not read as a classifier's result.
    expect(lines.at(-1)?.split('\n').at(-1)).toBe(
      'RESULT (dry run: the answers came from the answer key, not from a classifier): PASS. ' +
        'Recall 1.00, with 7 of 21 files selected.'
    );
  });

  it('marks a dry run in the JSON report too', async () => {
    const lines: string[] = [];

    const code = await main(['--dry', '--json'], {}, line => lines.push(line));

    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ dry: true, pass: true, recall: 1 });
  });

  it('does not mark a run answered by a classifier as dry', async () => {
    const key = await readAnswerKey(join(EVAL_FIXTURE, 'answer-key.json'));

    const report = await runEval({
      repoDir: join(EVAL_FIXTURE, 'repo'),
      key,
      env: { JEV_API_KEY: 'test-key', JEV_API_BASE: 'https://jev.example' },
      fetch: sayingYesTo(key.relevant),
    });

    expect(report.dry).toBe(false);
    expect(formatReport(report)).toContain(
      'RESULT: PASS. Recall 1.00, with 7 of 21 files selected.'
    );
    expect(formatReport(report)).not.toContain('dry run');
  });

  it('exits 2 and says what is missing when asked for a live run without a key', async () => {
    const lines: string[] = [];

    const code = await main([], { JEV_API_KEY: '' }, line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('unavailable (no_api_key)');
  });

  it('exits 2 on an argument it does not know', async () => {
    const lines: string[] = [];

    const code = await main(['--threshold', '0.5'], {}, line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('--threshold');
  });

  // Exit 1 means "the classifier was measured and fell short". A run that could not be
  // set up measured nothing, so each of these is 2, with the cause in the output.
  describe('exits 2, with a message, when the evaluation cannot be set up', () => {
    function scratch(): string {
      return trackTempRoot(mkdtempSync(join(tmpdir(), 'context-scout-eval-')));
    }

    async function run(argv: string[]): Promise<{ code: number; text: string }> {
      const lines: string[] = [];
      const code = await main(argv, {}, line => lines.push(line));
      return { code, text: lines.join('\n') };
    }

    it('for an answer key that does not exist', async () => {
      const missing = join(scratch(), 'no-such-key.json');
      const { code, text } = await run(['--dry', '--key', missing]);
      expect(code).toBe(2);
      expect(text).toContain('Cannot run the evaluation');
      expect(text).toContain(missing);
    });

    it('for an answer key that is not JSON', async () => {
      const key = join(scratch(), 'key.json');
      writeFileSync(key, '{ not json');
      const { code, text } = await run(['--dry', '--key', key]);
      expect(code).toBe(2);
      expect(text).toContain('Cannot run the evaluation');
      expect(text).toContain(key);
    });

    it('for an answer key of the wrong shape', async () => {
      const key = join(scratch(), 'key.json');
      writeFileSync(key, JSON.stringify({ question: 'q', relevant: ['a.ts'] }));
      const { code, text } = await run(['--dry', '--key', key]);
      expect(code).toBe(2);
      expect(text).toContain('is not an answer key');
    });

    it('for a repository that is not a git checkout', async () => {
      const plain = scratch();
      writeFileSync(join(plain, 'a.ts'), 'a');
      const { code, text } = await run(['--dry', '--repo', plain]);
      expect(code).toBe(2);
      expect(text).toContain('Cannot run the evaluation');
      expect(text).toContain(plain);
    });

    it('for an answer key that names a file the repository does not track', async () => {
      const key = join(scratch(), 'key.json');
      writeFileSync(
        key,
        JSON.stringify({
          question: 'q',
          paths: [],
          relevant: { 'services/api/gone.ts': 'removed' },
        })
      );
      const { code, text } = await run(['--dry', '--key', key]);
      expect(code).toBe(2);
      expect(text).toContain('services/api/gone.ts');
    });

    it('for an option that is missing its value', async () => {
      const { code, text } = await run(['--dry', '--key']);
      expect(code).toBe(2);
      expect(text).toContain('--key');
    });
  });
});
