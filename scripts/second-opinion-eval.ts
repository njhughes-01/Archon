#!/usr/bin/env bun
/**
 * Measures the second opinion's failure classification against labelled failure logs.
 *
 * When a project gate goes red, archon-validate's `failure-class` node asks a classifier
 * which of four kinds of failure the record shows
 * (.archon/workflows/sdlc/.shared/second-opinion.ts). This asks that same question, with
 * the choices the workflow file authors, about every seeded log in the fixture, and
 * compares the answers with the answer key: accuracy overall and per class, the confusion
 * matrix, mean confidence, and characters sent.
 *
 * A live run calls the real classifier, so it needs a key and the network and is not part
 * of `bun run test`. It is a manual command:
 *
 *   bun --env-file="$HOME/.archon/.env" run scripts/second-opinion-eval.ts
 *
 * which reads JEV_API_KEY and the other JEV_* settings from the file Archon itself reads
 * them from, or export them and run `bun run second-opinion-eval`. `--dry` answers from
 * the answer key instead of a classifier: no key, nothing sent. It proves the pipeline and
 * the arithmetic, not the classifier.
 *
 * What it does not measure: whether an agent that is handed the opinion makes fewer
 * unnecessary edits. That takes paired workflow runs; the pack README describes them.
 *
 * Usage:
 *   bun run scripts/second-opinion-eval.ts [--dry] [--json] [--fixture <dir>]
 *
 * Exit codes:
 *   0  scored, and it passed: accuracy at or above the floor, and no log labelled as a
 *      dependency or environment failure classified as a code defect
 *   1  scored, and it did not pass
 *   2  not scored: the classifier was unavailable or did not answer every log, the
 *      evaluation could not be set up (answer key, logs, workflow file), or bad usage
 *
 * Prints log names and numbers only. Never a log's contents, never the key.
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Fetch } from '../.archon/workflows/sdlc/.shared/jev-client.ts';
import {
  askSecondOpinion,
  parseChoices,
  readOpinionSettings,
  type SecondOpinion,
} from '../.archon/workflows/sdlc/.shared/second-opinion.ts';

export const EVAL_FIXTURE = resolve(
  import.meta.dir,
  '../.archon/scripts/__tests__/fixtures/second-opinion-eval'
);

const VALIDATE_WORKFLOW = resolve(
  import.meta.dir,
  '../.archon/workflows/sdlc/validate/archon-validate.yaml'
);
const CHECKPOINT_NODE = 'failure-class';

/** The lowest share of logs classified as labelled that still passes. */
export const ACCURACY_FLOOR = 0.8;

/**
 * The mistake that fails a run whatever the accuracy: a failure the machine or a package
 * caused, called a defect in the code. It is the one that sends an agent to edit code
 * that was never wrong, which is what the checkpoint exists to prevent.
 */
const BLAMES_CODE = 'code_defect';
const NOT_THE_CODE: readonly string[] = ['dependency_failure', 'environment_failure'];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(path).text()) as unknown;
  } catch (error) {
    // Bun's parse error names a position, not the file it came from.
    throw new Error(`${path} could not be read as JSON: ${messageOf(error)}`, { cause: error });
  }
}

/** The question and choices one checkpoint asks. */
export interface Checkpoint {
  question: string;
  /** Option name to its criterion, in the order the workflow lists them. */
  choices: Record<string, string>;
}

/**
 * What the validate workflow's `failure-class` node asks, read from the workflow file
 * itself, so the evaluation measures the question as authored and never a copy of it.
 */
export async function readCheckpoint(workflowPath = VALIDATE_WORKFLOW): Promise<Checkpoint> {
  const workflow: unknown = Bun.YAML.parse(await Bun.file(workflowPath).text());
  const nodes = isRecord(workflow) && Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const node = nodes.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.id === CHECKPOINT_NODE
  );
  const bindings = node !== undefined && isRecord(node.with) ? node.with : {};
  const question = typeof bindings.question === 'string' ? bindings.question.trim() : '';
  // The engine hands a script a list as JSON text; read it the way the script does.
  const choices = parseChoices(JSON.stringify(bindings.choices ?? null));
  if (question === '' || Object.keys(choices).length === 0) {
    throw new Error(
      `${workflowPath} has no '${CHECKPOINT_NODE}' node with a question and choices to evaluate`
    );
  }
  return { question, choices };
}

/** One seeded failure log and the class the answer key gives it. */
export interface LabelledLog {
  /** File name under the fixture's `logs/` directory. */
  name: string;
  expected: string;
  text: string;
}

