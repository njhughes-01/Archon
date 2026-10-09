/**
 * The one place a `bun test` invocation is assembled, so the per-test budget has one owner.
 *
 * On Windows the budget is 20 s instead of Bun's 5 s default. This is an attributed
 * runner-floor residual, not headroom for slow tests: on the 4-vCPU `windows-latest` VM the
 * suite's several hundred child processes periodically saturate the CPUs and the OS disk
 * (sometimes together with Windows' own background maintenance), and any spawn issued in
 * such a second can take 5 to 15 s regardless of which test issued it. Fifty instrumented
 * runs found no per-test, per-package, disk-layout or service-level change that removes
 * the class; the attribution is on coleam00/Archon#3294. A test with its own explicit
 * budget keeps it: `--timeout` only sets the default.
 */
export const WINDOWS_TEST_TIMEOUT_MS = 20_000;

export function bunTestCommand(
  selectors: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const budget = platform === 'win32' ? ['--timeout', String(WINDOWS_TEST_TIMEOUT_MS)] : [];
  return ['bun', 'test', ...budget, ...selectors];
}

/**
 * Environment for a `bun test` process. Tests never send telemetry: a test that
 * starts a real CLI or engine with a temp `ARCHON_HOME` would otherwise mint a
 * fresh install id per run and report it as a real install. A test that covers
 * telemetry itself re-enables it by setting the variable in its own child env.
 *
 * Tests never call the model router's classifier either. A test that runs a workflow
 * in-process with the router configured would otherwise send its prompts to the live
 * service whenever the developer's shell has a `JEV_API_KEY`. Forced rather than defaulted,
 * because an inherited `JEV_ROUTER_ENABLED=1` must not win. It is the router's own switch,
 * not `JEV_ENABLED`, so other Jev features' tests keep whatever they set. A test that
 * covers routing lifts the switch in-process and fakes the HTTP call.
 */
export function bunTestEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    ARCHON_TELEMETRY_DISABLED: env.ARCHON_TELEMETRY_DISABLED ?? '1',
    JEV_ROUTER_ENABLED: '0',
  };
}
