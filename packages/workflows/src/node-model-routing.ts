/**
 * The executor's side of the model router: turns what a running DAG knows about one agent
 * node into the router's input, and nothing else.
 *
 * It lives beside the executor rather than in it so the router's wiring can be read, and
 * changed, without opening the executor. The rules about which nodes may be lowered and
 * how far are in `jev/model-router.ts`; this file only supplies the facts.
 */
import type { ExecutionContext } from '@archon/providers/types';
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
import type { AgentNode, EffortLevel } from './schemas';
import type { ModelRouterConfig, NodeRoute } from './schemas/model-router';
import type { WorkflowSourceRoots } from './workflow-source';

/** The workflow-level values that reach a node's model resolution and capability checks. */
export interface ModelScopeOptions {
  effort?: EffortLevel;
  fallbackModel?: unknown;
  sandbox?: unknown;
  webSearchMode?: unknown;
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
}

/** What the executor knows about this one dispatch of the node. */
export interface NodeRoutingDispatch {
  /** The node shares its layer with others, so no session crosses it. */
  isParallelLayer: boolean;
  /** The node's session is stored and resumed across runs. */
  usesPersistedScope: boolean;
  /** The run's named inputs, already resolved. */
  runInputs: Readonly<Record<string, unknown>> | undefined;
  /** The route an earlier pass of this run recorded for the node. */
  recorded: NodeRoute | undefined;
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
    // Outside a parallel layer a node may inherit the previous node's session, and the
    // next node may inherit this one's, and a session only resumes on its own provider.
    sameProviderOnly: !dispatch.isParallelLayer,
    inContainer: run.execContext.kind === 'container',
    capabilityScope: {
      declaredEffort: resolution.declaredEffort,
      workflowFallbackModel: run.workflowLevelOptions.fallbackModel,
      workflowSandbox: run.workflowLevelOptions.sandbox,
      webSearchMode: run.workflowLevelOptions.webSearchMode,
      hasEnvVars: (run.config.envVars && Object.keys(run.config.envVars).length > 0) === true,
    },
    loadStepText: async () => {
      if (source.kind === 'inline') return source.prompt;
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