/**
 * Every log under `<fixtureDir>/logs`, labelled by `<fixtureDir>/answer-key.json`.
 *
 * The key maps each log's file name to `{ class, why }`; `why` is for whoever audits the
 * label. A key and a directory that disagree are refused before anything is spent: a log
 * with no label would silently go unmeasured, and a label with no log or with a class the
 * workflow does not offer would count as a miss forever.
 */
export async function readLabelledLogs(
  fixtureDir: string,
  classes: readonly string[]
): Promise<LabelledLog[]> {
  const keyPath = join(fixtureDir, 'answer-key.json');
  const key = await readJson(keyPath);
  if (!isRecord(key) || !isRecord(key.logs)) {
    throw new Error(`${keyPath} is not an answer key: it needs a "logs" map`);
  }
  const logsDir = join(fixtureDir, 'logs');
  const present = readdirSync(logsDir)
    .filter(name => name.endsWith('.txt'))
    .sort();
  const labelledNames = Object.keys(key.logs).sort();
  const unlabelled = present.filter(name => !labelledNames.includes(name));
  if (unlabelled.length > 0) {
    throw new Error(`${keyPath} has no label for: ${unlabelled.join(', ')}`);
  }
  const missing = labelledNames.filter(name => !present.includes(name));
  if (missing.length > 0) {
    throw new Error(`${keyPath} labels logs that are not in ${logsDir}: ${missing.join(', ')}`);
  }

  const logs: LabelledLog[] = [];
  for (const name of labelledNames) {
    const label = key.logs[name];
    const expected = isRecord(label) && typeof label.class === 'string' ? label.class : '';
    if (!classes.includes(expected)) {
      throw new Error(
        `${keyPath}: ${name} is labelled ${expected || '(nothing)'}, which is not one of ` +
          classes.join(', ')
      );
    }
    logs.push({ name, expected, text: await Bun.file(join(logsDir, name)).text() });
  }
  return logs;
}

/** What the classifier said about one log. */
export interface Outcome {
  log: string;
  /** What the answer key says. */
  expected: string;
  opinion: SecondOpinion;
  /** Characters in the request sent for this log: question, criteria and evidence, as JSON. */
  charsSent: number;
}

interface ClassScore {
  /** Logs the answer key gives this class. */
  total: number;
  /** Of those, how many the classifier gave the same class. */
  correct: number;
  /** Null when the key holds no log of this class. */
  accuracy: number | null;
}

export interface Miss {
  log: string;
  expected: string;
  predicted: string;
  confidence: number;
}

export interface Score {
  /** True when every log got an answer. Nothing below is a measurement otherwise. */
  scored: boolean;
  /** Empty when scored; otherwise the first log without an answer and why. */
  notScoredReason: string;
  /** Logs the classifier answered. */
  answered: number;
  correct: number;
  /** Null when not scored. */
  accuracy: number | null;
  perClass: Record<string, ClassScore>;
  /** `confusion[labelled][classified]`: how many logs with that label got that answer. */
  confusion: Record<string, Record<string, number>>;
  /** Mean of the classifier's confidence over its answers. Null when it gave none. */
  meanConfidence: number | null;
  charsSent: number;
  misclassified: Miss[];
  /** Logs labelled as a dependency or environment failure that were called a code defect. */
  wronglyBlamedOnCode: string[];
  /** Scored, accuracy at or above `ACCURACY_FLOOR`, and nothing wrongly blamed on code. */
  pass: boolean;
}

/** Compare the answers with their labels. Pure: this is all of the arithmetic. */
export function scoreOutcomes(classes: readonly string[], outcomes: readonly Outcome[]): Score {
  const perClass: Record<string, ClassScore> = Object.fromEntries(
    classes.map(name => [name, { total: 0, correct: 0, accuracy: null }])
  );
  const confusion: Record<string, Record<string, number>> = Object.fromEntries(
    classes.map(name => [name, Object.fromEntries(classes.map(other => [other, 0]))])
  );
  const misclassified: Miss[] = [];
  let answered = 0;
  let correct = 0;
  let confidence = 0;
  let notScoredReason = outcomes.length === 0 ? 'no labelled logs' : '';

  for (const { log, expected, opinion } of outcomes) {
    if (opinion.status !== 'ok' || opinion.choice === null || opinion.confidence === null) {
      notScoredReason ||= `${log}: ${opinion.reason}`;
      continue;
    }
    answered += 1;
    confidence += opinion.confidence;
    perClass[expected].total += 1;
    confusion[expected][opinion.choice] += 1;
    if (opinion.choice === expected) {
      correct += 1;
      perClass[expected].correct += 1;
    } else {
      misclassified.push({
        log,
        expected,
        predicted: opinion.choice,
        confidence: opinion.confidence,
      });
    }
  }
  for (const score of Object.values(perClass)) {
    score.accuracy = score.total === 0 ? null : score.correct / score.total;
  }

  const scored = notScoredReason === '';
  const accuracy = scored ? correct / answered : null;
  const wronglyBlamedOnCode = misclassified
    .filter(miss => miss.predicted === BLAMES_CODE && NOT_THE_CODE.includes(miss.expected))
    .map(miss => miss.log);
  return {
    scored,
    notScoredReason,
    answered,
    correct,
    accuracy,
    perClass,
    confusion,
    meanConfidence: answered === 0 ? null : confidence / answered,
    charsSent: outcomes.reduce((sum, outcome) => sum + outcome.charsSent, 0),
    misclassified,
    wronglyBlamedOnCode,
    pass: accuracy !== null && accuracy >= ACCURACY_FLOOR && wronglyBlamedOnCode.length === 0,
  };
}

