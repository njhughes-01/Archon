# Working in the SDLC pack

Conventions for this pack specifically. Project-wide judgment lives in
[`AGENTS.md`](../../../AGENTS.md); the YAML surface is governed by
[`.archon/workflow-language-constitution.md`](../../workflow-language-constitution.md).

## Guards

A guard here must protect an action the node it lives in takes.

**Keep** a guard when it:

- verifies the effect of something this node just did — exit 0 is not proof, and a
  forge can accept a write and silently not apply it; or
- refuses to proceed on a question it asked and could not get an answer to, where
  guessing is irreversible. `archon complete` blocking a branch delete it could not
  prove safe is the shape.

**Cut** a guard when it re-asserts an invariant something else already established.
That belongs where it is established, once — not at each node that depends on it.

**The test: if this pack's fixture suite cannot exercise the guard, it is not a
guard. It is a comment — write it as one.**

That test is mechanical and settles most arguments without debating threat models.
A node the dry run cannot execute — a composed `bash:` node, for instance, which
never receives its caller's `with:` values — can only ever be stubbed, so no
fixture can show the guard working or catch it breaking.

### Why this rule exists

The pack once verified "the checkout is on the branch my PR is on" in three places:
a preflight node before review, the ready flip, and prose inside the correction
prompt for an agent to honour. Three copies, two languages, one of them dependent
on a model's diligence.

None of it was load-bearing. The engine gives a run its worktree, and the pull
request is created in that worktree, so the invariant holds by construction.
Nothing had ever gone wrong — the alarm that prompted the work was investigated
and closed invalid. And the copies did not even cover the steps that would have
suffered most from a drifted checkout: `impl` writes code to that checkout without
checking, and `validate` runs the project's tests against it without checking.

The preflight alone cost 31 lines and a stub in 17 fixtures, for a node no fixture
could ever run. All three copies are gone.

The ready preflight re-reads checks for the recorded qualified PR itself. It refuses
pending, red, gated and unknown checks and any failed read, because a failed
observation is not evidence that no CI exists. The flip targets that same qualified
PR and reads the draft state back afterwards, because a successful exit is not proof
the state changed.

The rule is not "never defend against what has not happened" — the two Keep cases
above have not happened either, and both are worth their few lines. The question is
whether the guard is protecting *this node's own action*, or restating something
that was already true when the node started.

## Forge source

One switch selects the source for every forge read and write this pack makes.
[`.shared/forge.ts`](.shared/forge.ts) owns which one a run selected;
[`.shared/checks.ts`](.shared/checks.ts) owns the check read and its gate policy,
and [`.shared/pr.ts`](.shared/pr.ts) owns the pull-request reads and writes. Both
return the same shapes from either source, so one policy classifies both:

- **`gh` (default).** The GitHub CLI, acting on the recorded qualified PR. This
  needs only the authenticated `gh` the pack has always used.
- **`forge` (opt-in).** Set `ARCHON_SDLC_FORGE=forge` in the environment Archon
  runs with, for example `~/.archon/.env`. Operations then go through
  `archon forge`, which needs a forge plugin installed for the PR's host (see the
  forge reference in the docs) and the `ARCHON_CLI_COMMAND` host command that the
  CLI and server publish at startup.

The source is never picked from what happens to be installed. When `forge` is
selected and cannot answer (no host command, no plugin for the host, a failed
operation), the node refuses and `ci-note` reports the failure on stderr; none of
them falls back to `gh`. Any other value of `ARCHON_SDLC_FORGE` refuses too. The
forge source is for host execution: a container execution receives neither
`ARCHON_SDLC_FORGE` nor `ARCHON_CLI_COMMAND`, so a containerized run uses `gh`.

## Public writes belong to a script

An agent judges and authors; the node after it performs the one public write and
proves it landed. `publish-pr` opens or reuses the pull request, `publish-pr-body`
applies the resync, `publish-review` upserts the one marked review comment, and
`flip-ready` flips it out of draft. Each takes a recorded intent from the agent
before it, writes through the selected source, and fails unless the result reads
back — so "the write failed" and "the write may have landed" stay different
outcomes, in the pack as in the forge contract.

