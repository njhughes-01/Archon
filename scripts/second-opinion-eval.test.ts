import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { Fetch } from '../.archon/workflows/sdlc/.shared/jev-client.ts';
import type { SecondOpinion } from '../.archon/workflows/sdlc/.shared/second-opinion.ts';
import {
  ACCURACY_FLOOR,
  EVAL_FIXTURE,
  formatReport,
  main,
  readCheckpoint,
  readLabelledLogs,
  runEval,
  scoreOutcomes,
  type Checkpoint,
  type LabelledLog,
  type Outcome,
} from './second-opinion-eval';

const track = trackTempRoots();

const CLASSES = ['code_defect', 'flaky_test', 'dependency_failure', 'environment_failure'];

const CHECKPOINT: Checkpoint = {
  question: 'Why did this check fail?',
  choices: Object.fromEntries(CLASSES.map(name => [name, `The failure is a ${name}.`])),
};

function answered(choice: string, confidence = 0.9): SecondOpinion {
  return {
    status: 'ok',
    reason: '',
    choice,
    probabilities: Object.fromEntries(CLASSES.map(name => [name, name === choice ? 1 : 0])),
    confidence,
    advisory: true,
  };
}

function unanswered(reason: string): SecondOpinion {
  return {
    status: 'unavailable',
    reason,
    choice: null,
    probabilities: {},
    confidence: null,
    advisory: true,
  };
}

/** `count` outcomes labelled `expected`, each answered with the next entry of `predicted`. */
function outcomes(expected: string, predicted: readonly string[], confidence = 0.9): Outcome[] {
  return predicted.map((choice, index) => ({
    log: `${expected}-${String(index + 1)}.txt`,
    expected,
    opinion: answered(choice, confidence),
    charsSent: 100,
  }));
}

/**
 * A classifier that reads the label a test log carries in its text (`LABEL=<class>`) and
 * answers with `answer(label)`. The tests plant mistakes through `answer`.
 */
function answeringBy(answer: (label: string) => string | Response): {
  fetch: Fetch;
  calls: () => number;
} {
  let calls = 0;
  const fetch: Fetch = (_input, init) => {
    calls += 1;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      state: { evidence: string };
      questions: Record<string, { criteria: Record<string, string> }>;
    };
    const label = /LABEL=(\w+)/.exec(body.state.evidence)?.[1] ?? '';
    const given = answer(label);
    if (typeof given !== 'string') return Promise.resolve(given);
    const [name, question] = Object.entries(body.questions)[0];
    const probabilities = Object.fromEntries(
      Object.keys(question.criteria).map(option => [option, option === given ? 0.75 : 0.25 / 3])
    );
    return Promise.resolve(
      Response.json({
        answers: { [name]: { type: 'choice', choice: given, confidence: 0.6, probabilities } },
      })
    );
  };
  return { fetch, calls: () => calls };
}

function labelled(labels: readonly string[]): LabelledLog[] {
  return labels.map((expected, index) => ({
    name: `${String(index + 1).padStart(2, '0')}.txt`,
    expected,
    text: `$ run the gate\nLABEL=${expected}\nexit 1`,
  }));
}

const ENV = { JEV_API_KEY: 'test-key', JEV_API_BASE: 'https://jev.example' };

