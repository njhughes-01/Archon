#!/usr/bin/env bun
/**
 * Measures the context scout against a labelled repository.
 *
 * The scout pre-reads a checkout for one question and selects the files worth opening
 * (.archon/workflows/sdlc/.shared/context-scout.ts). This runs that same code over the
 * seeded fixture repository and compares what it selected with the answer key: recall,
 * precision, files selected out of the total, and characters sent.
 *
 * A live run calls the real classifier, so it needs a key and the network and is not part
 * of `bun run test`. It is a manual command:
 *
 *   bun --env-file="$HOME/.archon/.env" run scripts/context-scout-eval.ts
 *
 * which reads JEV_API_KEY and the other JEV_* settings from the file Archon itself reads
 * them from, or export them and run `bun run scout-eval`. `--dry` answers from the answer
 * key instead of a classifier: no key, nothing sent. It proves the pipeline and the
 * arithmetic, not the classifier.
 *
 * Usage:
 *   bun run scripts/context-scout-eval.ts [--dry] [--json] [--repo <dir>] [--key <file>]
 *
 * Exit codes:
 *   0  scored, and it passed: every relevant file selected, and at most half of the files
 *      the scout could read
 *   1  scored, and it did not pass
 *   2  not scored: the classifier was unavailable, the run was cut short, the evaluation
 *      could not be set up (answer key, repository), or bad usage
 *
 * Prints paths and numbers only. Never file contents, never the key.
 */
import { join, resolve } from 'node:path';
import {
  readScoutSettings,
  runScout,
  type LineWindow,
  type ScoutResult,
  type ScoutStatus,
} from '../.archon/workflows/sdlc/.shared/context-scout.ts';
import type { Fetch } from '../.archon/workflows/sdlc/.shared/jev-client.ts';

export const EVAL_FIXTURE = resolve(
  import.meta.dir,
  '../.archon/scripts/__tests__/fixtures/context-scout-eval'
);

/**
 * The most of the repository a passing run may select. Full recall is only worth having
 * when the scout also narrowed the reading, and selecting most files reaches it trivially.
 */
export const MAX_SELECTED_SHARE = 0.5;

export interface AnswerKey {
  question: string;
  /** Candidate paths handed to the scout. Empty means the whole repository. */
  paths: string[];
  /** The files a correct scout selects. Every other tracked file is a decoy. */
  relevant: string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `relevant` is a path-to-reason map on disk; the reasons are for whoever edits the key. */
export async function readAnswerKey(path: string): Promise<AnswerKey> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(path).text());
  } catch (error) {
    // Bun's parse error names a position, not the file it came from.
    throw new Error(`${path} could not be read as JSON: ${messageOf(error)}`, { cause: error });
  }
  if (!isRecord(parsed) || typeof parsed.question !== 'string' || !isRecord(parsed.relevant)) {
    throw new Error(`${path} is not an answer key: it needs "question" and a "relevant" map`);
  }
  const paths = Array.isArray(parsed.paths)
    ? parsed.paths.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { question: parsed.question, paths, relevant: Object.keys(parsed.relevant) };
}

export interface ScoredFile {
  path: string;
  confidence: number;
  /** What the answer key says. */
  relevant: boolean;
  /** What the scout said. */
  selected: boolean;
  evidence: LineWindow;
}

export interface Score {
  status: ScoutStatus;
  reason: string;
  /** Files the answer key marks relevant. */
  relevantTotal: number;
  /** Files the scout selected. */
  selected: number;
  /** Tracked files the scout was pointed at. */
  candidates: number;
  /**
   * The candidates the scout was allowed to send: those it classified and those a budget
   * cut. This is what narrowing is measured against. A withheld secret or binary was
   * never the scout's to select, so it must not make a broad selection look narrow.
   */
  classifiable: number;
  truePositives: number;
  /** Selected, but a decoy. */
  falsePositives: string[];
  /** Relevant, but not selected: answered no, cut by a budget, or never sent. */
  falseNegatives: string[];
  recall: number;
  /** Null when nothing was selected. */
  precision: number | null;
  /**
   * The highest threshold at which every relevant file would still be selected, and how
   * many files that selects. Null when a relevant file has no answer at all.
   */
  recallSafeThreshold: { threshold: number; selected: number } | null;
  /** Characters of code and question text sent. Paths and JSON framing are not counted. */
  charsSent: number;
  requests: number;
  windows: number;
  files: ScoredFile[];
  /**
   * Full recall from a complete run that selected at most `MAX_SELECTED_SHARE` of the
   * classifiable files.
   */
  pass: boolean;
}

