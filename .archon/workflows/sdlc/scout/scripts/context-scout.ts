/**
 * Ask the classifier one question about every candidate file and print the result.
 *
 * Always exits 0 with a valid result: `unavailable` is a result, not a failure, and the
 * agent that follows reads it and carries on. A result that is not `ok` is also named on
 * stderr, which reaches the operator as the run happens. File contents and the key never
 * reach either stream.
 */
import { runScout } from '../../.shared/context-scout.ts';
import { emit, note, text } from '../../.shared/io.ts';

const result = await runScout({
  question: text(process.env.INPUTS_QUESTION),
  paths: text(process.env.INPUTS_PATHS),
  cwd: process.cwd(),
  env: process.env,
});
if (result.status !== 'ok') note(`context-scout: ${result.status} (${result.reason})`);
emit(result);
