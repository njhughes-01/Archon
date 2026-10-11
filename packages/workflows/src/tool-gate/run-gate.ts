/**
 * The gate as one run uses it: built once where the run starts, then asked for
 * one callback per step.
 *
 * This is the only place that reads the switch and the classifier settings,
 * so the workflow executor and direct chat turn the same config and
 * environment into the same gate. A run holds one classifier cache; each
 * attempt of a step holds its own denial count.
 */
import { access, chmod, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProviderCapabilities } from '@archon/providers/types';
import { MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS, type WorkflowConfig } from '../deps';
import type { Fetch } from '../jev/jev-client';
import type { IWorkflowStore } from '../store';
import type { ToolGateConfig } from './config';
import { createJevEscalator, readToolGateJevSettings } from './escalate-jev';
import {
  createToolGate,
  createToolGateCache,
  type ToolGate,
  type ToolGateDecisionEvent,
  type ToolGateEscalator,
} from './gate';
import { collectCredentialValues } from './credential-values';
import { DEFAULT_PROTECTED_BRANCHES, DEFAULT_VERIFICATION_COMMANDS } from './rules';

/**
 * How an operator turns the gate off. There is one switch for the install and
 * one a repository can add; neither is per provider or per run.
 */
const OFF_SWITCH =
  'switch the gate off: set `toolGate.enabled: false` in ~/.archon/config.yaml, and remove ' +
  "`toolGate.enabled: true` from the repository's .archon/config.yaml if it is set there";

export interface RunToolGateInput {
  /** The merged `toolGate:` config. Absent or not enabled: there is no gate. */
  config: ToolGateConfig | undefined;
  /** Where the classifier's `JEV_*` settings are read from. */
  env: Readonly<Record<string, string | undefined>>;
  /** The checkout the steps work in. */
  repoRoot: string;
  /** Directories outside the checkout the steps may also write into. */
  extraWriteRoots?: readonly string[];
  /** Paths no step may write, move, remove or print. */
  protectedPaths?: readonly string[];
  /** Exact credential values the engine knows it handed to the steps. */
  credentialValues: readonly string[];
  /** The branch the work is based on. Protected along with the configured ones. */
  baseBranch?: string;
  /** Whether the steps' tools run inside a container instead of on this host. */
  inContainer?: boolean;
  /** See `ToolGateOptions.outsideRootAdvice`. */
  outsideRootAdvice?: string;
  /**
   * Receives every decision with the step it was made for. A promise it returns
   * is waited for before the call is answered; a throw or a rejection denies
   * the call. See `ToolGateOptions.record`.
   */
  record: (event: ToolGateDecisionEvent, step: string) => void | Promise<void>;
  /** Replaces the network for the classifier. Tests inject it. */
  fetch?: Fetch;
}

export interface RunToolGate {
  /**
   * A new callback for one attempt of a step, on the run's shared classifier
   * cache. Each call starts a denial count at zero and trusts the working
   * directory its requests report, so the caller asks again for every retry
   * attempt and every loop iteration: what one attempt was refused, or where
   * its shell went, says nothing about the next.
   */
  forStep(step: string): ToolGate;
}

/** Never asked: the gate does not call the classifier when none is configured. */
const noClassifier: ToolGateEscalator = () =>
  Promise.resolve({ ok: false, reason: 'not_configured' });

/**
 * Builds the gate for one run, or `undefined` when the gate is off.
 *
 * Throws when the gate is on and cannot do its job here: a container run, an
 * unusable classifier setting, a root that cannot be resolved. A gate that is
 * on must judge every call or stop the run; it never quietly stands down.
 */
export function createRunToolGate(input: RunToolGateInput): RunToolGate | undefined {
  if (input.config?.enabled !== true) return undefined;
  const config = input.config;

  if (input.inContainer === true) {
    // The gate resolves each path a call names on this host, and a container's
    // paths are not this host's: it would misplace every one of them.
    throw new Error(
      'The tool gate is on, but this run runs in a container, and the gate resolves each path ' +
        "a tool call names on the host: a container's paths are not the host's, so it cannot " +
        'judge them yet. Run it on the host (without --container or container.enabled), or ' +
        `${OFF_SWITCH}.`
    );
  }

  const jev = readToolGateJevSettings(input.env);
  if (jev.status === 'invalid') {
    throw new Error(
      `The tool gate is on, but its classifier setting ${jev.variable} ${jev.problem}. ` +
        'Fix or unset the variable.'
    );
  }

  const cache = createToolGateCache();
  const escalate =
    jev.status === 'on' ? createJevEscalator(jev.settings, { fetch: input.fetch }) : noClassifier;
  const baseBranch = input.baseBranch?.trim() ?? '';
  const protectedBranches = [
    ...new Set([
      ...DEFAULT_PROTECTED_BRANCHES,
      ...config.protectedBranches,
      ...(baseBranch === '' ? [] : [baseBranch]),
    ]),
  ];
  const verificationCommands = [
    ...new Set([...DEFAULT_VERIFICATION_COMMANDS, ...config.verificationCommands]),
  ];

  const forStep = (step: string): ToolGate =>
    createToolGate({
      repoRoot: input.repoRoot,
      extraWriteRoots: input.extraWriteRoots,
      protectedPaths: input.protectedPaths,
      classifierConfigured: jev.status === 'on',
      escalate,
      // Returned, not only called: the gate waits for a sink that is still writing.
      record: event => input.record(event, step),
      protectedBranches,
      verificationCommands,
      credentialValues: input.credentialValues,
      outsideRootAdvice: input.outsideRootAdvice,
      ...(jev.status === 'on' && { thresholds: jev.settings.thresholds }),
      cache,
    });

  // Built once and discarded: a root or threshold the gate refuses then stops
  // the run here, before its first step, instead of at that step's first tool call.
  forStep('');
  return { forStep };
}

