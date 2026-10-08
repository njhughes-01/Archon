import { z } from '@hono/zod-openapi';
import { tierNameSchema, type TierName } from './model-binding';

const unitSchema = z.number().min(0).max(1);

/** Whether a decided route changes what a node runs on, or is only recorded. */
export const MODEL_ROUTER_RECORDED_MODES = ['shadow', 'apply'] as const;
/** Every value the operator's `modelRouter.mode` may take. `off` is never recorded. */
export const MODEL_ROUTER_MODES = ['off', ...MODEL_ROUTER_RECORDED_MODES] as const;
export const modelRouterModeSchema = z.enum(MODEL_ROUTER_MODES);
export type ModelRouterMode = z.infer<typeof modelRouterModeSchema>;

/**
 * The model router's block as written under `modelRouter:`. In the install config it is
 * the operator's opt-in; in a repository's config it can only narrow that opt-in (see
 * `narrowModelRouterConfig`). Sparse, so a block can set one field and leave the other.
 */
export const modelRouterConfigInputSchema = z.object({
  tiers: z.array(tierNameSchema).optional(),
  mode: modelRouterModeSchema.optional(),
});
export type ModelRouterConfigInput = z.infer<typeof modelRouterConfigInputSchema>;

/**
 * The opt-in with its defaults applied. `tiers` names the authored tiers the router may
 * lower; a node on any other tier, on a literal model or on an `@alias` is never routed.
 */
export interface ModelRouterConfig {
  tiers: TierName[];
  mode: ModelRouterMode;
}

/** Only the tier meant for ordinary work may be lowered until an operator names others. */
export const DEFAULT_MODEL_ROUTER_TIERS: readonly TierName[] = ['medium'];
/** A configured router records its routes without applying them until told to. */
export const DEFAULT_MODEL_ROUTER_MODE: ModelRouterMode = 'shadow';

/**
 * Apply a repository's `modelRouter:` block to the install's. A repository can only narrow
 * what the operator allowed: turn the router down or off, and take tiers away. It cannot
 * switch the router on, move it toward `apply`, or add a tier. `MODEL_ROUTER_MODES` is
 * ordered from least to most effect, which is the order "narrower" means here.
 *
 * The operator's install config decides what may be sent off the machine and which steps
 * may run on a cheaper model. A repository's committed config is written by whoever can
 * open a pull request against it.
 */
export function narrowModelRouterConfig(
  install: ModelRouterConfig,
  repo: ModelRouterConfigInput
): ModelRouterConfig {
  const repoTiers = repo.tiers;
  const rank = (mode: ModelRouterMode): number => MODEL_ROUTER_MODES.indexOf(mode);
  return {
    tiers:
      repoTiers === undefined
        ? install.tiers
        : install.tiers.filter(tier => repoTiers.includes(tier)),
    mode:
      repo.mode !== undefined && rank(repo.mode) < rank(install.mode) ? repo.mode : install.mode,
  };
}

export function resolveModelRouterConfig(input: ModelRouterConfigInput): ModelRouterConfig {
  return {
    tiers: input.tiers ?? [...DEFAULT_MODEL_ROUTER_TIERS],
    mode: input.mode ?? DEFAULT_MODEL_ROUTER_MODE,
  };
}

/**
 * The model router's decision for one node attempt, recorded on its execution binding.
 *
 * `authoredTier` is the ceiling: `routedTier` is never above it. `applied` is true only
 * when the attempt actually ran on a lower tier; in shadow mode, and whenever the decision
 * is the ceiling, the attempt ran exactly as it would have with no router.
 *
 * `reason` and `escalationReason` are plain strings on purpose: an older binary resuming a
 * run must be able to read a record written with a reason it has never heard of.
 */
export const nodeRouteSchema = z.object({
  mode: z.enum(MODEL_ROUTER_RECORDED_MODES),
  /** `jev`: its answer decided. `fallback`: a call was needed but gave nothing usable. `disabled`: no call. */
  source: z.enum(['jev', 'fallback', 'disabled']),
  authoredTier: tierNameSchema,
  routedTier: tierNameSchema,
  applied: z.boolean(),
  /** The classifier's own pick, kept when a floor overrode it so thresholds can be tuned from records. */
  chosenTier: tierNameSchema.optional(),
  probability: unitSchema.optional(),
  confidence: unitSchema.optional(),
  riskNoul: unitSchema.optional(),
  ambiguityNoul: unitSchema.optional(),
  /** Why the decision is the ceiling. Absent when a lower tier was chosen. */
  reason: z.string().optional(),
  /** The lower tier an earlier attempt of this node ran on before this attempt escalated. */
  escalatedFrom: tierNameSchema.optional(),
  /** The failure kind of the lower-tier attempt that caused the escalation. */
  escalationReason: z.string().optional(),
});
export type NodeRoute = z.infer<typeof nodeRouteSchema>;