/** A classifier that gives every question the answer `expected`, with full confidence. */
function oracleFetch(expected: string): Fetch {
  return (_input, init) => {
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const questions = isRecord(body) && isRecord(body.questions) ? body.questions : {};
    const answers = Object.fromEntries(
      Object.entries(questions).map(([name, question]) => {
        const criteria = isRecord(question) && isRecord(question.criteria) ? question.criteria : {};
        const probabilities = Object.fromEntries(
          Object.keys(criteria).map(option => [option, option === expected ? 1 : 0])
        );
        return [name, { type: 'choice', choice: expected, confidence: 1, probabilities }];
      })
    );
    return Promise.resolve(Response.json({ answers }));
  };
}

export interface EvalRun {
  checkpoint: Checkpoint;
  logs: readonly LabelledLog[];
  env: NodeJS.ProcessEnv;
  /** Answer from the key instead of a classifier. Nothing is sent anywhere. */
  dry?: boolean;
  /** Replaces the network. Tests inject it; a live run leaves it out. */
  fetch?: Fetch;
}

export interface EvalReport extends Score {
  /** True when the answer key answered instead of a classifier. Such a run measures nothing about one. */
  dry: boolean;
  /** What answered: the dry oracle, or the endpoint and model. */
  classifier: string;
  /** Labelled logs in the fixture. */
  logs: number;
  /** The option names offered, in the workflow's order. */
  classes: string[];
}

/**
 * The endpoint as it may be printed: scheme, host and port. A base URL can carry a
 * credential in its userinfo or query, and the report is pasted into chats and tickets.
 */
function endpointName(apiBase: string): string {
  try {
    return new URL(apiBase).origin;
  } catch {
    return 'unparseable JEV_API_BASE';
  }
}

/**
 * One evaluation: the second opinion asked about every log, one request at a time.
 *
 * Stops at the first log that gets no answer. A run with one missing answer is not scored,
 * so the rest would be spent for nothing, and an endpoint that is down would otherwise be
 * waited on once per log.
 */
export async function runEval(run: EvalRun): Promise<EvalReport> {
  const classes = Object.keys(run.checkpoint.choices);
  // The dry run needs settings like any other, so it supplies a placeholder key and
  // clears both switches; with the oracle injected, that key is never sent anywhere.
  const env = run.dry
    ? { ...run.env, JEV_API_KEY: 'dry-run', JEV_ENABLED: '', JEV_OPINION_ENABLED: '' }
    : run.env;
  const settings = readOpinionSettings(env);
  let classifier = 'unavailable';
  if (run.dry) classifier = 'dry run (answers come from the answer key; nothing is sent)';
  else if (settings.available) {
    classifier = `${endpointName(settings.settings.apiBase)} (${settings.settings.model})`;
  }
  const report = (score: Score): EvalReport => ({
    ...score,
    dry: run.dry === true,
    classifier,
    logs: run.logs.length,
    classes,
  });
  if (!settings.available) {
    return report({ ...scoreOutcomes(classes, []), notScoredReason: settings.reason });
  }

  const outcomes: Outcome[] = [];
  for (const log of run.logs) {
    const send = run.dry ? oracleFetch(log.expected) : (run.fetch ?? globalThis.fetch);
    let charsSent = 0;
    const counting: Fetch = (input, init) => {
      charsSent += typeof init?.body === 'string' ? init.body.length : 0;
      return send(input, init);
    };
    const opinion = await askSecondOpinion({
      question: run.checkpoint.question,
      choices: run.checkpoint.choices,
      evidence: { text: log.text },
      env,
      fetch: counting,
    });
    outcomes.push({ log: log.name, expected: log.expected, opinion, charsSent });
    if (opinion.status !== 'ok') break;
  }
  return report(scoreOutcomes(classes, outcomes));
}

