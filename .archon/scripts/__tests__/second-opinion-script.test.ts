/**
 * The `failure-class` checkpoint of archon-validate, run as the engine runs it.
 *
 * Every workflow fixture stubs this node, because a fixture run inherits the operator's
 * environment and an unstubbed one would send its log to the live classifier. So this is
 * the test that the authored node reaches its script: the node's own `with:` values are
 * read from the workflow file, turned into binding text by the engine's own rule, and
 * handed to a Bun subprocess with `--no-env-file`, which talks HTTP to a local stand-in
 * for the service.
 *
 * The subprocess is the subject: what these tests pin is the process contract (exit 0 and
 * one valid JSON document whatever happens) and that each result satisfies the
 * `output_format` the workflow declares for the node.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { validateStructuredOutput } from '@archon/providers';
import { canonicalValueText } from '../../../packages/workflows/src/output-ref';
import { inputEnvKey } from '../../../packages/workflows/src/schemas/dag-node';
import { parseChoices } from '../../workflows/sdlc/.shared/second-opinion';

const VALIDATE = resolve(import.meta.dir, '../../workflows/sdlc/validate');
const API_KEY = 'sk-test-PLANTED-KEY';
const trackTempRoot = trackTempRoots();

interface AuthoredNode {
  id: string;
  script?: string;
  when?: string;
  depends_on?: string[];
  trigger_rule?: string;
  timeout?: number;
  on_timeout?: string;
  with?: Record<string, unknown>;
  output_format?: Record<string, unknown>;
}

/** One node of archon-validate, as authored. */
async function authoredNode(nodeId: string): Promise<AuthoredNode> {
  const workflow = Bun.YAML.parse(
    await Bun.file(join(VALIDATE, 'archon-validate.yaml')).text()
  ) as { nodes: AuthoredNode[] };
  const node = workflow.nodes.find(candidate => candidate.id === nodeId);
  if (node === undefined) throw new Error(`archon-validate has no node ${nodeId}`);
  return node;
}

/** The node's literal `with:` values as the environment the engine would deliver. */
async function authoredBindings(nodeId: string): Promise<Record<string, string>> {
  const bindings = (await authoredNode(nodeId)).with;
  if (bindings === undefined) throw new Error(`node ${nodeId} binds nothing`);
  return Object.fromEntries(
    Object.entries(bindings).map(([name, value]) => [inputEnvKey(name), canonicalValueText(value)])
  );
}

async function declaredSchema(nodeId: string): Promise<Record<string, unknown>> {
  const schema = (await authoredNode(nodeId)).output_format;
  if (schema === undefined) throw new Error(`node ${nodeId} declares no output_format`);
  return schema;
}

/** Fails unless `value` satisfies the schema the workflow declares for the node. */
async function expectCertified(nodeId: string, value: unknown): Promise<void> {
  const compileErrors: string[] = [];
  const validation = validateStructuredOutput(value, await declaredSchema(nodeId), message =>
    compileErrors.push(message)
  );
  expect(compileErrors).toEqual([]);
  expect(validation).toEqual({ valid: true });
}

interface ScriptRun {
  code: number;
  stdout: string;
  stderr: string;
}

const RECORD = [
  '# Validation',
  '',
  '## 1. tests',
  '',
  '`bun run test` failed (exit 1) after 12s.',
  '',
  'Last 60 lines of output:',
  '',
  '```',
  'SENT_MARKER error: connect ECONNREFUSED 127.0.0.1:5432',
  'DATABASE_PASSWORD=PLANTED_RECORD_SECRET',
  '```',
  '',
].join('\n');

/** A run's artifacts directory holding the record the failing gate left. */
function artifactsWith(record: string | null): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'failure-class-')));
  const dir = join(root, 'artifacts');
  mkdirSync(dir, { recursive: true });
  if (record !== null) writeFileSync(join(dir, 'validation.md'), record);
  return dir;
}