/** Compare a scout result with the answer key. Pure: this is all of the arithmetic. */
export function scoreSelection(key: AnswerKey, result: ScoutResult): Score {
  const relevant = new Set(key.relevant);
  const files = result.files.map(
    (file): ScoredFile => ({
      path: file.path,
      confidence: file.confidence,
      relevant: relevant.has(file.path),
      selected: file.relevant,
      evidence: file.evidence,
    })
  );
  const selected = files.filter(file => file.selected);
  const selectedPaths = new Set(selected.map(file => file.path));
  const truePositives = selected.filter(file => file.relevant).length;
  const falseNegatives = key.relevant.filter(path => !selectedPaths.has(path));

  const answered = files.filter(file => file.relevant);
  let recallSafeThreshold: Score['recallSafeThreshold'] = null;
  if (answered.length === key.relevant.length && answered.length > 0) {
    const threshold = Math.min(...answered.map(file => file.confidence));
    recallSafeThreshold = {
      threshold,
      selected: files.filter(file => file.confidence >= threshold).length,
    };
  }

  const recall = key.relevant.length === 0 ? 1 : truePositives / key.relevant.length;
  const classifiable = result.counts.classified + result.counts.unclassified;
  return {
    status: result.status,
    reason: result.reason,
    relevantTotal: key.relevant.length,
    selected: selected.length,
    candidates: result.counts.candidates,
    classifiable,
    truePositives,
    falsePositives: selected.filter(file => !file.relevant).map(file => file.path),
    falseNegatives,
    recall,
    precision: selected.length === 0 ? null : truePositives / selected.length,
    recallSafeThreshold,
    charsSent: result.counts.charsSent,
    requests: result.counts.requests,
    windows: result.counts.windows,
    files,
    pass:
      result.status === 'ok' &&
      recall === 1 &&
      selected.length <= classifiable * MAX_SELECTED_SHARE,
  };
}

/** A classifier that answers from the answer key: yes for a relevant file's windows. */
export function oracleFetch(key: AnswerKey): Fetch {
  const relevant = new Set(key.relevant);
  return (_input, init) => {
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const state = isRecord(body) && isRecord(body.state) ? body.state : {};
    const questions = isRecord(body) && isRecord(body.questions) ? body.questions : {};
    const answers = Object.fromEntries(
      Object.keys(questions).map(name => {
        const window = state[name];
        const path = isRecord(window) && typeof window.path === 'string' ? window.path : '';
        return [name, { type: 'noul', noul: relevant.has(path) ? 1 : 0 }];
      })
    );
    return Promise.resolve(Response.json({ answers }));
  };
}

export interface EvalRun {
  repoDir: string;
  key: AnswerKey;
  env: NodeJS.ProcessEnv;
  /** Answer from the key instead of a classifier. Nothing is sent anywhere. */
  dry?: boolean;
  /** Replaces the network. Tests inject it; a live run leaves it out. */
  fetch?: Fetch;
}

export interface EvalReport extends Score {
  /** True when the answer key answered instead of a classifier. Such a run measures nothing about one. */
  dry: boolean;
  repoDir: string;
  question: string;
  /** What answered: the dry oracle, or the endpoint and model. */
  classifier: string;
  /** The selection threshold in force, or null when the settings could not be read. */
  threshold: number | null;
}

