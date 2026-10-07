/**
 * Tell a chat when a workflow run its AI started finishes or needs someone.
 *
 * Each tick asks `waitForRunAttention` once about every run stamped with
 * `RUN_FOLLOW_UP_METADATA_KEY`, and wakes that chat's AI through the same locked
 * `handleMessage` path a typed message takes. Delivery is one `chat_follow_up_sent`
 * event on the run that needs attention, so a restart re-arms nothing and repeats
 * nothing. The service never writes run rows.
 */
import { handleMessage } from '@archon/core';
import type { ConversationLockManager, IPlatformAdapter } from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import * as sessionDb from '@archon/core/db/sessions';
import { toHydratedTimestamp } from '@archon/core/db/timestamps';
import * as workflowEventsDb from '@archon/core/db/workflow-events';
import * as workflowDb from '@archon/core/db/workflows';
import { waitForRunAttention } from '@archon/core/services/run-attention-watch';
import {
  formatRunFollowUpNote,
  formatRunFollowUpWake,
  isRunFollowUpEnabled,
  type RunFollowUpEvent,
  type RunFollowUpInput,
} from '@archon/core/services/run-follow-up';
import { RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS } from '@archon/core/services/run-live-owner';
import { getTriggerForCommand } from '@archon/core/state/session-transitions';
import { createLogger } from '@archon/paths';
import { readRunFollowUp, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';

const log = createLogger('run-follow-up');
const DEFAULT_INTERVAL_MS = 15_000;
const CANDIDATE_LIMIT = 200;
const ENDED_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RunFollowUpServiceOptions {
  /** Adapters by platform type; a chat whose platform is missing here is skipped. */
  platforms: ReadonlyMap<string, IPlatformAdapter>;
  lockManager: ConversationLockManager;
  intervalMs?: number;
}

/** What one stamped run needs, and the run the delivery mark belongs to. */
interface RunFollowUpCandidate {
  /** The top-level run the chat started. */
  run: WorkflowRun;
  /** The run that needs attention: a child run when the gate sits on the child. */
  ownerRunId: string;
  event: RunFollowUpEvent;
}

let followUpTimer: ReturnType<typeof setInterval> | undefined;
let tickInProgress = false;
// A one-shot attention check gets no control-handoff grace, so a run whose owner has
// not started yet, or is mid-resume, can look ownerless once. Report owner loss only
// when it is still observed after the grace period.
const ownerLostFirstSeen = new Map<string, number>();
// Owner runs with a wake queued behind a busy chat, so later ticks do not queue more.
const queuedWakes = new Set<string>();

/** One-shot attention for a stamped run, without the owner-loss confirmation. */
async function describeRun(run: WorkflowRun): Promise<RunFollowUpCandidate | undefined> {
  const result = await waitForRunAttention(run.id, { deadlineMs: 0 });
  if (result.kind === 'owner_lost') {
    return {
      run,
      ownerRunId: run.id,
      event: { kind: 'owner_lost', observedStatus: result.observedStatus },
    };
  }
  if (result.kind !== 'attention') return undefined;
  const attention = result.attention;
  switch (attention.kind) {
    case 'terminal': {
      // The candidate list is a snapshot; the outcome and error come from the row now.
      const ended = await workflowDb.getWorkflowRun(attention.runId);
      if (!ended) return undefined;
      const error = ended.metadata.error;
      return {
        run: ended,
        ownerRunId: ended.id,
        event: {
          kind: 'terminal',
          status: attention.status,
          outcome: ended.outcome,
          error: typeof error === 'string' && error.length > 0 ? error : undefined,
        },
      };
    }
    case 'awaiting_response': {
      const gateRun = await workflowDb.getWorkflowRun(attention.respondTo.runId);
      if (!gateRun) return undefined;
      return {
        run,
        ownerRunId: gateRun.id,
        event: { kind: 'awaiting_response', gateRun },
      };
    }
    case 'action_required':
      return {
        run,
        ownerRunId: attention.runId,
        event: { kind: 'action_required', message: attention.message },
      };
    case 'unreadable':
      return {
        run,
        ownerRunId: attention.runId,
        event: { kind: 'unreadable', detail: attention.detail },
      };
    case 'blocked_on_child':
      // waitForRunAttention follows child chains; it never returns this.
      return undefined;
  }
}

/** Apply the owner-loss confirmation to a fresh one-shot description. */
function confirmOwnerLoss(
  candidate: RunFollowUpCandidate | undefined,
  runId: string,
  now: number,
  intervalMs: number
): RunFollowUpCandidate | undefined {
  if (candidate?.event.kind !== 'owner_lost') {
    ownerLostFirstSeen.delete(runId);
    return candidate;
  }
  const firstSeen = ownerLostFirstSeen.get(runId);
  if (firstSeen === undefined) {
    ownerLostFirstSeen.set(runId, now);
    return undefined;
  }
  return now - firstSeen > RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS + intervalMs
    ? candidate
    : undefined;
}

/** Id of the owner run's current execution segment; a resume writes a newer one. */
async function currentSegment(ownerRunId: string): Promise<string | null> {
  const started = await workflowEventsDb.getLatestWorkflowEvent(ownerRunId, 'workflow_started');
  return started?.id ?? null;
}

async function alreadyFollowedUp(ownerRunId: string, segment: string | null): Promise<boolean> {
  const mark = await workflowEventsDb.getLatestWorkflowEvent(ownerRunId, 'chat_follow_up_sent');
  return mark !== null && mark.data.covers === segment;
}

async function writeMark(
  candidate: RunFollowUpCandidate,
  mode: 'wake' | 'note' | 'skipped',
  segment: string | null
): Promise<boolean> {
  try {
    await workflowEventsDb.persistWorkflowEvent({
      workflow_run_id: candidate.ownerRunId,
      event_type: 'chat_follow_up_sent',
      data: { mode, attention: candidate.event.kind, covers: segment },
    });
    return true;
  } catch (error) {
    log.error(
      { err: error as Error, runId: candidate.ownerRunId, mode },
      'run_follow_up.mark_failed'
    );
    return false;
  }
}

/** `/reset` already reports the runs it cancelled. */
async function cancelledByReset(candidate: RunFollowUpCandidate): Promise<boolean> {
  if (candidate.event.kind !== 'terminal' || candidate.event.status !== 'cancelled') return false;
  const cancelled = await workflowEventsDb.getLatestWorkflowEvent(
    candidate.run.id,
    'workflow_cancelled'
  );
  return cancelled?.data.cancel_reason === 'conversation_reset';
}

/** The session that started the run is gone, so a short note replaces the wake. */
async function chatResetSince(conversationId: string, since: Date): Promise<boolean> {
  const resetTrigger = getTriggerForCommand('reset');
  const sessions = await sessionDb.getSessionHistory(conversationId);
  return sessions.some(
    session =>
      session.ended_reason === resetTrigger &&
      session.ended_at !== null &&
      toHydratedTimestamp(session.ended_at) > toHydratedTimestamp(since)
  );
}

function queueWake(
  candidate: RunFollowUpCandidate,
  segment: string | null,
  adapter: IPlatformAdapter,
  chatId: string,
  lockManager: ConversationLockManager
): void {
  queuedWakes.add(candidate.ownerRunId);
  void lockManager.acquireLock(chatId, async () => {
    // Set once the mark is written: from then on this follow-up is never retried.
    let marked: RunFollowUpInput | undefined;
    try {
      // The chat may have been busy for a while: wake only for what is still true.
      const current = await describeRun(candidate.run);
      if (
        current?.event.kind !== candidate.event.kind ||
        current.ownerRunId !== candidate.ownerRunId ||
        (await currentSegment(candidate.ownerRunId)) !== segment ||
        (await alreadyFollowedUp(candidate.ownerRunId, segment))
      ) {
        return;
      }
      if (!(await writeMark(current, 'wake', segment))) return;
      const input: RunFollowUpInput = { run: current.run, event: current.event, surface: adapter };
      marked = input;
      await handleMessage(adapter, chatId, formatRunFollowUpWake(input), {
        isolationHints: { workflowType: 'thread', workflowId: chatId },
      });
      log.info(
        { runId: current.run.id, ownerRunId: current.ownerRunId, attention: current.event.kind },
        'run_follow_up.woke'
      );
    } catch (error) {
      log.error({ err: error as Error, runId: candidate.run.id }, 'run_follow_up.wake_failed');
      // The mark stands, so a failed wake would otherwise be the silence this service
      // exists to remove: tell the chat with the plain note instead.
      if (marked) {
        await adapter
          .sendMessage(chatId, formatRunFollowUpNote(marked))
          .catch((sendError: unknown) => {
            log.error(
              { err: sendError as Error, runId: candidate.run.id },
              'run_follow_up.wake_fallback_failed'
            );
          });
      }
    } finally {
      queuedWakes.delete(candidate.ownerRunId);
    }
  });
}

async function followUpRun(
  run: WorkflowRun,
  conversationId: string,
  options: RunFollowUpServiceOptions,
  now: number
): Promise<void> {
  const candidate = confirmOwnerLoss(
    await describeRun(run),
    run.id,
    now,
    options.intervalMs ?? DEFAULT_INTERVAL_MS
  );
  if (!candidate || queuedWakes.has(candidate.ownerRunId)) return;
  const segment = await currentSegment(candidate.ownerRunId);
  if (await alreadyFollowedUp(candidate.ownerRunId, segment)) return;

  const conversation = await conversationDb.getConversationById(conversationId);
  const adapter =
    conversation && isRunFollowUpEnabled(conversation.platform_type)
      ? options.platforms.get(conversation.platform_type)
      : undefined;
  if (!conversation || !adapter) {
    log.debug({ runId: run.id }, 'run_follow_up.chat_unavailable');
    return;
  }
  const chatId = conversation.platform_conversation_id;

  if (await cancelledByReset(candidate)) {
    if (await writeMark(candidate, 'skipped', segment)) {
      log.info({ runId: run.id }, 'run_follow_up.skipped_reset_cancel');
    }
    return;
  }
  if (await chatResetSince(conversation.id, candidate.run.started_at)) {
    if (!(await writeMark(candidate, 'note', segment))) return;
    await adapter.sendMessage(
      chatId,
      formatRunFollowUpNote({ run: candidate.run, event: candidate.event, surface: adapter })
    );
    log.info(
      { runId: run.id, ownerRunId: candidate.ownerRunId, attention: candidate.event.kind },
      'run_follow_up.noted'
    );
    return;
  }
  queueWake(candidate, segment, adapter, chatId, options.lockManager);
}

/** Stamped runs that are active, or ended inside the follow-up window. */
async function listCandidates(
  now: number
): Promise<{ run: WorkflowRun; conversationId: string }[]> {
  const [active, ended] = await Promise.all([
    workflowDb.listWorkflowRuns({ status: ['running', 'paused'], limit: CANDIDATE_LIMIT }),
    workflowDb.listWorkflowRuns({
      status: ['completed', 'failed', 'cancelled'],
      limit: CANDIDATE_LIMIT,
    }),
  ]);
  const recentlyEnded = ended.filter(
    run =>
      run.completed_at !== null &&
      now - toHydratedTimestamp(run.completed_at).getTime() <= ENDED_RUN_WINDOW_MS
  );
  return [...active, ...recentlyEnded].flatMap(run => {
    const followUp = readRunFollowUp(run.metadata);
    return followUp ? [{ run, conversationId: followUp.conversation_id }] : [];
  });
}

/** One pass over the stamped runs. Exported for tests; overlapping calls are skipped. */
export async function runFollowUpTick(
  options: RunFollowUpServiceOptions,
  now = Date.now()
): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    for (const { run, conversationId } of await listCandidates(now)) {
      try {
        await followUpRun(run, conversationId, options, now);
      } catch (error) {
        log.error({ err: error as Error, runId: run.id }, 'run_follow_up.tick_failed');
      }
    }
  } finally {
    tickInProgress = false;
  }
}

export function startRunFollowUpService(options: RunFollowUpServiceOptions): void {
  if (followUpTimer !== undefined) return;
  const tick = (): void => {
    void runFollowUpTick(options).catch((error: unknown) => {
      log.error({ err: error as Error }, 'run_follow_up.tick_failed');
    });
  };
  tick();
  followUpTimer = setInterval(tick, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  followUpTimer.unref?.();
}

export function stopRunFollowUpService(): void {
  if (followUpTimer !== undefined) clearInterval(followUpTimer);
  followUpTimer = undefined;
  ownerLostFirstSeen.clear();
}
