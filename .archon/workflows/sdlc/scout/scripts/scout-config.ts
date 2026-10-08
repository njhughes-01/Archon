/**
 * Whether the context scout can run here: a key is present and no switch turns it off.
 *
 * It runs before the agent that writes the scout's question, so an install with no
 * classifier spends no AI turn on a question nothing will answer. That is the normal case,
 * so it is reported in the result alone and never on stderr; only the reason is printed,
 * never a setting's value.
 */
import { readScoutSettings } from '../../.shared/context-scout.ts';
import { emit } from '../../.shared/io.ts';

const read = readScoutSettings(process.env);
emit({ available: read.available, reason: read.available ? '' : read.reason });
