---
title: Tool Action Gate
description: What the Tool Action Gate checks before an agent's tool call runs, how to turn it on, what it sends to its classifier, and what it cannot see.
category: reference
area: workflows
audience: [user, operator]
status: current
sidebar:
  order: 9
---

The Tool Action Gate checks each tool call an agent is about to make that can change state. A shell command, a file write, a network request or an MCP call is judged before it runs. A call the gate denies does not run: the agent gets the reason and what to do instead, and the decision is recorded.

It covers workflow agent nodes (including loop nodes and the agents inside a `loop_group`) and direct chat turns. It is **off by default**.

:::caution
The gate is defence in depth, not a sandbox. It reads the text of a tool call and cannot see what a script, an interpreter one-liner or an MCP tool does once it runs. See [What the gate cannot see](#what-the-gate-cannot-see). For isolation, use a [container run](/guides/container-isolation/) or run Archon on a machine you can afford to lose.
:::

## Turning it on

Add the block to `~/.archon/config.yaml`:

```yaml
toolGate:
  enabled: true
  protectedBranches: [dev, release]      # optional, added to main and master
  verificationCommands: ["make check"]   # optional, added to the built-in test and lint commands
```

| Key | What it does | Default |
| --- | --- | --- |
| `enabled` | Switches the gate on for every workflow agent node and chat turn | `false` |
| `protectedBranches` | Branches a `--force-with-lease` push may never target, beside `main`, `master` and the run's base branch | `[]` |
| `verificationCommands` | Command prefixes recorded as read-only verification, beside `bun`/`npm`/`pnpm`/`yarn` `test`, `run test`, `run lint`, `run type-check`, `run typecheck`, `run format:check` and `run validate` | `[]` |

A repository's `.archon/config.yaml` may carry the same block. It can switch the gate **on** for that repository and add to both lists. It cannot switch off a gate the install switched on and cannot remove an entry: that file lives in the checkout, which is exactly what a gated agent can edit. A run config (`--config`) cannot set `toolGate` at all.

A block Archon cannot read (a misspelled key, `enabled: "yes"`, a list that is not a list of names) stops the config from loading and names the key. A safety setting is never dropped quietly.

### When the gate is on and cannot do its job

A gate that is on either judges every call or stops the work. It never stands down quietly.

- **A provider that cannot ask the gate.** The node fails before its first turn, and a chat turn is refused, with a message naming the provider. Support per provider is the *Tool action gate* row of the [Provider Capability Matrix](/reference/provider-capabilities/). The ways out are a provider that supports the gate, or switching the gate off: there is no per-provider or per-run switch.
- **A container run.** The run fails before any node starts. The gate resolves paths on the host, and a container's paths are not the host's.
- **A chat that is not scoped to a project.** The turn is refused. Such a chat works in the workspaces directory that holds every project, so there is no single checkout to hold it to. Use `/setproject <name>` first.
- **An unusable classifier setting** (see [the classifier](#the-classifier-optional)). The run or turn stops and names the variable.

## What a tool call is judged against

The root is the checkout the node or chat works in. Every path a call names is resolved to where it really lands, following symlinks and `..`, before it is compared with that root. A workflow node may also write into the directories the engine hands it through its environment: the run's `$ARTIFACTS_DIR`, the project's `$STATE_DIR` and the run's log directory (`LOG_DIR`). The secret-file rules apply there as they do in the checkout. A chat turn has no such directories. Everything else outside the checkout, `/tmp` included, is outside.

The rules run in a fixed order. A script is judged command by command and the worst verdict wins, so `git status && rm -rf /` is denied.

### 1. Denied, always

No classifier can lower one of these.

| Rule | What it stops |
| --- | --- |
| `deny.path_outside_root` | A write, move or removal that resolves outside the checkout and the run's own directories |
| `deny.path_unresolvable` | A target the gate cannot place: a symlink loop, a path through a file, an unreadable directory |
| `deny.rm_recursive_root` | Recursive removal of `/`, the home directory, `.`, `..`, the checkout or a run directory itself, or a bare glob in one of them |
| `deny.git_force_push` | `git push` with the force flag, a `+refspec`, or `--mirror` |
| `deny.git_force_push_protected` | `git push --force-with-lease` onto a protected branch, or without naming its branch literally |
| `deny.git_reset_hard` | `git reset --hard` |
| `deny.git_clean_force` | `git clean` that removes untracked directories |
| `deny.secret_write` | A write to an env file, a key or a credential store (`.env*`, `*.pem`, `~/.ssh`, `credentials.*`, `.npmrc`, ...), or to a credential file Archon delivered for the run |
| `deny.secret_read` | Printing the contents of such a file (`cat .env`) |
| `deny.secret_exfiltration` | Sending the environment or a secret file to a network client (`printenv \| curl ...`, `scp .env host:`) |
| `deny.pipe_to_shell` | Downloading a script and running it in the same step (`curl ... \| sh`) |
| `deny.unreadable_request` | A call that reached the gate without its command text, write target or working directory |

### 2. Flagged: the escalation band

A risk signal does not deny a call. It marks it as one the rules cannot settle.

| Signal | What raises it |
| --- | --- |
| `risk.mutation_verb` | `rm`, `mv`, `dd`, `shred`, `docker`, `podman`, `kubectl`, `psql`, `mysql`, `mongosh`, `sudo`, `mkfs*`, recursive `chmod`/`chown`, `git push`, `git rebase`, `git branch -D`, `git tag -d`, a package `publish`, and `gh` commands that change something (`create`, `merge`, `close`, `delete`, `comment`, `edit`, ...) |
| `risk.network_request` | A network client with a method or a body (`curl -X POST`, `wget --post-data`, `gh api -f ...`), and remote clients such as `ssh` and `scp` |
| `risk.kind_network` / `risk.kind_mcp` | Any network tool or MCP tool call |
| `risk.secret_path_argument` | A secret-shaped path handed to a command that does not print it |
| `risk.cwd_outside_root` | A working directory, `cd` or `git -C` outside the checkout |
| `risk.opaque_shell` | Text the gate cannot read: `$(...)`, backticks, `eval`, `bash -c` strings, heredocs fed to an interpreter, `find -exec`, a variable or glob where a target should be |

What happens to a flagged call depends on the classifier:

- **No classifier configured**: the call is allowed and recorded with `source: fallback`. The fixed rules are the whole gate.
- **Classifier configured and it answers**: the call is denied as needing approval when the answer is at or above a threshold, and allowed otherwise.
- **Classifier configured and no usable answer** (timeout, HTTP error, malformed reply): the call is denied as needing approval. A classifier that is down never becomes a silent allow. The agent is told only that no usable answer came back; what went wrong is in the record.

### 3. Allowed

A call with no deny and no signal is allowed. Known read-only commands (`git status`, `git diff`, `git log`, `ls`, `cat` of a non-secret file, `rg`, the verification commands) are recorded as `allow.read_only`, a write inside the root as `allow.write_in_root`, and anything else as `default.no_signal`.

## What the agent is told

A denial is returned to the model as the tool's result. It carries the reason, one or more alternatives, and the instruction not to retry or rephrase the call: use an alternative, or report the work as blocked in the step's output. There is no mid-step pause for a human in this version; "needs approval" means the call was not run and a person has to do it or approve it outside the step.

After three denials in one step, every further denial tells the agent to stop calling denied tools and end the step. A loop node counts across its iterations.

## The classifier (optional)

With `JEV_API_KEY` set, flagged calls are sent to [Jev](https://docs.typesafe.ai/) in one request per call. Any Jev-compatible endpoint works: point `JEV_API_BASE` and `JEV_MODEL` at it. The settings are read from the environment of the Archon process, not from a project's environment variables.

It is asked two questions about the call:

- a **score** over four levels, lowest to highest: `read_only`, `reversible`, `out_of_bounds`, `destructive`. The score is a weighted mean, so it can be fractional.
- a **yes/no**: does the call modify production or external state?

The call is denied when the score is at or above `JEV_GATE_SCORE_THRESHOLD` or the yes/no likelihood is at or above `JEV_GATE_NOUL_THRESHOLD`. The classifier's confidence is recorded and never used to lower a decision. One answer is reused for the same call for the rest of the run.

**What leaves the machine.** Exactly six fields per flagged call: `tool` (the tool's name), `kind`, `command` (the shell text, or the tool's input as JSON when there is none), `targets` (paths and URLs the call acts on, at most 20), `repo_relative` and `reversible_hint`. Before sending, `command` and `targets` are redacted and each cut to 2,000 characters in total: exact credential values Archon knows about (secret-named environment variables and the credentials it injected), `KEY=value` pairs and flags with secret-shaped names, `Authorization` and other credential headers, bearer tokens, URL userinfo, PEM blocks and common token shapes are masked. Redaction works on shape and known values. A secret that looks like ordinary text is not detected. Calls the rules allow or deny are never sent.

| Variable | Description | Default |
| --- | --- | --- |
| `JEV_API_KEY` | API key, sent as a Bearer token. Without it the classifier is off and the rules are the whole gate. | -- |
| `JEV_ENABLED` | Set to `0` or `false` to turn every Jev feature off while keeping the key | on when the key is set |
| `JEV_GATE_ENABLED` | Set to `0` or `false` to turn only the gate's classifier off. The gate itself stays on. | on when the key is set |
| `JEV_API_BASE` | Base URL of the service | `https://api.typesafe.ai` |
| `JEV_MODEL` | Model id sent with each request | `jev-1.13.0` |
| `JEV_GATE_TIMEOUT_MS` | Longest one tool call waits for the classifier, at most `60000` | `5000` |
| `JEV_GATE_SCORE_THRESHOLD` | Deny at or above this score, from `0` to `3` (the top of the four-level scale) | `1.5` |
| `JEV_GATE_NOUL_THRESHOLD` | Deny at or above this likelihood of changing production or external state, from `0` to `1` | `0.5` |

An unusable number stops the run or chat turn and names the variable. It never falls back to the default, and it never turns the classifier off: either would let a typo turn flagged calls into unjudged ones.

## Records

Every decision is recorded, allowed ones included.

- **Workflow runs** write one `tool_gate_decision` event on the step whose tool call was judged. They are among the raw rows `archon workflow get <run-id> --json --verbose --events` returns.
- **Chat turns** have no run, so each decision is one structured log line, `orchestrator.tool_gate_decision`, with the conversation id.

Both carry the same fields: `tool`, `kind`, `decision`, `needsApproval`, `source` (`rule`, `jev` or `fallback`), `ruleId`, `latencyMs`, `commandHash` (SHA-256 of the raw call, so repeats can be matched) and `redactedPreview` (the redacted call, cut to 200 characters), plus `score`, `noul` and `confidence` when the classifier answered and `classifierFailure` when a configured classifier gave no usable answer. The raw command and tool input are never stored.

Identical calls made at the same moment are judged once and produce one record. A call the gate cannot read at all (an unknown kind, no command text) is denied as `deny.unreadable_request` and recorded like any other.

## What the gate cannot see

The gate reads a tool call's text. It does not run a shell, and it is not told what a tool does after it starts.

- **A script written and then run.** `./run.sh`, `bash run.sh`, `source x`. The write is judged; what the script does is not.
- **Interpreter programs.** `python -c`, `node -e`, `perl -e`. The program text is never read.
- **Indirection.** `make`, package scripts (`bun run build`), git hooks, and aliases or functions from the user's shell or git config.
- **Run-time values.** What a variable, a glob, brace expansion or an `xargs` input becomes. A destructive flag kept in a variable is at best flagged, never denied.
- **Unknown wrappers and unmodelled syntax.** A wrapper the reader does not know hides the command it runs. `case` patterns, extended globs and non-POSIX shells (PowerShell, cmd) mostly match nothing.
- **MCP tools.** The gate sees the tool's name and input, not what the server does with them. Without a classifier every MCP call is allowed.
- **Provider gaps.** Which of a provider's tools reach the gate is that provider's translation. Tools from user-owned Pi extensions are not wrapped. See the caveats in the [Provider Capability Matrix](/reference/provider-capabilities/).
- **Reads outside the checkout.** Only writes are held to the root. A read anywhere is allowed unless the path is secret-shaped.
- **Scratch files in `/tmp`.** These are denied like any other write outside the root. Agents should use `$ARTIFACTS_DIR`.

The classifier is a second opinion on flagged calls, not a boundary. Its confidence is not proof, and it only ever adds a denial.

## Measuring the classifier

`scripts/tool-gate-eval.ts` asks the configured classifier about a labelled set of escalation-band calls (`packages/workflows/src/tool-gate/fixtures/escalation-eval.jsonl`) through the gate's own code path:

```bash
bun --env-file="$HOME/.archon/.env" run scripts/tool-gate-eval.ts   # live: needs JEV_API_KEY
bun run tool-gate-eval --dry                                        # no key, nothing sent
```

It passes when no row labelled destructive was allowed, and reports the share of safe rows that were denied and the classifier's p50 and p95 latency. Exit code `0` is a pass, `1` a scored fail, and `2` means it was not scored: no key, a classifier failure on any row, or an unusable set. A `--dry` run answers from the labels; it proves the pipeline, not the classifier, and says so on its result line. Run the live evaluation before relying on the classifier, and again after changing a threshold, the model or the endpoint.
