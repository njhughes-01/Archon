---
title: Provider Capability Matrix
description: Canonical per-provider capability matrix, generated from each provider capabilities.ts.
category: reference
area: clients
audience: [user, developer]
status: current
sidebar:
  order: 10
---

<!-- AUTO-GENERATED — DO NOT EDIT. Regenerate with: bun run generate:capability-matrix -->

:::note
This page is **auto-generated** from each provider's `capabilities.ts` (the same
constants the workflow engine reads to enforce provider-specific behavior). Do not
edit it by hand — run `bun run generate:capability-matrix`.
A capability change fails `bun run validate` until this page is regenerated.
:::

Each column is a registered provider id (the value you set as `provider:` in a
workflow or `.archon/config.yaml`). A ✅ means Archon translates the corresponding
capability for that provider; a ❌ means the capability is unsupported. Unsupported
behavior is feature-specific: some optional fields are ignored with a warning, while
strict contracts fail closed. In particular, `context.resume` rejects an explicitly
unsupported provider at load time and an implicitly resolved one at runtime.

Reporting flags describe SDK fields that Archon translates into execution results.
Supported does not guarantee that every result reports a value or that usage includes
all nested agents. Unsupported fields remain absent; Archon does not estimate cost,
count events as turns, or substitute the requested model for an unreported model.
Cost reporting is independent of spend-limit support. Older providers may omit
reporting declarations; absence means unknown, not unsupported.

## Providers

- `claude` — Claude (Anthropic)
- `codex` — Codex (OpenAI)
- `opencode` — OpenCode (community) *(community provider)*
- `pi` — Pi (community) *(community provider)*
- `copilot` — Copilot (GitHub) *(community provider)*

## Capabilities

| Capability | `claude` | `codex` | `opencode` | `pi` | `copilot` |
| --- | --- | --- | --- | --- | --- |
| Session resume | ✅ | ✅ | ✅ | ✅ | ✅ |
| Immutable session fork (`context.resume`) | ✅ | ❌ | ❌ | ✅ | ❌ |
| MCP servers (`mcp:`) | ✅ | ✅ | ❌ | ❌ | ✅ |
| Hooks (`hooks:`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Skills (`skills:`) | ✅ | ❌ | ❌ | ✅ | ✅ |
| Inline sub-agents (`agents:`) | ✅ | ❌ | ✅¹ | ❌ | ✅ |
| Tool restrictions (`allowed_tools`/`denied_tools`) | ✅ | ❌ | ✅ | ✅ | ✅ |
| Direct chat without file-editing tools | ✅ | ❌ | ✅² | ✅ | ✅ |
| Tool action gate (`toolGate` config) | ✅³ | ✅⁴ | ❌ | ✅⁵ | ✅⁶ |
| Structured output (`output_format`) | **enforced** | **enforced** | **enforced** | best-effort | best-effort |
| Env injection (`env:`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Spend limit (`maxBudgetUsd`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Cost reporting (`costUsd`) | ✅ | ❌ | ✅ | ✅ | ❌ |
| Token reporting | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stop reason reporting | ✅ | ❌ | ✅ | ✅ | ❌ |
| Turn count reporting | ✅ | ❌ | ❌ | ❌ | ❌ |
| Resolved model reporting | ✅ | ❌ | ✅ | ✅ | ❌ |
| Effort control (`effort`) | ✅ | ✅ | ❌ | ✅ | ✅ |
| Fallback model (`fallbackModel`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Sandbox (`sandbox`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Setting sources (`settingSources`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| In-process native tools | ✅ | ❌ | ❌ | ✅ | ❌ |
| Container exec (folder-project container backend) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Strict-mode `required` coverage (every key in `properties` MUST appear in `required`) | ❌ | ✅ | ❌ | ❌ | ❌ |

## Caveats

- ¹ `opencode` — Inline sub-agents (`agents:`) — Config-file-based agent selection (named agents from `opencode.json`) with per-call model/tools overrides — not inline sub-agent definitions.
- ² `opencode` — Direct chat without file-editing tools — Sent as a per-session permission rule denying `edit`, which stays on that chat session. Wired from the SDK typings and not yet verified against a running OpenCode; a server that answers without the rule is logged as `opencode.file_write_restriction_unconfirmed`.
- ³ `claude` — Tool action gate (`toolGate` config) — Through a `PreToolUse` hook that answers `deny`. Verified with real runs: a denied call does not run and its reason reaches the model.
- ⁴ `codex` — Tool action gate (`toolGate` config) — Through Codex's `PreToolUse` command hook, on macOS and Linux only and with Codex CLI 0.157.0 or newer. A gated turn runs without TTY sessions, and with hooks forced on under the trust bypass, so the user's own configured hooks run too. Hosted tools (web search) never reach the hook. If Codex does not run the hook, the turn is stopped at the first tool call with `codex_tool_gate_inactive`.
- ⁵ `pi` — Tool action gate (`toolGate` config) — Every tool Archon builds for the turn is wrapped. Tools from the user's own Pi extensions are not, and with the gate on the built tool set replaces the user's `defaultTools`.
- ⁶ `copilot` — Tool action gate (`toolGate` config) — Through the `onPreToolUse` hook. Verified against the SDK typings and the runtime bundle only, not with a real run.

## Legend

- **✅ / ❌** — the capability is supported or unsupported for this provider.
- **Unknown** — the provider has not declared whether this reporting channel is supported.
- **✅¹ (superscript)** — supported, but with semantics that differ from the headline
  meaning of the axis — see [Caveats](#caveats).
- **Structured output** — `enforced` (the SDK/backend grammar-constrains decoding),
  `best-effort` (schema appended to the prompt, then validated + re-asked up to 3×),
  or ❌ (unsupported). See [AI Assistants → Structured output guarantees](/getting-started/ai-assistants/#structured-output-guarantees).
- **In-process native tools** — the provider can register Archon `NativeTool`s for a
  turn (gates auto-injection of Archon's `manage_run` tool into project-scoped chat).
- **Tool action gate** — the provider asks the engine before each tool call that can
  change state and does not run a call the gate denies. With the gate switched on, a
  workflow node or chat turn on a ❌ provider fails before it starts. See
  [Tool Action Gate](/reference/tool-gate/).

For per-provider field-level notes (YAML syntax, caveats), see the
[AI Assistants guide](/getting-started/ai-assistants/).
