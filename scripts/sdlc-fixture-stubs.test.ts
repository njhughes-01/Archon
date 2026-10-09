import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * archon-validate's `failure-class` node sends a failing check's record to a classifier
 * when one is configured. A fixture run inherits the operator's environment, and the CLI
 * loads the operator's Archon env file, so a fixture that lets that node execute would
 * send its log to the live service from `archon workflow test` and from `bun run
 * validate`, on every install that has a key.
 *
 * So every fixture whose run can reach the node stubs it. "Can reach" is read from the
 * fixture alone, with no simulation:
 *
 * - validate's `run` is stubbed red, which is the node's own condition; or
 * - `run` is not stubbed and the fixture executes code, so the real check runner decides.
 *   Today's checks may pass, but nothing would notice the day one is edited to fail.
 *
 * A fixture finds validate's nodes under whatever prefix composition gave them
 * (`validate__run` in deliver, `deliver__validate__run` in ship), so they are recognised
 * here by the shape of the stubs validate's own nodes take, never by a list of prefixes.
 */
const SDLC = join(import.meta.dir, '..', '.archon', 'workflows', 'sdlc');
const NODE = 'failure-class';

interface Fixture {
  path: string;
  stubs: Record<string, unknown>;
  execCode: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stub is a mapping, or the JSON text of one. */
function stubValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function fixtures(): Fixture[] {
  return [...new Bun.Glob('*/fixtures/*.stubs.yaml').scanSync({ cwd: SDLC })]
    .map(path => path.split('\\').join('/'))
    .sort()
    .map(path => {
      const parsed: unknown = Bun.YAML.parse(readFileSync(join(SDLC, path), 'utf8'));
      if (!isRecord(parsed)) throw new Error(`${path} is not a mapping`);
      const { fixture: _declaration, 'exec-code': execCode, ...stubs } = parsed;
      return { path, stubs, execCode: execCode === true };
    });
}

/** Whether a stub is the output of validate's `discover` node. */
function isDiscovery(stub: unknown): boolean {
  return isRecord(stub) && Array.isArray(stub.checks) && Array.isArray(stub.quarantine);
}

interface Reach {
  /** The prefix validate's nodes carry in this fixture: '' or `<include>__…`. */
  prefix: string;
  why: 'run is stubbed red' | 'the real check runner decides';
}

/** Every place in a fixture where validate's ordinary path can reach `failure-class`. */
function reaches(fixture: Fixture): Reach[] {
  const found: Reach[] = [];
  for (const [id, raw] of Object.entries(fixture.stubs)) {
    const stub = stubValue(raw);
    if (id === 'run' || id.endsWith('__run')) {
      const prefix = id.slice(0, id.length - 'run'.length);
      if (isRecord(stub) && stub.status === 'red') {
        found.push({ prefix, why: 'run is stubbed red' });
      }
    }
    if ((id === 'discover' || id.endsWith('__discover')) && isDiscovery(stub)) {
      const prefix = id.slice(0, id.length - 'discover'.length);
      if (fixture.execCode && !Object.hasOwn(fixture.stubs, `${prefix}run`)) {
        found.push({ prefix, why: 'the real check runner decides' });
      }
    }
  }
  return found;
}

describe('fixtures never reach the live classifier', () => {
  const all = fixtures();

  it('stubs failure-class wherever a fixture can reach it', () => {
    const unstubbed = all.flatMap(fixture =>
      reaches(fixture)
        .filter(reach => !Object.hasOwn(fixture.stubs, `${reach.prefix}${NODE}`))
        .map(reach => `${fixture.path}: stub '${reach.prefix}${NODE}' (${reach.why})`)
    );

    expect(unstubbed).toEqual([]);
  });

  it('gives every such stub the shape of a real opinion', () => {
    const malformed = all.flatMap(fixture =>
      Object.entries(fixture.stubs)
        .filter(([id]) => id === NODE || id.endsWith(`__${NODE}`))
        .filter(([, raw]) => {
          const stub = stubValue(raw);
          return !(
            isRecord(stub) &&
            (stub.status === 'ok' || stub.status === 'unavailable') &&
            stub.advisory === true
          );
        })
        .map(([id]) => `${fixture.path}: ${id}`)
    );

    expect(malformed).toEqual([]);
  });

  // Guards the checks above against passing by recognising nothing.
  it('recognises the node and both ways of reaching it', () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(SDLC, 'validate', 'archon-validate.yaml'), 'utf8')
    ) as { nodes: { id: string; depends_on?: string[]; when?: string }[] };
    const node = workflow.nodes.find(candidate => candidate.id === NODE);
    // The rule above restates this node's condition; it must still be the node's.
    expect(node?.depends_on).toEqual(['run']);
    expect(node?.when).toBe("$run.output.status == 'red'");
    expect(workflow.nodes.map(candidate => candidate.id)).toContain('discover');

    const reached = all.flatMap(fixture => reaches(fixture));
    expect(reached.filter(reach => reach.why === 'run is stubbed red').length).toBeGreaterThan(0);
    expect(
      reached.filter(reach => reach.why === 'the real check runner decides').length
    ).toBeGreaterThan(0);
    // Through each depth of composition the pack has: alone, included, included twice.
    expect([...new Set(reached.map(reach => reach.prefix))].sort()).toEqual([
      '',
      'deliver__validate__',
      'validate__',
    ]);
  });
});
