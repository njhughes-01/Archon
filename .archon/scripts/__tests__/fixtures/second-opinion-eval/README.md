# Second opinion evaluation fixture

Seeded failure logs for measuring the validate workflow's failure classification
against a real classifier. `logs/` holds at least ten logs for each class the
`failure-class` node offers, across JavaScript, TypeScript, Python, Go, Rust,
Ruby, Java and C# and their usual runners. They are `.txt` files because the
repository ignores `*.log`:

- code defects: assertions with expected and received values, type-checker and
  linter errors at the project's own lines, an exception thrown from the
  project's own function;
- timing- and order-dependent tests: a pass on retry, a failure under one random
  order, a run that crossed midnight, a sleep racing a timer, a bound on a random
  sample;
- dependency failures: a package that cannot be found or imported, a lockfile
  that disagrees with its manifest, a version that does not exist, versions that
  conflict, a native module built for another runtime;
- environment failures: a port in use, a refused connection, a missing
  environment variable, a full disk, a denied permission, a process killed for
  memory, an unreachable registry.

`answer-key.json` gives every log its class and one line saying why, so a label
can be audited without rereading the log. A log with no label, a label with no
log, and a class the workflow does not offer each fail the run before anything is
sent, so the key cannot drift from the directory or from the workflow.

Run it with `bun run second-opinion-eval` from the repository root; `--dry`
replaces the classifier with the answer key and needs no key or network. See
`scripts/second-opinion-eval.ts`.

## What these logs are and are not

Every log is at most sixty lines, the length of the output tail `validation.md`
records for a failing check, and each is sent whole as text. A real run sends the
tail of `validation.md` itself, which wraps that output in a few lines of
Markdown: the check's name, its command and its exit status. The evaluation does
not reproduce that wrapper.

A single failing run cannot show that a test is intermittent, so a log is only
classifiable as timing- or order-dependent when the log itself shows it. These do:
through a runner's retry output, a random seed, timestamps, or a line a wrapper
script printed about earlier runs. A real intermittent failure whose log shows
none of that reads as a code defect, to a classifier and to a person.

No log names its own class, and none contains a credential: the evaluation's
tests check that each is sent exactly as written, with nothing for the redaction
to remove. Nothing here is real output from a real project, and no file is named
like a test, so the repository's own test, lint and type-check runs pass over it.
