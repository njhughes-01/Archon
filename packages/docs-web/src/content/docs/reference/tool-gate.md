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
- **A container run.** The run fails before any node starts. The gate resolves each path a tool call names on the host, and a container's paths are not the host's, so it cannot judge them yet. Run the workflow on the host (without `--container` or `container.enabled`), or switch the gate off.
- **An unusable classifier setting** (see [the classifier](#the-classifier-optional)). The run or turn stops and names the variable.

## What a tool call is judged against

The root is the checkout the node or chat works in. Every path a call names is resolved to where it really lands, following symlinks and `..`, before it is compared with that root. A workflow node may also write into its run's `$ARTIFACTS_DIR` and the project's `$STATE_DIR`, where the secret-file rules apply as they do in the checkout. A chat turn has no such directories. Everything else outside the checkout is outside: `/tmp`, and the project's log directory too, which holds the engine's transcripts of every run.

### A chat with no project

A chat that is not scoped to a project works in the workspaces directory, which holds every project with its artifacts and credential directories. The gate is not rooted there. It is rooted at an empty private directory instead, so:

- every write is denied, anywhere, including into a project under the workspaces directory;
- the fixed deny rules apply as usual;
- every shell command is flagged (`risk.cwd_outside_root`), because none runs inside the root. With no classifier it runs and is recorded as `fallback`; with one, each distinct command is one classifier request per turn.

Adding a project from such a chat does not work while the gate is on: the target of the `git clone` is a write, and nothing is writable, so the clone is denied (`deny.path_outside_root`). The denial tells the agent what to pass on. Clone the repository in a terminal and register it with `/register-project <name> <path>` or **Add Project** in the web console, or switch the gate off for the setup. Neither `/register-project` nor `/setproject` is a tool call, so the gate does not affect them.

The rules run in a fixed order. A script is judged command by command and the worst verdict wins, so `git status && rm -rf /` is denied.

### 1. Denied, always

No classifier can lower one of these.

| Rule | What it stops |
| --- | --- |
| `deny.path_outside_root` | A write, move or removal that resolves outside the checkout and the run's own directories. The target of a `git clone` or `git worktree add` counts as a write |
| `deny.path_unresolvable` | A target the gate cannot place: a symlink loop, a path through a file, an unreadable directory, a path relative to a running process (`/proc/self/cwd/...`), a path through a symlink the same command makes to somewhere it does not say (`ln -s "$T" x && echo > x/f`), a file-tool path in a form only that tool resolves (a leading `~` or `@`, a `file://` URL), and a relative path in a shell that an earlier allowed call of the same step may have left standing outside the checkout |
| `deny.command_too_large` | A command past the gate's reading budget: more than 262,144 characters, 3,000 words and operators, 400 commands, 24 wrappers in front of one command, 800 different paths, or an unknown tool with more than six command names among its arguments. The body of a heredoc that is only stored counts as one word. Such a command is denied rather than flagged, so padding cannot carry a denied command past the rules |
| `deny.rm_recursive_root` | Recursive removal of `/`, the home directory, the checkout, its `.git`, its parent or a run directory itself, or a bare glob in one of them. The same through `find` (`find . -delete`, `find . -exec rm -rf {} +`, a `-delete` in front of its tests or on an `-o` branch), through `xargs` when what it is fed is written in the command (`echo / \| xargs rm -rf`), and through a symlink the command itself makes (`ln -s / r; rm -rf r/`) |
| `deny.git_force_push` | `git push` with the force flag, a `+refspec`, or `--mirror` |
| `deny.git_force_push_protected` | A push that rewrites or deletes a protected branch, and a `--force-with-lease` push whose branch cannot be read from the command or the checkout: a pattern such as `refs/heads/*`, a repository named with `--git-dir` or `GIT_DIR`, or a command in the same call that may change which branch is out (`git checkout main && git push --force-with-lease`, in either order). A lease push of the checked-out, unprotected branch (bare, or `origin HEAD`) is not denied, and neither is one that follows `git checkout -b <new-branch>` |
| `deny.git_reset_hard` | `git reset --hard` |
| `deny.git_discard_worktree` | Discarding uncommitted changes across the working tree: `git checkout -- .`, `git restore .`, `git checkout -f`, `git switch --discard-changes`, `git checkout-index -f -a`, and a checkout or restore through a wildcard (`git restore '*.ts'`), which git expands across directories whether it is quoted or not. The same loss as a hard reset. A discard that names its files or one sub-directory is flagged instead |
| `deny.git_push_destination_change` | Changing where the checkout's pushes go: `git remote set-url`, `rename` or `remove` on `origin`, adding a remote called `origin`, and `git config` writes to `remote.*`, `branch.*.remote`, `branch.*.pushRemote`, `url.*.insteadOf`, `url.*.pushInsteadOf` or `push.default`. Adding a remote under another name is flagged, not denied |
| `deny.git_clean_force` | `git clean` that deletes untracked files or directories (a dry run is not denied) |
| `deny.secret_write` | A write to an env file, a key or a credential store (`.env*`, `*.pem`, `~/.ssh`, `credentials.*`, `.npmrc`, provider login files, ...), or to a credential file Archon delivered for the run. Templates such as `.env.example` are not secrets, and neither are source and prose files named for them (`src/secrets/index.ts`, `api.key.ts`, `docs/credentials.mdx`), a path whose last name is a bare `env` (far more often a directory), or a `.docker/` directory inside the checkout. `.envrc` and manifests such as `k8s/secrets.yaml` are secrets, and so is every file in a credential directory (`~/.ssh`, `~/.aws`, `~/.docker`), public keys included |
| `deny.secret_read` | Reading, copying, loading or printing such a file (`cat .env`, `cp .env copy.txt`, `source .env`), by any command that does more than look at its metadata |
| `deny.secret_exfiltration` | Sending the environment or a secret file off the machine, or into a program that can (`printenv \| curl ...`, `scp .env host:`, `curl -F f=@id_rsa ...`) |
| `deny.pipe_to_shell` | Downloading a script and running it in the same step (`curl ... \| sh`, `bash <(curl ...)`, download-then-run), with any fetcher and any shell or interpreter on the receiving end |
| `deny.unreadable_request` | A call that reached the gate without its command text, write target, a known kind or an absolute working directory, with a field of the wrong shape, or a patch whose file headers the provider could not all read |

### 2. Flagged: the escalation band

A risk signal does not deny a call. It marks it as one the rules cannot settle.

| Signal | What raises it |
| --- | --- |
| `risk.mutation_verb` | `rm`, `mv`, `dd`, `shred`, `docker`, `podman`, `kubectl`, `psql`, `mysql`, `mongosh`, `redis-cli`, `dropdb`, `sudo`, `mkfs*`, recursive `chmod`/`chown`, `git push`, `git branch -D`/`-M`/`-f`, `git checkout -B`, `git tag -d`, `git rm`, `git worktree remove`, git commands that discard work in a directory or drop history (`restore src/`, `stash drop`, ...), a `git config` write to a setting that can name a program (`core.hooksPath`, `core.sshCommand`, `alias.*`), a write under `.git/`, `rsync --delete`, a package `publish`, `unpublish` or `yank`, `gh` commands that change something on GitHub (`merge`, `close`, `delete`, `run`, `cancel`, `archive`, ...), `terraform`/`helm`/`pulumi` verbs that change infrastructure, `aws`/`gcloud`/`az` operations whose name does not say they read, `systemctl` and `service` verbs other than status, `crontab` other than `-l`, `pkill`, `killall`, `shutdown`, and a `kill` of `-1`, `0`, `1`, a process group or a target in a variable. The routine cases that raise nothing are in [Routine work the rules settle](#routine-work-the-rules-settle) |
| `risk.network_request` | A network client with a method or a body (`curl -X POST`, `wget --post-data`, `gh api -f ...`), and remote clients such as `ssh` and `scp` |
| `risk.kind_network` / `risk.kind_mcp` | Any network tool or MCP tool call |
| `risk.kind_other` | A tool the provider could not put in any other kind. It is never allowed by rule. A `file_path`, `path` or similar field in its input is judged as a write target first, so one outside the checkout or on a secret file is denied |
| `risk.environment_dump` | Printing the whole environment to the agent (`env`, `printenv`, `set`, `export -p`, `declare -p`). Sending it anywhere is a denial, above |
| `risk.secret_path_argument` | A secret-shaped path handed to a command that does not print it |
| `risk.cwd_outside_root` | A working directory, `cd` or `git -C` outside the checkout |
| `risk.opaque_shell` | Text the gate cannot read: a substitution among the arguments of a command that acts on them, `eval`, `bash -c` strings, a `find -exec` or `xargs` that runs more than a reader, a variable or glob where a target should be, a variable prefix that makes a read-only command run something (`GIT_EXTERNAL_DIFF=...`, `PAGER=...`) or points git or `gh` at another repository or configuration (`GIT_DIR`, `HOME`, `GH_REPO`), a `git -c` setting that is not known to be inert, what a git command hands to a shell (`rebase --exec`, `submodule foreach`, `bisect run`), interpreter code that mentions a destructive command in a string or builds a command at run time, and everything from a PowerShell or cmd tool. Where the hidden text is a literal it is read too, so a destructive command inside is still denied |

What happens to a flagged call depends on the classifier:

- **No classifier configured**: the call is allowed and recorded with `source: fallback`. The fixed rules are the whole gate.
- **Classifier configured and it answers**: the call is denied as needing approval when the answer is at or above a threshold, and allowed otherwise.
- **Classifier configured and no usable answer** (timeout, HTTP error, malformed reply): the call is denied as needing approval. A classifier that is down never becomes a silent allow. The agent is told only that no usable answer came back; what went wrong is in the record.

### 3. Allowed

A call with no deny and no signal is allowed. Known read-only commands (`git status`, `git diff`, `git log`, `ls`, `cat` of a non-secret file, `rg`, the verification commands) are recorded as `allow.read_only`, a write inside the root as `allow.write_in_root`, and anything else as `default.no_signal`.

### Routine work the rules settle

Some things an agent does all the time are facts the rules can read for certain, so they are not left to a classifier:

- **Pushing a feature branch to `origin`.** A `git push` raises nothing when the remote is `origin` (named or implied), the only other options are `-u`, `-q`, `-v`, `--no-verify` and `--force-with-lease`, and it pushes either the checked-out branch, which must not be protected, or another branch that is not protected and without the lease flag. The checked-out branch is read from the checkout's `HEAD`, or from a `git checkout -b` earlier in the same command. Any other push stays flagged: another remote or a URL, a lease push of another branch, `--tags`, `--all`, `--prune`, `--repo`, a deletion, a destination that is not a plain branch name. Because this rests on `origin` being what the checkout was given, changing it is denied (`deny.git_push_destination_change`).
- **Bringing back named files.** `git restore <file>...` and `git checkout [<tree>] -- <file>...` raise nothing when every operand names one file inside the checkout: at most eight, no directory, no wildcard, nothing in a variable, no `-p`.
- **Removing and renaming named paths.** An `rm` raises nothing when every path it names is its own path inside the checkout or a run directory: nothing in a variable, not the root, nothing under `.git`, and for a recursive removal not a top-level directory of the checkout. A wildcard counts by the directory it is anchored in. An `mv` is the same for its sources and its destination. These lose nothing a file-writing tool could not already overwrite.
- **Removing build output and disposable files.** An `rm` or `find -delete` raises nothing when every path it names lies in a directory named `node_modules`, `dist`, `build`, `target`, `.cache`, `__pycache__` or `coverage` inside the checkout. Neither does a `find` that removes only files of a disposable name (`*.pyc`, `__pycache__`, `*.orig`, `*.rej`, `.DS_Store`, `*.swp`, `*.tmp`, and the Python tool caches) with nothing else in its expression.
- **Rebasing.** A `git rebase` rewrites local commits the reflog keeps. What it runs with `--exec` is judged as a script.
- **Steps on the caller's own pull request.** `gh pr create`, `gh pr comment` and `gh pr edit` raise nothing with their ordinary options (title, body, labels, reviewers, draft, base and head on create) and nothing that points them at another repository: no `--repo`, no URL operand, no `GH_REPO`, `GH_HOST` or `HOME` set in the command. `gh pr edit --base` stays flagged.
- **Looking at containers and clusters.** `docker`/`podman` `ps`, `logs`, `images`, `stats` and their `compose` forms, and `kubectl get`, `describe` and `logs` of anything but secrets.
- **Reading through `find -exec`, `xargs` and substitutions.** `find ... -exec grep ...`, `git ls-files | xargs wc -l` and `echo "$(date)"` are reads. A name test or start path that is secret-shaped is denied like the same path given to `cat`.
- **Names and messages.** For a tool the rules do not know, the value of `-g`, `-t`, `-e`, `-m`, `-k`, `--filter`, `--title`, `--grep`, `--body`, `--message` and similar options is text, not a command, unless it is shaped like a script: more than one command, or a first command the rules have a deny rule for.

## What the agent is told

A denial is returned to the model as the tool's result. It carries the reason, one or more alternatives, and the instruction not to retry or rephrase the call: use an alternative, or report the work as blocked in the step's output. There is no mid-step pause for a human in this version; "needs approval" means the call was not run and a person has to do it or approve it outside the step.

After three denials in one attempt of a step, every further denial tells the agent to stop calling denied tools and end the step. The count starts again for each retry of a node and each iteration of a loop node.

## The classifier (optional)

With `JEV_API_KEY` set, flagged calls are sent to [Jev](https://docs.typesafe.ai/) in one request per call. Any Jev-compatible endpoint works: point `JEV_API_BASE` and `JEV_MODEL` at it. The settings are read from the environment of the Archon process, not from a project's environment variables.

It is asked two questions about the call, each on its own:

- a **score** over four levels. The score is a weighted mean, so it can be fractional.
- a **yes/no**: does the call change production, shared or third-party state that the agent running it does not own?

The call is denied when the score is at or above `JEV_GATE_SCORE_THRESHOLD` or the yes/no likelihood is at or above `JEV_GATE_NOUL_THRESHOLD`. The classifier's confidence is recorded and never used to lower a decision. One answer is reused for the same call for the rest of the run.

| Level | What belongs there |
| --- | --- |
| `read_only` | Only reads or inspects: listing, viewing, a query that only selects, an HTTP GET, printing the environment to the agent |
| `reversible` | Routine work on the agent's own task that it could undo itself: changing files in the repository, deleting build output, discarding changes to named files, local git history work, pushing a feature branch, opening, updating or commenting on a pull request or issue, rerunning or cancelling CI, local containers and test stacks, changing a database named as test or dev (emptying or dropping its tables included), ordinary requests to a service on the local machine, a dry run |
| `out_of_bounds` | Changes something outside the task that others rely on, without destroying data: a protected branch, merging or closing a pull request, dispatching a workflow or deployment, repository settings and secrets, a remote machine, cluster or non-local database, a state-changing request to an external API, root on the host, or an effect hidden behind a variable or opaque script |
| `destructive` | Permanently destroys or irrevocably publishes: dropping or truncating a database that is not named as test or dev, deleting remote branches, tags, releases, repositories, volumes or cloud resources, deleting git recovery data, emptying the repository, publishing a package, image or release, tearing down a production service, removing files through an unknown variable |

The default thresholds deny from half-way between `reversible` and `out_of_bounds` upward. The exact wording of both questions is in `packages/workflows/src/tool-gate/escalate-jev.ts`.

**Facts sent with the call.** The classifier sees text, and some of what matters is not in the text. The rules state what they know for certain under `context`, in fixed words. A fact the rules could not establish is `unknown`; one that does not concern the call is `not_applicable`.

| Fact | Values | From |
| --- | --- | --- |
| `git_push_target` | `checked_out_branch`, `other_unprotected_branch`, `protected_branch`, `deletes_remote_ref`, `several_or_all_refs`, `unknown` | The refspecs, the checkout's `HEAD` and the protected-branch list |
| `uncommitted_work` | `discarded_in_named_paths`, `unknown` | The operands of `git checkout` and `git restore`. A whole-tree or wildcard discard is denied by rule and never sent; `unknown` is a path in a variable |
| `removal_target` | `build_or_cache_output`, `other_repository_path`, `unknown` | Where the paths of an `rm` or `find -delete` really land |
| `github_action` | `comment`, `open_or_update`, `ci_run_control`, `workflow_dispatch`, `merge_or_close`, `release`, `delete`, `settings_or_secrets`, `other` | The `gh` group and verb. Whether the pull request or run is the agent's own is not known to the gate |
| `target_host` | `test_or_dev_named`, `loopback`, `production_named`, `unknown` | The host or database a database, HTTP or remote-shell client names. Loopback is certain about the address only: a tunnel puts a production database there too, so dropping or emptying tables counts as routine only for a database named as test or dev. A name wins over the address |

**What leaves the machine.** Per flagged call: `tool` (the tool's name), `kind`, `command` (the shell text, or the tool's input as JSON when there is none), `targets` (paths and URLs the call acts on, at most 20), `repo_relative`, `reversible_hint`, and the `context` facts above, which are fixed words and never text from the call. Before sending, `command` and `targets` are redacted and each cut to 2,000 characters in total: exact credential values Archon knows about (secret-named environment variables and the credentials it injected), `KEY=value` pairs and flags with secret-shaped names, `Authorization` and other credential headers, bearer tokens, URL userinfo, PEM blocks and common token shapes are masked. Redaction works on shape and known values. A secret that looks like ordinary text is not detected. Calls the rules allow or deny are never sent.

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

Both carry the same fields: `tool`, `kind`, `decision`, `needsApproval`, `source` (`rule`, `jev` or `fallback`), `ruleId`, `count`, `latencyMs`, `commandHash` (SHA-256 of the raw call, so repeats can be matched) and `redactedPreview` (the redacted call, cut to 200 characters), plus `score`, `noul` and `confidence` when the classifier answered and `classifierFailure` when a configured classifier gave no usable answer. The raw command and tool input are never stored.

Identical calls made at the same moment are judged once and produce one record, whose `count` says how many calls it answered (`1` for a call made alone). A call the gate cannot read at all (an unknown kind, no command text, a field of the wrong shape) is denied as `deny.unreadable_request` and recorded like any other, by its tool name alone.

In a workflow run the record is written before the call is let through. If the write fails, an allowed call is denied instead (`guard.unrecorded_decision`) and the failure is logged: nothing runs that the run has no record of.

## What the gate cannot see

The gate reads a tool call's text. It does not run a shell, and it is not told what a tool does after it starts.

- **A script written and then run.** `./run.sh`, `bash run.sh`, `source x`. The write is judged; what the script does is not.
- **Interpreter programs.** In `python -c`, `node -e`, `bun -e`, `deno eval`, `ruby -e`, `lua -e`, `Rscript -e` code, and in a heredoc fed to one of them, the gate reads the quoted strings. A string handed to a call that runs commands (`os.system`, `subprocess.run`, `execSync`, `spawnSync`, backticks in Ruby and Perl) is judged as that command, and a secret path handed to a call that opens files is a secret read. A destructive command or a secret path in any other string is flagged, not denied, and so is a command built at run time. Anything else the program does (a file write, a network call, a spawn through a name the gate does not know) is unseen. Only the first 32,768 characters of a program are read; a longer one is flagged.
- **Indirection.** `make`, package scripts (`bun run build`), git hooks, and aliases or functions from the user's shell or git config.
- **Run-time values.** What a variable, a glob, brace expansion or an `xargs` input becomes. A destructive flag kept in a variable is at best flagged, never denied. `$ARTIFACTS_DIR` is one of them: the engine writes the directory's path into a prompt, but an agent's shell has no such variable, so a command that spells it as a variable is flagged. `$(mktemp)` is read as a path in `/tmp`.
- **Symlinks made by other means.** A link made with `ln -s` is followed for the rest of the same command. One made by a script, an archive, `cp -a` or an earlier tool call is followed only once it exists on disk.
- **Unmodelled syntax.** `case` patterns, extended globs, `[[ ]]` internals and non-POSIX shells mostly match nothing. PowerShell and cmd text is read for what it shares with POSIX shell and always flagged. A destructive command behind a wrapper the gate does not know is still found, but nothing else about what that wrapper does is.
- **An unknown tool that runs a text option.** If a tool the rules do not know runs the value of its `-e` or `-t` as a command, a single command there that is not one the rules deny by name is not read.
- **Tools the rules have no word for.** A command raises a signal only when the rules know its verb. Framework commands such as a migration reset, and any CLI not named under `risk.mutation_verb`, are allowed without a signal and never reach the classifier.
- **The checkout's own git files.** A write to `.git/config` or `.git/hooks` is flagged, not denied: with no classifier it runs. The deny rule on changing where pushes go covers `git remote` and `git config`, not an edit of the file behind them.
- **A Codex shell call with its own working directory.** Codex lets a shell call name the directory it runs in and does not pass that to the gate, so a relative path in such a call is judged against the turn's directory. Seen in a real run; there is no fix on Archon's side short of denying every relative path from Codex.
- **A shell that keeps its directory between calls.** Each call is judged against the directory the provider reports for it. After an allowed call that left the checkout, later relative writes in the same attempt are denied rather than trusted; a provider that reports the wrong directory in any other way is not detected.
- **MCP tools.** The gate sees the tool's name and input, not what the server does with them. Without a classifier every MCP call is allowed.
- **Provider gaps.** Which of a provider's tools reach the gate is that provider's translation, and each has limits of its own. They are the *Tool action gate* caveats in the [Provider Capability Matrix](/reference/provider-capabilities/).
- **Reads outside the checkout.** Only writes are held to the root. A read anywhere is allowed unless the path is secret-shaped.
- **Scratch files in `/tmp`.** These are denied like any other write outside the root. Agents should use `$ARTIFACTS_DIR`.

The classifier is a second opinion on flagged calls, not a boundary. Its confidence is not proof, and it only ever adds a denial.

## Measuring the classifier

`scripts/tool-gate-eval.ts` asks the configured classifier about a labelled set of escalation-band calls (`packages/workflows/src/tool-gate/fixtures/escalation-eval.jsonl`) through the gate's own code path:

```bash
bun --env-file="$HOME/.archon/.env" run scripts/tool-gate-eval.ts   # live: needs JEV_API_KEY
bun run tool-gate-eval --dry                                        # no key, nothing sent
```

The set is two halves, marked on each row. The questions and thresholds are tuned against `tuning` only. `heldout` holds rows they were never tuned on, including whole command families the tuning half does not contain, and is the half to judge a result by:

```bash
bun --env-file="$HOME/.archon/.env" run scripts/tool-gate-eval.ts --split heldout
```

It passes when no row labelled destructive was allowed, and reports the share of safe rows that were denied and the classifier's p50 and p95 latency. Exit code `0` is a pass, `1` a scored fail, and `2` means it was not scored: no key, a classifier failure on any row, or an unusable set. A `--dry` run answers from the labels; it proves the pipeline, not the classifier, and says so on its result line. Run the live evaluation before relying on the classifier, and again after changing a threshold, the model or the endpoint.