That split is also what keeps the source switch out of the prompts. A prompt that
branched on `ARCHON_SDLC_FORGE` would be an invented protocol; the scripts read it
and the agents never see it.

## Deterministic scripts

Every `script:` node here is TypeScript on Bun, under its own component's
`scripts/` directory. Logic more than one of them needs lives once in
[`.shared/`](.shared), imported by relative path with the extension written
(`../../.shared/report.ts`). That directory is reserved for modules: nothing in it
is a workflow or a named script target, and a node that names one fails at load.

The repository validates them where they live. `.archon/workflows/tsconfig.json`
is the owning configuration — `bun run type-check` compiles that project, and both
`eslint.config.mjs` and `scripts/lint.ts` derive their globs from its `include`
rather than restating them. A script placed outside those globs fails
`pack-scripts.test.ts` rather than going quietly unchecked.

Three rules, each protecting something a script cannot get back on its own:

- **Read every binding as a literal `process.env.INPUTS_<NAME>`.** The engine scans
  each script's own source at load and refuses a workflow whose script reads a
  binding no `with:` clause provides. It matches that literal form only, and it never
  follows imports — so a helper that built the key from a name would hide every read
  in the pack from that check, and a renamed binding would surface as a wrong result
  at the end of a paid run instead of a refusal before it started. Pass the value to
  `.shared/io.ts`, never the name.
- **Never call `process.exit()`.** Bun leaves without draining stdout — a 500 KB
  write to a pipe arrives as 131072 bytes, silently. Set `process.exitCode` and
  return; `.shared/io.ts` is the only place that should need to know this.
- **Nothing the target project provides is available.** No `package.json`, no
  `node_modules`, no `tsconfig.json`, no npm dependency. Relative imports within
  the pack and the standard library are the whole surface, which is what keeps
  these workflows runnable against a project in any language.

A vocabulary a node declares in YAML has exactly one owner. A script that routes on
one imports it from `.shared/verdict.ts`; a script that merely consumes another
node's certified value does not restate the list at all.

## Context scout

[archon-scout](scout/archon-scout.yaml) is an optional pre-read that `investigate`
and `plan` include before their agent: a classifier answers one yes/no question
about every candidate file, in line windows, and the agent starts from the files
it selected. Three nodes, each doing the one thing its kind is for:

- `config` (shell) reports whether a classifier is configured. `when:` cannot
  read the environment, so this is the gate that keeps an install without one
  from paying for anything after it. It is `bash:` text using shell built-ins
  only, because it runs on every investigate and plan, including where Bun is
  not installed.
- `question` (agent, small tier) turns the free-text request into one question
  and the paths worth checking, or declines. That is judgment, so no script
  attempts it.
- `classify` (script) is everything after the judgment: which files may be sent,
  the budgets, the requests, the result. It is the only node here that needs
  Bun, and it runs only once the gate says a classifier is configured.

[`.shared/context-scout.ts`](.shared/context-scout.ts) owns all of the last one,
and it is where to read what "never sent" means. The settings are environment
variables, documented with the rest of the configuration reference.

Two rules hold it together:

- **Without a classifier it costs nothing; with one, its nodes can fail the
  run.** No key means the gate alone runs and the consumer reads its
  `if_skipped` value. With a key, every way the classifier cannot answer is
  still a result (`status: unavailable`, with the reason), but the scout's own
  nodes are ordinary nodes and the engine has none that is optional: when the
  `question` agent still fails after its five retries, or `classify` cannot
  start because Bun is missing, the run fails before the consumer's agent
  starts. It is resumable, and `JEV_SCOUT_ENABLED=0` turns the scout off. Do not
  describe the scout as unable to fail a run.
- **Its list is a lead, never evidence.** The prompts that read it say so. A file
  the budget cut is counted as unclassified and left out; it is never listed as
  not relevant.

