/**
 * Run follow-up: a chat whose AI starts a workflow run is told when that run finishes or
 * needs someone.
 *
 * Core owns the vocabulary — the registry, the env var, and the text — and stays
 * platform-agnostic. The host decides which platform types get follow-ups and drives
 * delivery; with no platform enabled, nothing on any path changes.
 */
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import type {
  RunTerminalStatus,
  WorkflowRun,
  WorkflowRunOutcome,
} from '@archon/workflows/schemas/workflow-run';
import { formatPausedGateSection, type PausedGateContext } from '../orchestrator/prompt-builder';
import type { NonTerminalWorkflowRunStatus } from './run-attention-watch';

const followUpPlatforms = new Set<string>();

export function enableRunFollowUp(platformType: string): void {
  followUpPlatforms.add(platformType);
}

export function disableRunFollowUp(platformType: string): void {
  followUpPlatforms.delete(platformType);
}

export function isRunFollowUpEnabled(platformType: string): boolean {
  return followUpPlatforms.has(platformType);
}

/**
 * Carries the chat's database conversation id from a chat turn into the AI's shell, so
 * `archon workflow run` started there stamps the run for follow-up. The CLI deletes it
 * from its own environment on entry, so nothing the run spawns inherits it.
 */
export const RUN_FOLLOW_UP_CONVERSATION_ENV = 'ARCHON_FOLLOW_UP_CONVERSATION_ID';

/** System-prompt section for a chat turn on a platform with follow-up enabled. */
export const RUN_FOLLOW_UP_PROMPT_SECTION =
  '## Run follow-ups\n\n' +
  'Workflow runs you start from this chat (with `manage_run` or with `archon workflow run` in ' +
  'your shell) are followed up automatically: you will receive an automatic message in this ' +
  'chat when one finishes, fails or needs input. Do not poll, sleep or run ' +
  '`archon workflow wait` for them; just tell the user you will follow up.';

/** First line of every wake, so the AI and the stored transcript can tell it from a typed message. */
export const RUN_FOLLOW_UP_WAKE_MARKER = '[Archon run update — automatic, not typed by the user]';

// Approval gates are resolved only with the user's answer; an automatic turn has none.
const AUTOMATIC_TURN_RULE =
  'This is an automatic turn. Never approve, reject, respond to, resume, cancel or abandon a run in this turn ' +
  'unless the user already gave that exact decision in this chat. Otherwise put the decision to the user and stop.';

const REQUEST_EXCERPT_CHARS = 300;

/** What a followed-up run reached. `awaiting_response` carries the run that owns the gate. */
export type RunFollowUpEvent =
  | {
      kind: 'terminal';
      status: RunTerminalStatus;
      outcome: WorkflowRunOutcome | null;
      error: string | undefined;
    }
  | { kind: 'awaiting_response'; gateRun: PausedGateContext['run'] }
  | { kind: 'action_required'; message: string }
  | { kind: 'owner_lost'; observedStatus: NonTerminalWorkflowRunStatus }
  | { kind: 'unreadable'; detail: string };

export interface RunFollowUpInput {
  /** The top-level run the chat started. */
  run: Pick<WorkflowRun, 'id' | 'workflow_name' | 'user_message'>;
  event: RunFollowUpEvent;
  surface: WorkflowCommandSurface;
}

function describeEvent(event: RunFollowUpEvent): string {
  switch (event.kind) {
    case 'terminal':
      if (event.status === 'completed') {
        return event.outcome === 'failed' ? 'finished with outcome failed' : 'finished';
      }
      if (event.status === 'cancelled') return 'cancelled';
      return event.error ? `failed: ${event.error.split('\n')[0]}` : 'failed';
    case 'awaiting_response':
      return 'needs a decision';
    case 'action_required':
      return `needs an outside action: ${event.message}`;
    case 'owner_lost':
      return (
        `may have lost its process while still marked ${event.observedStatus}; ` +
        'check it and ask the user before abandoning or resuming it'
      );
    case 'unreadable':
      return `stuck: ${event.detail}`;
  }
}

function summarizeEvent(event: RunFollowUpEvent): string {
  switch (event.kind) {
    case 'terminal':
      if (event.status === 'completed') {
        return event.outcome === 'failed' ? 'has finished with outcome failed' : 'has finished';
      }
      return event.status === 'cancelled' ? 'was cancelled' : 'has failed';
    case 'awaiting_response':
      return 'is waiting for a decision';
    case 'action_required':
      return 'is waiting for an outside action';
    case 'owner_lost':
      return 'may have lost its process';
    case 'unreadable':
      return 'is stuck';
  }
}

/** The automatic message that wakes the chat's AI about a run it started. */
export function formatRunFollowUpWake(input: RunFollowUpInput): string {
  const { run, event } = input;
  const sections = [
    RUN_FOLLOW_UP_WAKE_MARKER,
    'A workflow run you started from this chat needs your attention.\n\n' +
      `- Run id: \`${run.id}\`\n` +
      `- Workflow: **${run.workflow_name}**\n` +
      `- What happened: ${describeEvent(event)}\n` +
      `- Original request: ${run.user_message.slice(0, REQUEST_EXCERPT_CHARS)}`,
    'Tell the user the result in plain words. For details use `manage_run get` ' +
      `(or \`archon workflow get ${run.id} --json\`). Then continue with what you said you would ` +
      'do next, and ask the user when a decision is theirs. If you already reported this result, ' +
      'just confirm it in one line.',
    AUTOMATIC_TURN_RULE,
  ];
  if (event.kind === 'awaiting_response') {
    sections.push(
      formatPausedGateSection({
        run: event.gateRun,
        agentCanResolve: true,
        surface: input.surface,
      })
    );
  }
  return sections.join('\n\n');
}

/** The short plain note sent instead of a wake when the chat was reset after the run started. */
export function formatRunFollowUpNote(input: RunFollowUpInput): string {
  const { run, event, surface } = input;
  return (
    `Run ${run.id.slice(0, 8)} (${run.workflow_name}) that this chat started ` +
    `${summarizeEvent(event)}. Details: ${spellWorkflowCommand(surface, 'status')}`
  );
}
