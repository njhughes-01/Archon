# Classify a red gate

The project's gate ran and a check failed. `$ARTIFACTS_DIR/validation.md` is the record: every check that ran, its exit status, the failing check's output tail, and the path of each check's full output log. Decide why the failed check failed. You fix nothing, re-run nothing to make it pass, and change nothing in the checkout.

## Declare

- `red_cause` — why the gate is red:
  - `introduced` — the change under validation caused the failure.
  - `inherited` — the same check was already failing at the base this branch came from.
  - `environment` — the machine caused it, not any code: a database or port a parallel process holds, a missing credential, a network fault, a process killed for memory.
- `summary` — a few sentences: the failing check by name, what failed in it, and the evidence for the cause. A fixer reads this first.

## Evidence

Classifying red never makes it green. But `inherited` and `environment` let delivery continue, so neither is the comfortable answer: declaring one commits you to evidence. Name the exact failing check and the concrete reason the change under validation cannot have caused it — the same failure on the exact base revision, or a resource another process demonstrably holds. Disjoint changed paths alone do not prove independence; a check can read a path another change moves. `$ARTIFACTS_DIR/implementation.md` may already record the same red; corroborate it against the recorded output rather than repeating it. Without that evidence the cause is `introduced`.

To show a failure is inherited, reproduce the narrowest failing piece — the single failing test or file, not the whole gate — at the base revision, in a separate temporary worktree that you remove afterwards. Never check out another revision in the run's own checkout. If you cannot reproduce it at the base, the cause is `introduced`.

## Second opinion

Before you started, a classifier may have read the end of `validation.md` and sorted the failure into one of four kinds. Its result:

$INPUTS.opinion

When `status` is `unavailable`, no opinion was given — the usual case. Skip this section and work as you otherwise would.

When `status` is `ok`, `choice` is the kind it picked, `probabilities` is how it spread its answer over the four, and `confidence` is how concentrated that spread is:

- `code_defect` — the project's code, or a test of it, is wrong and fails the same way every run.
- `flaky_test` — the outcome depends on timing or order, not on the code.
- `dependency_failure` — a third-party package is missing, mismatched or broken.
- `environment_failure` — the machine or its surroundings stopped the check.

It is a hypothesis to check first, and nothing more:

- Start by testing it. Open the failing check's output and look for what a failure of that kind would show. The classifier saw only a bounded tail of the record with secrets removed — not the full log, not the diff, not the base revision — and it can be wrong.
- It names the kind of failure, not who caused it, so no choice settles `red_cause`. `environment_failure` is not evidence for `environment`. `flaky_test` and `dependency_failure` have no cause of their own: a dependency this change bumped is `introduced`, a registry that is down is `environment`, and a test that fails intermittently is `introduced` until the Evidence section's bar is met. `code_defect` does not tell `introduced` from `inherited`.
- The Evidence section governs unchanged. The opinion never stands in for the evidence it requires, and without that evidence the cause is `introduced`.
- A high `confidence` is not proof. It measures how sure the classifier sounded, not whether it is right.
- Record what you found. When an opinion was given, `summary` carries one sentence naming the kind the classifier chose and whether the log confirmed or contradicted it, so whoever acts on this red knows the opinion was checked and how it came out. When the log contradicts it, the log wins: say what in the log shows otherwise. When `status` is `unavailable`, `summary` says nothing about a second opinion.
