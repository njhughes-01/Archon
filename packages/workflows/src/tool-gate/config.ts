/**
 * The gate's configuration: what an install or a repository may write under
 * `toolGate:`, and how the two layers combine.
 *
 * The layers only ever tighten. A repository's config file is something the
 * gated agent can edit, so a later layer may switch the gate on and add to its
 * lists, and can never switch it off or take an entry away.
 */

/** The `toolGate:` block as one config file writes it. */
export interface ToolGateConfigInput {
  /** Switches the gate on. Default off. */
  enabled?: boolean;
  /** Branches a lease-protected forced push may never target, beside the built-in ones. */
  protectedBranches?: string[];
  /** Command prefixes known to only verify the repository, beside the built-in ones. */
  verificationCommands?: string[];
}

/** The block after the install and repository layers are combined. */
export interface ToolGateConfig {
  enabled: boolean;
  protectedBranches: readonly string[];
  verificationCommands: readonly string[];
}

const LIST_KEYS = ['protectedBranches', 'verificationCommands'] as const;
const KNOWN_KEYS: readonly string[] = ['enabled', ...LIST_KEYS];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseList(value: unknown, key: string, source: string): string[] {
  const entries = Array.isArray(value)
    ? value.map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    : [];
  if (!Array.isArray(value) || entries.includes('')) {
    throw new Error(`toolGate.${key} in ${source} must be a list of non-empty strings`);
  }
  return entries;
}

/**
 * Reads one file's `toolGate:` block. Refuses what it cannot read instead of
 * dropping it: a typo in a safety setting must not leave the gate off, or a
 * branch unprotected, with nothing to show the setting was ignored.
 *
 * @param source Names the file in the error, e.g. `global config (~/.archon/config.yaml)`.
 */
export function parseToolGateConfig(value: unknown, source: string): ToolGateConfigInput {
  if (!isRecord(value)) {
    throw new Error(`toolGate in ${source} must be a mapping with enabled and optional lists`);
  }
  const unknown = Object.keys(value).find(key => !KNOWN_KEYS.includes(key));
  if (unknown !== undefined) {
    throw new Error(
      `toolGate in ${source} has unknown key '${unknown}'. Known keys: ${KNOWN_KEYS.join(', ')}`
    );
  }
  const parsed: ToolGateConfigInput = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new Error(`toolGate.enabled in ${source} must be true or false`);
    }
    parsed.enabled = value.enabled;
  }
  for (const key of LIST_KEYS) {
    if (value[key] !== undefined) parsed[key] = parseList(value[key], key, source);
  }
  return parsed;
}

function union(base: readonly string[], added: readonly string[] | undefined): string[] {
  return [...new Set([...base, ...(added ?? [])])];
}

/** Adds one layer to what the layers before it set. See the file header for why it only tightens. */
export function mergeToolGateConfig(
  base: ToolGateConfig | undefined,
  layer: ToolGateConfigInput
): ToolGateConfig {
  return {
    enabled: base?.enabled === true || layer.enabled === true,
    protectedBranches: union(base?.protectedBranches ?? [], layer.protectedBranches),
    verificationCommands: union(base?.verificationCommands ?? [], layer.verificationCommands),
  };
}
