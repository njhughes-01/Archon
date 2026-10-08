/**
 * The executor's side of the model router: turns what a running DAG knows about one agent
 * node into the router's input, and nothing else.
 *
 * It lives beside the executor rather than in it so the router's wiring can be read, and
 * changed, without opening the executor. The rules about which nodes may be lowered and
 * how far are in `jev/model-router.ts`; this file only supplies the facts.
 */
import type { ExecutionContext } from '@archon/providers/types';
import { readComposedMeta } from './compiled-command';
import type { WorkflowConfig, WorkflowDeps } from './deps';
import { loadCommandPrompt } from './executor-shared';
import { formatTaskText, routeAgentNode, type RoutedNode } from './jev/model-router';
import type { ModelAliasPreset, ResolvedAiProfile, TierName } from './model-validation';
import {
  assistantModelDefaults,
  resolveNodeModel,
  type WorkflowModelScope,
} from './node-model-resolution';
import { collectCredentialValues } from './redaction';
import type { AgentNode, DagNode, EffortLevel } from './schemas';
import type { ModelRouterConfig, NodeRoute } from './schemas/model-router';
import type { GraphPlan } from './schemas/workflow';
import { assertWorkflowSourceIntegrity, type WorkflowSourceRoots } from './workflow-source';

/** The workflow-level values that reach a node's model resolution and capability checks. */
export interface ModelScopeOptions {
  effort?: EffortLevel;
  fallbackModel?: unknown;
  sandbox?: unknown;
  webSearchMode?: unknown;
  betas?: unknown;
  workflowTier?: TierName;
}

/** The workflow-level fallbacks the executor threads beside each node, as the resolver takes them. */
export function executorModelScope(
  workflowProvider: string,
  workflowModel: string | undefined,
  workflowPreset: ModelAliasPreset | undefined,
  workflowLevelOptions: ModelScopeOptions
): WorkflowModelScope {
  return {
    provider: workflowProvider,
    model: workflowModel,
    preset: workflowPreset,
    tier: workflowLevelOptions.workflowTier,
    effort: workflowLevelOptions.effort,
    // Only used to LABEL an inherited provider in a dry run; the executor discards it.
    providerOrigin: 'workflow',
  };
}

/** What the run knows about itself, read off the executor's layer context. */
export interface NodeRoutingRun {
  deps: Pick<WorkflowDeps, 'loadConfig'>;
  cwd: string;
  config: WorkflowConfig;
  workflowRun: { user_message: string };
  workflowProvider: string;
  workflowModel: string | undefined;
  workflowPreset?: ModelAliasPreset;
  workflowLevelOptions: ModelScopeOptions;
  aiProfile?: ResolvedAiProfile;
  execContext: ExecutionContext;
  configuredCommandFolder?: string;
  workflowSourceRoots: WorkflowSourceRoots;
  namedResumeSourceIds?: ReadonlySet<string>;
  /** The topological layers the executor is walking: the whole top-level DAG. */
  layers: GraphPlan['layers'];
  /**
   * Whether this run may use a provider at all. Nothing sets it yet; the tool-action
   * gate will, so that with the gate on a provider without the `toolActionGate`
   * capability is never offered. Absent means every registered provider is usable.
   */
  providerUsable?: (provider: string) => boolean;
}

/** What the executor knows about this one dispatch of the node. */
export interface NodeRoutingDispatch {
  /** The index of the node's layer in `NodeRoutingRun.layers`. */
  layerIndex: number;
  /** The node's session is stored and resumed across runs. */
  usesPersistedScope: boolean;
  /** The run's named inputs, already resolved. */
  runInputs: Readonly<Record<string, unknown>> | undefined;
  /** The route an earlier pass of this run recorded for the node. */
  recorded: NodeRoute | undefined;
}

/** A node the engine starts without a session whatever ran before it. */
function startsFreshByDeclaration(node: DagNode): boolean {
  // A composed block's entry starts as coldly as the block would standalone, unless its
  // author asked for the caller's thread with `context: shared`.
  return (
    node.context === 'fresh' ||
    (readComposedMeta(node)?.blockEntry === true && node.context !== 'shared')
  );
}

/** A node that makes no provider turn and leaves the session cursor exactly as it found it. */
function leavesSessionCursorAlone(node: DagNode): boolean {
  return node.kind === 'exec' || node.kind === 'halt' || node.kind === 'wait';
}

