/**
 * Ask the classifier which kind of failure a red gate's record shows, and print the
 * opinion.
 *
 * Always exits 0 with a valid result: `unavailable` is a result, not a failure, and the
 * agent that follows reads it and carries on. An opinion that could have been given and
 * was not is also named on stderr, which reaches the operator as the run happens. Being
 * switched off or having no key is the ordinary state of an install and says nothing
 * there. The record and the key never reach either stream.
 */
import { emit, note, text } from '../../.shared/io.ts';
import { askSecondOpinion, parseChoices } from '../../.shared/second-opinion.ts';

/** Off by configuration: the operator chose it, so there is nothing to tell them. */
const OFF = ['no_api_key', 'disabled'];

const opinion = await askSecondOpinion({
  question: text(process.env.INPUTS_QUESTION),
  choices: parseChoices(text(process.env.INPUTS_CHOICES)),
  evidence: { path: text(process.env.INPUTS_EVIDENCE_PATH) },
  env: process.env,
});
if (opinion.status !== 'ok' && !OFF.includes(opinion.reason)) {
  note(`failure-class: unavailable (${opinion.reason})`);
}
emit(opinion);
