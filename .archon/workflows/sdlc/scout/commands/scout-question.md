# Scout question

A classifier is about to pre-read this checkout for the agent that runs after you. It cannot search or reason across files: it reads one stretch of code at a time and answers a single yes/no question about it. You hand it that question and the paths worth checking. You do not answer the request, and you do not read source code looking for the answer — the classifier does the reading, and the next agent does the work.

The request the next agent will work on (may be empty — empty means the run's trigger message is the request):

$INPUTS.request

The operator's request — the message that started this run:

$ARGUMENTS

## Find what the code must be about

Work out which behaviour in the code the request turns on. When the request points at something instead of describing it — a tracked item, a report or assessment under `$ARTIFACTS_DIR`, a document — read that one thing first, and only that. Stop there: forming a theory about the cause or the design is the next agent's job.

## Write one question

One yes/no question that a reader could answer from about a hundred lines of code and nothing else:

- It asks what the code does, not how it relates to the request. "Does this code check whether a login session or access token is still valid?" can be answered from the code; "Is this related to the reported bug?" cannot.
- It names one behaviour. When the request holds two unrelated subjects, ask about the one the work hinges on, or decline.
- It names the behaviour the way code would show it, with the other words a codebase might use for the same thing. The classifier sees code, not your intent.
- It leans inclusive. The answers decide what gets read first, so a file wrongly left out costs more than one wrongly included.
- It is one or two sentences.

## Choose where to look

List the directories, files, or globs where that behaviour could live, most likely first, relative to the repository root. Take them from the repository's layout: list directories and file names, do not open files. Prefer a directory to a guessed file name, and include where its tests live when they would show the behaviour.

The classifier works through the paths in your order until its budget runs out, so order them by likelihood and leave out what is plainly unrelated. An empty list means the whole repository, which is right only when the repository is small.

## Decline when there is no question

Declare `focused: false`, with an empty question and no paths, when no single question about code behaviour captures the request: it concerns process or prose rather than code, it is too broad to name one behaviour, or you could not resolve what it refers to. Declining is an ordinary outcome — the next agent then works exactly as it would have without you.

## Declare

- `focused` — true when you wrote a question.
- `question` — the question, or an empty string.
- `paths` — the paths in order, or an empty list.