[`.shared/jev-client.ts`](.shared/jev-client.ts) is a byte-for-byte copy of
`packages/workflows/src/jev/jev-client.ts`, because nothing in a pack can import
engine code. Edit the engine file and copy it over; `jev-client-mirror.test.ts`
fails while they differ. The gate's shell text and `readScoutSettings` are the
other pair that must agree, in two languages; `context-scout-script.test.ts`
runs the gate under `sh` and `bash` with an empty `PATH` against that function.

Whether the classifier is good enough is measured, not assumed:
`bun run scout-eval` runs the same code over a labelled fixture repository and
reports recall, precision, files selected and characters sent. It calls the real
classifier, so it needs `JEV_API_KEY` and is not part of the test suite;
`--dry` answers from the answer key and sends nothing. See
[`scripts/context-scout-eval.ts`](../../../scripts/context-scout-eval.ts).

## Second opinion

A second opinion is one bounded question put to a classifier at a checkpoint
where a workflow is about to make a judgment call, so the agent that makes it
starts from a hypothesis instead of from its first guess.
[`.shared/second-opinion.ts`](.shared/second-opinion.ts) is the whole of it: a
question, two or more named choices each with a criterion, and a piece of
evidence go in; `{ status, reason, choice, probabilities, confidence, advisory }`
comes out. It is a script, so it works the same under every provider.

The one checkpoint today is a red gate. In
[archon-validate](validate/archon-validate.yaml), `failure-class` runs after
`run` on the same condition that sends a red gate to `classify`, and asks which
kind of failure the record shows: `code_defect`, `flaky_test`,
`dependency_failure` or `environment_failure`. The question and each criterion
are authored on that node. A new checkpoint is a new node with its own question
and a wrapper script in its workflow's `scripts/`; do not add one to every step.
An opinion is worth a request where a wrong first guess is expensive, which is
at an explicit point of uncertainty.

Three rules hold it together:

- **It is advisory, and the result says so.** `advisory` is always `true`.
  `classify` receives the opinion through `with:` as a hypothesis to test
  against the log, under a prompt that keeps its own evidence bar: no class
  settles `red_cause`, `environment_failure` is not evidence for `environment`,
  and where the log disagrees the log wins and the summary says so. `result`
  carries the class beside the verdict as `advisory_failure_class`, present only
  when a classifier answered. Nothing reads that field to decide anything:
  delivery binds `green`, `red_cause` and `summary` by name, and
  `sdlc-validation-run.test.ts` fails if a pack file starts to read it. A
  classifier's `confidence` is how concentrated its answer was, never the chance
  it is right.
- **Without a classifier it costs one script start, and it never fails the run
  on purpose.** No `JEV_API_KEY`, `JEV_ENABLED` or `JEV_OPINION_ENABLED` off, an
  unusable setting, evidence it may not read, a timeout, an HTTP error or an
  answer that is not one of the choices: each is a result with
  `status: unavailable` and the reason, and the script exits 0. No AI turn is
  spent either way, which is why no gate node stands in front of it as one does
  in front of the scout. The node's own timeout skips rather than fails, and
  `classify` reads its `if_skipped` value. It is still an ordinary node: a crash
  the script does not catch would fail the run like any other.
- **What is sent is bounded and filtered, and only that.** One request to
  `JEV_API_BASE` per red gate: the question, the criteria, and the last
  `JEV_OPINION_MAX_EVIDENCE_CHARS` characters of `validation.md`, which is the
  failing check's recorded output tail. Before the cut, recognisable secrets are
  replaced with a marker: the value of every secret-named variable in the
  script's environment (the classifier key among them), private-key blocks,
  `Authorization` and bearer credentials, the user and password in a URL, values
  assigned to secret-named keys, and well-known token formats. A path given as
  evidence must be a regular file inside the run's artifacts directory, never a
  link and never a secret-shaped name; the secret-path vocabulary is the scout's
  `isSecretPath`, and there is no second list. The filter is a filter: a
  credential in a shape it does not describe is sent as it is. Where that
  matters, leave the opinion off or point `JEV_API_BASE` at a service you host.
  Neither the evidence nor the key is ever printed.

