/**
 * The text of `validation.md`: the record archon-validate's check runner writes, and the
 * one place that knows its layout.
 *
 * The runner renders it. Whatever reads a failing check's output back out of it, such as
 * the second opinion's wrapper and its evaluation, does so through this module too, so a
 * change to the layout cannot leave a reader behind.
 */

/** How many lines of a failing check's output the record keeps. */
export const TAIL_LINES = 60;

/** What became of one declared check. */
export type CheckOutcome =
  | { kind: 'passed' }
  | { kind: 'failed'; exitCode: number | null; signal: string | null }
  | { kind: 'not-started'; error: string }
  | { kind: 'stopped'; signal: string }
  | { kind: 'running' }
  | { kind: 'never-ran' };

export function describeOutcome(outcome: CheckOutcome): string {
  switch (outcome.kind) {
    case 'passed':
      return 'passed (exit 0)';
    case 'failed':
      return outcome.signal === null
        ? `failed (exit ${String(outcome.exitCode)})`
        : `failed (killed by ${outcome.signal})`;
    case 'not-started':
      return `could not start: ${outcome.error}`;
    case 'stopped':
      return `did not finish: the node's time limit stopped it (${outcome.signal})`;
    case 'running':
      return 'running';
    case 'never-ran':
      return 'never ran';
  }
}

/** The last `TAIL_LINES` lines of a check's output, without trailing blank lines. */
export function outputTail(output: string): string {
  return output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
}

export interface RecordedCheck {
  name: string;
  argv: readonly string[];
  outcome: CheckOutcome;
  /** How long it ran, or null when it never started. */
  seconds: number | null;
  /** The check's output tail (see `outputTail`), shown for a check that did not pass. */
  output: string;
  /** Where the check's full output is kept. */
  log: string;
}

export interface ValidationRecord {
  /** What `discover` said about the checks it declared. */
  notes: string;
  checks: readonly RecordedCheck[];
  /** Paths moved out of the checkout while the checks ran. */
  quarantined: readonly string[];
  /** Moved copies left in place because the checkout already had the path again. */
  kept: readonly string[];
}

const OUTPUT_HEADING = `Last ${String(TAIL_LINES)} lines of output:`;
const FENCE = '```';
const FULL_OUTPUT = 'Full output: `';

export function renderValidationRecord(record: ValidationRecord): string {
  const lines = ['# Validation', ''];
  if (record.notes.trim() !== '') lines.push(record.notes.trim(), '');
  if (record.checks.length === 0) lines.push('The project defines no checks, so none ran.', '');
  if (record.quarantined.length > 0) {
    lines.push(
      'Moved aside while the checks ran (untracked run scaffolding):',
      ...record.quarantined.map(path => `- \`${path}\``),
      ''
    );
  }
  if (record.kept.length > 0) {
    lines.push(
      'Not restored, because the checkout already had the path again. The moved copy is kept at:',
      ...record.kept.map(path => `- \`${path}\``),
      ''
    );
  }
  for (const [index, check] of record.checks.entries()) {
    const seconds = check.seconds === null ? '' : ` after ${check.seconds.toFixed(0)}s`;
    lines.push(`## ${String(index + 1)}. ${check.name}`, '');
    lines.push(`\`${check.argv.join(' ')}\` ${describeOutcome(check.outcome)}${seconds}.`);
    const { kind } = check.outcome;
    if (kind === 'failed' || kind === 'stopped' || kind === 'not-started') {
      if (check.output !== '') {
        lines.push('', OUTPUT_HEADING, '', FENCE, check.output, FENCE);
      }
    }
    if (kind !== 'never-ran' && kind !== 'not-started') {
      lines.push('', `${FULL_OUTPUT}${check.log}\``);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The failing check's output as it stands in the end of a record, or the empty string when
 * that end holds none.
 *
 * `text` is the record or any tail of it, so the block's opening may be cut off: the
 * output then runs from the start of the text. Everything else in a record is framing
 * (headings, commands, exit statuses, paths), which says that a check failed and nothing
 * about why.
 */
export function recordedOutput(text: string): string {
  const close = text.lastIndexOf(`\n${FENCE}\n\n${FULL_OUTPUT}`);
  if (close === -1) return '';
  const opening = `${OUTPUT_HEADING}\n\n${FENCE}\n`;
  const open = text.lastIndexOf(opening, close);
  return text.slice(open === -1 ? 0 : open + opening.length, close);
}
