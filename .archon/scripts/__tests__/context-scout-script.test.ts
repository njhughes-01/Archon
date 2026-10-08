/**
 * The scout's two script nodes, run as the engine runs them: a Bun subprocess with
 * `--no-env-file`, reading `INPUTS_*` and the `JEV_*` settings from its environment, in a
 * real git checkout, talking HTTP to a local stand-in for the classifier.
 *
 * The subprocess is the subject: what these tests pin is the process contract (exit 0 and
 * one valid JSON document whatever the classifier does) and that the result satisfies the
 * `output_format` the workflow declares for the node.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { validateStructuredOutput } from '@archon/providers';

const SCOUT = resolve(import.meta.dir, '../../workflows/sdlc/scout');
const API_KEY = 'sk-test-PLANTED-KEY';
const trackTempRoot = trackTempRoots();

interface ScriptRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runScript(
  name: 'scout-config' | 'context-scout',
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

/** The `output_format` the workflow declares for one of its nodes. */
async function declaredSchema(nodeId: string): Promise<Record<string, unknown>> {
  const workflow = Bun.YAML.parse(await Bun.file(join(SCOUT, 'archon-scout.yaml')).text()) as {
    nodes: { id: string; output_format?: Record<string, unknown> }[];
  };
  const schema = workflow.nodes.find(node => node.id === nodeId)?.output_format;
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

describe('scout-config', () => {
  it('reports unavailable, silently, when no key is set', async () => {
    const run = await runScript('scout-config', repo(SOURCES), {});

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toEqual({ available: false, reason: 'no_api_key' });
    await expectCertified('config', run.stdout);
  });

  it('reports available without printing the key', async () => {
    const run = await runScript('scout-config', repo(SOURCES), { JEV_API_KEY: API_KEY });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ available: true, reason: '' });
    expect(run.stdout + run.stderr).not.toContain(API_KEY);
    await expectCertified('config', run.stdout);
  });

  it('reports the scout switched off while the key stays set', async () => {
    const run = await runScript('scout-config', repo(SOURCES), {
      JEV_API_KEY: API_KEY,
      JEV_SCOUT_ENABLED: '0',
    });

    expect(JSON.parse(run.stdout)).toEqual({ available: false, reason: 'disabled' });
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
