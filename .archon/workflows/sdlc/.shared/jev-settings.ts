/**
 * Whether a Jev-backed feature of this pack may reach the classifier, and where it is.
 *
 * Every such feature answers this the same way, so the key, the endpoint, the model and
 * the two kinds of switch are read here once. What a feature does with the answer, and
 * every setting of its own, stays in the feature's module.
 */

const DEFAULT_API_BASE = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-1.13.0';

/** Where the classifier is and how a request is authorised. */
export interface JevAccess {
  apiKey: string;
  apiBase: string;
  model: string;
}

export type JevAvailability =
  | { available: true; access: JevAccess }
  | { available: false; reason: 'disabled' | 'no_api_key' };

function switchedOff(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === '0' || flag === 'false';
}

/**
 * On when `JEV_API_KEY` is set, unless `JEV_ENABLED` (everything Jev) or the feature's own
 * switch is `0` or `false`. A switch wins over a missing key, so a feature that is turned
 * off says so whether or not a key is present.
 *
 * A container run does not inherit the host's environment, so there every feature is off
 * unless the project's own environment supplies the key.
 *
 * @param featureSwitch The value of the feature's own switch, e.g. `env.JEV_SCOUT_ENABLED`.
 */
export function readJevAccess(
  env: NodeJS.ProcessEnv,
  featureSwitch: string | undefined
): JevAvailability {
  if (switchedOff(env.JEV_ENABLED) || switchedOff(featureSwitch)) {
    return { available: false, reason: 'disabled' };
  }
  const apiKey = env.JEV_API_KEY?.trim() ?? '';
  if (apiKey === '') return { available: false, reason: 'no_api_key' };
  return {
    available: true,
    access: {
      apiKey,
      apiBase: env.JEV_API_BASE?.trim() || DEFAULT_API_BASE,
      model: env.JEV_MODEL?.trim() || DEFAULT_MODEL,
    },
  };
}
