import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  COMPOSED_NODE,
  type ComposedNodeMeta,
  type NodeWithComposedMeta,
} from './compiled-command';
import { planGraph } from './graph-plan';
import { sessionMayCrossNode } from './node-model-routing';
import { dagNodeSchema, type DagNode } from './schemas/dag-node';
import type { GraphPlan } from './schemas/workflow';
import { discoverWorkflows } from './workflow-discovery';

const node = (fields: Record<string, unknown>): DagNode => {
  const parsed = dagNodeSchema.parse(fields);
  if (parsed.kind === 'include') throw new Error('fixture is an include directive');
  return parsed;
};
const agent = (id: string, deps: string[] = [], extra: Record<string, unknown> = {}): DagNode =>
  node({ id, prompt: 'p', depends_on: deps, ...extra });
const script = (id: string, deps: string[] = []): DagNode =>
  node({ id, bash: 'true', depends_on: deps });

function attachComposedMeta(target: DagNode, meta: ComposedNodeMeta): void {
  (target as DagNode & NodeWithComposedMeta)[COMPOSED_NODE] = meta;
}

/** Whether a session may cross the node called `id` in the graph `nodes` describe. */
function crosses(nodes: DagNode[], id: string): boolean {
  const { layers } = planGraph(nodes);
  const index = layers.findIndex(layer => layer.some(candidate => candidate.id === id));
  if (index < 0) throw new Error(`no node '${id}' in the plan`);
  return sessionMayCrossNode(layers, index);
}

describe('sessionMayCrossNode: the rule, on small graphs', () => {
  it('is false for a node that runs alone in its workflow', () => {
    expect(crosses([agent('a')], 'a')).toBe(false);
  });

  it('is true on both sides of two agent nodes in sequence', () => {
    const graph = [agent('a'), agent('b', ['a'])];
    expect(crosses(graph, 'a')).toBe(true);
    expect(crosses(graph, 'b')).toBe(true);
  });

  it('is true across a script: a script leaves the cursor where the agent before it put it', () => {
    const graph = [agent('a'), script('s', ['a']), agent('b', ['s'])];
    expect(crosses(graph, 'a')).toBe(true);
    expect(crosses(graph, 'b')).toBe(true);
  });

  it('is false for every node of a parallel layer, which neither inherits nor hands on', () => {
    const graph = [agent('first'), agent('left', ['first']), agent('right', ['first'])];
    expect(crosses(graph, 'left')).toBe(false);
    expect(crosses(graph, 'right')).toBe(false);
    // The parallel layer clears the cursor, so `first` hands its session to nobody.
    expect(crosses(graph, 'first')).toBe(false);
  });

  it('is false after a parallel layer: the cursor was cleared and nothing set it since', () => {
    const graph = [
      agent('first'),
      agent('left', ['first']),
      agent('right', ['first']),
      script('join', ['left', 'right']),
      agent('last', ['join']),
    ];
    expect(crosses(graph, 'last')).toBe(false);
  });

  it('does not treat a fresh node as a barrier, because a skipped node moves nothing', () => {
    // `b` starts fresh, so it does not read `a`'s session. But if `b` is skipped, the
    // cursor is still `a`'s when `c` runs.
    const graph = [agent('a'), agent('b', ['a'], { context: 'fresh' }), agent('c', ['b'])];
    expect(crosses(graph, 'a')).toBe(true);
    expect(crosses(graph, 'c')).toBe(true);
  });

  it('is false for a fresh node followed only by scripts', () => {
    const graph = [agent('a'), agent('b', ['a'], { context: 'fresh' }), script('s', ['b'])];
    expect(crosses(graph, 'b')).toBe(false);
  });

  it('is false between fresh nodes separated from the rest by scripts and the end', () => {
    const graph = [script('s'), agent('only', ['s'], { context: 'fresh' }), script('t', ['only'])];
    expect(crosses(graph, 'only')).toBe(false);
  });

  it('treats a composed block entry as starting fresh, unless it asks for the shared thread', () => {
    const entry = agent('block__entry', ['a']);
    attachComposedMeta(entry, { origin: 'block', blockEntry: true });
    expect(crosses([agent('a', [], { context: 'fresh' }), entry], 'block__entry')).toBe(false);
    const shared = agent('block__entry', ['a'], { context: 'shared' });
    attachComposedMeta(shared, { origin: 'block', blockEntry: true });
    expect(crosses([agent('a'), shared], 'block__entry')).toBe(true);
  });

  it('is true next to a loop node, whose use of the cursor is not modelled', () => {
    const loop = (deps: string[]): DagNode =>
      node({
        id: 'loop',
        depends_on: deps,
        loop: { prompt: 'p', until: 'DONE', max_iterations: 1, fresh_context: true },
      });
    expect(crosses([agent('a'), loop(['a'])], 'a')).toBe(true);
    expect(crosses([loop([]), agent('after', ['loop'])], 'after')).toBe(true);
    expect(crosses([loop([]), agent('after', ['loop'], { context: 'fresh' })], 'after')).toBe(
      false
    );
  });

  it('does not count a loop group after the node as a reader, but counts one before it', () => {
    const group = (deps: string[]): DagNode =>
      node({
        id: 'group',
        depends_on: deps,
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          nodes: [{ id: 'body', prompt: 'p' }],
        },
      });
    expect(crosses([agent('a', [], { context: 'fresh' }), group(['a'])], 'a')).toBe(false);
    expect(crosses([group([]), agent('after', ['group'])], 'after')).toBe(true);
  });
});

