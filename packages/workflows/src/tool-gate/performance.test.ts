/**
 * Timing of the rules on inputs built to be slow.
 *
 * The gate runs on the server's event loop, so one tool call must not hold it.
 * Each shape below is about 100 KB of the cheapest text that once made a scan
 * quadratic or worse. The budget asserted is generous, so a loaded CI host does
 * not fail it; the real numbers are printed. Nothing here is executed.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ToolActionRequest } from '@archon/providers/types';
import {
  DEFAULT_PROTECTED_BRANCHES,
  DEFAULT_VERIFICATION_COMMANDS,
  evaluateRules,
  type RuleContext,
} from './rules';
import { MAX_SCRIPT_CHARS, parseShell } from './shell-tokens';

const SIZE = 100_000;
/** What one call may cost on an idle host. */
const TARGET_MS = 50;
/** What the assertion allows, for a host that is busy with other builds. */
const CEILING_MS = TARGET_MS * 10;

const trackTempRoot = trackTempRoots();

function makeContext(): RuleContext {
  const base = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tool-gate-perf-'))));
  const root = join(base, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/login\n');
  return {
    repoRoot: root,
    homeDir: join(base, 'home'),
    protectedBranches: DEFAULT_PROTECTED_BRANCHES,
    verificationCommands: DEFAULT_VERIFICATION_COMMANDS,
  };
}

/** `unit` repeated until the text is about `size` characters long. */
function fill(unit: string, size = SIZE): string {
  return unit.repeat(Math.ceil(size / unit.length));
}

/** `count` pieces of text, each made from its number. */
function numbered(count: number, piece: (n: string) => string): string {
  return Array.from({ length: count }, (_, index) => piece(String(index))).join('');
}

const RECURSIVE = `-${'r'}f`;
const QUOTE = "'";

/** [name, command]. Sizes are about 100 KB unless the name says otherwise. */
const SHAPES: readonly (readonly [string, string])[] = [
  // The shapes of the second review's table, each grown to 100 KB.
  ['an unknown tool with a long run of `env` words', `mytool ${fill('env ')}ls`],
  ['echo with a run of open brackets', `echo ${fill('[ ')}`],
  ['a run of empty commands', fill(':;')],
  ['a long pipeline', `cat x ${fill('| cat ')}`],
  ['a python heredoc of print lines', `python3 - <<'EOF'\n${fill('print("line")\n')}EOF`],
  ['interpreter code that is all escaped quotes', `python3 -c "${fill(`\\${QUOTE}`)}"`],
  ['a removal with thousands of operands', `rm ${fill('src/a.tmp ')}`],
  ['find with a run of -exec clauses', `find . ${fill('-exec cat {} ; ')}`],
  ['a run of redirections', `echo x ${fill('> src/out.txt ')}`],
  ['a chain of nested shells', `${fill('bash -c ', 4_000)}ls`],
  ['a list of removals', fill('rm src/a.tmp; ')],
  ['a reader with thousands of operands', `cat ${fill('src/a.ts ')}`],
  ['a run of open parentheses', fill('(')],
  ['a chain of wrappers', `${fill('env nice time ')}ls`],
  // Ten more of this round.
  ['a run of assignments', `${fill('A=b ')}ls`],
  ['a run of command substitutions', `echo ${fill('$(echo x) ')}`],
  ['substitutions nested inside each other', `echo ${fill('$(echo ', 20_000)}`],
  ['a run of unterminated quotes', fill('" \' ')],
  ['a run of backslashes', `echo ${fill('\\')}`],
  ['one enormous word', `echo ${fill('a')}`],
  ['a run of here-strings', `cat ${fill('<<< x ')}`],
  ['a run of git config overrides', `git ${fill('-c color.ui=false ')}status`],
  ['a long and-list of git commands', `git status ${fill('&& git status ')}`],
  ['a recursive removal with a run of wildcards', `rm ${RECURSIVE} ${fill('src/*/x ')}`],
  ['a run of symlinks made and used', fill('ln -s src l; cat l/x; ')],
  ['a run of sed expressions', `sed ${fill('-e s/a/b/ ')} src/a.ts`],
  ['a heredoc of data for cat', `cat > src/big.txt <<'EOF'\n${fill('some data\n')}EOF`],
  ['node code that is all backticks', `node -e "${fill('`')}"`],
  ['xargs chained through a pipeline', `echo x ${fill('| xargs echo ')}`],
  ['an unknown tool with a run of quoted arguments', `mytool ${fill('"git status" ')}`],
  // Just inside the reading budget, where everything is read to the end.
  ['inside the budget: an unknown tool with 2,900 `env` words', `mytool ${'env '.repeat(2_900)}ls`],
  ['inside the budget: an unknown tool with 2,900 `echo` words', `mytool ${'echo '.repeat(2_900)}`],
  [
    'inside the budget: 23 wrappers before 2,800 words',
    `${'env '.repeat(23)}mytool ${'x '.repeat(2_800)}`,
  ],
  ['inside the budget: 2,900 git words to an unknown tool', `mytool ${'git '.repeat(2_900)}`],
  ['inside the budget: 390 commands', 'git status; '.repeat(390)],
  ['inside the budget: a 390-stage pipeline', `cat x ${'| cat '.repeat(389)}`],
  ['inside the budget: 2,900 open brackets', `echo ${'[ '.repeat(2_900)}`],
  ['inside the budget: 390 nested shells', "bash -c 'ls'; ".repeat(195)],
  [
    'inside the budget: 190 symlinks made and used',
    numbered(190, n => `ln -s src l${n}; cat l${n}/x; `),
  ],
  ['inside the budget: 700 files removed by name', `rm ${numbered(700, n => `src/f${n}.tmp `)}`],
  ['inside the budget: 700 files read by name', `cat ${numbered(700, n => `src/f${n}.ts `)}`],
  ['inside the budget: find with 500 -exec clauses', `find . ${'-exec cat {} ; '.repeat(500)}`],
  ['inside the budget: 1,400 quoted arguments', `mytool ${'"git status" '.repeat(1_400)}`],
  ['inside the budget: 390 substitutions', `echo ${'$(echo x) '.repeat(390)}`],
  ['inside the budget: 390 pushes of the checked-out branch', 'git push origin HEAD; '.repeat(390)],
];

function shell(command: string, cwd: string): ToolActionRequest {
  return { toolName: 'Bash', kind: 'shell', cwd, command, input: {} };
}

async function timed(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

describe.skipIf(process.platform === 'win32')('rules stay within their time budget', () => {
  test.each(SHAPES)('%s', async (name, command) => {
    const context = makeContext();
    // Once to load and warm the code paths, then the measured run.
    await evaluateRules(shell('ls', context.repoRoot), context);
    const elapsed = await timed(() => evaluateRules(shell(command, context.repoRoot), context));
    console.log(
      `tool-gate timing: ${name}: ${String(command.length)} chars, ${elapsed.toFixed(1)} ms`
    );
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  test('a write tool call naming thousands of paths', async () => {
    const context = makeContext();
    const paths = Array.from({ length: 700 }, (_, index) => `src/file-${String(index)}.ts`);
    const request: ToolActionRequest = {
      toolName: 'Write',
      kind: 'file_write',
      cwd: context.repoRoot,
      paths,
      input: {},
    };
    const elapsed = await timed(() => evaluateRules(request, context));
    console.log(`tool-gate timing: 700 write paths: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });
});

/** Shapes the final attack round reported as over 50 ms, at its sizes and at 100 KiB. */
const REPORTED_SHAPES: readonly (readonly [string, string])[] = [
  ...[10_240, 51_200, 102_400].map((size): readonly [string, string] => [
    `a ${String(size)}-byte slash path`,
    `cat ${'a/'.repeat(Math.ceil(size / 2)).slice(0, size - 5)}z`,
  ]),
  ...[51_200, 102_400].map((size): readonly [string, string] => [
    `a ${String(size)}-byte credential-shaped dotted name`,
    `cat ${'credentials.'.repeat(Math.ceil(size / 12)).slice(0, size - 7)}txt`,
  ]),
  ['nested arithmetic at 1 KiB', `echo $((${'1+('.repeat(338).slice(0, 1013)}1))`],
  ['nested arithmetic at 100 KiB', `echo $((${'1+('.repeat(34_000).slice(0, 100_000)}1))`],
];

describe.skipIf(process.platform === 'win32')(
  'shapes the final attack round reported as slow',
  () => {
    test.each(REPORTED_SHAPES)('%s', async (name, command) => {
      const context = makeContext();
      await evaluateRules(shell('ls', context.repoRoot), context);
      const elapsed = await timed(() => evaluateRules(shell(command, context.repoRoot), context));
      console.log(
        `tool-gate timing: ${name}: ${String(command.length)} chars, ${elapsed.toFixed(1)} ms`
      );
      expect(elapsed).toBeLessThan(CEILING_MS);
    });

    test.each([160, 390])(
      '%d chained pushes of the checked-out branch from 48 levels down',
      async count => {
        const context = makeContext();
        const deep = join(context.repoRoot, ...Array.from({ length: 48 }, () => 'nested'));
        mkdirSync(deep, { recursive: true });
        const command = Array.from({ length: count }, () => 'git push origin HEAD').join(' && ');
        await evaluateRules(shell('ls', deep), context);
        const started = performance.now();
        const outcome = await evaluateRules(shell(command, deep), context);
        const elapsed = performance.now() - started;
        console.log(
          `tool-gate timing: ${String(count)} deep pushes: ${String(command.length)} chars, ${elapsed.toFixed(1)} ms`
        );
        expect(outcome.outcome).toBe('allow');
        expect(elapsed).toBeLessThan(CEILING_MS);
      }
    );

    test('a path over the longest one Linux allows is denied without being walked', async () => {
      const context = makeContext();
      const outcome = await evaluateRules(
        shell(`cat ${'a/'.repeat(3_000)}z`, context.repoRoot),
        context
      );
      expect(outcome).toMatchObject({ outcome: 'deny', ruleId: 'deny.path_unresolvable' });
    });
  }
);

describe.skipIf(process.platform === 'win32')('the reading budget', () => {
  const context = makeContext();

  test('a call naming more paths than are placed is denied, wherever the extra ones point', async () => {
    const paths = Array.from({ length: 5_000 }, (_, index) => `src/file-${String(index)}.ts`);
    const started = performance.now();
    const outcome = await evaluateRules(
      { toolName: 'Write', kind: 'file_write', cwd: context.repoRoot, paths, input: {} },
      context
    );
    console.log(
      `tool-gate timing: 5000 write paths: ${(performance.now() - started).toFixed(1)} ms`
    );
    expect(outcome).toMatchObject({ outcome: 'deny', ruleId: 'deny.command_too_large' });
  });

  test('a command past the size budget is denied, not read and not left to a classifier', async () => {
    const outcome = await evaluateRules(
      shell(`echo ${fill('a ', MAX_SCRIPT_CHARS + 10)}`, context.repoRoot),
      context
    );
    expect(outcome).toMatchObject({ outcome: 'deny', ruleId: 'deny.command_too_large' });
  });

  test('padding cannot carry a denied command past the rules', async () => {
    // The destructive command sits behind more commands than the budget reads.
    const hidden = `${fill('true; ', 30_000)}git reset --${'hard'}`;
    const outcome = await evaluateRules(shell(hidden, context.repoRoot), context);
    expect(outcome.outcome).toBe('deny');
  });

  test('padding in front of a script handed to a nested shell is denied too', async () => {
    const inner = `${fill('true; ', 30_000)}git clean -${'fdx'}`;
    const outcome = await evaluateRules(shell(`bash -c '${inner}'`, context.repoRoot), context);
    expect(outcome.outcome).toBe('deny');
  });

  test('a long data heredoc costs one item, so writing a large file is still judged by rule', async () => {
    const body = fill('line of data\n', 200_000);
    const command = `cat > src/big.txt <<'EOF'\n${body}EOF`;
    expect(parseShell(command).overBudget).toBe(false);
    const outcome = await evaluateRules(shell(command, context.repoRoot), context);
    expect(outcome).toMatchObject({ outcome: 'allow' });
  });

  test('an ordinary long command is far inside the budget', async () => {
    const command = `bun test ${fill('src/a.test.ts ', 8_000)}`;
    expect(parseShell(command).overBudget).toBe(false);
  });
});
