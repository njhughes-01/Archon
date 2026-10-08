# Context scout evaluation fixture

A small synthetic repository for measuring the context scout against a real
classifier. `repo/` holds authentication-validation code in seven files and six
languages, one of them buried in the middle of a long utility file, among
fourteen decoys. Several decoys share vocabulary with the real thing on purpose:
a login form that validates nothing, a `SessionCache` for shopping carts, a
`TokenBucket` rate limiter, a search `Tokenizer`, an invoice validator.

`answer-key.json` holds the question and the files a correct scout selects.
Every other file under `repo/` is a decoy. A path in the key that is not a
tracked file fails the run, so the key cannot drift from the repository.

Run it with `bun run scout-eval` from the repository root; `--dry` replaces the
classifier with the answer key and needs no key or network. See
`scripts/context-scout-eval.ts`.

Nothing here is real code or a real credential, and no file is named like a
test, so the repository's own test, lint and type-check runs pass over it.
