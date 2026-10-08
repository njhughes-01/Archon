/**
 * Table-driven test over `fixtures/actions.jsonl`.
 *
 * The rows are POSIX shell text and POSIX paths, judged against a real
 * directory tree so symlink and `..` escapes resolve the way the kernel would.
 * The gate only reads these strings: nothing in a row is ever executed.
 */
import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ToolActionKind, ToolActionRequest } from '@archon/providers/types';
import {
  createToolGate,
  DEFAULT_PROTECTED_BRANCHES,
  DEFAULT_VERIFICATION_COMMANDS,
  ESCALATION_LEVELS,
  evaluateRules,
  type ToolGateDecisionEvent,
  type ToolGateEscalationRequest,
  type ToolGateEscalationResult,
} from './index';

type Expectation = 'allow' | 'deny' | 'escalate';

interface FixtureRow {
  id: string;
  tool: string;
  kind: ToolActionKind | 'browser';
  cwd: string;
  expect: Expectation;
  command?: string;
  paths?: string[];
  url?: string;
  input?: Record<string, unknown>;
  parsedCommands?: string[];
  ruleId?: string;
  needs?: 'symlink';
}

const isWindows = process.platform === 'win32';
const rows: FixtureRow[] = readFileSync(join(import.meta.dir, 'fixtures', 'actions.jsonl'), 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => JSON.parse(line) as FixtureRow);
const table = rows.map(row => [row.id, row] as const);

interface Tree {
  root: string;
  outside: string;
  home: string;
}

const trackTempRoot = trackTempRoots();

/**
 * repo/ is the root the gate protects. outside/ and home/ sit next to it, and
 * the links inside repo/ are the escape routes the rows try.
 */
function makeTree(): Tree {
  const base = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tool-gate-fixtures-'))));
  const root = join(base, 'repo');
  const outside = join(base, 'outside');
  const home = join(base, 'home');
  const dirs = ['src', 'docs', 'build/empty', 'sub', 'dist', 'a\\b\\c'];
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  // Three checkouts with different current branches, read from their HEAD files.
  const heads = [
    ['.', 'ref: refs/heads/feature/login\n'],
    ['on-main', 'ref: refs/heads/main\n'],
    ['detached', '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n'],
  ] as const;
  for (const [dir, head] of heads) {
    mkdirSync(join(root, dir, '.git'), { recursive: true });
    writeFileSync(join(root, dir, '.git', 'HEAD'), head);
  }
  writeFileSync(join(root, '.env.example'), 'FIXTURE=\n');
  mkdirSync(outside);
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  writeFileSync(join(root, 'docs', 'README.md'), '# docs\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1;\n');
  writeFileSync(join(root, '.env'), 'FIXTURE=1\n');
  writeFileSync(join(outside, 'data.txt'), 'outside\n');
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'not a key\n');
  symlinkSync('../outside', join(root, 'link-out'));
  symlinkSync('src', join(root, 'link-in'));
  symlinkSync('../outside/missing.txt', join(root, 'dangling'));
  symlinkSync('.env', join(root, 'notes.txt'));
  return { root, outside, home };
}

function fill(text: string, tree: Tree): string {
  return text
    .replaceAll('{root}', tree.root)
    .replaceAll('{outside}', tree.outside)
    .replaceAll('{home}', tree.home);
}

function toRequest(row: FixtureRow, tree: Tree): ToolActionRequest {
  return {
    toolName: row.tool,
    // One row carries a kind no provider should send, to pin the refusal.
    kind: row.kind as ToolActionKind,
    cwd: fill(row.cwd, tree),
    input: row.input ?? {},
    ...(row.command !== undefined && { command: fill(row.command, tree) }),
    ...(row.paths !== undefined && { paths: row.paths.map(path => fill(path, tree)) }),
    ...(row.url !== undefined && { url: row.url }),
    ...(row.parsedCommands !== undefined && {
      parsedCommands: row.parsedCommands.map(command => fill(command, tree)),
    }),
  };
}

interface Run {
  decision: Awaited<ReturnType<ReturnType<typeof createToolGate>>>;
  calls: ToolGateEscalationRequest[];
  records: ToolGateDecisionEvent[];
}

async function runGate(
  row: FixtureRow,
  tree: Tree,
  classifierConfigured: boolean,
  answer: ToolGateEscalationResult
): Promise<Run> {
  const calls: ToolGateEscalationRequest[] = [];
  const records: ToolGateDecisionEvent[] = [];
  const gate = createToolGate({
    repoRoot: tree.root,
    homeDir: tree.home,
    classifierConfigured,
    escalate: request => {
      calls.push(request);
      return Promise.resolve(answer);
    },
    record: event => records.push(event),
  });
  return { decision: await gate(toRequest(row, tree)), calls, records };
}

