/**
 * Ask the classifier which kind of failure a red gate's record shows, and print the
 * opinion.
 *
 * Always exits 0 with a valid result: `unavailable` is a result, not a failure, and the
 * agent that follows reads it and carries on. An opinion that could have been given and
 * was not is also named on stderr, which reaches the operator as the run happens. Being
 * switched off or having no key is the ordinary state of an install and says nothing
 * there. The record and the key never reach either stream.
 *
 * The pack's modules are loaded inside the `try`, not imported at the top. The engine has
 * no optional node, so a script that failed to load would fail validation over an opinion
 * nobody had to have. A load error becomes an `unavailable` result like every other.
 */

// Nothing is imported at the top, so this is what makes the file a module.
export {};

/** Off by configuration: the operator chose it, so there is nothing to tell them. */
const OFF = ['no_api_key', 'disabled'];

try {
  const { emit, note, text } = await import('../../.shared/io.ts');
  const { askSecondOpinion, parseChoices } = await import('../../.shared/second-opinion.ts');
  const { recordedOutput } = await import('../../.shared/validation-record.ts');

  const opinion = await askSecondOpinion({
    question: text(process.env.INPUTS_QUESTION),
    choices: parseChoices(text(process.env.INPUTS_CHOICES)),
    evidence: { path: text(process.env.INPUTS_EVIDENCE_PATH) },
    // The record frames the failing check's output with headings, commands and paths.
    // Those say that a check failed; only the output can say why.
    judged: recordedOutput,
    env: process.env,
  });
  if (opinion.status !== 'ok' && !OFF.includes(opinion.reason)) {
    note(`failure-class: unavailable (${opinion.reason})`);
  }
  emit(opinion);
} catch (error) {
  // Nothing the pack exports can be trusted to have loaded, so this result is spelled
  // out here. A test certifies it against the node's schema. Only the error's class is
  // reported, because its message can quote a path or the record.
  const kind = error instanceof Error ? error.name : 'unknown';
  console.error(`failure-class: unavailable (load_error:${kind})`);
  console.log(
    JSON.stringify({
      status: 'unavailable',
      reason: `load_error:${kind}`,
      choice: null,
      probabilities: {},
      confidence: null,
      advisory: true,
    })
  );
}