let emptyRoot: string | undefined;

/**
 * A private, empty, read-only directory to root a gate at when the work has no
 * checkout of its own. Everything else is then outside the root: every write is
 * denied by rule, and a shell call from any other directory is flagged.
 *
 * One per process, under the system temp directory and readable only by this
 * user. Made again if something removed it.
 */
export async function emptyToolGateRoot(): Promise<string> {
  if (emptyRoot !== undefined) {
    try {
      await access(emptyRoot);
      return emptyRoot;
    } catch {
      // Removed since it was made (a temp cleaner, a reboot): make another.
    }
  }
  const created = await realpath(await mkdtemp(join(tmpdir(), 'archon-tool-gate-empty-')));
  await chmod(created, 0o500);
  emptyRoot = created;
  return created;
}

/**
 * Whether a provider may run a step under this config: always when the gate is
 * off, and only with the `toolActionGate` capability when it is on. The
 * question a caller choosing between providers asks before it picks one.
 */
export function providerHonoursToolGate(
  config: ToolGateConfig | undefined,
  capabilities: Pick<ProviderCapabilities, 'toolActionGate'>
): boolean {
  return config?.enabled !== true || capabilities.toolActionGate === true;
}

/**
 * The same question as a predicate over provider names, for a caller that picks
 * among providers (the model router): with the gate on, a provider that could
 * not be checked is never offered, so a step is not routed to one that dispatch
 * would then refuse.
 */
export function providersUsableUnderToolGate(
  config: ToolGateConfig | undefined,
  capabilitiesOf: (provider: string) => Pick<ProviderCapabilities, 'toolActionGate'>
): (provider: string) => boolean {
  return provider => providerHonoursToolGate(config, capabilitiesOf(provider));
}

/**
 * Refuses a provider that would run tools without asking while the gate is on.
 * Called where a step is dispatched, with the provider it resolved to.
 */
export function assertProviderHonoursToolGate(
  config: ToolGateConfig | undefined,
  provider: string,
  capabilities: Pick<ProviderCapabilities, 'toolActionGate'>
): void {
  if (providerHonoursToolGate(config, capabilities)) return;
  throw new Error(
    `The tool gate is on, but provider '${provider}' cannot ask it before running a tool ` +
      '(toolActionGate capability), so its tool calls would run unchecked. Either run this on a ' +
      'provider that supports the gate (the "Tool action gate" row of the provider capability ' +
      `matrix), or, to run on '${provider}' without the gate, ${OFF_SWITCH}.`
  );
}

/**
 * The audit sink for a workflow run: one `tool_gate_decision` event per
 * decision, on the step that asked, carrying the decision record as it is.
 *
 * Unlike the run's other observability events this write is not best-effort:
 * a call may not run without its record. So it goes through the store's
 * `persistWorkflowEvent`, which reports a failed write, and never through
 * `createWorkflowEvent`, which by contract swallows one. The write's promise is
 * handed back for the gate to wait on; when it rejects the gate denies the
 * call and logs the failure. Nothing is caught or logged here, which would
 * hide the failure from the gate and log it twice.
 */
export function workflowToolGateRecorder(
  store: Pick<IWorkflowStore, 'persistWorkflowEvent'>,
  workflowRunId: string
): RunToolGateInput['record'] {
  return (event, step) =>
    store.persistWorkflowEvent({
      workflow_run_id: workflowRunId,
      event_type: 'tool_gate_decision',
      step_name: step,
      data: { ...event },
    });
}

export interface WorkflowRunToolGateInput {
  config: Pick<
    WorkflowConfig,
    'toolGate' | 'envVars' | 'protectedEnvKeys' | 'protectedCredentialValues'
  >;
  store: Pick<IWorkflowStore, 'persistWorkflowEvent'>;
  workflowRunId: string;
  /** The checkout the run's nodes work in. */
  cwd: string;
  /** `$ARTIFACTS_DIR` of the run. */
  artifactsDir: string;
  /** `$STATE_DIR` of the project. */
  stateDir: string;
  baseBranch: string;
  inContainer: boolean;
  /** The engine's own environment. Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The gate for one workflow run, or `undefined` when the gate is off.
 *
 * The run's artifacts directory and the project's state directory are the only
 * places outside the checkout a node may write. Everything else outside stays
 * denied, `/tmp` included. So does the log directory: it is one directory for
 * every run of the project and holds the engine's own transcripts of them. The
 * provider homes the engine delivers credentials into sit inside the artifacts
 * directory, so they are named as protected.
 */
export function createWorkflowRunToolGate(
  input: WorkflowRunToolGateInput
): RunToolGate | undefined {
  if (input.config.toolGate?.enabled !== true) return undefined;
  const env = input.env ?? process.env;
  return createRunToolGate({
    config: input.config.toolGate,
    env,
    repoRoot: input.cwd,
    extraWriteRoots: [input.artifactsDir, input.stateDir],
    protectedPaths: [
      ...new Set(
        MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS.map(path =>
          join(input.artifactsDir, dirname(path))
        )
      ),
    ],
    // What a node's tools can see: the engine's environment with the run's own on top.
    credentialValues: collectCredentialValues(
      { ...env, ...input.config.envVars },
      input.config.protectedEnvKeys,
      input.config.protectedCredentialValues
    ),
    baseBranch: input.baseBranch,
    inContainer: input.inContainer,
    record: workflowToolGateRecorder(input.store, input.workflowRunId),
  });
}