function ratio(value: number | null): string {
  return value === null ? 'n/a ' : value.toFixed(2);
}

/**
 * How every result line starts. The last line of a report gets pasted on its own, and a
 * dry run's must never read as a classifier's.
 */
function resultLabel(report: EvalReport): string {
  return report.dry
    ? 'RESULT (dry run: the answers came from the answer key, not from a classifier):'
    : 'RESULT:';
}

/** The report as text: log names and numbers only. */
export function formatReport(report: EvalReport): string {
  const lines = [
    'Second opinion evaluation',
    `classifier: ${report.classifier}`,
    `logs:       ${String(report.logs)} labelled, ${String(report.answered)} answered`,
  ];
  const result = resultLabel(report);
  if (!report.scored) {
    lines.push(
      '',
      `${result} NOT SCORED. The classifier did not answer every log (${report.notScoredReason}), so there is nothing to measure.`
    );
    return lines.join('\n');
  }

  const width = Math.max(...report.classes.map(name => name.length), 'labelled'.length);
  lines.push(
    `accuracy:   ${ratio(report.accuracy)}  (${String(report.correct)} of ${String(report.answered)} logs classified as labelled)`,
    `confidence: ${ratio(report.meanConfidence)}  (mean over ${String(report.answered)} answers)`,
    `sent:       ${report.charsSent.toLocaleString('en-US')} characters in ${String(report.answered)} requests`,
    '',
    'per class:'
  );
  for (const name of report.classes) {
    const score = report.perClass[name];
    lines.push(
      `  ${name.padEnd(width)}  ${ratio(score.accuracy)}  (${String(score.correct)} of ${String(score.total)})`
    );
  }

  lines.push('', 'confusion (rows: labelled, columns: classified, in the same order):');
  for (const name of report.classes) {
    const row = report.classes.map(other => String(report.confusion[name][other]).padStart(4));
    lines.push(`  ${name.padEnd(width)} ${row.join('')}`);
  }

  lines.push('', report.misclassified.length === 0 ? 'misclassified: none' : 'misclassified:');
  for (const miss of report.misclassified) {
    lines.push(
      `  ${miss.log}: labelled ${miss.expected}, classified ${miss.predicted} (${miss.confidence.toFixed(2)})`
    );
  }
  lines.push('');

  const accuracy = ratio(report.accuracy);
  const blamed = report.wronglyBlamedOnCode.length;
  if (report.pass) {
    lines.push(
      `${result} PASS. Accuracy ${accuracy}, at or above the floor of ${ACCURACY_FLOOR.toFixed(2)}, and no ` +
        `${NOT_THE_CODE.join(' or ')} log was classified ${BLAMES_CODE}.`
    );
  } else if (blamed > 0) {
    lines.push(
      `${result} FAIL. ${String(blamed)} log(s) labelled ${NOT_THE_CODE.join(' or ')} were classified ` +
        `${BLAMES_CODE}: ${report.wronglyBlamedOnCode.join(', ')}. Accuracy ${accuracy}.`
    );
  } else {
    lines.push(
      `${result} FAIL. Accuracy ${accuracy} is below the floor of ${ACCURACY_FLOOR.toFixed(2)}.`
    );
  }
  return lines.join('\n');
}

const USAGE = 'Usage: bun run scripts/second-opinion-eval.ts [--dry] [--json] [--fixture <dir>]';

/**
 * The command. Returns the exit code; `write` receives each output line.
 *
 * @param fetch Replaces the network. Tests inject it; the command line never does.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (line: string) => void,
  fetch?: Fetch
): Promise<number> {
  let dry = false;
  let json = false;
  let fixtureDir = EVAL_FIXTURE;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--dry') dry = true;
    else if (argument === '--json') json = true;
    else if (argument === '--fixture' && value !== undefined) fixtureDir = resolve(argv[++index]);
    else {
      write(`Unsupported argument: ${argument}`);
      write(USAGE);
      return 2;
    }
  }

  let report: EvalReport;
  try {
    const checkpoint = await readCheckpoint();
    const logs = await readLabelledLogs(fixtureDir, Object.keys(checkpoint.choices));
    report = await runEval({ checkpoint, logs, env, dry, fetch });
  } catch (error) {
    // Deliberately every error: exit 1 means "the classifier was measured and fell
    // short", and nothing that stops the run before a score may be mistaken for that.
    write(`Cannot run the evaluation: ${messageOf(error)}`);
    return 2;
  }
  write(json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (!report.scored) return 2;
  return report.pass ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2), process.env, line => {
    console.log(line);
  });
}