describe('scoreOutcomes', () => {
  it('derives accuracy, the per-class figures and the confusion matrix from the answers', () => {
    const score = scoreOutcomes(CLASSES, [
      ...outcomes('code_defect', ['code_defect', 'code_defect', 'flaky_test'], 0.9),
      ...outcomes('flaky_test', ['flaky_test', 'environment_failure'], 0.5),
      ...outcomes('dependency_failure', ['dependency_failure', 'dependency_failure'], 0.8),
      ...outcomes(
        'environment_failure',
        ['environment_failure', 'environment_failure', 'code_defect'],
        0.6
      ),
    ]);

    expect(score.scored).toBe(true);
    expect(score.answered).toBe(10);
    expect(score.correct).toBe(7);
    expect(score.accuracy).toBe(0.7);
    expect(score.perClass).toEqual({
      code_defect: { total: 3, correct: 2, accuracy: 2 / 3 },
      flaky_test: { total: 2, correct: 1, accuracy: 0.5 },
      dependency_failure: { total: 2, correct: 2, accuracy: 1 },
      environment_failure: { total: 3, correct: 2, accuracy: 2 / 3 },
    });
    // Rows are what the answer key says; columns are what the classifier said.
    expect(score.confusion).toEqual({
      code_defect: { code_defect: 2, flaky_test: 1, dependency_failure: 0, environment_failure: 0 },
      flaky_test: { code_defect: 0, flaky_test: 1, dependency_failure: 0, environment_failure: 1 },
      dependency_failure: {
        code_defect: 0,
        flaky_test: 0,
        dependency_failure: 2,
        environment_failure: 0,
      },
      environment_failure: {
        code_defect: 1,
        flaky_test: 0,
        dependency_failure: 0,
        environment_failure: 2,
      },
    });
    // (3 * 0.9 + 2 * 0.5 + 2 * 0.8 + 3 * 0.6) / 10
    expect(score.meanConfidence).toBeCloseTo(0.71, 10);
    expect(score.charsSent).toBe(1000);
    expect(score.misclassified.map(miss => [miss.log, miss.expected, miss.predicted])).toEqual([
      ['code_defect-3.txt', 'code_defect', 'flaky_test'],
      ['flaky_test-2.txt', 'flaky_test', 'environment_failure'],
      ['environment_failure-3.txt', 'environment_failure', 'code_defect'],
    ]);
    expect(score.wronglyBlamedOnCode).toEqual(['environment_failure-3.txt']);
    expect(score.pass).toBe(false);
  });

  it('passes exactly at the floor when no machine or dependency failure was blamed on code', () => {
    // Ten logs, eight right; both mistakes are between other classes.
    const score = scoreOutcomes(CLASSES, [
      ...outcomes('code_defect', ['code_defect', 'code_defect', 'flaky_test']),
      ...outcomes('flaky_test', ['flaky_test', 'flaky_test']),
      ...outcomes('dependency_failure', ['dependency_failure', 'environment_failure']),
      ...outcomes('environment_failure', [
        'environment_failure',
        'environment_failure',
        'environment_failure',
      ]),
    ]);

    expect(ACCURACY_FLOOR).toBe(0.8);
    expect(score.accuracy).toBe(0.8);
    expect(score.wronglyBlamedOnCode).toEqual([]);
    expect(score.pass).toBe(true);
  });

  it('fails one answer below the floor', () => {
    const score = scoreOutcomes(CLASSES, [
      ...outcomes('code_defect', ['code_defect', 'flaky_test', 'flaky_test']),
      ...outcomes('flaky_test', ['flaky_test', 'flaky_test']),
      ...outcomes('dependency_failure', ['dependency_failure', 'environment_failure']),
      ...outcomes('environment_failure', [
        'environment_failure',
        'environment_failure',
        'environment_failure',
      ]),
    ]);

    expect(score.accuracy).toBe(0.7);
    expect(score.wronglyBlamedOnCode).toEqual([]);
    expect(score.pass).toBe(false);
  });

  it.each(['dependency_failure', 'environment_failure'])(
    'fails above the floor when one %s log was called a code defect',
    labelledClass => {
      const score = scoreOutcomes(CLASSES, [
        ...outcomes(
          'code_defect',
          Array.from({ length: 10 }, () => 'code_defect')
        ),
        ...outcomes(
          'flaky_test',
          Array.from({ length: 10 }, () => 'flaky_test')
        ),
        ...outcomes(labelledClass, ['code_defect']),
      ]);

      expect(score.accuracy).toBe(20 / 21);
      expect(score.wronglyBlamedOnCode).toEqual([`${labelledClass}-1.txt`]);
      expect(score.pass).toBe(false);
    }
  );

  it('does not count a flaky test called a code defect as the forbidden mistake', () => {
    const score = scoreOutcomes(CLASSES, [
      ...outcomes(
        'code_defect',
        Array.from({ length: 9 }, () => 'code_defect')
      ),
      ...outcomes('flaky_test', ['code_defect']),
    ]);

    expect(score.accuracy).toBe(0.9);
    expect(score.wronglyBlamedOnCode).toEqual([]);
    expect(score.pass).toBe(true);
  });

  it('is not scored when any log got no answer, whatever the rest say', () => {
    const score = scoreOutcomes(CLASSES, [
      ...outcomes('code_defect', ['code_defect', 'code_defect']),
      {
        log: 'late.txt',
        expected: 'flaky_test',
        opinion: unanswered('classifier_timeout'),
        charsSent: 100,
      },
    ]);

    expect(score.scored).toBe(false);
    expect(score.notScoredReason).toBe('late.txt: classifier_timeout');
    expect(score.accuracy).toBeNull();
    expect(score.answered).toBe(2);
    expect(score.pass).toBe(false);
  });

  it('is not scored when there was nothing to answer', () => {
    const score = scoreOutcomes(CLASSES, []);

    expect(score.scored).toBe(false);
    expect(score.notScoredReason).toBe('no labelled logs');
    expect(score.meanConfidence).toBeNull();
    expect(score.pass).toBe(false);
  });
});

