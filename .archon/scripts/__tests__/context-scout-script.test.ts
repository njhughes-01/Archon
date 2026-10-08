/**
 * The scout's deterministic nodes, run as the engine runs them.
 *
 * The gate is the `config` node's own shell text, taken from the workflow file and run
 * with a shell and nothing else on PATH. The classifier is a Bun subprocess with
 * `--no-env-file`, reading `INPUTS_*` and the `JEV_*` settings from its environment, in a
 * real git checkout, talking HTTP to a local stand-in for the service.
 *
 * The subprocess is the subject: what these tests pin is the process contract (exit 0 and
 * one valid JSON document whatever happens) and that each result satisfies the
 * `output_format` the workflow declares for its node.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { validateStructuredOutput } from '@archon/providers';
import { stepRetryConfigSchema } from '../../../packages/workflows/src/schemas/retry';
import { readScoutSettings } from '../../workflows/sdlc/.shared/context-scout';

const SCOUT = resolve(import.meta.dir, '../../workflows/sdlc/scout');
const API_KEY = 'sk-test-PLANTED-KEY';
const trackTempRoot = trackTempRoots();

interface ScriptRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runScript(
  name: 'context-scout',
  cwd: string,
  env: Record<string, string>
): Promise<ScriptRun> {
  // The child gets PATH (to find git) and exactly the settings a test names. JEV_API_KEY
  // is always passed, empty unless the test sets it, so a key the developer's shell
  // exports can never reach the child and send this fixture to the live service.
  const child = Bun.spawn(['bun', '--no-env-file', 'run', join(SCOUT, 'scripts', `${name}.ts`)], {
    cwd,
    env: { PATH: process.env.PATH ?? '', JEV_API_KEY: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

function repo(tracked: Record<string, string>): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'context-scout-script-')));
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

interface Received {
  authorization: string | null;
  body: string;
}

type Respond = (body: string) => Response | Promise<Response>;

/** A local HTTP endpoint the script reaches through `JEV_API_BASE`. */
function classifier(respond: Respond): { base: string; received: Received[] } {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = await request.text();
      received.push({ authorization: request.headers.get('authorization'), body });
      return respond(body);
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${String(server.port)}`, received };
}

const servers: { stop: (closeActiveConnections?: boolean) => Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(servers.map(server => server.stop(true)));
});

/** Answers every question in the request with `noul`. */
function answering(noul: (path: string) => number): Respond {
  return body => {
    const request = JSON.parse(body) as {
      state: Record<string, { path: string }>;
      questions: Record<string, unknown>;
    };
    const answers = Object.fromEntries(
      Object.keys(request.questions).map(name => [
        name,
        { type: 'noul', noul: noul(request.state[name].path) },
      ])
    );
    return Response.json({ model: 'fake', answers, usage: { input_tokens: 1 } });
  };
}

interface AuthoredNode {
  id: string;
  bash?: string;
  script?: string;
  retry?: unknown;
  output_format?: Record<string, unknown>;
}

/** One node of the scout workflow, as authored. */
async function authoredNode(nodeId: string): Promise<AuthoredNode> {
  const workflow = Bun.YAML.parse(await Bun.file(join(SCOUT, 'archon-scout.yaml')).text()) as {
    nodes: AuthoredNode[];
  };
  const node = workflow.nodes.find(candidate => candidate.id === nodeId);
  if (node === undefined) throw new Error(`archon-scout has no node ${nodeId}`);
  return node;
}

/** The `output_format` the workflow declares for one of its nodes. */
async function declaredSchema(nodeId: string): Promise<Record<string, unknown>> {
  const schema = (await authoredNode(nodeId)).output_format;
  if (schema === undefined) throw new Error(`node ${nodeId} declares no output_format`);
  return schema;
}

/** Fails unless `stdout` is one JSON document the node's declared schema accepts. */
async function expectCertified(nodeId: string, stdout: string): Promise<void> {
  const compileErrors: string[] = [];
  const validation = validateStructuredOutput(
    JSON.parse(stdout),
    await declaredSchema(nodeId),
    message => compileErrors.push(message)
  );
  expect(compileErrors).toEqual([]);
  expect(validation).toEqual({ valid: true });
}

const QUESTION = 'Does this code validate a login token?';
const SOURCES = {
  'src/auth/token.ts': 'export function verifyToken(): boolean {\n  return true;\n}\n',
  'src/billing/invoice.ts': 'export const total = 1;\n',
  '.env': 'DATABASE_PASSWORD=PLANTED_DOTENV_SECRET\n',
};

/**
 * Runs the `config` node's shell text under `shell`, with an empty PATH: whatever it
 * prints, it printed using the shell alone.
 */
async function runGate(shell: string, env: Record<string, string>): Promise<ScriptRun> {
  const body = (await authoredNode('config')).bash;
  if (body === undefined) throw new Error('the config node is not a bash node');
  const shellPath = Bun.which(shell);
  if (shellPath === null) throw new Error(`${shell} is not installed`);
  const child = Bun.spawn([shellPath, '-c', body], {
    env: { PATH: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe('the config gate', () => {
  it('is shell text the workflow carries, not a script that needs a runtime', async () => {
    const node = await authoredNode('config');
    expect(typeof node.bash).toBe('string');
    expect(node.script).toBeUndefined();
  });

  // The gate and `readScoutSettings` both decide "is a classifier configured", in two
  // languages, because the gate must run where Bun may not be installed. This is the
  // conformance between them: every environment below gets the same answer from both.
  // An unusable number is the one deliberate difference. The gate does not read numbers,
  // so it says available, and the classifier node then reports the setting.
  const environments: Record<string, string>[] = [
    {},
    { JEV_API_KEY: '' },
    { JEV_API_KEY: '   ' },
    { JEV_API_KEY: '\t\n' },
    { JEV_API_KEY: 'k' },
    { JEV_API_KEY: '  k  ' },
    { JEV_API_KEY: 'k', JEV_ENABLED: '' },
    { JEV_API_KEY: 'k', JEV_ENABLED: '1' },
    { JEV_API_KEY: 'k', JEV_ENABLED: 'true' },
    { JEV_API_KEY: 'k', JEV_ENABLED: 'no' },
    { JEV_API_KEY: 'k', JEV_ENABLED: '00' },
    { JEV_API_KEY: 'k', JEV_ENABLED: '0' },
    { JEV_API_KEY: 'k', JEV_ENABLED: 'false' },
    { JEV_API_KEY: 'k', JEV_ENABLED: 'FALSE' },
    { JEV_API_KEY: 'k', JEV_ENABLED: ' False ' },
    { JEV_API_KEY: 'k', JEV_SCOUT_ENABLED: '0' },
    { JEV_API_KEY: 'k', JEV_SCOUT_ENABLED: 'fAlSe' },
    { JEV_API_KEY: 'k', JEV_SCOUT_ENABLED: ' 0\t' },
    { JEV_API_KEY: 'k', JEV_SCOUT_ENABLED: 'falsey' },
    { JEV_API_KEY: 'k', JEV_ENABLED: '1', JEV_SCOUT_ENABLED: '0' },
    { JEV_API_KEY: 'k', JEV_ENABLED: '0', JEV_SCOUT_ENABLED: '1' },
    { JEV_ENABLED: '0' },
    { JEV_API_KEY: 'k', JEV_SCOUT_THRESHOLD: 'high' },
    { JEV_API_KEY: '$(echo PLANTED_EXPANSION) * `id` "quoted" \\' },
  ];

  it.each(['sh', 'bash'])(
    'agrees with readScoutSettings on every environment under %s',
    async shell => {
      for (const env of environments) {
        const read = readScoutSettings(env);
        const numbersOnly = !read.available && read.reason.startsWith('invalid_setting:');
        const expected =
          read.available || numbersOnly
            ? { available: true, reason: '' }
            : { available: false, reason: read.reason };

        const run = await runGate(shell, env);

        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect({ env, result: JSON.parse(run.stdout) as unknown }).toEqual({
          env,
          result: expected,
        });
        await expectCertified('config', run.stdout);
      }
    }
  );

  it('never prints the key or anything a value expands to', async () => {
    const run = await runGate('sh', { JEV_API_KEY: `${API_KEY} $(echo PLANTED_EXPANSION)` });

    expect(JSON.parse(run.stdout)).toEqual({ available: true, reason: '' });
    expect(run.stdout + run.stderr).not.toContain('PLANTED');
  });
});

describe('the question node', () => {
  // Once a classifier is configured this agent can fail the run, so it retries harder
  // than the default: every failure class that is not fatal, the most times allowed.
  it('retries the most the engine allows, on any error that is not fatal', async () => {
    const retry = stepRetryConfigSchema.parse((await authoredNode('question')).retry);
    expect(retry).toEqual({ max_attempts: 5, on_error: 'all' });
  });
});

describe('context-scout', () => {
  it('prints a certified result naming the relevant file', async () => {
    const jev = classifier(answering(path => (path === 'src/auth/token.ts' ? 0.92 : 0.04)));

    const run = await runScript('context-scout', repo(SOURCES), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
      INPUTS_QUESTION: QUESTION,
      INPUTS_PATHS: '["src"]',
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    await expectCertified('classify', run.stdout);
    const result = JSON.parse(run.stdout) as {
      status: string;
      files: { path: string; relevant: boolean }[];
    };
    expect(result.status).toBe('ok');
    expect(result.files.map(entry => [entry.path, entry.relevant])).toEqual([
      ['src/auth/token.ts', true],
      ['src/billing/invoice.ts', false],
    ]);
    expect(jev.received).toHaveLength(1);
    expect(jev.received[0].authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('sends no excluded file and prints neither file contents nor the key', async () => {
    const jev = classifier(answering(() => 0.9));

    const run = await runScript('context-scout', repo(SOURCES), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
      INPUTS_QUESTION: QUESTION,
      INPUTS_PATHS: '',
    });

    expect(run.code).toBe(0);
    const sent = jev.received.map(request => request.body).join('\n');
    expect(sent).toContain('verifyToken');
    expect(sent).not.toContain('PLANTED_DOTENV_SECRET');
    expect(sent).not.toContain(API_KEY);
    const printed = run.stdout + run.stderr;
    expect(printed).not.toContain('PLANTED_DOTENV_SECRET');
    expect(printed).not.toContain('verifyToken');
    expect(printed).not.toContain(API_KEY);
  });

  it('tells the operator when it passed over a path git rejected', async () => {
    const jev = classifier(answering(() => 0.9));

    const run = await runScript('context-scout', repo(SOURCES), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
      INPUTS_QUESTION: QUESTION,
      INPUTS_PATHS: '["src", "../elsewhere"]',
    });

    expect(run.code).toBe(0);
    expect(run.stderr.trim()).toBe('context-scout: passed over 1 path(s) git rejected');
    await expectCertified('classify', run.stdout);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'ok', counts: { badPaths: 1 } });
  });

  it('reports an unusable setting itself, since the gate does not read numbers', async () => {
    const run = await runScript('context-scout', repo(SOURCES), {
      JEV_API_KEY: API_KEY,
      JEV_SCOUT_PARALLELISM: '64',
      INPUTS_QUESTION: QUESTION,
      INPUTS_PATHS: '["src"]',
    });

    expect(run.code).toBe(0);
    await expectCertified('classify', run.stdout);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'unavailable',
      reason: 'invalid_setting:JEV_SCOUT_PARALLELISM',
    });
  });

  it('marks a result the budget cut as truncated, on stdout and to the operator', async () => {
    const jev = classifier(answering(() => 0.9));

    const run = await runScript('context-scout', repo(SOURCES), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
      JEV_SCOUT_MAX_FILES: '1',
      INPUTS_QUESTION: QUESTION,
      INPUTS_PATHS: '["src"]',
    });

    expect(run.code).toBe(0);
    expect(run.stderr.trim()).toBe('context-scout: truncated (max_files)');
    await expectCertified('classify', run.stdout);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'truncated',
      reason: 'max_files',
      counts: { classified: 1, unclassified: 1 },
    });
  });

  it('exits 0 with an unavailable result when no key is set', async () => {
    const run = await runScript('context-scout', repo(SOURCES), {
      INPUTS_QUESTION: QUESTION,
      INPUTS_PATHS: '["src"]',
    });

    expect(run.code).toBe(0);
    expect(run.stderr.trim()).toBe('context-scout: unavailable (no_api_key)');
    await expectCertified('classify', run.stdout);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'unavailable',
      reason: 'no_api_key',
      files: [],
    });
  });

  it.each([
    [
      'an HTTP 500',
      (): Response => new Response('boom', { status: 500 }),
      'classifier_http_error:500',
    ],
    [
      'a body that is not JSON',
      (): Response => new Response('<html>'),
      'classifier_malformed_response',
    ],
    [
      'answers of the wrong shape',
      (): Response => Response.json({ answers: { w0000: { type: 'noul', noul: 'yes' } } }),
      'classifier_malformed_response',
    ],
  ])('exits 0 with an unavailable result on %s', async (_label, respond, reason) => {
    const jev = classifier(respond);

    const run = await runScript('context-scout', repo(SOURCES), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
      INPUTS_QUESTION: QUESTION,
      INPUTS_PATHS: '["src"]',
    });

    expect(run.code).toBe(0);
    expect(run.stderr.trim()).toBe(`context-scout: unavailable (${reason})`);
    await expectCertified('classify', run.stdout);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'unavailable', reason, files: [] });
  });

  it('exits 0 with an unavailable result when the classifier does not answer in time', async () => {
    const jev = classifier(async () => {
      await Bun.sleep(2000);
      return new Response('late');
    });

    const run = await runScript('context-scout', repo(SOURCES), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
      JEV_SCOUT_TIMEOUT_MS: '100',
      INPUTS_QUESTION: QUESTION,
      INPUTS_PATHS: '["src"]',
    });

    expect(run.code).toBe(0);
    await expectCertified('classify', run.stdout);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'unavailable',
      reason: 'classifier_timeout',
      files: [],
    });
  });

  it('exits 0 with an unavailable result when nothing listens at the endpoint', async () => {
    const run = await runScript('context-scout', repo(SOURCES), {
      JEV_API_KEY: API_KEY,
      // Port 9 (discard) on loopback: refused at once, and never a live service.
      JEV_API_BASE: 'http://127.0.0.1:9',
      INPUTS_QUESTION: QUESTION,
      INPUTS_PATHS: '["src"]',
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'unavailable',
      reason: 'classifier_network_error',
    });
  });
});