/**
 * Whether a provider session may cross the node at `layers[layerIndex]`: come into it from
 * an earlier node, or go out of it into a later one. A session only resumes on the provider
 * that created it, so moving such a node to another provider either drops a continuation
 * the unrouted run would have had or creates one it would not.
 *
 * Read off the plan alone, from the executor's cursor rules, so the answer is the same on
 * every run of a graph and never depends on which nodes happened to be skipped:
 *
 *  - Every node of a parallel layer starts without a session, and none of them becomes the
 *    cursor. A parallel layer also clears the cursor when it starts.
 *  - A single-node layer's node becomes the cursor when it completes with a session.
 *  - Bash, script, cancel and wait nodes neither read nor move the cursor. A script
 *    between two agent nodes therefore does not separate them.
 *  - An agent node that starts fresh by declaration does not read the cursor, but it may
 *    be skipped, and a skipped node leaves the cursor where it was. So it is not a
 *    barrier in either direction.
 *
 *  - A loop group never reads the enclosing cursor (its body has its own), so one after
 *    the node is not a reader. One before the node may have left a session behind.
 *
 * `false` is a proof that no session crosses the node. Anything not proven is `true`: a
 * loop, an approval gate, a sub-run or a fan-out next to the node counts as a possible
 * session, because their use of the cursor is not modelled here.
 */
export function sessionMayCrossNode(layers: GraphPlan['layers'], layerIndex: number): boolean {
  const own = layers[layerIndex];
  if (own?.length !== 1) return false;
  const [node] = own;

  // In: walk back to the nearest thing that could have set the cursor.
  if (!startsFreshByDeclaration(node)) {
    for (let index = layerIndex - 1; index >= 0; index--) {
      const layer = layers[index];
      if (layer.length !== 1) break;
      if (!leavesSessionCursorAlone(layer[0])) return true;
    }
  }

  // Out: walk forward to the nearest node that could read the cursor this node sets.
  for (let index = layerIndex + 1; index < layers.length; index++) {
    const layer = layers[index];
    if (layer.length !== 1) break;
    const [next] = layer;
    if (leavesSessionCursorAlone(next)) continue;
    if (next.kind === 'agent' && startsFreshByDeclaration(next)) continue;
    // A loop group's body runs on the group's own cursor, which starts empty or from the
    // group's own pause record. It never reads the enclosing one, though it may replace it.
    if (next.kind === 'loop_group') continue;
    return true;
  }
  return false;
}

/**
 * Ask the model router whether this node may run below its authored tier. `undefined`
 * means the router does not apply to the node, and nothing is recorded for it.
 *
 * Called only for a single-shot agent node of the top-level DAG. That is the one place a
 * node's `source` still holds the text its author wrote: a loop_group body, a fan-out
 * instance and an approval rework prompt have run data written into theirs before
 * dispatch, and a loop node runs many turns on one binding. Those paths never reach here.
 *
 * What leaves the machine is the authored step text and the run's task input (its
 * message and named inputs), each redacted and cut by the router. Node-local `with:`
 * bindings and upstream outputs are run data and are never sent.
 */
export async function routeNodeModel(
  run: NodeRoutingRun,
  node: AgentNode,
  config: ModelRouterConfig,
  dispatch: NodeRoutingDispatch
): Promise<RoutedNode | undefined> {
  let resolution: ReturnType<typeof resolveNodeModel>;
  try {
    resolution = resolveNodeModel(
      node,
      executorModelScope(
        run.workflowProvider,
        run.workflowModel,
        run.workflowPreset,
        run.workflowLevelOptions
      ),
      assistantModelDefaults(run.config),
      run.aiProfile
    );
  } catch {
    // An unresolvable model ref is the node's own failure, and the executor's resolution
    // reports it next with the full error. Routing has nothing to add to it.
    return undefined;
  }
  const { source } = node;
  return routeAgentNode({
    node,
    resolution,
    aiProfile: run.aiProfile,
    config,
    recorded: dispatch.recorded,
    isResumeSource: run.namedResumeSourceIds?.has(node.id) === true,
    usesPersistedScope: dispatch.usesPersistedScope,
    sameProviderOnly: sessionMayCrossNode(run.layers, dispatch.layerIndex),
    ...(run.providerUsable !== undefined ? { providerUsable: run.providerUsable } : {}),
    inContainer: run.execContext.kind === 'container',
    capabilityScope: {
      declaredEffort: resolution.declaredEffort,
      workflowFallbackModel: run.workflowLevelOptions.fallbackModel,
      workflowSandbox: run.workflowLevelOptions.sandbox,
      webSearchMode: run.workflowLevelOptions.webSearchMode,
      workflowBetas: run.workflowLevelOptions.betas,
      hasEnvVars: (run.config.envVars && Object.keys(run.config.envVars).length > 0) === true,
    },
    loadStepText: async () => {
      if (source.kind === 'inline') return source.prompt;
      // The node's own execution checks the captured source before it reads a command.
      // This read comes first and its text leaves the machine, so it checks too: a
      // tampered capture throws here, which the router turns into "keep the ceiling".
      await assertWorkflowSourceIntegrity(run.workflowSourceRoots);
      const loaded = await loadCommandPrompt(
        run.deps,
        run.cwd,
        source.name,
        run.configuredCommandFolder,
        run.workflowSourceRoots
      );
      return loaded.success ? loaded.content : undefined;
    },
    taskText: () => formatTaskText(run.workflowRun.user_message, dispatch.runInputs),
    credentialValues: () =>
      collectCredentialValues(
        { ...process.env, ...run.config.envVars },
        run.config.protectedEnvKeys,
        run.config.protectedCredentialValues
      ),
  });
}
