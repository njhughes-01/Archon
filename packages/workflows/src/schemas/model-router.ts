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
export const modelRouterConfigInputSchema = z
  .object({
    tiers: z.array(tierNameSchema).optional(),
    mode: modelRouterModeSchema.optional(),
    steps: z.array(z.string().trim().min(1)).optional(),
  })
  // Strict on purpose, unlike the rest of the config: a mistyped key here (`teirs`,
  // `mdoe`) would otherwise leave the operator on defaults they did not choose.
  .strict();
export type ModelRouterConfigInput = z.infer<typeof modelRouterConfigInputSchema>;

/**
 * The opt-in with its defaults applied. `tiers` names the authored tiers the router may
 * lower; a node on any other tier, on a literal model or on an `@alias` is never routed.
 */
export interface ModelRouterConfig {
  tiers: TierName[];
  mode: ModelRouterMode;
  /**
   * The steps the router may lower, by step name (see `routerStepName`). Absent means
   * every step on a routable tier; present, only these. A listed name grants nothing by
   * itself: the step must still pass every other rule.
   */
  steps?: string[];
}

/** Only the tier meant for ordinary work may be lowered until an operator names others. */
export const DEFAULT_MODEL_ROUTER_TIERS: readonly TierName[] = ['medium'];
/** A configured router records its routes without applying them until told to. */
export const DEFAULT_MODEL_ROUTER_MODE: ModelRouterMode = 'shadow';

/**
 * Apply a repository's `modelRouter:` block to the install's. A repository can only narrow
 * what the operator allowed: turn the router down or off, and take tiers away. It cannot
 * switch the router on, move it toward `apply`, add a tier, or add a step. `MODEL_ROUTER_MODES` is
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
  const repoSteps = repo.steps;
  const rank = (mode: ModelRouterMode): number => MODEL_ROUTER_MODES.indexOf(mode);
  // No install list means every step. A repository list then narrows "every step" to
  // its own entries; with an install list it can only keep entries the install has.
  const steps =
    repoSteps === undefined
      ? install.steps
      : install.steps === undefined
        ? repoSteps
        : install.steps.filter(step => repoSteps.includes(step));
  return {
    tiers:
      repoTiers === undefined
        ? install.tiers
        : install.tiers.filter(tier => repoTiers.includes(tier)),
    mode:
      repo.mode !== undefined && rank(repo.mode) < rank(install.mode) ? repo.mode : install.mode,
    ...(steps !== undefined ? { steps } : {}),
  };
}

export function resolveModelRouterConfig(input: ModelRouterConfigInput): ModelRouterConfig {
  return {
    tiers: input.tiers ?? [...DEFAULT_MODEL_ROUTER_TIERS],
    mode: input.mode ?? DEFAULT_MODEL_ROUTER_MODE,
    ...(input.steps !== undefined ? { steps: input.steps } : {}),
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