function trackedFiles(repoDir: string): Set<string> {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z'], {
    cwd: repoDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed in ${repoDir}: ${listed.stderr.toString().trim()}`);
  }
  return new Set(listed.stdout.toString().split('\0').filter(Boolean));
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

/** One evaluation: the scout over `repoDir`, scored against `key`. */
export async function runEval(run: EvalRun): Promise<EvalReport> {
  // A key that names a file the repository lost would count it as a miss forever and
  // make every classifier look worse than it is. Refuse it before spending anything.
  const tracked = trackedFiles(run.repoDir);
  const stale = run.key.relevant.filter(path => !tracked.has(path));
  if (stale.length > 0) {
    throw new Error(
      `The answer key names files that are not tracked in ${run.repoDir}: ${stale.join(', ')}`
    );
  }

  // The dry run needs settings like any other, so it supplies a placeholder key and
  // clears both switches; with the oracle injected, that key is never sent anywhere.
  const env = run.dry
    ? { ...run.env, JEV_API_KEY: 'dry-run', JEV_ENABLED: '', JEV_SCOUT_ENABLED: '' }
    : run.env;
  const settings = readScoutSettings(env);
  const result = await runScout({
    question: run.key.question,
    paths: JSON.stringify(run.key.paths),
    cwd: run.repoDir,
    env,
    fetch: run.dry ? oracleFetch(run.key) : run.fetch,
  });

  let classifier = 'unavailable';
  if (run.dry) classifier = 'dry run (answers come from the answer key; nothing is sent)';
  else if (settings.available) {
    classifier = `${endpointName(settings.settings.apiBase)} (${settings.settings.model})`;
  }
  return {
    ...scoreSelection(run.key, result),
    dry: run.dry === true,
    repoDir: run.repoDir,
    question: result.question,
    classifier,
    threshold: settings.available ? settings.settings.threshold : null,
  };
}

/** Says so when some tracked files were never the scout's to read. */
function withheld(report: EvalReport): string {
  const count = report.candidates - report.classifiable;
  return count === 0
    ? ''
    : ` (${String(count)} more tracked files were withheld from the classifier)`;
}

function ratio(value: number | null): string {
  return value === null ? 'n/a ' : value.toFixed(2);
}

function listed(label: string, paths: readonly string[]): string[] {
  const head = `${label}:`.padEnd(12);
  if (paths.length === 0) return [`${head}none`];
  return paths.map((path, index) => `${index === 0 ? head : ' '.repeat(12)}${path}`);
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

/** The report as text: paths and numbers only. */
export function formatReport(report: EvalReport): string {
  const lines = [
    'Context scout evaluation',
    `repo:       ${report.repoDir}`,
    `classifier: ${report.classifier}`,
    `question:   ${report.question}`,
  ];
  if (report.status === 'unavailable') {
    lines.push(
      `status:     unavailable (${report.reason})`,
      '',
      `${resultLabel(report)} NOT SCORED. The classifier gave no answers, so there is nothing to measure.`
    );
    return lines.join('\n');
  }

  const plural = report.requests === 1 ? 'request' : 'requests';
  lines.push(
    `status:     ${report.status}${report.reason === '' ? '' : ` (${report.reason})`}`,
    `threshold:  ${report.threshold === null ? 'n/a' : String(report.threshold)}`,
    '',
    `recall:     ${ratio(report.recall)}  (${String(report.truePositives)} of ${String(report.relevantTotal)} relevant files selected)`,
    report.precision === null
      ? 'precision:  n/a   (nothing was selected)'
      : `precision:  ${ratio(report.precision)}  (${String(report.truePositives)} of ${String(report.selected)} selected files are relevant)`,
    `selected:   ${String(report.selected)} of ${String(report.classifiable)} files${withheld(report)}`,
    `sent:       ${report.charsSent.toLocaleString('en-US')} characters of code and question text in ${String(report.requests)} ${plural} (${String(report.windows)} windows)`,
    '',
    ...listed('missed', report.falseNegatives),
    ...listed('extra', report.falsePositives),
    ''
  );

  lines.push('conf  key       scout     file (best lines)');
  for (const file of report.files) {
    lines.push(
      [
        file.confidence.toFixed(2),
        (file.relevant ? 'relevant' : 'decoy').padEnd(8),
        (file.selected ? 'selected' : '-').padEnd(8),
        `${file.path} (${String(file.evidence.startLine)}-${String(file.evidence.endLine)})`,
      ].join('  ')
    );
  }
  lines.push('');

  if (report.recallSafeThreshold === null) {
    lines.push('No threshold selects every relevant file: at least one has no answer.');
  } else {
    const { threshold, selected } = report.recallSafeThreshold;
    lines.push(
      `Highest threshold that still selects every relevant file: ${String(threshold)} ` +
        `(selects ${String(selected)} of ${String(report.classifiable)} files).`
    );
  }

  const result = resultLabel(report);
  if (report.status === 'truncated') {
    lines.push(
      `${result} NOT SCORED. The run was cut short (${report.reason}); raise the budget and rerun.`
    );
  } else if (report.pass) {
    lines.push(
      `${result} PASS. Recall 1.00, with ${String(report.selected)} of ${String(report.classifiable)} files selected.`
    );
  } else if (report.recall < 1) {
    lines.push(
      `${result} FAIL. ${String(report.falseNegatives.length)} relevant file(s) were not selected.`
    );
  } else {
    lines.push(
      `${result} FAIL. Recall is 1.00, but ${String(report.selected)} of ${String(report.classifiable)} files were ` +
        `selected, more than ${String(MAX_SELECTED_SHARE * 100)}%: the scout narrowed too little.`
    );
  }
  return lines.join('\n');
}

const USAGE =
  'Usage: bun run scripts/context-scout-eval.ts [--dry] [--json] [--repo <dir>] [--key <file>]';

/** The command. Returns the exit code; `write` receives each output line. */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (line: string) => void
): Promise<number> {
  let dry = false;
  let json = false;
  let repoDir = join(EVAL_FIXTURE, 'repo');
  let keyPath = join(EVAL_FIXTURE, 'answer-key.json');
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--dry') dry = true;
    else if (argument === '--json') json = true;
    else if (argument === '--repo' && value !== undefined) repoDir = resolve(argv[++index]);
    else if (argument === '--key' && value !== undefined) keyPath = resolve(argv[++index]);
    else {
      write(`Unsupported argument: ${argument}`);
      write(USAGE);
      return 2;
    }
  }

  let report: EvalReport;
  try {
    report = await runEval({ repoDir, key: await readAnswerKey(keyPath), env, dry });
  } catch (error) {
    // Deliberately every error: exit 1 means "the classifier was measured and fell
    // short", and nothing that stops the run before a score may be mistaken for that.
    write(`Cannot run the evaluation: ${messageOf(error)}`);
    return 2;
  }
  write(json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (report.status !== 'ok') return 2;
  return report.pass ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2), process.env, line => {
    console.log(line);
  });
}