describe('runEval', () => {
  it('asks about every log through the real second opinion and scores the answers', async () => {
    // Plants one forbidden mistake and one ordinary one.
    const classifier = answeringBy(label =>
      label === 'environment_failure'
        ? 'code_defect'
        : label === 'flaky_test'
          ? 'code_defect'
          : label
    );

    const report = await runEval({
      checkpoint: CHECKPOINT,
      logs: labelled([
        'code_defect',
        'flaky_test',
        'dependency_failure',
        'environment_failure',
        'code_defect',
      ]),
      env: ENV,
      fetch: classifier.fetch,
    });

    expect(classifier.calls()).toBe(5);
    expect(report.dry).toBe(false);
    expect(report.classifier).toBe('https://jev.example (jev-1.13.0)');
    expect(report.scored).toBe(true);
    expect(report.logs).toBe(5);
    expect(report.correct).toBe(3);
    expect(report.accuracy).toBe(0.6);
    expect(report.meanConfidence).toBeCloseTo(0.6, 10);
    expect(report.wronglyBlamedOnCode).toEqual(['04.txt']);
    expect(report.charsSent).toBeGreaterThan(5 * 'LABEL=code_defect'.length);
    expect(report.pass).toBe(false);
  });

  it('stops at the first log the classifier cannot answer, and is not scored', async () => {
    const classifier = answeringBy(label =>
      label === 'flaky_test' ? new Response('down', { status: 503 }) : label
    );

    const report = await runEval({
      checkpoint: CHECKPOINT,
      logs: labelled(['code_defect', 'flaky_test', 'dependency_failure', 'environment_failure']),
      env: ENV,
      fetch: classifier.fetch,
    });

    expect(classifier.calls()).toBe(2);
    expect(report.scored).toBe(false);
    expect(report.notScoredReason).toBe('02.txt: classifier_http_error:503');
    expect(report.logs).toBe(4);
    expect(report.answered).toBe(1);
  });

  it('sends nothing without a key, and is not scored', async () => {
    const classifier = answeringBy(label => label);

    const report = await runEval({
      checkpoint: CHECKPOINT,
      logs: labelled(['code_defect', 'flaky_test']),
      env: {},
      fetch: classifier.fetch,
    });

    expect(classifier.calls()).toBe(0);
    expect(report.scored).toBe(false);
    expect(report.notScoredReason).toBe('no_api_key');
    expect(report.classifier).toBe('unavailable');
  });

  it('answers from the answer key on a dry run, and says so', async () => {
    const report = await runEval({
      checkpoint: CHECKPOINT,
      logs: labelled(['code_defect', 'flaky_test', 'dependency_failure', 'environment_failure']),
      // No key, and both switches off: a dry run needs neither and sends nothing.
      env: { JEV_ENABLED: '0', JEV_OPINION_ENABLED: '0' },
      dry: true,
    });

    expect(report.dry).toBe(true);
    expect(report.classifier).toContain('dry run');
    expect(report.scored).toBe(true);
    expect(report.accuracy).toBe(1);
    expect(report.pass).toBe(true);
  });

  it('never prints a log or the key', async () => {
    const classifier = answeringBy(() => 'code_defect');
    const report = await runEval({
      checkpoint: CHECKPOINT,
      logs: labelled(['flaky_test', 'environment_failure']),
      env: {
        ...ENV,
        JEV_API_KEY: 'PLANTED-EVAL-KEY',
        JEV_API_BASE: 'https://user:PLANTEDPASS@jev.example/v9?k=PLANTEDQUERY',
      },
      fetch: classifier.fetch,
    });

    const printed = formatReport(report) + JSON.stringify(report);
    expect(printed).not.toContain('run the gate');
    expect(printed).not.toContain('PLANTED');
    expect(report.classifier).toBe('https://jev.example (jev-1.13.0)');
  });
});

