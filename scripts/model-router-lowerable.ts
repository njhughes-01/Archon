/**
 * Which steps of the bundled SDLC pack the model router could lower on a given tier map.
 *
 * No classifier is involved. This answers the question that comes before it: with these
 * tiers on these providers, which steps would the router even ask about? It loads the pack
 * with the real loader, so composed workflows are the expanded graphs a run executes, and
 * applies the router's own rules (`routingCeiling`, `offerTiers`, `sessionMayCrossNode`)
 * with the registered providers' real capabilities. Nothing here restates a rule.
 *
 * `scripts/model-router-eval.ts --lowerable <map>` prints the report.
 */
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { registerBuiltinProviders } from '../packages/providers/src/index';
import { readComposedMeta } from '../packages/workflows/src/compiled-command';
import {
  offerTiers,
  routingCeiling,
  type RoutingCandidate,
} from '../packages/workflows/src/jev/model-router';
import { buildAiProfile } from '../packages/workflows/src/model-validation';
import { sessionMayCrossNode } from '../packages/workflows/src/node-model-routing';
import { resolveNodeModel } from '../packages/workflows/src/node-model-resolution';
import { parsePackagedResourceReference } from '../packages/workflows/src/packaged-workflow';
import { isNodeContextResume, type AgentNode } from '../packages/workflows/src/schemas/dag-node';
import type { RawTiersConfig, TierName } from '../packages/workflows/src/schemas/model-binding';
import type { ModelRouterConfig } from '../packages/workflows/src/schemas/model-router';
import type { ResolvedWorkflow } from '../packages/workflows/src/schemas/workflow';
import { discoverWorkflows } from '../packages/workflows/src/workflow-discovery';

/**
 * Named tier maps. `codex-small` is the cross-provider shape the router's rules were
 * written against: the small tier on one provider, medium and large on another.
 */
export const TIER_MAPS = {
  'codex-small': {
    defaultProvider: 'claude',
    tiers: {
      small: { provider: 'codex', model: 'gpt-6-luna' },
      medium: { provider: 'claude', model: 'sonnet' },
      large: { provider: 'claude', model: 'opus' },
    },
  },
  'claude-only': {
    defaultProvider: 'claude',
    tiers: {
      small: { provider: 'claude', model: 'haiku' },
      medium: { provider: 'claude', model: 'sonnet' },
      large: { provider: 'claude', model: 'opus' },
    },
  },
} as const satisfies Record<string, { defaultProvider: string; tiers: RawTiersConfig }>;
export type TierMapName = keyof typeof TIER_MAPS;

export function isTierMapName(value: unknown): value is TierMapName {
  return typeof value === 'string' && Object.hasOwn(TIER_MAPS, value);
}

/** The opt-in the report assumes: the router's default tiers, applied. */
const ROUTER_CONFIG: ModelRouterConfig = { tiers: ['medium'], mode: 'apply' };

export interface PackInstance {
  workflow: string;
  nodeId: string;
  /** The command the step runs, traced back through composition to the file that names it. */
  command: string | undefined;
  authoredTier: TierName | undefined;
  lowerable: boolean;
  /** `tier (provider)` the step could be lowered to. */
  target?: string;
  /** Why the step cannot be lowered. */
  reason?: string;
  /** The router's input for this step, for a caller that goes on to classify it. */
  candidate: RoutingCandidate;
}

/** A command's name as its author wrote it, without the pack prefix the loader adds. */
function plainCommandName(reference: string): string {
  return parsePackagedResourceReference(reference)?.name ?? reference;
}

/** The dispatchable workflows of the pack under `packRoot`, by the file names that declare them. */
async function packWorkflowNames(packRoot: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const entry of await readdir(packRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of await readdir(join(packRoot, entry.name))) {
      if (file.endsWith('.yaml')) names.add(basename(file, '.yaml'));
    }
  }
  return names;
}

function whyNotRoutable(candidate: RoutingCandidate): string {
  const { node, resolution, config } = candidate;
  if (resolution.tier === undefined || resolution.preset === undefined) return 'pinned_model';
  if (!config.tiers.includes(resolution.tier)) return `tier_${resolution.tier}_not_routable`;
  if (isNodeContextResume(node.context)) return 'resume_consumer';
  if (candidate.isResumeSource) return 'resume_source';
  if (candidate.usesPersistedScope) return 'persisted_session';
  return 'unregistered_provider';
}