const SAYS_DESTRUCTIVE: ToolGateEscalationResult = {
  ok: true,
  score: ESCALATION_LEVELS.indexOf('destructive'),
  noul: 1,
  confidence: 1,
};
const SAYS_READ_ONLY: ToolGateEscalationResult = {
  ok: true,
  score: ESCALATION_LEVELS.indexOf('read_only'),
  noul: 0,
  confidence: 1,
};

describe('fixture file', () => {
  test('has unique ids and enough rows of every outcome', () => {
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    expect(rows.length).toBeGreaterThanOrEqual(60);
    const count = (expectation: Expectation): number =>
      rows.filter(row => row.expect === expectation).length;
    expect(count('deny')).toBeGreaterThanOrEqual(20);
    expect(count('allow')).toBeGreaterThanOrEqual(20);
    expect(count('escalate')).toBeGreaterThanOrEqual(20);
  });

  test('every row names the rule it expects', () => {
    expect(rows.filter(row => row.ruleId === undefined).map(row => row.id)).toEqual([]);
  });

  test('covers every acceptance row of the decisions file', () => {
    const ids = new Set(rows.map(row => row.id));
    const required = [
      'deny-cat-env',
      'deny-printenv-curl-post',
      'deny-push-force-long',
      'deny-push-force-short',
      'deny-rm-rf-slash',
      'deny-rm-rf-tilde',
      'deny-rm-rf-dot',
      'deny-reset-hard',
      'deny-clean-fdx',
      'deny-write-ssh-authorized-keys',
      'deny-write-env',
      'deny-curl-pipe-sh',
      'allow-git-status',
      'allow-git-diff',
      'allow-ls-la',
      'allow-rg-foo',
      'allow-cat-readme',
      'allow-bun-run-test',
      'escalate-bash-c-variable',
      'escalate-gh-pr-merge',
      'escalate-psql-drop-table',
      'escalate-rm-variable-glob',
    ];
    expect(required.filter(id => !ids.has(id))).toEqual([]);
  });
});

describe.skipIf(isWindows)('fixture table: rules alone', () => {
  test.each(table)('%s', async (_id, row) => {
    const tree = makeTree();
    const outcome = await evaluateRules(toRequest(row, tree), {
      repoRoot: tree.root,
      homeDir: tree.home,
      protectedBranches: DEFAULT_PROTECTED_BRANCHES,
      verificationCommands: DEFAULT_VERIFICATION_COMMANDS,
    });
    expect<{ outcome: string; ruleId: string | undefined }>({
      outcome: outcome.outcome,
      ruleId: outcome.ruleId,
    }).toEqual({ outcome: row.expect, ruleId: row.ruleId });
    if (outcome.outcome === 'deny') {
      expect(outcome.reason).not.toBe('');
      expect(outcome.alternatives.length).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(isWindows)('fixture table: gate', () => {
  test.each(table)('%s', async (_id, row) => {
    const tree = makeTree();

    // A classifier that would call everything destructive. Rules decide allow and
    // deny rows on their own, so it must not even be asked about them.
    const harsh = await runGate(row, tree, true, SAYS_DESTRUCTIVE);
    expect(harsh.records).toHaveLength(1);
    const [harshRecord] = harsh.records;
    if (row.expect === 'allow') {
      expect(harsh.decision).toEqual({ action: 'allow' });
      expect(harsh.calls).toHaveLength(0);
      expect(harshRecord?.source).toBe('rule');
    } else if (row.expect === 'deny') {
      expect(harsh.decision.action).toBe('deny');
      expect(harsh.calls).toHaveLength(0);
      expect(harshRecord).toMatchObject({ decision: 'deny', source: 'rule', needsApproval: false });
    } else {
      expect(harsh.calls).toHaveLength(1);
      expect(harsh.decision).toMatchObject({ action: 'deny', needsApproval: true });
      expect(harshRecord).toMatchObject({ decision: 'deny', source: 'jev', needsApproval: true });
    }

    // A classifier that would call everything read-only. It can only add
    // denials: a rule's deny stands whatever it says.
    const lenient = await runGate(row, tree, true, SAYS_READ_ONLY);
    expect(lenient.records).toHaveLength(1);
    if (row.expect === 'deny') {
      expect(lenient.decision).toMatchObject({ action: 'deny', ruleId: row.ruleId });
      expect(lenient.calls).toHaveLength(0);
    } else {
      expect(lenient.decision).toEqual({ action: 'allow' });
      expect(lenient.calls).toHaveLength(row.expect === 'escalate' ? 1 : 0);
    }

    // No classifier configured: rules still deny, and the escalation band is
    // allowed and logged as a fallback without asking anything.
    const noKey = await runGate(row, tree, false, SAYS_DESTRUCTIVE);
    expect(noKey.calls).toHaveLength(0);
    expect(noKey.records).toHaveLength(1);
    expect(noKey.decision.action).toBe(row.expect === 'deny' ? 'deny' : 'allow');
    expect(noKey.records[0]?.source).toBe(row.expect === 'escalate' ? 'fallback' : 'rule');
  });
});