Every fixture that reaches `failure-class` stubs it. A fixture run inherits the
operator's environment, key included, so an unstubbed one would send its log to
the live classifier. `second-opinion-script.test.ts` is what proves the authored
node reaches its script: it builds the node's environment from the workflow
file's own `with:` values and runs the real wrapper against a local stand-in.

[`.shared/jev-settings.ts`](.shared/jev-settings.ts) reads the key, the endpoint,
the model and the switches for both this and the scout, so the defaults have one
owner.

### What is measured, and what is not

`bun run second-opinion-eval` asks the workflow's own question about seeded
failure logs of every class, across several languages and test runners, and
reports accuracy overall and per class, the confusion matrix, mean confidence
and characters sent. It passes at or above its accuracy floor (`ACCURACY_FLOOR`
in the script) with no log labelled as a dependency or environment failure
classified as a code defect, which is the one mistake that sends an agent to
edit code that was never wrong. It calls the real
classifier, so it needs `JEV_API_KEY` and is not part of the test suite; `--dry`
answers from the answer key and sends nothing. See
[`scripts/second-opinion-eval.ts`](../../../scripts/second-opinion-eval.ts).

That measures whether the classifier names the right kind of failure. It does
not measure whether an agent that is handed the opinion makes fewer unnecessary
edits, and no unit test or classifier evaluation can: that is a property of
whole runs. To measure it, run paired workflows by hand:

1. Prepare a small repository with a passing gate, and four or more seeded
   reds that need no code change: a port another process holds, a database that
   is down, a lockfile out of step with its manifest, a test that fails one run
   in five. Add as many seeded real defects, so that "never edit" is not the
   winning strategy.
2. For each seed, start two runs of a workflow that validates and then corrects
   (`archon-deliver` from the same starting commit), one with
   `JEV_OPINION_ENABLED=0` and one with the opinion on. Repeat each pair at
   least three times; agent runs vary.
3. For each run record: the `red_cause` validation declared and whether it
   matches the seed; the files the correction step changed (`git diff --stat`
   against the starting commit); and whether the gate was green afterwards.
4. Count an edit as unnecessary when the seed needed no code change and the run
   changed code anyway. Compare that count, and the count of real defects left
   unfixed, between the two arms.

A lower unnecessary-edit count with no rise in unfixed defects is the result the
checkpoint is for. Until those runs are done, the claim is unproven.

## Evidence never carries credentials

The engine retains what every exec node prints, so a node's output is the record
whether it set out to keep one or not. Never print a value that can contain a
secret: read it where it is normalized and pass on the normalized form. A remote
URL is the common one — `https://<token>@host/repo` is a perfectly ordinary origin
— so the ready flip normalizes `owner/repo` inside the substitution that reads the
remote, and only that reaches a command line. Failure messages are the same
surface: interpolating the raw value into one leaks it just as effectively.

That retention is also why a node does not need its own log. The ready flip once
wrote one by hand — every command it ran, echoed into an artifact — which is what
the transcript now holds for free.

## The engineering-conventions sidecar

A repository may declare its engineering conventions in an `engineering.md`
(root, or a config directory such as `.archon/`). Prompts that write code read
it before coding — `implement` carries the line today — the same way any
workflow may read a repository's direction sidecar. The check is conditional on
the file existing, so the pack stays portable: a repository without one loses
nothing. A new pack workflow that writes code carries the same line.

## A node's streams are the operator's channel

Retention is not the only reader. Anything a node writes to stderr is sent to the
operator as the run happens, even when the node succeeds — and that copy is not
redacted. So a node speaks for itself: capture what the commands inside it print,
and let only your own authored messages reach the streams. Re-emit a command's
output when it failed and its words are the diagnostic; drop it when it is just a
tool narrating itself. Capture a value's stderr separately rather than merging it,
too — a `gh` update notice merged into a read becomes the value.

## Composition validation

[archon-validate](validate/README.md) accepts an explicit composition request to run
the same project gate on two pinned parts and their composed tree. Its `interaction`
result remains red; delivery holds it rather than treating it as inherited or
environmental. The report retains revision, tree and check evidence for an existing
merger to consume. It does not install a queue or authorize a merge.
