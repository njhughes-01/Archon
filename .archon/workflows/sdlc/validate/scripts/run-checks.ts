/**
 * Runs the checks `discover` declared, in order, and records what happened.
 *
 * Every exit status lands in `$ARTIFACTS_DIR/validation.md`, rewritten after each
 * check so the record is current if the node is stopped. Each check's full output
 * goes to its own log under `$ARTIFACTS_DIR/validation/`. The first failing check
 * ends the run: later checks are recorded as never run, which is how the project's
 * own aggregate gates behave.
 *
 * The status is read from exit statuses alone:
 * - `red`: a check ran and exited non-zero, or was killed by a signal it did not
 *   get from this script. `classify` judges why.
 * - `incomplete`: no check failed, but one could not be started.
 * - `green`: every declared check ran and exited 0. No declared checks is green only
 *   because `discover` judged that the project defines none; its notes say so.
 *
 * No timer lives here. The node's `timeout:` is the only one, and the engine stops
 * this script with SIGTERM when it expires. The handler below then stops the
 * running check's whole process tree, restores anything quarantined, records the
 * stop, and re-raises the signal so the engine sees a timeout rather than a result.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { projectEnvironment } from '../../.shared/node-env.ts';
import {
  describeOutcome,
  outputTail,
  renderValidationRecord,
  type CheckOutcome,
  type RecordedCheck,
} from '../../.shared/validation-record.ts';

interface Check {
  name: string;
  argv: string[];
}

interface Discovery {
  checks: Check[];
  quarantine: string[];
  notes: string;
}

interface Entry {
  check: Check;
  log: string;
  outcome: CheckOutcome;
  seconds: number | null;
}

// `discover`'s output is certified against its node's schema before it is bound here.
const discovery = JSON.parse(text(process.env.INPUTS_DISCOVERY)) as Discovery;
const cwd = process.cwd();
const artifacts = artifactsDir();
const logDir = join(artifacts, 'validation');
const quarantineDir = join(logDir, 'quarantine');
const report = join(artifacts, 'validation.md');
// The checks run as the project's own gate, not as part of this run.
const gateEnv = projectEnvironment(process.env);

/** The record's view of one entry. Output is read only for a check that did not pass. */
function recorded(entry: Entry): RecordedCheck {
  const { kind } = entry.outcome;
  const shown = kind === 'failed' || kind === 'stopped' || kind === 'not-started';
  return {
    name: entry.check.name,
    argv: entry.check.argv,
    outcome: entry.outcome,
    seconds: entry.seconds,
    output: shown && existsSync(entry.log) ? outputTail(readFileSync(entry.log, 'utf8')) : '',
    log: entry.log,
  };
}

function render(entries: readonly Entry[], quarantined: readonly string[]): void {
  writeFileSync(
    report,
    renderValidationRecord({
      notes: discovery.notes,
      checks: entries.map(recorded),
      quarantined,
      kept,
    })
  );
}

