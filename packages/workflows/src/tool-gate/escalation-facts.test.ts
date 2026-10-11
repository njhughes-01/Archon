import { describe, expect, test } from 'bun:test';
import {
  ESCALATION_FACT_VALUES,
  githubAction,
  isBuildOutputPath,
  noteFact,
  targetHost,
  type EscalationFacts,
} from './escalation-facts';

describe('noteFact', () => {
  test('the first statement stands until a more concerning one is made', () => {
    const facts: EscalationFacts = {};
    noteFact(facts, 'gitPushTarget', 'other_unprotected_branch');
    noteFact(facts, 'gitPushTarget', 'checked_out_branch');
    expect(facts.gitPushTarget).toBe('other_unprotected_branch');
    noteFact(facts, 'gitPushTarget', 'protected_branch');
    expect(facts.gitPushTarget).toBe('protected_branch');
  });

  test('every fact has `unknown` or its own catch-all, so no call is forced into a wrong word', () => {
    for (const [name, values] of Object.entries(ESCALATION_FACT_VALUES)) {
      const catchAll = (values as readonly string[]).some(value =>
        ['unknown', 'other'].includes(value)
      );
      expect([name, catchAll]).toEqual([name, true]);
    }
  });
});

describe('isBuildOutputPath', () => {
  test.each([
    'build',
    'build/cache/x.o',
    'node_modules/.cache',
    'packages/web/dist',
    'src/__pycache__/mod.pyc',
    'coverage/lcov.info',
    'target/debug',
    '.cache',
  ])('%s is build, install or cache output', path => {
    expect(isBuildOutputPath(path)).toBe(true);
  });

  test.each(['src', 'src/builder.ts', 'docs/build-notes.md', 'distribution/readme', '', 'rebuild'])(
    '%p is not: only a whole path segment counts',
    path => {
      expect(isBuildOutputPath(path)).toBe(false);
    }
  );
});

describe('githubAction', () => {
  test.each([
    ['pr', 'comment', 'comment'],
    ['pr', 'review', 'comment'],
    ['pr', 'ready', 'open_or_update'],
    ['issue', 'create', 'open_or_update'],
    ['run', 'rerun', 'ci_run_control'],
    ['workflow', 'run', 'workflow_dispatch'],
    ['pr', 'merge', 'merge_or_close'],
    ['release', 'create', 'release'],
    ['release', 'delete', 'delete'],
    ['repo', 'delete', 'delete'],
    ['secret', 'set', 'settings_or_secrets'],
    ['repo', 'edit', 'settings_or_secrets'],
    ['label', 'create', 'other'],
    ['pr', 'frobnicate', 'other'],
  ])('gh %s %s → %s', (group, verb, expected) => {
    expect<string>(githubAction(group, verb)).toBe(expected);
  });
});

describe('targetHost', () => {
  test.each([
    [['-h', 'localhost', '-d', 'app'], 'loopback'],
    [['--host=127.0.0.1', '-c', 'select 1'], 'loopback'],
    [['mongodb://[::1]:27017/app'], 'loopback'],
    [['-d', 'app_test'], 'test_or_dev_named'],
    // A name says more than an address: test on loopback is still stated as test.
    [['-h', 'localhost', '-d', 'app_test'], 'test_or_dev_named'],
    [['mongodb://127.0.0.1:27017/widgets_dev'], 'test_or_dev_named'],
    [['-h', 'db.dev.internal', '-d', 'app'], 'test_or_dev_named'],
    [['-h', 'db.prod.internal', '-d', 'orders'], 'production_named'],
    // A production name wins over a loopback address: a tunnel is still production.
    [['-h', 'localhost', '-d', 'orders_production'], 'production_named'],
    [['-h', '10.20.4.17', '-d', 'orders'], 'unknown'],
  ])('a database client given %p → %s', (args, expected) => {
    expect<string | undefined>(targetHost(args, true)).toBe(expected);
  });

  test.each([
    [['http://localhost:3000/api/items'], 'loopback'],
    [['https://sandbox.api.example.com/v1/charges'], 'test_or_dev_named'],
    [['deploy@prod-1.example.com', 'uptime'], 'production_named'],
    [['build/app.tar.gz', 'deploy@prod-1.example.com:/srv/app/current.tar.gz'], 'production_named'],
    [['https://api.example.com/v1/users/42'], 'unknown'],
    // Only the host is a name here: not the user, the path, or a request body.
    [['-X', 'POST', 'http://127.0.0.1:3000/api/login', '-d', 'user=test'], 'loopback'],
    [['https://api.example.com/v1/test-fixtures/42'], 'unknown'],
    [['test@build-1.example.com', 'uptime'], 'unknown'],
    [['-h', 'http://localhost:8080/'], 'loopback'],
  ])('any other client given %p → %s', (args, expected) => {
    expect<string | undefined>(targetHost(args, false)).toBe(expected);
  });

  test('arguments that name no host and no database state nothing', () => {
    expect(targetHost(['-c', 'select 1'], true)).toBeUndefined();
    expect(targetHost(['-h'], false)).toBeUndefined();
    expect(targetHost([], false)).toBeUndefined();
  });

  test('a word that only contains a marker is not a marker: products is not prod', () => {
    expect(targetHost(['-h', 'products-db.internal'], true)).toBe('unknown');
    expect(targetHost(['-d', 'contest_entries'], true)).toBe('unknown');
  });
});
