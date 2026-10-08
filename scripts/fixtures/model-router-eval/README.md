# Model router evaluation set

`cases.jsonl` is the labelled set `scripts/model-router-eval.ts` scores the cost-aware
model router against. One JSON object per line:

| Field | Meaning |
| --- | --- |
| `id` | Unique name for the case. Reports print this, never the task. |
| `node` | A command the SDLC pack ships. The runner reads its text from the pack. |
| `task` | What the run was asked to do. Synthetic, but shaped like a real request. |
| `features` | What the pack's own step declares in its workflow file: `has_output_format`, `tools_declared`, `mcp_present`, `skills_present`, `mutates_checkout`. |
| `label_min_tier` | The lowest tier (`small`, `medium`, `large`) a person judged sufficient for this step on this task. |
| `kind` | `extraction`, `mechanical`, `implementation`, `architecture` or `high_risk`. |
| `split` | `tuning`, `heldout` or `heldout2`. The first two halve the original set, each kind divided evenly; they share their commands. `heldout2` was written later from commands and phrasings the tuning half does not contain. |

## How to label

Ask: on this task, would a careful reviewer accept this step's output from the tier below?
If yes, the label is the lower tier. When in doubt, label higher: the evaluation fails on
any case routed below its label, so a generous label is the safe mistake.

- `extraction` and `mechanical` cases are labelled `small`.
- A step that works out the scope or contract later steps are judged against is not
  routine, even when its instructions say it judges nothing: an item it drops narrows every
  later step, and nothing in its output shows the gap.
- `architecture` and `high_risk` cases are labelled `large`, whatever the step: a routine
  step on a task that touches authentication, schemas, deletion, credentials, money or
  production state is not routine.
- Keep the three groups (routine, ordinary, complex) at about a third each.

## Two questions, two runs

The plain run asks about every case, on one stand-in provider that can run anything, and
gives every stand-in step an output contract. It measures one thing: whether the classifier
agrees with the labels. It says nothing about which steps can actually move.

`--map <tier-map>` asks the other question. Each case stands for its command's real step in
the pack, on real providers, and is classified only if the router would ask about that step
on that map. `--lowerable <tier-map>` lists every step of the pack with the reason it can
or cannot be lowered, and calls no classifier. Keep the two results apart: a classifier
that agrees with every label still saves nothing on a map where few steps can move.

## Tuning and held-out halves

Change the router's questions, criteria or thresholds against the `tuning` half only
(`--split tuning`), then run the whole set once: the report scores each half beside the
whole. A change that only fits the cases it was tuned on shows up as a gap between the
halves. Looking at a held-out result and then changing wording spends that half's
independence; say so when it happens, and add fresh cases when it has happened often.

When a case fails, first ask whether the label follows the rules above. If it does not,
fix the label and record why in the commit. Never reword a question around one case id.

The labels are one person's judgement. A pass says the router agrees with them; it does
not measure output quality. Real-workload evidence comes from the routes recorded in
shadow mode and from paired runs of the same step on both tiers.