describe('sessionMayCrossNode: the bundled SDLC graphs', () => {
  const repoRoot = join(import.meta.dir, '../../..');

  async function layersOf(name: string): Promise<GraphPlan['layers']> {
    const found = await discoverWorkflows(repoRoot, { loadDefaults: false });
    const workflow = found.workflows.find(entry => entry.workflow.name === name)?.workflow;
    if (!workflow) throw new Error(`workflow '${name}' was not discovered`);
    return workflow.plan.layers;
  }
  /** Agent nodes a session may cross, and those it provably cannot. */
  async function partition(name: string): Promise<{ crossed: string[]; clear: string[] }> {
    const layers = await layersOf(name);
    const crossed: string[] = [];
    const clear: string[] = [];
    layers.forEach((layer, index) => {
      for (const candidate of layer) {
        if (candidate.kind !== 'agent') continue;
        (sessionMayCrossNode(layers, index) ? crossed : clear).push(candidate.id);
      }
    });
    return { crossed: crossed.sort(), clear: clear.sort() };
  }

  it('validate: discover shares a layer and classify follows a cleared cursor', async () => {
    expect(await partition('archon-validate')).toEqual({
      crossed: [],
      clear: ['classify', 'discover'],
    });
  });

  it('pr and triage: a lone agent step followed by a script', async () => {
    expect(await partition('archon-pr')).toEqual({ crossed: [], clear: ['pr'] });
    expect(await partition('archon-triage')).toEqual({ crossed: [], clear: ['triage'] });
  });

  it('review: every step starts fresh and none hands a session on', async () => {
    expect((await partition('archon-review')).crossed).toEqual([]);
  });

  it('deliver: pr hands its session to the scope classifier across a script', async () => {
    const { crossed, clear } = await partition('archon-deliver');
    // pr -> publish (script) -> classify: the script does not separate the two agents.
    expect(crossed).toEqual(['classify', 'pr__pr']);
    expect(clear).toEqual(
      expect.arrayContaining([
        'review__scope',
        'review__synthesize',
        'sync-pr-body',
        'validate__classify',
        'validate__discover',
      ])
    );
  });

  it('ship: the same pair inside deliver, and nothing else', async () => {
    const { crossed } = await partition('archon-ship');
    expect(crossed).toEqual(['deliver__classify', 'deliver__pr__pr']);
  });
});
