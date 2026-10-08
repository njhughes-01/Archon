import type { ProviderCapabilities } from '../types';

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  sessionFork: false,
  mcp: true,
  hooks: false,
  // Codex has native filesystem skills, but does not implement Archon's per-node
  // `skills:` list. Workflow nodes suppress the automatic catalog and authors
  // invoke installed skills explicitly with `$skill-name` in the node body.
  skills: false,
  agents: false,
  toolRestrictions: false,
  // No thread option expresses "no project-file writes, shell otherwise free".
  // `sandboxMode` is the only write control: `read-only` also stops the shell
  // writing anywhere (project setup clones, `archon workflow …` state) and has
  // no network switch (`networkAccessEnabled` only sets
  // `sandbox_workspace_write.network_access`); `workspace-write` makes the
  // working directory — the project itself — writable. There is no per-tool
  // switch and no approval callback to refuse a single edit.
  fileWriteRestriction: false,
  structuredOutput: 'enforced', // SDK outputSchema grammar-constrains decoding
  requiresAllPropertiesRequired: true, // OpenAI strict-mode: every key in properties must appear in required
  envInjection: true,
  costControl: false,
  costReporting: false, // turn usage carries token axes only
  tokenReporting: true,
  stopReasonReporting: false,
  turnCountReporting: false,
  resolvedModelReporting: false,
  // Codex reads the node-level `effort:` field like every other effort-capable
  // provider and translates it to the SDK's `modelReasoningEffort` internally
  // (#2556). Before that it was `false` — which was read as "Codex cannot do
  // reasoning depth" rather than the truth, "Codex spells it differently".
  effortControl: true,
  fallbackModel: false,
  sandbox: false,
  settingSources: false, // Claude Agent SDK-only knob (which setting sources the agent loads)
  nativeTools: false,
  containerExec: false, // no in-container spawn path yet (fail-fast source of truth)
};