describe('formatReport', () => {
  it('prints the figures, the matrix and the mistakes of a scored run', async () => {
    const classifier = answeringBy(label =>
      label === 'environment_failure' ? 'code_defect' : label
    );
    const report = await runEval({
      checkpoint: CHECKPOINT,
      logs: labelled(['code_defect', 'flaky_test', 'dependency_failure', 'environment_failure']),
      env: ENV,
      fetch: classifier.fetch,
    });

    const text = formatReport(report);

    expect(text).toContain('Second opinion evaluation');
    expect(text).toContain('accuracy:   0.75  (3 of 4 logs classified as labelled)');
    expect(text).toContain('confidence: 0.60  (mean over 4 answers)');
    expect(text).toMatch(/environment_failure\s+0\.00\s+\(0 of 1\)/);
    expect(text).toContain('04.txt: labelled environment_failure, classified code_defect (0.60)');
    const last = text.split('\n').at(-1) ?? '';
    expect(last).toStartWith('RESULT: FAIL.');
    expect(last).toContain('1 log(s) labelled dependency_failure or environment_failure');
  });

  it('labels every result line of a dry run as dry', async () => {
    const report = await runEval({
      checkpoint: CHECKPOINT,
      logs: labelled(CLASSES),
      env: {},
      dry: true,
    });

    const last = formatReport(report).split('\n').at(-1) ?? '';
    expect(last).toStartWith(
      'RESULT (dry run: the answers came from the answer key, not from a classifier): PASS.'
    );
  });

  it('says NOT SCORED, with the reason, and prints no figures', async () => {
    const report = await runEval({
      checkpoint: CHECKPOINT,
      logs: labelled(CLASSES),
      env: {},
    });

    const text = formatReport(report);
    expect(text).not.toContain('accuracy:');
    expect(text.split('\n').at(-1)).toBe(
      'RESULT: NOT SCORED. The classifier did not answer every log (no_api_key), so there is nothing to measure.'
    );
  });
});

describe('the shipped fixture', () => {
  it('asks the question the validate workflow asks, about its four classes', async () => {
    const checkpoint = await readCheckpoint();

    expect(Object.keys(checkpoint.choices)).toEqual(CLASSES);
    expect(checkpoint.question).not.toBe('');
  });

  it('holds at least ten logs of every class, each the size the workflow would send', async () => {
    const logs = await readLabelledLogs(EVAL_FIXTURE, CLASSES);

    for (const name of CLASSES) {
      expect(logs.filter(log => log.expected === name).length).toBeGreaterThanOrEqual(10);
    }
    for (const log of logs) {
      // validation.md records the last 60 lines of a failing check's output.
      expect({ log: log.name, lines: log.text.trimEnd().split('\n').length <= 60 }).toEqual({
        log: log.name,
        lines: true,
      });
      // A log that names its own label would be answering the question for the classifier.
      // A runner's own word for a retried test is evidence, not a label, and stays.
      expect({
        log: log.name,
        named: /code_defect|flaky_test|dependency_failure|environment_failure/i.test(log.text),
      }).toEqual({
        log: log.name,
        named: false,
      });
    }
  });

  it('passes a dry run end to end, with every log answered from the key', async () => {
    const lines: string[] = [];

    const code = await main(['--dry', '--json'], {}, line => lines.push(line));

    expect(code).toBe(0);
    const report = JSON.parse(lines.join('\n')) as {
      dry: boolean;
      scored: boolean;
      logs: number;
      accuracy: number;
      pass: boolean;
      charsSent: number;
    };
    expect(report.dry).toBe(true);
    expect(report.scored).toBe(true);
    expect(report.logs).toBeGreaterThanOrEqual(40);
    expect(report.accuracy).toBe(1);
    expect(report.pass).toBe(true);
    expect(report.charsSent).toBeGreaterThan(0);
  });
});

