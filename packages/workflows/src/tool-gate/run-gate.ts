/**
 * The gate as one run uses it: built once where the run starts, then asked for
 * one callback per step.
 *
 * This is the only place that reads the switch and the classifier settings,
 * so the workflow executor and direct chat turn the same config and
 * environment into the same gate. A run holds one classifier cache; a step
 * holds its own denial count.
 */
import { dirname, join } from 'node:path';
import { createLogger } from '@archon/paths';
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

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.tool-gate');
  return cachedLog;
}

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
  /** Receives every decision with the step it was made for. A throw fails the tool call. */
  record: (event: ToolGateDecisionEvent, step: string) => void;
  /** Replaces the network for the classifier. Tests inject it. */
  fetch?: Fetch;
}

export interface RunToolGate {
  /** The callback for one step: its own denial count, the run's shared classifier cache. */
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
      'The tool gate is on, but this run executes in a container, where the gate cannot yet ' +
        `resolve the paths a tool call names. Run without the container backend, or ${OFF_SWITCH}.`
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
      record: event => {
        input.record(event, step);
      },
      protectedBranches,
      verificationCommands,
      credentialValues: input.credentialValues,
      ...(jev.status === 'on' && { thresholds: jev.settings.thresholds }),
      cache,
    });

  // Built once and discarded: a root or threshold the gate refuses then stops
  // the run here, before its first step, instead of at that step's first tool call.
  forStep('');
  return { forStep };
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
  if (config?.enabled !== true || capabilities.toolActionGate === true) return;
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
 * The write is best-effort like every other observability event. A store that
 * cannot take it is logged with the decision's own fields, so the record is
 * not lost with the write.
 */
export function workflowToolGateRecorder(
  store: Pick<IWorkflowStore, 'createWorkflowEvent'>,
  workflowRunId: string
): RunToolGateInput['record'] {
  return (event, step) => {
    store
      .createWorkflowEvent({
        workflow_run_id: workflowRunId,
        event_type: 'tool_gate_decision',
        step_name: step,
        data: { ...event },
      })
      .catch((err: unknown) => {
        getLog().error(
          { err, workflowRunId, step, eventType: 'tool_gate_decision', decision: event },
          'workflow_event_persist_failed'
        );
      });
  };
}

export interface WorkflowRunToolGateInput {
  config: Pick<
    WorkflowConfig,
    'toolGate' | 'envVars' | 'protectedEnvKeys' | 'protectedCredentialValues'
  >;
  store: Pick<IWorkflowStore, 'createWorkflowEvent'>;
  workflowRunId: string;
  /** The checkout the run's nodes work in. */
  cwd: string;
  /** `$ARTIFACTS_DIR` of the run. */
  artifactsDir: string;
  /** `$STATE_DIR` of the project. */
  stateDir: string;
  /** `LOG_DIR` of the run. */
  logDir: string;
  baseBranch: string;
  inContainer: boolean;
  /** The engine's own environment. Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The gate for one workflow run, or `undefined` when the gate is off.
 *
 * The directories the engine hands a node through its environment
 * (`ARTIFACTS_DIR`, `STATE_DIR`, `LOG_DIR`) are the only places outside the
 * checkout it may write. Everything else outside, `/tmp` included, stays
 * denied. The provider homes the engine delivers credentials into sit inside
 * the artifacts directory, so they are named as protected.
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
    extraWriteRoots: [input.artifactsDir, input.stateDir, input.logDir],
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