async function runFailureClass(
  artifacts: string,
  env: Record<string, string>
): Promise<ScriptRun> {
  // The child gets exactly the settings a test names. JEV_API_KEY is always passed, empty
  // unless the test sets it, so a key the developer's shell exports can never reach the
  // child and send this fixture to the live service.
  const child = Bun.spawn(
    ['bun', '--no-env-file', 'run', join(VALIDATE, 'scripts', 'failure-class.ts')],
    {
      cwd: artifacts,
      env: {
        PATH: process.env.PATH ?? '',
        JEV_API_KEY: '',
        ARTIFACTS_DIR: artifacts,
        ...(await authoredBindings('failure-class')),
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

interface Received {
  authorization: string | null;
  body: string;
}

type Respond = (body: string) => Response | Promise<Response>;

const servers: { stop: (closeActiveConnections?: boolean) => Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(servers.map(server => server.stop(true)));
});

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

interface ChoiceRequest {
  state: { evidence: string };
  questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
}

/** Answers the question asked with `choice`, at 0.85, the rest spread evenly. */
function choosing(choice: string): Respond {
  return body => {
    const request = JSON.parse(body) as ChoiceRequest;
    const [name, question] = Object.entries(request.questions)[0];
    const others = Object.keys(question.criteria).filter(option => option !== choice);
    const probabilities = Object.fromEntries([
      [choice, 0.85],
      ...others.map(option => [option, 0.15 / others.length]),
    ]);
    return Response.json({
      model: 'fake',
      answers: { [name]: { type: 'choice', choice, confidence: 0.8, probabilities } },
      usage: { input_tokens: 1 },
    });
  };
}

const CLASSES = ['code_defect', 'flaky_test', 'dependency_failure', 'environment_failure'];

describe('the failure-class node as authored', () => {
  it('offers the four failure classes, each with a criterion', async () => {
    const bindings = await authoredBindings('failure-class');
    const choices = parseChoices(bindings.INPUTS_CHOICES);

    expect(Object.keys(choices)).toEqual(CLASSES);
    for (const criterion of Object.values(choices)) {
      // A sentence about what the log shows, not a restatement of the name.
      expect(criterion.length).toBeGreaterThan(60);
    }
    expect(bindings.INPUTS_QUESTION.trim()).not.toBe('');
    expect(bindings.INPUTS_EVIDENCE_PATH).toBe('validation.md');
  });

  it('runs only on a red gate, and can never hold the run up', async () => {
    const node = await authoredNode('failure-class');
    const classify = await authoredNode('classify');

    expect(node.script).toBe('failure-class');
    expect(node.depends_on).toEqual(['run']);
    // The same condition that sends a red gate to `classify`.
    expect(node.when).toBe(classify.when);
    expect(node.when).toBe("$run.output.status == 'red'");
    // The script ends itself at its own deadline; the node's timeout is the backstop,
    // and it skips rather than fails.
    expect(node.on_timeout).toBe('skip');
    expect(node.timeout).toBeGreaterThan(30_000);
    // A skipped opinion must not skip the classification it advises.
    expect(classify.depends_on).toEqual(['run', 'failure-class']);
    expect(classify.trigger_rule).toBe('none_failed_min_one_success');
  });

  it('names the same classes everywhere the workflow spells them', async () => {
    const offered = Object.keys(
      parseChoices((await authoredBindings('failure-class')).INPUTS_CHOICES)
    );
    const opinion = (await declaredSchema('failure-class')) as {
      properties: { choice: { anyOf: { enum?: string[] }[] } };
    };
    const result = (await declaredSchema('result')) as {
      properties: { advisory_failure_class: { enum: string[] } };
      required: string[];
    };

    expect(opinion.properties.choice.anyOf.find(branch => branch.enum)?.enum).toEqual(offered);
    expect(result.properties.advisory_failure_class.enum).toEqual(offered);
    // Advisory and optional: no consumer of the verdict may come to depend on it.
    expect(result.required).not.toContain('advisory_failure_class');

    // The prompt explains every class by name, and names no class that is not offered.
    const prompt = await Bun.file(join(VALIDATE, 'commands', 'classify-red.md')).text();
    const named = new Set(prompt.match(/\b[a-z]+_(?:defect|test|failure)\b/g) ?? []);
    expect([...named].sort()).toEqual([...offered].sort());
  });

  it('gives classify a default that has the shape of a real opinion', async () => {
    const binding = (await authoredNode('classify')).with?.opinion as {
      from: string;
      if_skipped: Record<string, unknown>;
    };

    expect(binding.from).toBe('$failure-class.output');
    expect(binding.if_skipped).toEqual({
      status: 'unavailable',
      reason: 'not_run',
      choice: null,
      probabilities: {},
      confidence: null,
      advisory: true,
    });
    await expectCertified('failure-class', binding.if_skipped);
  });
});

describe('failure-class', () => {
  it('sends the question, the four classes and the record, and prints a certified opinion', async () => {
    const jev = classifier(choosing('environment_failure'));

    const run = await runFailureClass(artifactsWith(RECORD), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    const opinion = JSON.parse(run.stdout) as Record<string, unknown>;
    await expectCertified('failure-class', opinion);
    expect(Object.keys(opinion).sort()).toEqual(
      ['advisory', 'choice', 'confidence', 'probabilities', 'reason', 'status'].sort()
    );
    expect(opinion).toMatchObject({
      status: 'ok',
      reason: '',
      choice: 'environment_failure',
      confidence: 0.8,
      advisory: true,
    });
    expect(Object.keys(opinion.probabilities as object).sort()).toEqual([...CLASSES].sort());

    expect(jev.received).toHaveLength(1);
    expect(jev.received[0].authorization).toBe(`Bearer ${API_KEY}`);
    const request = JSON.parse(jev.received[0].body) as ChoiceRequest;
    const questions = Object.values(request.questions);
    expect(questions).toHaveLength(1);
    expect(questions[0].type).toBe('choice');
    expect(Object.keys(questions[0].criteria)).toEqual(CLASSES);
    expect(questions[0].instructions).toStartWith(
      (await authoredBindings('failure-class')).INPUTS_QUESTION.trim()
    );
    expect(request.state.evidence).toContain('SENT_MARKER error: connect ECONNREFUSED');
  });

  it('redacts the record before sending it, and prints neither the record nor the key', async () => {
    const jev = classifier(choosing('environment_failure'));

    const run = await runFailureClass(artifactsWith(RECORD), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
    });

    expect(run.code).toBe(0);
    const sent = jev.received.map(request => request.body).join('\n');
    expect(sent).toContain('SENT_MARKER');
    expect(sent).not.toContain('PLANTED_RECORD_SECRET');
    expect(sent).not.toContain(API_KEY);
    const printed = run.stdout + run.stderr;
    expect(printed).not.toContain('SENT_MARKER');
    expect(printed).not.toContain('PLANTED');
    expect(printed).not.toContain(API_KEY);
  });

  it.each([
    ['no key is set', {}, 'no_api_key'],
    ['every Jev feature is switched off', { JEV_API_KEY: API_KEY, JEV_ENABLED: '0' }, 'disabled'],
    ['its own switch is off', { JEV_API_KEY: API_KEY, JEV_OPINION_ENABLED: '0' }, 'disabled'],
  ])('exits 0, silent and unavailable, when %s', async (_label, env, reason) => {
    const run = await runFailureClass(artifactsWith(RECORD), env);

    expect(run.code).toBe(0);
    // Off by configuration is the usual state of an install. It is not news.
    expect(run.stderr).toBe('');
    const opinion: unknown = JSON.parse(run.stdout);
    await expectCertified('failure-class', opinion);
    expect(opinion).toEqual({
      status: 'unavailable',
      reason,
      choice: null,
      probabilities: {},
      confidence: null,
      advisory: true,
    });
  });

  it('names an unusable setting, to the operator as well', async () => {
    const run = await runFailureClass(artifactsWith(RECORD), {
      JEV_API_KEY: API_KEY,
      JEV_OPINION_MAX_EVIDENCE_CHARS: 'lots',
    });

    expect(run.code).toBe(0);
    expect(run.stderr.trim()).toBe(
      'failure-class: unavailable (invalid_setting:JEV_OPINION_MAX_EVIDENCE_CHARS)'
    );
    const opinion: unknown = JSON.parse(run.stdout);
    await expectCertified('failure-class', opinion);
    expect(opinion).toMatchObject({
      status: 'unavailable',
      reason: 'invalid_setting:JEV_OPINION_MAX_EVIDENCE_CHARS',
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
      'a class that was not offered',
      (body: string): Response => {
        const [name] = Object.keys((JSON.parse(body) as ChoiceRequest).questions);
        return Response.json({
          answers: {
            [name]: {
              type: 'choice',
              choice: 'cosmic_rays',
              confidence: 1,
              probabilities: { cosmic_rays: 1 },
            },
          },
        });
      },
      'classifier_unknown_choice',
    ],
  ])('exits 0 with an unavailable opinion on %s', async (_label, respond, reason) => {
    const jev = classifier(respond);

    const run = await runFailureClass(artifactsWith(RECORD), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
    });

    expect(run.code).toBe(0);
    expect(run.stderr.trim()).toBe(`failure-class: unavailable (${reason})`);
    const opinion: unknown = JSON.parse(run.stdout);
    await expectCertified('failure-class', opinion);
    expect(opinion).toMatchObject({ status: 'unavailable', reason, choice: null });
    expect(jev.received).toHaveLength(1);
  });

  it('exits 0 with an unavailable opinion when the classifier does not answer in time', async () => {
    const jev = classifier(async () => {
      await Bun.sleep(2000);
      return new Response('late');
    });

    const run = await runFailureClass(artifactsWith(RECORD), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
      JEV_OPINION_TIMEOUT_MS: '100',
    });

    expect(run.code).toBe(0);
    const opinion: unknown = JSON.parse(run.stdout);
    await expectCertified('failure-class', opinion);
    expect(opinion).toMatchObject({ status: 'unavailable', reason: 'classifier_timeout' });
  });

  it('exits 0 with an unavailable opinion when nothing listens at the endpoint', async () => {
    const run = await runFailureClass(artifactsWith(RECORD), {
      JEV_API_KEY: API_KEY,
      // Port 9 (discard) on loopback: refused at once, and never a live service.
      JEV_API_BASE: 'http://127.0.0.1:9',
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: 'unavailable',
      reason: 'classifier_network_error',
    });
  });

  it('exits 0 with an unavailable opinion when the gate left no record', async () => {
    const jev = classifier(choosing('code_defect'));

    const run = await runFailureClass(artifactsWith(null), {
      JEV_API_KEY: API_KEY,
      JEV_API_BASE: jev.base,
    });

    expect(run.code).toBe(0);
    const opinion: unknown = JSON.parse(run.stdout);
    await expectCertified('failure-class', opinion);
    expect(opinion).toMatchObject({
      status: 'unavailable',
      reason: 'evidence_not_regular_file',
    });
    expect(jev.received).toEqual([]);
  });
});
