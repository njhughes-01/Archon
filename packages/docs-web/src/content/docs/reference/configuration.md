---
title: Configuration Reference
description: Full reference for Archon's layered configuration system including YAML config, environment variables, and streaming modes.
category: reference
area: config
audience: [user, operator]
status: current
sidebar:
  order: 6
---

Archon supports a layered configuration system with sensible defaults, optional YAML config files, and environment variable overrides. For a quick introduction, see [Getting Started: Configuration](/getting-started/).

## Directory Structure

### User-Level (~/.archon/)

```
~/.archon/
├── workspaces/owner/repo/  # Project-centric layout
│   ├── source/             # Clone or symlink -> local path
│   ├── worktrees/          # Git worktrees for this project
│   ├── artifacts/          # Workflow artifacts
│   └── logs/               # Workflow execution logs
├── workflows/              # Home-scoped workflows (source: 'global')
├── commands/               # Home-scoped commands (source: 'global')
├── scripts/                # Home-scoped scripts (runtime: bun | uv)
├── archon.db               # SQLite database (when DATABASE_URL not set)
└── config.yaml             # Global configuration (optional)
```

Home-scoped `workflows/`, `commands/`, and `scripts/` apply to every project on the machine. Repo-local legacy/shared files at `<repoRoot>/.archon/{workflows,commands,scripts}/` override them by filename (or script name). Shared/grouped layouts support one subfolder; packaged workflows use exactly `workflows/<pack>/<workflow>/` with one YAML directly inside. Package-owned commands and scripts do not fall through across scopes. See [Global Workflows](/guides/global-workflows/) for details and dotfiles-sync examples.

### Repository-Level (.archon/)

```
.archon/
├── commands/       # Custom commands
│   └── plan.md
├── workflows/      # Workflow definitions (YAML files)
└── config.yaml     # Repo-specific configuration (optional)
```

## Configuration Priority

Settings are loaded in this order (later overrides earlier):

1. **Defaults** - Sensible built-in defaults
2. **Global Config** - `~/.archon/config.yaml`
3. **Repo Config** - `.archon/config.yaml` in repository
4. **Environment Variables** - Process-level overrides
5. **Per-user AI preferences** - Personal assistant, tiers, and aliases for the acting user
6. **Run config** - Sparse content selected for one fresh run
7. **Explicit run model bindings** - Repeatable `--model` or HTTP `tiers`/`aliases`, per named binding

The last three layers exist only where their setting has a run-time consumer. Archon-managed GitHub and provider credentials remain protected and are injected after user-authored run environment values.

## Global Configuration

Create `~/.archon/config.yaml` for user-wide preferences:

```yaml
# Default AI assistant
defaultAssistant: claude # must match a registered provider (e.g. claude, codex)

# Assistant defaults
assistants:
  claude:
    model: sonnet
    settingSources:   # Which sources the Claude SDK loads (default: ['project', 'user'])
      - project       # Project-level <cwd>/.claude/ (CLAUDE.md, skills, commands, agents)
      - user          # User-level ~/.claude/ (CLAUDE.md, skills, commands, agents)
    # Optional: absolute path to the Claude Code executable.
    # Required in compiled Archon binaries when CLAUDE_BIN_PATH is not set.
    # Accepts the native binary (~/.local/bin/claude from the curl installer),
    # the npm-installed cli.js, or the npm platform-package directory
    # (e.g. @anthropic-ai/claude-code-win32-x64 — auto-expanded to claude/claude.exe).
    # Source/dev mode auto-resolves.
    # claudeBinaryPath: /absolute/path/to/claude
  codex:
    model: gpt-5.6-terra
    modelReasoningEffort: medium
    webSearchMode: disabled
    additionalDirectories:
      - /absolute/path/to/other/repo
    # codexBinaryPath: /absolute/path/to/codex  # Optional: Codex CLI path

# Streaming preferences per platform
streaming:
  telegram: stream # 'stream' or 'batch'
  discord: batch
  slack: batch
  github: batch

# Custom paths (usually not needed)
paths:
  workspaces: ~/.archon/workspaces
  worktrees: ~/.archon/worktrees

# Concurrency limits
concurrency:
  maxConversations: 10
  # Optional install-wide cap on simultaneous provider attempts, by provider ID.
  # Unlisted providers are unlimited. See "Provider concurrency caps" below.
  # providers:
  #   pi: 1

# Optional continuation for provider quota-window exhaustion. Off by default.
workflows:
  autoResumeOnQuotaReset: false
  # quotaFallbackDelayMs: 3600000
  quotaMaxAttempts: 1
  quotaDeadlineMs: 86400000

# Model router — optional. Writing this block opts in; see "Model router" below.
# modelRouter:
#   tiers: [medium]   # authored tiers the router may lower
#   mode: shadow      # off | shadow (record only) | apply

# Model tiers — optional cross-provider presets used by bundled workflows,
# custom workflows, direct chat (`chatTier`, default `large`), and title
# generation (`small`).
tiers:
  large: { provider: claude, model: opus }
  medium: { provider: codex, model: gpt-5.6-terra, effort: high }
  small: { provider: pi, model: minimax-m3 }

# Tier the chat agent runs on: small, medium or large. Default: large.
# chatTier: medium

# Model aliases — optional custom refs for project workflows.
aliases:
  '@reasoning': { provider: claude, model: opus, effort: max }

```

