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
  // Not wired. The thread options this provider sets do not express "no
  // project-file writes, shell otherwise free": `sandboxMode: 'read-only'` also
  // stops the shell writing anywhere (project setup clones, `archon workflow …`
  // state) and `networkAccessEnabled` only sets
  // `sandbox_workspace_write.network_access`, while `workspace-write` is meant
  // to keep the working directory — the project itself — writable. A permission
  // profile passed through `CodexOptions.config` might express it; that route
  // has not been evaluated.
  fileWriteRestriction: false,
  // Through Codex's PreToolUse command hook (tool-gate-bridge.ts), proven with
  // real runs on codex-cli 0.157.0 and 0.159.3: shell commands, `apply_patch`
  // edits and MCP tools are asked about before they run, on new and resumed
  // threads; a denied call does not run and its reason and alternatives reach
  // the model. What this does not cover:
  //   - macOS and Linux only. A gated request on Windows is refused.
  //   - Hosted tools (web search) run inside OpenAI and never reach a hook.
  //   - The hook is Codex's to run. If the user has turned hooks off, the first
  //     tool call of a gated turn runs unasked before the provider sees it in
  //     the stream and stops the turn with `codex_tool_gate_inactive`.
  //   - The gate is told the session's working directory, not a directory the
  //     model may have chosen for one command.
  // Gated turns run with `features.unified_exec=false`, because `write_stdin`
  // to a running command is not hooked, and with Codex's hook-trust check
  // bypassed for that invocation, so hooks the user has configured but not yet
  // reviewed run as well.
  toolActionGate: true,
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