/** Every single-shot agent step of every workflow in the pack, with the router's verdict. */
export async function packInstances(
  repoRoot: string,
  packRoot: string,
  mapName: TierMapName
): Promise<PackInstance[]> {
  registerBuiltinProviders();
  const map = TIER_MAPS[mapName];
  const aiProfile = buildAiProfile(map.defaultProvider, { repoTiers: map.tiers });
  const names = await packWorkflowNames(packRoot);
  const discovered = await discoverWorkflows(repoRoot, { loadDefaults: false });
  const workflows = discovered.workflows
    .map(entry => entry.workflow)
    .filter(workflow => names.has(workflow.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  // A composed step is an inline prompt under a prefixed id. Its command is named by the
  // step of the same id in the workflow it was authored in.
  const ownCommands = new Map<string, string>();
  for (const workflow of workflows) {
    for (const node of workflow.nodes) {
      if (node.kind === 'agent' && node.source.kind === 'command') {
        ownCommands.set(`${workflow.name}\u0000${node.id}`, plainCommandName(node.source.name));
      }
    }
  }
  const commandOf = (workflow: ResolvedWorkflow, node: AgentNode): string | undefined => {
    if (node.source.kind === 'command') return plainCommandName(node.source.name);
    const origin = readComposedMeta(node)?.origin;
    const leaf = node.id.split('__').at(-1) ?? node.id;
    return ownCommands.get(`${origin ?? workflow.name}\u0000${leaf}`);
  };

  const instances: PackInstance[] = [];
  for (const workflow of workflows) {
    const resumeSources = new Set(
      workflow.nodes.flatMap(node =>
        isNodeContextResume(node.context) ? [node.context.resume] : []
      )
    );
    workflow.plan.layers.forEach((layer, layerIndex) => {
      for (const node of layer) {
        if (node.kind !== 'agent') continue;
        const resolution = resolveNodeModel(
          node,
          {
            provider: map.defaultProvider,
            model: undefined,
            preset: undefined,
            tier: undefined,
            effort: undefined,
            providerOrigin: 'default assistant',
          },
          {},
          aiProfile
        );
        const candidate: RoutingCandidate = {
          node,
          resolution,
          aiProfile,
          config: ROUTER_CONFIG,
          isResumeSource: resumeSources.has(node.id),
          usesPersistedScope:
            (node.context !== 'fresh' && node.persist_session) ??
            workflow.persist_sessions === true,
          sameProviderOnly: sessionMayCrossNode(workflow.plan.layers, layerIndex),
          inContainer: false,
          capabilityScope: {
            declaredEffort: resolution.declaredEffort,
            workflowFallbackModel: undefined,
            workflowSandbox: undefined,
            webSearchMode: workflow.webSearchMode,
            workflowBetas: undefined,
            hasEnvVars: false,
          },
        };
        const base = {
          workflow: workflow.name,
          nodeId: node.id,
          command: commandOf(workflow, node),
          authoredTier: resolution.tier,
          candidate,
        };
        const ceiling = routingCeiling(candidate);
        if (ceiling === undefined) {
          instances.push({ ...base, lowerable: false, reason: whyNotRoutable(candidate) });
          continue;
        }
        if (node.output_format === undefined) {
          instances.push({ ...base, lowerable: false, reason: 'unverifiable' });
          continue;
        }
        const offer = offerTiers(candidate, ceiling);
        const [tier] = offer.offered;
        if (tier === undefined) {
          const reasons = [...new Set(Object.values(offer.excluded))].join(', ');
          instances.push({ ...base, lowerable: false, reason: reasons || 'no_lower_tier' });
          continue;
        }
        instances.push({
          ...base,
          lowerable: true,
          target: `${tier} (${aiProfile.aliases[tier].provider})`,
        });
      }
    });
  }
  return instances;
}

/** The report as text. */
export function formatLowerability(
  instances: readonly PackInstance[],
  mapName: TierMapName
): string {
  const map = TIER_MAPS[mapName];
  const tiers = Object.entries(map.tiers)
    .map(([tier, preset]) => `${tier}=${preset.provider}`)
    .join(', ');
  const routable = instances.filter(
    instance =>
      instance.authoredTier !== undefined && ROUTER_CONFIG.tiers.includes(instance.authoredTier)
  );
  const lowerable = instances.filter(instance => instance.lowerable);
  const lines = [
    `Steps the model router could lower on the '${mapName}' map (${tiers}), tiers ${ROUTER_CONFIG.tiers.join(', ')}`,
    '',
  ];
  for (const workflow of [...new Set(instances.map(instance => instance.workflow))]) {
    lines.push(workflow);
    for (const instance of instances.filter(candidate => candidate.workflow === workflow)) {
      const verdict = instance.lowerable
        ? `LOWERABLE -> ${instance.target ?? ''}`
        : `no: ${instance.reason ?? ''}`;
      lines.push(
        `  ${instance.nodeId.padEnd(36)} ${(instance.command ?? '-').padEnd(22)} ${(instance.authoredTier ?? 'pinned').padEnd(7)} ${verdict}`
      );
    }
  }
  const commands = (list: readonly PackInstance[]): string =>
    [...new Set(list.map(instance => instance.command ?? instance.nodeId))].sort().join(', ') ||
    'none';
  const reasons = new Map<string, number>();
  for (const instance of routable.filter(candidate => !candidate.lowerable)) {
    const reason = instance.reason ?? 'unknown';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  lines.push(
    '',
    `Single-shot agent steps: ${String(instances.length)}; on a routable tier: ${String(routable.length)}; lowerable: ${String(lowerable.length)}`,
    `Lowerable commands: ${commands(lowerable)}`,
    `Routable-tier commands never lowerable: ${commands(routable.filter(instance => !lowerable.some(other => other.command === instance.command)))}`,
    'Why routable-tier steps are not lowerable:',
    ...[...reasons]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `  ${String(count).padStart(3)}  ${reason}`)
  );
  return lines.join('\n');
}