The `tiers:` block above is no longer hand-edit-only -- you can also set the `small`/`medium`/`large` presets from the console **AI Settings** -> **Model Tiers** panel, or from the CLI with [`archon ai tier set`](/reference/cli/#ai). Connecting your own provider API key or subscription is covered in [Per-user credentials and AI Settings](/getting-started/ai-assistants/#per-user-credentials-and-ai-settings).

`chatTier` picks the tier the chat agent's own turns run on, on every chat surface (Web UI, Telegram, Slack, Discord, forge comments). It changes chat only: workflow nodes keep the tiers they name, and conversation titles stay on `small`. It is read from `~/.archon/config.yaml` only -- a repository config cannot set it -- and a value other than `small`, `medium` or `large` stops the config from loading. A user's own default chat model ([`archon ai default <provider> <model> --scope user`](/reference/cli/#ai)) still wins for that user; a per-user default applies to the identity that set it, so one set from the CLI or the Web UI does not reach that person's Telegram or Slack turns. When `chatTier` is set, `assistants.<provider>.model` no longer stands in for an unconfigured tier in chat.

These files are persistent layers. For one invocation, use repeatable [`workflow run --model <name>=<spec>`](/reference/cli/#workflow-run-name-message), [`workflow run --config <path>`](/reference/cli/#per-run-config-files), or the run API's inline `config`, `tiers`, and `aliases` fields. Each run layer is sparse and sits above user, repository, global, and built-in values without editing a persistent config file.

### How `assistants:` is validated

Every `assistants.<provider>` block is checked by that provider when the config loads, in both `~/.archon/config.yaml` and a repository `.archon/config.yaml`. A misspelled key, an unsupported value, or a wrong type stops the load with a message naming the file, the provider, the key, and the accepted values. A `--config` run layer is checked by the same provider parser, with one difference: settings that apply to the whole process, such as `assistants.pi.env` and `assistants.pi.maxConcurrent`, are accepted in a config file and refused in a run layer. Values the provider would have quietly discarded used to reach a run and be reported as the setting the node ran at:

```
Invalid assistants config in '/Users/you/.archon/config.yaml':
  'assistants.claude.settingSources.0': expected 'project' or 'user'.
```

`archon doctor` reports the same failure as the **Config files** check. To repair `~/.archon/config.yaml` through Archon, change the invalid value from the console settings; any other settings, `archon ai tier set`, or `archon ai alias set` change is refused until that value is fixed, because Archon validates the whole file before writing it. An `assistants:` entry for a provider this install has not registered is ignored, as before — there is no provider to validate it.

## Provider concurrency caps

`concurrency.providers.<provider-id>: N` limits how many attempts against that provider run at once across every Archon process sharing this database: server, CLI, detached runs, chat, and title generation. There are no default caps. A provider without an entry is unlimited, so many runs across Claude, Codex, and Pi keep running in parallel. Set a cap only when the provider cannot take more, such as a local model on one GPU or an account with a hard concurrency limit.

- **Attempts, not runs.** One attempt holds one slot from the moment the provider starts until its stream has closed. Retry backoff between attempts, including the internal retries of Claude, Codex, and OpenCode, holds no slot. A rate limit is retried with backoff as before; it never lowers the cap.
- **Waiting.** An attempt that finds the cap full waits and checks again about once a second. Cancelling the run stops the wait without starting the attempt. Until queue visibility lands, a waiting node looks idle, and a wait longer than the node's `idle_timeout` ends the node like any other idle node.
- **Changes apply immediately.** The cap is re-read on every admission check, including by attempts already waiting. Lowering it blocks new attempts until enough running ones finish; running attempts are never cancelled.
- **Strict.** A key that is not a registered provider ID, a value that is not a positive integer, or a config file that cannot be parsed refuses every provider attempt with an error naming the problem, instead of silently running uncapped.
- **Process loss.** A slot belongs to the process that took it. When that process dies, the next admission on the same host releases the slot. A holder from another host is never released by time or guesswork: list it with `archon ai capacity` and, once you have verified that process is gone, release it with `archon ai capacity release <attempt-id>`. Hosts that share one PostgreSQL database need distinct hostnames. A recreated Docker container gets a new hostname unless the compose service sets `hostname:`, so holders left by the old container need an explicit release.

## Run-scoped configuration

Keep a reusable file such as `config.minimax.yaml` in a repository and select it only for runs that need it:

```yaml
assistant: pi
tiers:
  large: { provider: pi, model: minimax/MiniMax-M3 }
workflows:
  quotaMaxAttempts: 3
env:
  BENCH_MODE: "1"
```

```bash
archon workflow run x \
  --config ./config.minimax.yaml \
  --model large=openai/gpt-5.6
```

The file changes only the keys it contains. The explicit model flag is the final layer, so the command above replaces the file's `large` binding and keeps the file or lower-layer `small`, `medium`, aliases, assistant defaults, and other settings.

Run config accepts settings whose consumers still execute after the run is dispatched: `assistant` or `defaultAssistant`, `assistants`, `tiers`, `aliases`, `workflows`, `docs.path`, and `env`. It fails before source capture, isolation, or execution when a key cannot truthfully apply at that point:

- `commands` and `defaults` already affected workflow and command discovery.
- `worktree` and `container` already affected isolation.
- `botName`, `chatTier`, `streaming`, `paths`, and `concurrency` are process-scoped or have no per-run consumer.
- `recommendedWorkflows` is listing-only.
- `modelRouter` is an operator opt-in in the install or repo config, and one run cannot opt itself in.
- `assistants.pi.env` and `assistants.pi.maxConcurrent` mutate process-lifetime Pi state rather than one request.

Unknown keys, unregistered providers, invalid effort values, and alias names without `@` also fail instead of being ignored. CLI accepts a local path; the HTTP run API accepts inline validated content and never a caller-selected server path.

Fresh runs seal the normalized layer before recording it. Run metadata exposes its source label and configured key paths, not plaintext `env` or provider-default values. A continuation restores that sealed layer without rereading the original file, and child workflows inherit it. Detached CLI launches also transfer the already-validated sealed layer to the child instead of rereading the caller's file. This is why `--config` cannot be supplied with `--resume`.

## Repository Configuration

Create `.archon/config.yaml` in any repository for project-specific settings:

```yaml
# AI assistant for this project (used as default provider for workflows)
assistant: claude

# Assistant defaults (override global)
assistants:
  claude:
    model: sonnet
    settingSources:  # Override global settingSources for this repo
      - project
  codex:
    model: gpt-5.6-terra
    webSearchMode: live

# Commands configuration
commands:
  folder: .archon/commands
  autoLoad: true

# Worktree settings
worktree:
  baseBranch: main  # Optional: auto-detected from git when not set
  copyFiles:  # Optional: Gitignored files/dirs to copy into new worktrees.
              # Nothing is copied unless you list it here.
    - .env
    - .vscode               # Copy entire directory
    - plans/                # Local plans not committed to the team repo
  initSubmodules: true  # Optional: default true — auto-detects .gitmodules and runs
                        # `git submodule update --init --recursive`. Set false to opt out.
  path: .worktrees      # Optional: co-locate worktrees with the repo at
                        # <repoRoot>/.worktrees/<branch> instead of under
                        # ~/.archon/workspaces/<owner>/<repo>/worktrees/.
                        # Must be relative; no absolute, no `..` segments.
  remote: origin        # Optional: git remote name for fetch/push. Auto-detected
                        # when omitted (origin if it exists, sole remote otherwise).

# Documentation directory
docs:
  path: docs  # Optional: default is docs/

# Defaults configuration
defaults:
  loadDefaultCommands: true   # Load app's bundled default commands at runtime
  loadDefaultWorkflows: true  # Load app's bundled default workflows at runtime

# Recommended workflows for this project (declared order = pin order in the UI)
# recommendedWorkflows:
#   - archon-fix-github-issue
#   - archon-idea-to-pr
#   - archon-plan

# Per-project environment variables for workflow execution (Claude SDK only)
# Injected into the Claude subprocess env. For secrets, open Environment variables
# from the project row in the console project rail.
# env:
#   MY_API_KEY: value
#   CUSTOM_ENDPOINT: https://...

# Model tiers and aliases override global entries with the same name (repo > global).
# tiers:
#   small: { provider: codex, model: gpt-5.6-luna }
# aliases:
#   '@fast': { provider: claude, model: haiku }

```

Only `claude` and `codex` ship built-in tier defaults (claude: `haiku`/`sonnet`/`opus`;
codex: the current small/medium/large models) and work without a `tiers:` block, at the
provider's default reasoning effort. Every other provider must configure each tier it
uses — with `archon ai tier set`, the console AI Settings -> Model Tiers panel, or the
`tiers:` block — or resolving `small`, `medium`, or `large` fails with a configuration
error that names those surfaces.

### Claude settingSources

Controls which sources the Claude Agent SDK discovers during sessions — `CLAUDE.md`, skills, commands, agents, and hooks. In workflow nodes, discovery does not activate ambient skills: the node's `skills:` list remains the exact active set, and omission/`[]` selects none.

A declared skill that is installed on disk must live under a source that remains
enabled — `settingSources: ['project']` cannot select a user-global skill, for
instance — and Archon rejects that mismatch before provider spend. Names that are
absent from disk entirely, such as Claude's built-in skills and plugin-qualified
`plugin:skill` entries, are left to the SDK to resolve.

Unrecognized entries are dropped rather than ignored: `settingSources: ['projct']`
resolves to no sources and logs `claude.setting_sources_invalid_entries`. A typo
therefore narrows and reports itself, instead of falling back to the permissive
`['project', 'user']` default.

| Value | Description |
|-------|-------------|
| `project` | Load project-level `<cwd>/.claude/` (CLAUDE.md, skills, commands, agents) |
| `user` | Load user-level `~/.claude/` (CLAUDE.md, skills, commands, agents) |

**Default**: `['project', 'user']` — both project-level and user-level sources are loaded.

To restrict a project to project-level resources only (e.g. CI, shared environments, or when `~/.claude/` contains personal commands you don't want surfacing in workflows):

```yaml
assistants:
  claude:
    settingSources:
      - project
```

Set in `~/.archon/config.yaml` (global) or `.archon/config.yaml` (repo-specific).

### Worktree file copying (`worktree.copyFiles`)

`git worktree add` only copies **tracked** files into a new worktree. Anything gitignored — secrets, local planning docs, agent reports, IDE settings, data fixtures — is absent by default. Archon's `worktree.copyFiles` closes that gap: after the worktree is created, each listed path is copied from the canonical repo into the worktree via raw filesystem copy (not git), so gitignored content comes along for the ride.

**Why this matters for agent runs.** A run does its work inside the worktree, so anything the agent needs at runtime has to be there. `.env` is the common case: without it an agent cannot start the project's server, run an integration test, or reproduce a bug that reads local credentials — and nothing errors, it simply finds no configuration. If you want agents to verify their own work by running the thing they changed, list `.env` here.

Copy the **real** gitignored file, never a tracked template. Listing `.env.example` is wrong twice over: the worktree already has it, because it is tracked; and materialising it as `.env` produces placeholder credentials, so a server starts misconfigured instead of failing loudly.

`worktree.copyFiles` is read from the repo's own `.archon/config.yaml`. It is not a global setting — placing it in `~/.archon/config.yaml` parses without error and has no effect.

**Nothing is copied unless you list it.** Archon used to copy `.archon/` into every worktree automatically, because that was the only way a workflow's own commands and scripts could be found from inside the worktree it was running against. Runs now carry their own source (see below), so the implicit copy is gone.

If you relied on it — most often for a gitignored `.archon/config.yaml` holding local settings — add it explicitly:

```yaml
worktree:
  copyFiles:
    - .archon
```

You do **not** need this for workflows, commands, or scripts. Those are captured by the run itself, including uncommitted ones.

**Workflow source no longer travels through the worktree.** When a run starts, Archon freezes the workflow's own `.archon/workflows`, `.archon/commands`, and `.archon/scripts` — plus your home-scoped `~/.archon/` source, so a statically included global workflow is frozen too — into that run's artifacts directory, and resolves them from there for the run's whole life. Three consequences:

- The worktree stays clean. Authoring files never appear in its `git status`, and repo validators no longer see packages that came from somewhere else.
- Editing or deleting the authoring checkout mid-run does not change a run already in flight. A resumed run executes the source it started with; the next fresh run picks up your edits.
- Uncommitted workflows work against any target, with no commit, push, or merge — see `--workflow-source` in the [CLI reference](/reference/cli/).

**Common entries:**

```yaml
worktree:
  copyFiles:
    - .env                  # local secrets
    - .vscode/              # editor settings
    - .claude/              # per-repo Claude Code config (agents, skills, hooks)
    - plans/                # working docs that aren't committed
    - reports/              # agent-generated markdown reports
    - data/fixtures/        # local-only test data
```

**Semantics:**

- Each entry is a path (file or directory) relative to the repo root — source and destination are always identical. No rename syntax.
- Missing files are silently skipped (`ENOENT` at debug level), so you can list "optional" entries without bookkeeping.
- Directories are copied recursively.
- Per-entry failures are isolated — one bad entry won't abort the rest. Non-ENOENT failures (permissions, disk full) are surfaced as warnings on the environment.
- Path-traversal attempts (entries resolving outside the repo root, or absolute paths on a different drive) are rejected — the entry is logged and skipped.

**Interaction with `worktree.path`:** The copy step runs identically (and is still a no-op with no `copyFiles`) whether worktrees live under `~/.archon/workspaces/<owner>/<repo>/worktrees/` (default) or inside the repo at `<repoRoot>/<worktree.path>/` (repo-local). Both layouts get the same gitignored-file treatment.

**Defaults behavior:** The app's bundled default commands and workflows are loaded at runtime and merged with repo-specific ones. Repo commands/workflows override app defaults by name. Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` to disable runtime loading.

**Submodule behavior:** When a repo contains `.gitmodules`, submodules are initialized in new worktrees by default (git's `worktree add` does not do this). The check is a cheap filesystem probe — repos without submodules pay zero cost. Submodule init failure throws a classified error (credentials, network, timeout) rather than silently producing a worktree with empty submodule directories, and the worktree whose setup did not finish is removed so a retry starts from a fresh checkout instead of adopting it. If that removal cannot finish, the error names the leftover path, and later runs refuse to adopt it until you delete it. Set `worktree.initSubmodules: false` to opt out.

**Remote behavior:** By default, all git operations (fetch, push, branch tracking) use the `origin` remote. If your repo uses a different remote name, configure `worktree.remote`. Resolution order:
1. If `worktree.remote` is set: Uses the configured remote name for all operations.
2. If omitted: Auto-detects — `origin` if it exists, otherwise the sole remote if only one is configured.
3. If multiple remotes exist and none is named `origin`: Worktree creation **fails with an actionable error** listing the available remotes and suggesting the config fix.

**Base branch behavior:** Before creating a worktree, the canonical workspace is synced to the latest code. Resolution order:
1. If `worktree.baseBranch` is set: Uses the configured branch. **Fails with an error** if the branch doesn't exist on the resolved remote (no silent fallback).
2. If omitted: Auto-detects the default branch via `git symbolic-ref` on the resolved remote. Works without any config for standard repos.
3. If auto-detection fails and a workflow references `$BASE_BRANCH`: Fails with an error explaining the resolution chain.

**Docs path behavior:** The `docs.path` setting controls where the `$DOCS_DIR` variable points. When not configured, `$DOCS_DIR` defaults to `docs/`. Unlike `$BASE_BRANCH`, this variable always has a safe default and never throws an error. Configure it when your documentation lives outside the standard `docs/` directory (e.g., `packages/docs-web/src/content/docs`).

### Recommended workflows (`recommendedWorkflows`)

Repo owners curate an **ordered list of recommended workflows** in the project's
`.archon/config.yaml`. The console's new-run picker shows that ordered list under
**Recommended for this project** and the remaining choices under **Other workflows**.

```yaml
recommendedWorkflows:
  - archon-fix-github-issue
  - archon-idea-to-pr
  - archon-plan
```

**Semantics:**

- **List order = pin order.** First entry appears first in both UIs.
- Each entry is a **workflow name** matched against the discovered set (bundled + global + project).
- A name that matches **no** discovered workflow is **silently ignored** (debug log). The list is advisory — a stale entry never breaks discovery.
- Search and category filters apply to **both** partitions. If filtering hides all recommended cards, the header is not rendered.
- Key **absent or empty** → flat list, no header, no divider. Zero-config safe.
- The list lives **per-project only** — it is not part of global config (`~/.archon/config.yaml`) and is not per-user.

**Worktree path behavior:** By default, every repo's worktrees live under `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>` — outside the repo, invisible to the IDE. Set `worktree.path` to opt in to a **repo-local** layout instead: worktrees are created at `<repoRoot>/<worktree.path>/<branch>` so they show up in the file tree and editor workspace. A common choice is `.worktrees`. Because worktrees now live inside the repository tree, you should add the directory to your `.gitignore` (Archon does not modify user-owned files). The configured path must be relative to the repo root; absolute paths and paths containing `..` segments fail loudly at worktree creation rather than silently falling back.

### Container isolation (folder projects)

**Folder projects** run in place by default. Opt into overlay-isolated Docker execution — writes land in an overlay upper layer, not the live root — with the `--container` CLI flag, the `container.enabled` config key, or a workflow's `container.enabled` policy. Valid on both global and repo `.archon/config.yaml` (repo overrides global per-field):

```yaml
container:
  image: archon-runner:latest # runner image tag (default: archon-runner:latest)
  network: bridge # 'bridge' (default) or 'none' (no egress)
  memoryMb: 4096 # hard memory cap in MiB (positive integer)
  pidsLimit: 512 # process cap / fork-bomb guard (positive integer)
  enabled: false # run folder projects in a container without --container (default false)
```

**Selection precedence:** `--container` flag > workflow `container.enabled` > config `container.enabled` > `false`. (A workflow `enabled: false` hard-disables relative to config, but the flag still wins.)

**Write-back mode** is a per-workflow policy (not a config key). After a container run finishes, its overlay diff is reviewed before touching the live root:

```yaml
# In a workflow YAML (.archon/workflows/*.yaml):
container:
  write_back: approve # 'approve' (default) pauses at a write-back gate; 'auto' applies without pausing
```

**Prerequisites:** Docker, and the runner image built once with `bun run build:runner-image` (tags `archon-runner:<version>` + `:latest`). Container mode is **folder-project-only** (a repo project errors). Pausing workflows (approval/interactive gates) **are** supported — a pause `docker stop`s the container (near-zero resources while awaiting a decision) and resume rediscovers and restarts it. Neither `$ARTIFACTS_DIR` nor `$STATE_DIR` is mounted into the container — see [Container runs and run output](#container-runs-and-run-output) below. For the full flow, pause economics, and security posture, see the [Container isolation guide](/guides/container-isolation/) and `packages/isolation/docker/SECURITY.md`.

### Container runs and run output

Container runs are the one place where a run's output is **not** addressable from the host
filesystem by run id. This is a documented limitation, not an oversight — the accurate
picture:

- A container run has exactly two mounts: the project root at `/mnt/lower` (read-only) and
  the per-run overlay volume at `/mnt/upper`. `ARCHON_HOME` is never mounted.
- `ARTIFACTS_DIR` and `STATE_DIR` reach the container only as environment variables, so a
  node that writes to either from *inside* the container writes into the container's own
  ephemeral layer, not to the host.
- The container is **not** destroyed when the run completes. It is removed by the cleanup
  service (7-day stale window by default) or by an explicit teardown, and `destroy()`
  removes the container *and* its volume. Until then those files remain readable with
  `docker exec`.

Net effect: container-run output is a roughly 7-day TTL on an ephemeral container layer,
reachable by `docker exec`, and **not** addressable by run id from the host. Retrieval is
therefore non-uniform — "point an agent at run X's artifacts" is a filesystem path for
every other run, and a `docker exec` into a specific container within the cleanup window
for a container run. The blast radius is bounded: container mode is folder-projects-only
and works only with `containerExec`-capable providers.

**Workaround.** A node whose output must reach the host should write into the **project
root** — the node's working directory inside the container, which is the overlay mount —
rather than into `$ARTIFACTS_DIR` / `$STATE_DIR`. A plain relative path does this. Writes
there ride the existing overlay diff plus the approval-gated write-back, so they do land on
the host.

## Environment Variables

Environment variables override all other configuration. They are organized by category below.

### Core

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_HOME` | Base directory for all Archon-managed files. **Ignored in Docker** — the container always uses `/.archon`. | `~/.archon` |
| `PORT` | HTTP server listen port | `3090` (auto-allocated in worktrees) |
| `LOG_LEVEL` | Logging verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). CLI commands other than `archon serve` log at `warn` unless `--verbose` or `LOG_LEVEL=debug`/`trace` is set (a quieter `LOG_LEVEL` such as `error` is kept); see [CLI logs](/reference/cli/#logs). | `info` |
| `BOT_DISPLAY_NAME` | Bot name shown in batch-mode "starting" messages | `Archon` |
| `DEFAULT_AI_ASSISTANT` | Fallback AI assistant when no config file sets the assistant. Overridden by `defaultAssistant` in global config or `assistant` in repo config. Must match a registered provider id — currently `claude`, `codex`, `pi`, or `copilot`. | `claude` |
| `MAX_CONCURRENT_CONVERSATIONS` | Maximum concurrent AI conversations | `10` |
| `SESSION_RETENTION_DAYS` | Delete inactive sessions older than N days | `30` |
| `ARCHON_VERBOSE_BOOT` | When set to `1`, prints `[archon] loaded N keys from …` lines to stderr at boot. Also enabled by `LOG_LEVEL=debug` or `LOG_LEVEL=trace`. Silent by default to avoid interleaving with interactive command output. | -- |
| `ARCHON_BASH_PATH` | Override the bash executable path used by `bash` nodes and loop `until_bash`. Eagerly validated at resolution time — typos surface immediately instead of as opaque ENOENTs inside the first bash-node fire. | `bash` on Linux/macOS; on Windows, the first existing of the common Git-Bash locations: `%ProgramFiles%\Git\bin\bash.exe`, `%ProgramFiles%\Git\usr\bin\bash.exe`, `%ProgramFiles(x86)%\Git\bin\bash.exe`, `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`, `%USERPROFILE%\scoop\apps\git\current\bin\bash.exe` |
| `WSL_DISTRO_NAME` | Set automatically by WSL in every distro shell. Archon reads it (via `/api/health`) to emit Windows-host-friendly `vscode://vscode-remote/wsl+<distro>/...` "Open in IDE" URIs. You do not normally set this yourself; override it only to force a specific distro name into the URI. | -- (unset outside WSL) |

### AI Providers -- Claude

| Variable | Description | Default |
| --- | --- | --- |
| `CLAUDE_USE_GLOBAL_AUTH` | Use global auth from `claude /login` (`true`/`false`) | Auto-detect |
| `CLAUDE_CODE_OAUTH_TOKEN` | Explicit OAuth token (alternative to global auth) | -- |
| `CLAUDE_API_KEY` | Explicit API key (alternative to global auth) | -- |
| `TITLE_GENERATION_MODEL` | Lightweight model for generating conversation titles | SDK default |
| `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS` | Timeout (ms) before Claude subprocess is considered hung (throws with diagnostic log) | `60000` |

When `CLAUDE_USE_GLOBAL_AUTH` is unset, Archon auto-detects: it uses explicit tokens if present, otherwise falls back to global auth.

### AI Providers -- Codex

| Variable | Description | Default |
| --- | --- | --- |
| `CODEX_ID_TOKEN` | Codex ID token (from `~/.codex/auth.json`) | -- |
| `CODEX_ACCESS_TOKEN` | Codex access token | -- |
| `CODEX_REFRESH_TOKEN` | Codex refresh token | -- |
| `CODEX_ACCOUNT_ID` | Codex account ID | -- |

### AI Providers -- Copilot (community)

| Variable | Description | Default |
| --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` | Explicit GitHub PAT for the Copilot provider. Always wins over `useLoggedInUser` when set. | -- |
| `COPILOT_BIN_PATH` | Absolute path to the Copilot CLI binary. Required in compiled Archon binaries when `assistants.copilot.copilotCliPath` is not set; auto-detected in dev mode. | -- |

The Copilot provider also reads `assistants.copilot.{model, modelReasoningEffort, copilotCliPath, configDir, enableConfigDiscovery, useLoggedInUser, logLevel}` from `~/.archon/config.yaml` or `.archon/config.yaml`. See the [AI Assistants guide](/getting-started/ai-assistants/) for the full setup.

### Platform Adapters -- Slack

| Variable | Description | Default |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) | -- |
| `SLACK_APP_TOKEN` | Slack app-level token for Socket Mode (`xapp-...`) | -- |
| `SLACK_ALLOWED_USER_IDS` | Comma-separated Slack user IDs for whitelist | Open access |
| `SLACK_STREAMING_MODE` | Streaming mode (`stream` or `batch`) | `batch` |

### Platform Adapters -- Telegram

| Variable | Description | Default |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | -- |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs for whitelist | Open access |
| `TELEGRAM_STREAMING_MODE` | Streaming mode (`stream` or `batch`) | `stream` |
| `TELEGRAM_RUN_FOLLOW_UP` | Set to `false` to stop telling a chat about workflow runs its AI started (see [Telegram](/adapters/telegram/#run-follow-ups)) | On |

### Platform Adapters -- Discord

| Variable | Description | Default |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Discord bot token from Developer Portal | -- |
| `DISCORD_ALLOWED_USER_IDS` | Comma-separated Discord user IDs for whitelist | Open access |
| `DISCORD_STREAMING_MODE` | Streaming mode (`stream` or `batch`) | `batch` |
| `DISCORD_REQUIRE_MENTION` | Require @mention to activate in servers (`true` or `false`); DMs never require a mention | `true` |

### Platform Adapters -- GitHub

| Variable | Description | Default |
| --- | --- | --- |
| `GITHUB_TOKEN` | GitHub personal access token (also used by `gh` CLI) | -- |
| `GH_TOKEN` | Alias for `GITHUB_TOKEN` (used by GitHub CLI) | -- |
| `WEBHOOK_SECRET` | HMAC SHA-256 secret for GitHub webhook signature verification | -- |
| `GITHUB_ALLOWED_USERS` | Comma-separated GitHub usernames for whitelist (case-insensitive) | Open access |
| `GITHUB_BOT_MENTION` | @mention name the bot responds to in issues/PRs | Falls back to `BOT_DISPLAY_NAME` |

### Per-user GitHub identity (App mode, optional)

An opt-in layer on top of [GitHub App mode](/adapters/github-app-setup/) that lets each teammate connect their own GitHub identity so commits, PR comments, and pushes attribute to the human rather than the bot. The feature gate turns on when `GITHUB_APP_ID` **and** `TOKEN_ENCRYPTION_KEY` are both set; `GITHUB_APP_CLIENT_ID` is additionally required for the connect (device) flow — set all three. Solo `GITHUB_TOKEN` installs and App-for-bot-only installs are unaffected.

| Variable | Description | Default |
| --- | --- | --- |
| `GITHUB_APP_CLIENT_ID` | The App's **Client ID** (starts with `Iv1.`/`Iv23…`, distinct from the numeric `GITHUB_APP_ID`). Required for the device flow that connects per-user identities. | -- |
| `TOKEN_ENCRYPTION_KEY` | 64-char hex (32 bytes; `openssl rand -hex 32`) used to encrypt stored per-user tokens at rest (AES-256-GCM). **Per-user GitHub identity** requires this + `GITHUB_APP_ID`. **AI credential vault** auto-provisions its own key at `~/.archon/credential-key` — this env var overrides that file on managed/multi-user deploys. **Rotating it invalidates all stored user credentials** — everyone must reconnect. | -- |
| `ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK` | When `false` (default), a workflow run by an **unconnected** user has `GH_TOKEN`/`GITHUB_TOKEN` scrubbed (so `gh`/`git` fail) rather than silently using the shared org/bot token. Set `true` to opt back into the shared token. | `false` |
| `ARCHON_WEB_AUTH_HEADER` | Name of the reverse-proxy-set header Archon trusts to identify the web user (reverse-proxy fallback; still honored alongside Better Auth web login below). Only safe when Archon is reachable **solely** through the proxy on a loopback bind — on a public bind the header is forgeable. Absent header → unattributed (never elevated). | `X-Archon-User` |

To connect once the vars are set: `archon auth github` (CLI), `/archon connect github` (Slack), or the Web UI **Settings → Connect GitHub** card.

### Web UI login (Better Auth, optional)

Real per-user email/password login for the Web UI, mounted at `/api/auth/*` by [Better Auth](https://better-auth.com). **Opt-in and Postgres-only**: enabled only when **both** `DATABASE_URL` (Postgres) and `BETTER_AUTH_SECRET` are set. SQLite/solo installs can never enable it and behave exactly as before (no login UI). It supersedes the single-user `auth-service` sidecar; the `ARCHON_WEB_AUTH_HEADER` trust above remains a fallback for reverse-proxy deploys.

A Better Auth session resolves to the **canonical** `remote_agent_users` row via the `web` platform identity, so chat/CLI/forge identities and the `role` column live on the one Archon user — Better Auth is only the login mechanism. Better Auth owns four tables prefixed `remote_agent_auth_*` (`user`/`session`/`account`/`verification`), applied automatically on startup. Every web request resolves a `{ userId, role }` auth context (session first, then the trusted header); `role` defaults to `admin` and visibility stays open. `GET /api/workflows/runs?mine=true` and `GET /api/conversations?mine=true` are non-enforcing "my" filters that prove the scoping seam — they are not a security boundary.

| Variable | Description | Default |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Session signing secret, **≥32 chars** (`openssl rand -base64 32`). Its presence (with `DATABASE_URL`) is what enables web login. Boot fails fast if set but too short. | -- |
| `BETTER_AUTH_URL` | Public base URL. Omit for same-origin deploys (inferred from the request); set only behind a fixed-origin reverse proxy. | inferred |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated extra origins allowed for CSRF/cross-origin (beyond same-origin). | -- |
| `ARCHON_AUTH_ALLOWED_EMAILS` | Comma-separated invite allowlist for signup (case-insensitive). Set this to invite teammates. | -- |
| `ARCHON_AUTH_OPEN_SIGNUP` | `true` allows open public signup when no allowlist is set. Default (unset) + no allowlist = signup **disabled** (login only). | `false` |
| `ARCHON_WEB_AUTH_REQUIRED` | When web auth is enabled, gate every `/api/*` request server-side (401 without a session/identity), except `/api/auth/*` and `/api/health*`. `false` keeps login-UI-only. | on (when enabled) |

Signup uses email + password (no email verification by default). **Signup posture:** allowlist set → invite-gated (403 for non-listed emails); no allowlist + `ARCHON_AUTH_OPEN_SIGNUP=true` → open; otherwise **disabled** (login only, with a boot WARN) so enabling auth never silently opens public registration. Existing sessions remain valid until expiry even if an email is later removed from the allowlist. When `ARCHON_WEB_AUTH_REQUIRED` is on (default), Better Auth is the real access gate, so the Caddy `forward_auth` sidecar can be retired.

### Platform Adapters -- Gitea

| Variable | Description | Default |
| --- | --- | --- |
| `GITEA_URL` | Self-hosted Gitea instance URL (e.g. `https://gitea.example.com`) | -- |
| `GITEA_TOKEN` | Gitea personal access token or bot account token | -- |
| `GITEA_WEBHOOK_SECRET` | HMAC SHA-256 secret for Gitea webhook signature verification | -- |
| `GITEA_ALLOWED_USERS` | Comma-separated Gitea usernames for whitelist (case-insensitive) | Open access |
| `GITEA_BOT_MENTION` | @mention name the bot responds to in issues/PRs | Falls back to `BOT_DISPLAY_NAME` |

### Database

| Variable | Description | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (omit to use SQLite) | SQLite at `~/.archon/archon.db` |

### Web UI

| Variable | Description | Default |
| --- | --- | --- |
| `WEB_UI_ORIGIN` | CORS origin for API routes (restrict when exposing publicly) | `*` (allow all) |
| `WEB_UI_DEV` | When set, skip serving static frontend (Vite dev server used instead) | -- |

### Worktree Management

| Variable | Description | Default |
| --- | --- | --- |
| `STALE_THRESHOLD_DAYS` | Days before an inactive worktree is considered stale | `14` |
| `MAX_WORKTREES_PER_CODEBASE` | Max worktrees per codebase before auto-cleanup | `25` |
| `CLEANUP_INTERVAL_HOURS` | How often the background cleanup service runs | `6` |

### Docker / Deployment

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_DATA` | Host path for Archon data (workspaces, worktrees, artifacts). Compose-only — read by `docker-compose.yml` to choose the bind-mount source for `/.archon`; not read by Archon source code. | Docker-managed volume |
| `ARCHON_USER_HOME` | Host path for `/home/appuser` (Claude/Codex/Pi config, `~/.gitconfig`, shell history). Compose-only — read by `docker-compose.yml` to choose the bind-mount source for `/home/appuser`; not read by Archon source code. Persisted by default to a Docker-managed volume so user state survives rebuilds. | Docker-managed volume |
| `DOMAIN` | Public domain for Caddy reverse proxy (TLS auto-provisioned) | -- |
| `CADDY_BASIC_AUTH` | Caddy basicauth directive to protect Web UI and API | Disabled |
| `AUTH_USERNAME` | Username for form-based auth (Caddy forward_auth) | -- |
| `AUTH_PASSWORD_HASH` | Bcrypt hash for form-based auth password (escape `$` as `$$` in Compose) | -- |
| `COOKIE_SECRET` | 64-hex-char secret for auth session cookies | -- |
| `AUTH_SERVICE_PORT` | Port for the auth service container | `9000` |
| `COOKIE_MAX_AGE` | Auth cookie lifetime in seconds | `86400` |

### Context scout -- Jev (optional)

Before the `archon-investigate` and `archon-plan` agents read a checkout, a classifier can pre-read it for them. One small-tier agent turn turns the request into a yes/no question and the paths worth checking; [Jev](https://docs.typesafe.ai/) then answers that question about every candidate file, in line windows. The agent that follows starts from the files the classifier selected and still verifies them itself. The scout is the `archon-scout` workflow in the SDLC pack, and any workflow can `include:` it.

The scout is on when `JEV_API_KEY` is set. Without a key, or with either switch off, only its gate runs: a shell step that needs nothing installed. No AI turn is spent and the workflows run as they always have. A [container run](#container-runs-and-run-output) does not inherit the host's environment, so there the scout is off unless the project's own environment variables supply the key.

With a key set, the scout adds two steps before the workflow's own agent: the small-tier agent turn that writes the question, and the classification, which needs `bun` on the `PATH`. They start after the code-index step and add their own time: one small-tier turn, then the classification, which stands down after `JEV_SCOUT_DEADLINE_MS`.

- **The workflow's agent runs without a list** when the classifier fails or times out, a setting is unusable, the request has no single question, or the scout's paths select nothing. The classification's node output names the reason.
- **The run fails before the workflow's agent starts** when one of the scout's own steps fails: the question turn still failing after its five retries, or the classification unable to start because `bun` is missing. The engine has no optional step, so this is the same outcome as any other failed step. The run can be resumed, and `JEV_SCOUT_ENABLED=0` turns the scout off without removing the key.

**What leaves the machine.** Line windows of files under the selected paths are sent to `JEV_API_BASE`, with their paths. Only files git tracks and does not ignore are considered. Never sent: env files (`.env*`, `*.env`, `env.production`, and anything under a `.env*` directory); key, certificate and credential files and renamed copies of them (`id_rsa*`, `id_ed25519*`, `*.pem`, `*.key`, `credentials.*`, `secrets.*`, `.npmrc`, `.netrc`, Terraform state and variables, and anything under `.ssh/`, `.aws/`, `.gnupg/`, `.kube/`, `.docker/` or `secrets/`); any file containing a private-key block; symlinks, and files reached through a directory that links out of the checkout; binaries; and files over `JEV_SCOUT_MAX_FILE_BYTES`. A secret written into an ordinary source file is not detected. For a repository where that matters, leave the scout off or point `JEV_API_BASE` at a service you host.

Each run is bounded by a file, a window and a character budget. When a budget is reached the result is marked `truncated` and the files it did not reach are counted, never reported as not relevant. A file with lines too long to fit one request is named in the result's `skipped` list, and a path git rejects is passed over and counted.

| Variable | Description | Default |
| --- | --- | --- |
| `JEV_API_KEY` | API key, sent as a Bearer token. The scout is off without it. | -- |
| `JEV_ENABLED` | Set to `0` or `false` to turn every Jev feature off while keeping the key | on when the key is set |
| `JEV_SCOUT_ENABLED` | Set to `0` or `false` to turn only the scout off | on when the key is set |
| `JEV_API_BASE` | Base URL of the service. Any Jev-compatible endpoint works. | `https://api.typesafe.ai` |
| `JEV_MODEL` | Model id sent with each request | `jev-1.13.0` |
| `JEV_SCOUT_THRESHOLD` | A file is selected when its best window scores at least this (0--1). Low on purpose: a missed file costs more than an extra one. | `0.3` |
| `JEV_SCOUT_WINDOW_LINES` | Lines per window | `120` |
| `JEV_SCOUT_WINDOW_OVERLAP` | Lines each window repeats from the one before; must be smaller than the window | `20` |
| `JEV_SCOUT_PARALLELISM` | Classifier requests in flight at once, at most `16` | `4` |
| `JEV_SCOUT_MAX_FILES` | Most files classified in one run | `60` |
| `JEV_SCOUT_MAX_WINDOWS` | Most windows classified in one run | `240` |
| `JEV_SCOUT_MAX_CHARS` | Most characters of code and question text sent in one run | `600000` |
| `JEV_SCOUT_MAX_FILE_BYTES` | Files larger than this are never sent | `200000` |
| `JEV_SCOUT_MAX_REQUEST_CHARS` | Most characters in one request | `40000` |
| `JEV_SCOUT_TIMEOUT_MS` | Longest one classifier request may take | `30000` |
| `JEV_SCOUT_DEADLINE_MS` | Longest the whole classification may take before it stands down | `120000` |

An unusable number makes the classification report `unavailable` and name the variable; it never falls back to the default, so a mistyped threshold or budget cannot quietly become another policy.

### Second opinion -- Jev (optional)

When a project gate goes red in `archon-validate`, a classifier can say which kind of failure the record shows before the agent that classifies the red reads it: `code_defect`, `flaky_test`, `dependency_failure` or `environment_failure`. The agent gets that answer as a hypothesis to check first, which is meant to keep a failure the machine or a package caused from being written up as a defect and sent back for a code fix. It uses the same [Jev](https://docs.typesafe.ai/) key, endpoint and model as the context scout.

**It is advisory.** The agent must verify the answer against the log before acting on it, and where the two disagree the log wins and the agent says so in its summary. No class decides the validation verdict: the agent still declares `red_cause` under the same evidence rules, and a failure the classifier calls an environment failure is not thereby one. The validation result carries the class as `advisory_failure_class`, beside `red_cause`, only when a classifier answered. Nothing in the bundled workflows reads that field to decide anything. `confidence` reports how concentrated the classifier's answer was, not the chance that it is right.

The second opinion is on when `JEV_API_KEY` is set. To turn it off and keep the key, set `JEV_OPINION_ENABLED=0`; `JEV_ENABLED=0` turns it off along with every other Jev feature. Without a key, or with either switch off, nothing is sent and validation runs as it always has. It spends no AI turn in either state: the step is a script. A [container run](#container-runs-and-run-output) does not inherit the host's environment, so there it is off unless the project's own environment variables supply the key.

With a key set, a red gate adds one classifier request before the agent starts, bounded by `JEV_OPINION_TIMEOUT_MS`. Every way the classifier cannot answer -- a timeout, an HTTP error, an answer that is not one of the four classes, an unusable setting, a failing check that printed nothing to judge -- gives the agent an `unavailable` result naming the reason, and the agent works without an opinion. The step does not fail the run on those.

**What leaves the machine.** One request to `JEV_API_BASE` per red gate, carrying the question, the four criteria, and the end of `validation.md` from the run's artifacts: the failing check's name, command, exit status and the last lines of its output. At most `JEV_OPINION_MAX_EVIDENCE_CHARS` characters of it are sent, starting on a whole line unless that would drop more than half of them.

Before that cut, recognisable secrets are replaced with `[REDACTED]`:

- the exact value of every secret-named variable in the step's environment, when it is eight characters or longer;
- private keys, including encrypted and PGP ones and a key printed on one line;
- values assigned to secret-named keys (`DB_PASS=...`, `signing_key: ...`, `"client_secret": "..."`, a YAML value on the lines under such a key), taken to the end of the line unless they are quoted or sit in a query string;
- values passed after secret-named flags (`--token ...`), and a MySQL client's `-p...`;
- `Cookie`, `Set-Cookie`, `Authorization` and bearer credentials;
- the password in a URL (`scheme://user:password@host`), and a token in front of a host;
- well-known token formats, among them OpenAI, GitHub, GitLab, Slack, Stripe, Google, SendGrid, Twilio and npm tokens, AWS key ids, and JSON Web Tokens.

A name counts as secret when one of its parts is `PASSWORD`, `SECRET`, `TOKEN`, `CREDENTIAL` or `COOKIE`, when it ends in `AUTH`, `SIGNATURE`, `SIG` or `DSN`, or when a longer name ends in `KEY`, `PASS` or `PWD`. The name of an error class (`TokenExpiredError: ...`) is never one, so the error's message stays. This is a filter over known shapes, not a guarantee: a credential that a failing command printed in some other shape is sent as it is. For a project where that matters, leave the second opinion off or point `JEV_API_BASE` at a service you host. Neither the record nor the key is written to the run's output.

| Variable | Description | Default |
| --- | --- | --- |
| `JEV_OPINION_ENABLED` | Set to `0` or `false` to turn only the second opinion off | on when the key is set |
| `JEV_OPINION_TIMEOUT_MS` | Longest the one classifier request may take. Must be under `120000`, the step's own time limit. | `30000` |
| `JEV_OPINION_MAX_EVIDENCE_CHARS` | Most characters of the failing check's record sent. The end of the record is what is kept. | `16000` |

`JEV_API_KEY`, `JEV_ENABLED`, `JEV_API_BASE` and `JEV_MODEL` are shared with the scout and listed above. An unusable number makes the step report `unavailable` and name the variable; it never falls back to the default.

Whether the classifier names the right class is measured by `bun run second-opinion-eval`, a manual command that needs the key. Whether the opinion reduces unnecessary edits is not measured by it, and has not been measured. No agent that edits code reads the opinion itself. Its effect reaches an edit only through the cause and summary the classifying agent writes: the summary states the class the classifier chose and whether the log bore it out, and `archon-deliver` hands that summary to its CI correction step as context. The SDLC pack's README describes the paired runs that would measure it.

### Model router (optional)

Connection and thresholds for the [model router](#model-router). None of these turn it on: that takes a `modelRouter:` block in the config.

| Variable | Description | Default |
| --- | --- | --- |
| `JEV_API_KEY` | API key for the classifier, sent as a Bearer token. Without it the router classifies nothing and every step runs on its authored tier. | -- |
| `JEV_ENABLED` | Set to `0`, `false`, `off` or `no` to turn the router off along with every other Jev-backed feature | on |
| `JEV_ROUTER_ENABLED` | Set to `0`, `false`, `off` or `no` to turn only the model router off | on |
| `JEV_API_BASE` | Base URL of the classifier. Any Jev-compatible endpoint works. | `https://api.typesafe.ai` |
| `JEV_MODEL` | Model id sent with each request | `jev-1.13.0` |
| `JEV_ROUTER_TIMEOUT_MS` | Longest a step waits for a route before it runs on its authored tier | `3000` |
| `JEV_ROUTER_MIN_PROB` | The chosen tier needs at least this probability (0--1) | `0.75` |
| `JEV_ROUTER_MIN_CONFIDENCE` | The choice needs at least this confidence (0--1) | `0.5` |
| `JEV_ROUTER_RISK_THRESHOLD` | A "high-risk" answer at or above this keeps the authored tier (0--1) | `0.3` |
| `JEV_ROUTER_AMBIGUITY_THRESHOLD` | An "ambiguous or multi-step" answer at or above this keeps the authored tier (0--1) | `0.5` |
| `JEV_ROUTER_MAX_STEP_CHARS` | Most characters of the step's authored text sent per request: its opening, which says what the step is for and what it must get right, not the whole procedure | `3200` |
| `JEV_ROUTER_MAX_TASK_CHARS` | Most characters of the run's task text sent per request | `4000` |

A value that is not a usable number turns the router off rather than falling back to a default, and every route record then says which variable (`invalid_setting:<NAME>`).

### Telemetry

Archon sends a few anonymous events — `archon_started` (once per CLI invocation or server boot), `archon_active` (daily server heartbeat), `chat_turn_handled` (direct chat turn — platform, provider, model, duration, and usage totals, counted as failed when the provider errors mid-turn; never message content), `workflow_invoked` (workflow start or resumed segment), `workflow_completed`/`workflow_failed`/`workflow_cancelled` (sent once when the run's final status is saved), `workflow_approval_resolved` (binary approve/reject), and `codebase_registered` (pure count — no name/path/URL). Categorical only: workflow name (real for bundled workflows, `"custom"` for your own), platform, provider id (model id on `workflow_invoked`), node shape (`nodes_<type>` counts, `graph_depth`, `max_fan_out`, `command_refs`, `prompt_chars_bucket`) and feature flags, `derived_from`/`derived_similarity` naming the bundled workflow a custom one was copied from (never the copy's own name), outcome/duration, aggregate provider-reported usage (gross input, output, optional cache-read/cache-write totals plus a flag when those totals are a floor, cost, and loop iterations), a fixed-enum failure class and exit/cancel reason (never error text), a `run_ref` hash that joins one run's events without sending its id, deployment shape (adapter/db/auth booleans), OS/arch/version, install channel (`binary`/`docker`/`source`) and build commit, a `schema_version`, and a random install UUID stored at `$ARCHON_HOME/telemetry-id`. No code, prompts, paths, IP, geo, or error text. Any one of the variables below disables it. See `archon telemetry status` to inspect the live state.

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_TELEMETRY_DISABLED` | Set to `1` to disable anonymous telemetry | -- |
| `DO_NOT_TRACK` | Set to `1` to disable telemetry (de facto standard honored by Astro, Bun, Prisma, etc.) | -- |
| `CI` | When set to `true` (case-insensitive), telemetry is auto-disabled so fork CI runs don't send events | -- |
| `POSTHOG_API_KEY` | Set to `off` / `0` / `false` / `disabled` / empty to disable; set to a `phc_*` key to use a custom PostHog project | Built-in key |
| `POSTHOG_HOST` | Custom PostHog instance URL (first failure on a custom host logs at `warn`) | `https://us.i.posthog.com` |

### `.env` File Locations

Archon keys env loading on **directory ownership, not filename**. `.archon/` (at `~/` or `<cwd>/`) is archon-owned. Anything else is yours.

| Path | Stripped at boot? | Archon loads? | `archon setup` writes? |
| --- | --- | --- | --- |
| `<cwd>/.env` | **yes** (safety guard) | never | never |
| `<cwd>/.archon/.env` | no | yes (repo scope, overrides user scope) | yes iff `--scope project` |
| `~/.archon/.env` | no | yes (user scope) | yes iff `--scope home` (default) |

**Load order at boot** (every entry point — CLI and server):

1. Strip keys Bun auto-loaded from `<cwd>/.env`, `.env.local`, `.env.development`, `.env.production` (prevents target-repo env from leaking into Archon).
2. Load `~/.archon/.env` with `override: true` (archon config wins over shell-inherited vars).
3. Load `<cwd>/.archon/.env` with `override: true` (repo scope wins over user scope).

A repository's `<cwd>/.archon/.env` cannot set `ARCHON_HOME`, `HOME`, `USERPROFILE`, `ARCHON_DOCKER`, `WORKSPACE_PATH` or `PATH`. If it does, Archon refuses to start and names the file and the key. Those keys decide which Archon home and which executables Archon uses, so a repository could otherwise choose which plugins run. Set them in your shell, your scheduler or `~/.archon/.env` instead.

**Operator log lines** (stderr, emitted only when there is something to report):

```
[archon] stripped 2 keys from /path/to/target-repo (.env, .env.local) to prevent target repo env from leaking into Archon processes
```

The `[archon] loaded N keys from …` lines are suppressed by default (they would otherwise interleave with `archon setup`/`archon doctor` checklist output). To enable them, set `ARCHON_VERBOSE_BOOT=1` or `LOG_LEVEL=debug` before running:

```
[archon] loaded 3 keys from ~/.archon/.env
[archon] loaded 2 keys from /path/to/target-repo/.archon/.env (repo scope, overrides user scope)
```

**Which file should I use?**

- **`~/.archon/.env`** — user-wide defaults (your personal `SLACK_WEBHOOK`, `DATABASE_URL`, etc.). Applies to every project.
- **`<cwd>/.archon/.env`** — per-project overrides. Different webhook per repo, different DB per environment, etc. It cannot set `ARCHON_HOME`, `HOME`, `USERPROFILE`, `ARCHON_DOCKER`, `WORKSPACE_PATH` or `PATH`.
- **`<cwd>/.env`** — **your app's** env file. Archon does not read this file; it strips the keys at boot so they do not leak into Archon's process.

```bash
# User-wide
mkdir -p ~/.archon
cp .env.example ~/.archon/.env

# Per-project override (e.g. a different Slack webhook for this repo)
mkdir -p /path/to/repo/.archon
printf 'SLACK_WEBHOOK=https://hooks.slack.com/...\n' > /path/to/repo/.archon/.env
```

## Docker Configuration

In Docker containers, paths are automatically set:

```
/.archon/
├── workspaces/owner/repo/
│   ├── source/
│   ├── worktrees/
│   ├── artifacts/
│   └── logs/
└── archon.db
```

Environment variables still work and override defaults.

## Command Folder Detection

When cloning or switching repositories, Archon looks for commands in this priority order:

1. `.archon/commands/` - Always searched first
2. Configured folder from `commands.folder` in `.archon/config.yaml` (if specified)

Example `.archon/config.yaml`:
```yaml
commands:
  folder: .claude/commands/archon  # Additional folder to search
  autoLoad: true
```

## Examples

### Minimal Setup (Using Defaults)

No configuration needed. Archon works out of the box with:

- `~/.archon/` for all managed files
- Claude as default AI assistant
- Platform-appropriate streaming modes

### Custom AI Preference

```yaml
# ~/.archon/config.yaml
defaultAssistant: codex
```

### Project-Specific Settings

```yaml
# .archon/config.yaml in your repo
assistant: claude  # Workflows inherit this provider unless they specify their own
commands:
  autoLoad: true
```

### Docker with Custom Volume

```bash
docker run -v /my/data:/.archon ghcr.io/coleam00/archon
```

## Streaming Modes

Each platform adapter supports two streaming modes, configured via environment variable or `~/.archon/config.yaml`.

### Stream Mode

Messages are sent in real-time as the AI generates responses.

```ini
TELEGRAM_STREAMING_MODE=stream
SLACK_STREAMING_MODE=stream
DISCORD_STREAMING_MODE=stream
```

**Pros:**
- Real-time feedback and progress indication
- More interactive and engaging
- See AI reasoning as it works

**Cons:**
- More API calls to platform
- May hit rate limits with very long responses
- Creates many messages/comments

**Best for:** Interactive chat platforms (Telegram)

### Batch Mode

Only the final summary message is sent after AI completes processing.

```ini
TELEGRAM_STREAMING_MODE=batch
SLACK_STREAMING_MODE=batch
DISCORD_STREAMING_MODE=batch
```

**Pros:**
- Single coherent message/comment
- Fewer API calls
- No spam or clutter

**Cons:**
- No progress indication during processing
- Longer wait for first response
- Can't see intermediate steps

**Best for:** Issue trackers and async platforms (GitHub)

### Platform Defaults

| Platform | Default Mode |
|----------|-------------|
| Telegram | `stream` |
| Discord  | `batch` |
| Slack    | `batch` |
| GitHub   | `batch` |
| Web UI   | SSE streaming (always real-time, not configurable) |

---

## Workflow continuation settings

`workflows:` can be set globally or per repository; repo fields override matching global fields.

| Field | Default | Meaning |
| --- | --- | --- |
| `autoResumeOnQuotaReset` | `false` | Schedule a failed workflow for continuation when its node error proves provider quota-window exhaustion |
| `quotaFallbackDelayMs` | unset | Explicit delay to use only when the provider error has no machine-readable reset time, capped at 1000 years. When unset, Archon records that automatic continuation was skipped instead of guessing |
| `quotaMaxAttempts` | `1` | Maximum number of scheduled continuation attempts for one run |
| `quotaDeadlineMs` | `86400000` | Maximum window from the first quota failure in which a continuation may be scheduled, capped at 1000 years |

This policy is separate from per-node `retry:`. Quota exhaustion is terminal for the current attempt because retrying in the same provider window only repeats the failure. When enabled, Archon leaves the run `failed`, records the scheduled time in run metadata, and the server claims and resumes it when due. The claim is durable and bounded, so two server scans cannot launch the same attempt and an early resume failure does not create a rapid retry loop.

Provider errors that include an unambiguous epoch or relative reset duration use it. Errors such as MiniMax plan exhaustion code `2056` often omit a reset time; those resume only when you configure `quotaFallbackDelayMs`. The server must be running at the due time, or it resumes the run on the first later scan.

## Model router

The model router decides, one workflow step at a time, whether the step can run on a cheaper [model tier](#global-configuration) than its author declared. It asks a small classifier (a Jev-compatible service) about the step and the task, and only lowers a step when the answer is confident, low-risk and unambiguous. It is optional and off until you configure it.

```yaml
# ~/.archon/config.yaml
modelRouter:
  tiers: [medium]
  mode: shadow
```

| Field | Default | Meaning |
| --- | --- | --- |
| `tiers` | `[medium]` | The authored tiers the router may lower. A step on any other tier is never routed. |
| `mode` | `shadow` | `off`: nothing is classified or recorded. `shadow`: each route is recorded and the step runs exactly as it would with no router. `apply`: the step runs on the routed tier. |

**The install config decides.** The block in `~/.archon/config.yaml` is the operator's opt-in. A repository's `.archon/config.yaml` may carry a `modelRouter:` block too, but it can only narrow the install's: lower the mode (`apply` to `shadow` or `off`, `shadow` to `off`) and remove tiers. It cannot switch the router on, raise the mode, add a tier, or override an install-level `mode: off`; a repository block with no install opt-in is ignored and logged. The block is not accepted in [run-scoped configuration](#run-scoped-configuration). The classifier connection and thresholds are [environment variables](#model-router-optional).

With no `modelRouter:` block in the install config, with `mode: off`, with no `JEV_API_KEY`, or with a switch off, every step resolves exactly as it does without the router and no route is recorded. `JEV_ENABLED` and `JEV_ROUTER_ENABLED` are off at `0`, `false`, `off` or `no`.

**The authored tier is the ceiling.** The router keeps a step's authored tier or goes below it, never above. A step that names a literal model or an `@alias` is never routed: its author pinned one exact model. There is no workflow field for the router and no `model: auto`.

### Which steps are routed

Only single-shot agent steps (`prompt:` or `command:`) at the top level of a workflow, including steps a workflow brings in through `include:`. These are never routed, and get no route record:

- `loop:` steps, anything inside a `loop_group:`, composed fan-out instances, and the rework prompt of an approval step;
- a step with `context: { resume: ... }`, a step another step resumes from, and a step with `persist_session` (their provider session outlives the attempt);
- a step whose authored tier is not listed in `tiers`.

**A step is lowered only where a bad result would be caught.** Escalation can see one thing: a failed output contract. So a step with no `output_format` is never lowered, on any provider, and the classifier is not asked about it; its route record says `unverifiable`. In the bundled SDLC pack that rules out the six review lenses.

In the bundled SDLC pack, the default `tiers: [medium]` puts these commands on a routable tier wherever a workflow runs them as a top-level step: `discover-checks` and `classify-red` (validate), `pr`, `sync-pr-body`, `triage`, `investigate`, `assess`, and the eight review commands. `plan` (large), `implement` (a loop) and `classify-review-scope` (already small) are not. Of those, the ones that declare an output contract and can therefore be lowered are `discover-checks`, `classify-red`, `pr`, `sync-pr-body`, `triage`, `investigate`, `assess`, `review-scope` and `review-synthesize`. Which of them can move to **another provider** depends on the rules below; `bun run scripts/model-router-eval.ts --lowerable <tier-map>` prints the answer for every step of the pack on a named tier map.

### What is offered

A lower tier is offered only when it has a preset of its own, differs from the authored tier's preset, and names a provider that:

- is registered and usable in this run;
- enforces the step's `output_format` as written: constrained decoding (not best effort), every property listed in `required` where the provider demands that, and no open `additionalProperties` that a strict provider would silently close.

A tier on a **different provider** must also pass all of these:

- the provider can run inside the container when the run uses one;
- the provider honours every field the authored provider honours: `allowed_tools`/`denied_tools`, `hooks`, `mcp`, `skills`, `agents`, `effort`, `maxBudgetUsd`, `fallbackModel`, `sandbox`, `settingSources`, `betas`, injected env, and `webSearchMode`. A routed step never loses a tool restriction, a sandbox or a spend limit;
- the step does not name another `provider:` itself;
- the step does not declare `mutates_checkout: false`. A lower tier that writes to such a checkout fails a run that would have succeeded, and no second attempt can undo the write. Within its own provider such a step may still be lowered;
- no provider session can cross the step. A session only resumes on the provider that created it, so moving a step that inherits a session, or whose session a later step inherits, would silently change what that step knows. The engine reads this off the workflow's plan: a step in a parallel layer never inherits and is never inherited from; a parallel layer clears the thread; a `bash:` or `script:` step between two agent steps does **not** separate them; a `context: fresh` step does not inherit, but because it may be skipped it does not shield the steps after it. Where it cannot be shown that no session crosses a step, the step stays on its provider.

If no lower tier can be offered, the classifier is not called.

### What is sent off the machine

One request per routed step, to `JEV_API_BASE`:

- the run's task input: the message that started the run and its named inputs, up to `JEV_ROUTER_MAX_TASK_CHARS`;
- the opening of the step's **authored** command or prompt text, before any variable or upstream output is substituted into it, up to `JEV_ROUTER_MAX_STEP_CHARS`;
- facts computed in code: whether the step declares tool restrictions, MCP servers or skills, whether the engine enforces that it leaves the checkout unchanged, and the size of the two texts. Nothing sent depends on whether a command runs in its own workflow or composed into another, so the step's id and name are not sent. The authored tier is not sent either: telling the classifier which tier the author picked pulls its answer toward that tier.

Before either text is sent, exact values of credentials Archon injected or holds under secret-named environment variables are removed, and text shaped like a credential is masked: `KEY=value` under a secret-like name, `Authorization` and bearer values, `user:password@` in URLs, PEM blocks, cookies, JSON and CLI-flag secrets, JWTs, webhook URLs and common token prefixes. Masking runs over a bounded window of each text, so its cost does not grow with the size of a task message. Shape masking is defence in depth, not a guarantee: do not put secrets in a task message. Upstream step outputs, node-local `with:` bindings, file contents and the key are never sent, and no log line contains the step text, the task text or the key.

### How a route is decided

The classifier answers three questions in that one request:

1. **Tier.** The smallest tier, among those offered, that can do this step well for this task. It is told to judge the thinking the step needs, not the length of its instructions. Small is collecting, listing, sorting or restating existing facts by fixed instructions; medium is engineering judgement on a clearly stated task within one part of a system; large is hard or consequential reasoning.
2. **High-risk.** Whether the subject of the task is a sensitive area: authentication or authorization, credentials or secrets, database schemas or migrations, deleting data or files, money or billing, or a change made directly to production. A step that only reviews or describes such a change still counts. Pushing a work-in-progress branch or writing a pull-request description does not make an ordinary task sensitive.
3. **Ambiguous or open-ended.** Whether the task leaves open what should be done: under-specified, open to more than one reading, or leaving a design decision across several parts of a system. A step whose fixed instructions list several things to do is not ambiguous for that reason.

Deterministic floors then apply, risk first: either yes/no answer at or above its threshold, or a choice below the probability or confidence minimum, keeps the authored tier. So does a timeout, an HTTP error, an unreadable or out-of-range answer, and a choice that was not offered. Routing never fails or blocks a step: an error anywhere inside it leaves the step on its authored tier. The longest wait it adds is the classifier request, bounded by `JEV_ROUTER_TIMEOUT_MS`, plus a few milliseconds of local work (reading a command file once and redacting two bounded texts).

### Escalation

In `apply` mode, a step that ran on a lower tier and failed runs once more on its authored tier, under its own `retry:` policy. The trigger is the failure kind the engine recorded, not error text: a failed output contract (`output_contract`), or a provider error (`fatal`, `rate_limited`, `transient`, `unknown`, `timeout`). A cancelled step and a configuration fault are not escalated. Usage from both rounds is counted.

The escalation attempt starts from the session the step would have started from without the router: none, or the one it inherits. It is never handed the failed attempt's own new session. On a provider that can fork a session the inherited one is untouched by the failed attempt. A provider that can only resume in place may have appended the failed attempt's turns to the inherited session, as it would for any retry.

A lower-tier attempt that changed the checkout of a `mutates_checkout: false` step is not escalated, whether it completed or failed: the step stays failed on the attempt that made the change.

### The record

Each attempt of a routed step carries a `route` object on its execution binding, in the run's node events and API:

| Field | Meaning |
| --- | --- |
| `mode` | `shadow` or `apply` |
| `source` | `jev` (its answer decided), `fallback` (a call was needed but gave nothing usable), `disabled` (no call was made) |
| `authoredTier`, `routedTier` | The ceiling, and the decision |
| `applied` | Whether this attempt actually ran on a lower tier |
| `chosenTier`, `probability`, `confidence`, `riskNoul`, `ambiguityNoul` | The classifier's answers, kept even when a floor overrode the choice |
| `reason` | Why the decision is the ceiling, e.g. `high_risk`, `low_confidence`, `timeout`, `no_lower_tier`, `unverifiable`, `router_error` |
| `escalatedFrom`, `escalationReason` | Set on the escalation attempt |

The step's own status and failure kind are the result. A resumed or restarted run reuses the route it recorded for a step instead of classifying it again, and a step that escalated stays on its authored tier. `archon workflow run --dry-run` makes no classifier call: it reports the unrouted resolution and marks the steps the router may lower, or says the router is inactive when it has no key or a switch is off.

### Rolling it out

1. Add the block with `mode: shadow` and set `JEV_API_KEY`. Runs behave as before; route records accumulate.
2. Read the records. Look for steps routed below a tier you would not accept, and at the answers behind them; tune the thresholds.
3. See what can move at all on your tiers: `bun run scripts/model-router-eval.ts --lowerable <tier-map>`. Then run the labelled evaluation: `bun --env-file="$HOME/.archon/.env" run scripts/model-router-eval.ts`, with `--map <tier-map>` to ask only about the steps that can move. It must report zero under-routing.
4. Switch to `mode: apply`.

The evaluation compares the router with hand-written labels, so a pass is a proxy for "no quality regression", not a measurement of it. The shadow records are the evidence from real workloads; a true measurement needs paired runs of the same step on both tiers.

### Known limits

- The default `tiers: [medium]` puts every medium single-shot step on a routable tier (see the list above). Steps with no output contract are recorded as `unverifiable` and never lowered; for the rest, whether one is lowered is the classifier's call on each run.
- The classifier's answers vary a little between identical requests. A case that sits on a threshold can land on either side, so read thresholds from many shadow records, not from one run.
- A lower-tier attempt that completes with a worse answer that still satisfies the step's contract is not detected. Escalation catches failures, not quality.
- A lower-tier attempt that modifies the checkout of a `mutates_checkout: false` step fails the step. It is not escalated, because the tree is already changed. This can only happen within one provider: such a step is never moved to another.
- **A step moved to another provider leaves the first provider's own hooks behind.** Hooks, permission rules and guard scripts that live in a provider's user or project settings (for example a Claude Code `PreToolUse` guard in `~/.claude/settings.json`) apply to that provider's sessions only. Archon's capability checks cannot see them, so a step lowered from Claude to another provider runs without them. If you rely on such a guard, keep every tier on that provider or leave the router in shadow mode.
- Expect modest savings. With the small tier on another provider, only a minority of the bundled pack's medium steps can be lowered at all (`--lowerable` prints the current list), and on the labelled evaluation the classifier reliably lowers only the simplest of them.
- Escalation runs the step again, as a retry does, so a step with side effects may repeat them.
- Escalation is a second round of attempts. A failed output contract costs one attempt on each tier. A provider error is retried under the step's `retry:` policy on the lower tier first (by default up to 3 attempts, or 6 when rate-limited) and then again on the authored tier, so in the worst case a routed step uses twice the attempts of an unrouted one.
- When the lower tier and the authored tier share a provider, a provider-wide failure (quota, authentication) fails on both; escalation costs one more failed attempt.
- A step is classified once per run. Changing thresholds does not re-route a run that is resumed.
- Shadow mode still makes the classifier request, so it adds up to `JEV_ROUTER_TIMEOUT_MS` to each routed step and sends the texts described above.

## Concurrency Settings

Control how many conversations the system processes simultaneously:

```ini
MAX_CONCURRENT_CONVERSATIONS=10  # Default: 10
```

**How it works:**
- Conversations are processed with a lock manager
- If the max concurrent limit is reached, new messages are queued
- Prevents resource exhaustion and API rate limits
- Each conversation maintains its own independent context

**Tuning guidance:**

| Resources | Recommended Setting |
|-----------|-------------------|
| Low resources | 3-5 |
| Standard | 10 (default) |
| High resources | 20-30 (monitor API limits) |

---

## Health Check Endpoints

The application exposes health check endpoints for monitoring:

**Basic Health Check:**
```bash
curl http://localhost:3090/health
```
Returns: `{"status":"ok"}`

**Database Connectivity:**
```bash
curl http://localhost:3090/health/db
```
Returns: `{"status":"ok","database":"connected"}`

**Concurrency Status:**
```bash
curl http://localhost:3090/health/concurrency
```
Returns: `{"status":"ok","active":0,"queued":0,"maxConcurrent":10}`

**Use cases:**
- Docker healthcheck configuration
- Load balancer health checks
- Monitoring and alerting systems (Prometheus, Datadog, etc.)
- CI/CD deployment verification

---

## Troubleshooting

### Config Parse Errors

If your config file has invalid YAML syntax, you'll see error messages like:

```
[Config] Failed to parse global config at ~/.archon/config.yaml: <error details>
[Config] Using default configuration. Please fix the YAML syntax in your config file.
```

Common YAML syntax issues:
- Incorrect indentation (use spaces, not tabs)
- Missing colons after keys
- Unquoted values with special characters

The application will continue running with default settings until the config file is fixed.