/** Git's view of a path: whether anything at or under it is tracked. */
function tracked(path: string): boolean {
  const result = spawnSync('git', ['ls-files', '--', path], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed for quarantine path '${path}': ${result.stderr}`);
  }
  return result.stdout.trim() !== '';
}

/**
 * The quarantine boundary. Only untracked run scaffolding under `.archon/` may move:
 * never a tracked file, and never anything outside that directory.
 */
function quarantinable(path: string): string {
  const normal = normalize(path).split('\\').join('/');
  if (isAbsolute(path) || normal.split('/').includes('..') || !normal.startsWith('.archon/')) {
    throw new Error(`Refusing to quarantine '${path}': only paths under .archon/ may move.`);
  }
  if (!existsSync(join(cwd, normal))) {
    throw new Error(`Refusing to quarantine '${path}': it does not exist.`);
  }
  if (tracked(normal)) {
    throw new Error(`Refusing to quarantine '${path}': git tracks files there.`);
  }
  return normal;
}

/** A path moved out of the checkout, and where its copy lives until it goes back. */
interface Moved {
  path: string;
  copy: string;
}

// Every attempt moves into its own directory, so a copy an earlier attempt kept is
// never merged into or overwritten by a later one.
const attemptDir = join(quarantineDir, `${String(Date.now())}-${String(process.pid)}`);

// The moves not yet undone, mirrored to disk before each original is removed. An
// attempt that dies without restoring (on Windows, or after SIGKILL, the engine stops
// this script with no signal to catch) leaves the list for the next attempt.
const manifest = join(logDir, 'quarantine.json');
const pending: Moved[] = existsSync(manifest)
  ? (JSON.parse(readFileSync(manifest, 'utf8')) as Moved[])
  : [];

/** Moved copies left in place because the checkout already had the path again. */
const kept: string[] = [];

/**
 * Put every pending path back. A path the checkout has again is never overwritten:
 * its moved copy stays where it is and the record names it, since a stop here would
 * block every later attempt until someone intervened by hand. A copy that is already
 * gone was put back by an attempt that died before it could record that.
 */
function restorePending(): void {
  for (const { path, copy } of pending) {
    if (!existsSync(copy)) continue;
    if (existsSync(join(cwd, path))) {
      kept.push(copy);
      continue;
    }
    cpSync(copy, join(cwd, path), { recursive: true });
    rmSync(copy, { recursive: true, force: true });
  }
  pending.length = 0;
  rmSync(manifest, { force: true });
}

// An earlier attempt left paths moved aside. Put them back before anything is
// validated or moved again.
restorePending();

// Validate every path before moving any, so a refusal leaves the checkout untouched.
const toQuarantine = discovery.quarantine.map(quarantinable);
const quarantined: string[] = [];

const entries: Entry[] = discovery.checks.map((check, index) => ({
  check,
  log: join(logDir, `${String(index + 1)}.log`),
  outcome: { kind: 'never-ran' },
  seconds: null,
}));
let current: { entry: Entry; child: ChildProcess; started: number } | null = null;

// POSIX only: a detached child leads its own process group, so one signal reaches
// every process the check started. Windows has no process groups, and the engine
// ends a timed-out script there without a signal this handler could catch.
const ownGroup = process.platform !== 'win32';

function stopCurrent(signal: NodeJS.Signals): void {
  if (current === null) return;
  const { entry, child, started } = current;
  entry.outcome = { kind: 'stopped', signal };
  entry.seconds = (Date.now() - started) / 1000;
  if (child.pid === undefined) return;
  try {
    if (ownGroup) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // The group already exited between its last output and this signal.
  }
}

function onSignal(signal: NodeJS.Signals): void {
  stopCurrent(signal);
  try {
    restorePending();
  } finally {
    render(entries, quarantined);
    // Re-raise with default handling, so the engine sees the node stopped by its
    // signal. Exiting normally here would read to the engine as a finished run.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
}
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

function runOne(entry: Entry): Promise<void> {
  const fd = openSync(entry.log, 'w');
  const started = Date.now();
  return new Promise<void>(resolve => {
    const [command, ...args] = entry.check.argv;
    const child = spawn(command, args, {
      cwd,
      env: gateEnv,
      stdio: ['ignore', fd, fd],
      detached: ownGroup,
    });
    current = { entry, child, started };
    entry.outcome = { kind: 'running' };
    render(entries, quarantined);
    // A command that cannot be spawned reports `error` and may or may not also
    // report `close`; whichever settles the check first wins.
    let settled = false;
    const settle = (outcome: CheckOutcome): void => {
      if (settled) return;
      settled = true;
      current = null;
      closeSync(fd);
      entry.seconds = (Date.now() - started) / 1000;
      if (entry.outcome.kind === 'running') entry.outcome = outcome;
      resolve();
    };
    child.once('error', error => {
      settle({ kind: 'not-started', error: error.message });
    });
    child.once('close', (exitCode, signal) => {
      settle(exitCode === 0 ? { kind: 'passed' } : { kind: 'failed', exitCode, signal });
    });
  });
}

mkdirSync(logDir, { recursive: true });
try {
  for (const path of toQuarantine) {
    const copy = join(attemptDir, path);
    cpSync(join(cwd, path), copy, { recursive: true });
    quarantined.push(path);
    pending.push({ path, copy });
    writeFileSync(manifest, JSON.stringify(pending));
    rmSync(join(cwd, path), { recursive: true, force: true });
  }
  for (const entry of entries) {
    await runOne(entry);
    if (entry.outcome.kind !== 'passed') break;
  }
} finally {
  restorePending();
  render(entries, quarantined);
}

const failed = entries.find(entry => entry.outcome.kind === 'failed');
const unstarted = entries.find(entry => entry.outcome.kind === 'not-started');
const passed = entries.filter(entry => entry.outcome.kind === 'passed').map(entry => entry.check.name);
const ranPassed = passed.length === 0 ? 'No check passed before it.' : `Passed first: ${passed.join(', ')}.`;

if (failed !== undefined) {
  emit({
    status: 'red',
    summary: `${failed.check.name} ${describeOutcome(failed.outcome)}. ${ranPassed} See validation.md.`,
  });
} else if (unstarted !== undefined) {
  emit({
    status: 'incomplete',
    summary: `${unstarted.check.name} ${describeOutcome(unstarted.outcome)}. ${ranPassed} Later checks never ran.`,
  });
} else if (entries.length === 0) {
  emit({ status: 'green', summary: `No checks defined by this project. ${discovery.notes}`.trim() });
} else {
  emit({ status: 'green', summary: `Every check passed: ${passed.join(', ')}.` });
}