describe('readLabelledLogs', () => {
  function fixture(key: unknown, logs: Record<string, string>): string {
    const dir = track(mkdtempSync(join(tmpdir(), 'second-opinion-eval-')));
    mkdirSync(join(dir, 'logs'));
    writeFileSync(
      join(dir, 'answer-key.json'),
      typeof key === 'string' ? key : JSON.stringify(key)
    );
    for (const [name, text] of Object.entries(logs)) writeFileSync(join(dir, 'logs', name), text);
    return dir;
  }
  const label = (name: string): { class: string; why: string } => ({ class: name, why: 'because' });

  it('reads every log with its label, in name order', async () => {
    const dir = fixture(
      { logs: { 'b.txt': label('flaky_test'), 'a.txt': label('code_defect') } },
      { 'a.txt': 'first', 'b.txt': 'second' }
    );

    expect(await readLabelledLogs(dir, CLASSES)).toEqual([
      { name: 'a.txt', expected: 'code_defect', text: 'first' },
      { name: 'b.txt', expected: 'flaky_test', text: 'second' },
    ]);
  });

  it.each([
    ['is not JSON', '{nope', {}, 'could not be read as JSON'],
    ['has no logs map', { entries: {} }, {}, 'is not an answer key'],
    [
      'labels a log with a class the workflow does not offer',
      { logs: { 'a.txt': label('cosmic_rays') } },
      { 'a.txt': 'x' },
      'a.txt is labelled cosmic_rays',
    ],
    [
      'names a log that does not exist',
      { logs: { 'a.txt': label('code_defect'), 'gone.txt': label('flaky_test') } },
      { 'a.txt': 'x' },
      'gone.txt',
    ],
    [
      'leaves a log unlabelled',
      { logs: { 'a.txt': label('code_defect') } },
      { 'a.txt': 'x', 'stray.txt': 'y' },
      'stray.txt',
    ],
  ])('refuses a key that %s', async (_label, key, logs, message) => {
    const dir = fixture(key, logs);

    expect(readLabelledLogs(dir, CLASSES)).rejects.toThrow(message);
  });
});

describe('main', () => {
  async function run(
    argv: string[],
    env: NodeJS.ProcessEnv,
    fetch?: Fetch
  ): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    const code = await main(argv, env, line => lines.push(line), fetch);
    return { code, text: lines.join('\n') };
  }

  /** Answers every shipped log as its key labels it, except those `mistake` remaps. */
  async function keyed(mistake: (expected: string) => string): Promise<Fetch> {
    const logs = await readLabelledLogs(EVAL_FIXTURE, CLASSES);
    return (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        state: { evidence: string };
        questions: Record<string, unknown>;
      };
      const log = logs.find(candidate => candidate.text.trim() === body.state.evidence.trim());
      if (log === undefined) return Promise.resolve(new Response('unknown log', { status: 400 }));
      const choice = mistake(log.expected);
      const probabilities = Object.fromEntries(
        CLASSES.map(name => [name, name === choice ? 1 : 0])
      );
      return Promise.resolve(
        Response.json({
          answers: {
            [Object.keys(body.questions)[0]]: {
              type: 'choice',
              choice,
              confidence: 1,
              probabilities,
            },
          },
        })
      );
    };
  }

  it('exits 0 when a classifier passes, with a result line that is not labelled dry', async () => {
    const { code, text } = await run([], ENV, await keyed(expected => expected));

    expect(code).toBe(0);
    expect(text.split('\n').at(-1)).toStartWith('RESULT: PASS.');
  });

  it('exits 1 when a classifier was scored and fell short', async () => {
    const { code, text } = await run(
      [],
      ENV,
      await keyed(expected => (expected === 'environment_failure' ? 'code_defect' : expected))
    );

    expect(code).toBe(1);
    expect(text.split('\n').at(-1)).toStartWith('RESULT: FAIL.');
  });

  it('exits 2 when the classifier is unavailable', async () => {
    const { code, text } = await run([], {});

    expect(code).toBe(2);
    expect(text.split('\n').at(-1)).toContain('NOT SCORED');
  });

  it('exits 0 on a dry run and labels its result line', async () => {
    const { code, text } = await run(['--dry'], {});

    expect(code).toBe(0);
    expect(text.split('\n').at(-1)).toStartWith('RESULT (dry run:');
  });

  it('exits 2 on an argument it does not know', async () => {
    const { code, text } = await run(['--live'], ENV);

    expect(code).toBe(2);
    expect(text).toContain('Unsupported argument: --live');
    expect(text).toContain('Usage:');
  });

  it('exits 2 when the fixture cannot be read', async () => {
    const empty = track(mkdtempSync(join(tmpdir(), 'second-opinion-eval-')));

    const { code, text } = await run(['--dry', '--fixture', empty], {});

    expect(code).toBe(2);
    expect(text).toContain('Cannot run the evaluation:');
  });
});
