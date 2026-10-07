import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { IPlatformAdapter, Session } from '@archon/core';
import type { WorkflowEventRow } from '@archon/core/db/workflow-events';
import type { RunWaitResult } from '@archon/core/services/run-attention-watch';
import { ConversationLockManager } from '@archon/core/utils/conversation-lock';
import { runAttention, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowEventInput } from '@archon/workflows/store';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const CHAT_DB_ID = 'chat-db-1';
const CHAT_ID = 'telegram-chat-1';

// In-memory rows behind the mocked database modules.
const runs = new Map<string, WorkflowRun>();
let events: WorkflowEventRow[] = [];
let sessions: Session[] = [];
let conversationPlatform = 'telegram';
const attentionOverrides = new Map<string, RunWaitResult>();

const mockHandleMessage = mock(async (..._args: unknown[]) => undefined);
const mockListWorkflowRuns = mock(async (options?: { status?: string[] }) =>
  [...runs.values()].filter(
    run => run.parent_run_id === null && (options?.status ?? []).includes(run.status)
  )
);
const mockPersistWorkflowEvent = mock(async (input: WorkflowEventInput) => {
  appendEvent(input.workflow_run_id, input.event_type, input.data ?? {});
});

mock.module('@archon/core', () => ({ handleMessage: mockHandleMessage }));
mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mockListWorkflowRuns,
  getWorkflowRun: async (id: string) => runs.get(id) ?? null,
}));
mock.module('@archon/core/db/workflow-events', () => ({
  getLatestWorkflowEvent: async (runId: string, eventType: string) =>
    events.filter(e => e.workflow_run_id === runId && e.event_type === eventType).at(-1) ?? null,
  persistWorkflowEvent: mockPersistWorkflowEvent,
}));
mock.module('@archon/core/db/conversations', () => ({
  getConversationById: async (id: string) =>
    id === CHAT_DB_ID
      ? { id, platform_type: conversationPlatform, platform_conversation_id: CHAT_ID }
      : null,
}));
mock.module('@archon/core/db/sessions', () => ({
  getSessionHistory: async () => sessions,
  SessionNotFoundError: class extends Error {},
}));
mock.module('@archon/core/services/run-attention-watch', () => ({
  waitForRunAttention: async (runId: string): Promise<RunWaitResult> => {
    const override = attentionOverrides.get(runId);
    if (override) return override;
    const run = runs.get(runId);
    if (!run) return { kind: 'not_found', runId };
    const attention = runAttention(run);
    return attention
      ? { kind: 'attention', attention }
      : { kind: 'deadline', runId, observedStatus: run.status };
  },
}));

const { enableRunFollowUp, disableRunFollowUp, RUN_FOLLOW_UP_WAKE_MARKER } =
  await import('@archon/core/services/run-follow-up');
const { RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS } =
  await import('@archon/core/services/run-live-owner');
const { runFollowUpTick, stopRunFollowUpService } = await import('./run-follow-up-service');

let eventSeq = 0;
function appendEvent(runId: string, eventType: string, data: Record<string, unknown>): string {
  eventSeq += 1;
  const id = `event-${String(eventSeq)}`;
  events.push({
    id,
    workflow_run_id: runId,
    event_type: eventType,
    step_index: null,
    step_name: null,
    data,
    created_at: new Date(NOW).toISOString(),
    event_order: eventSeq,
  });
  return id;
}

function putRun(overrides: Partial<WorkflowRun> & Pick<WorkflowRun, 'id' | 'status'>): WorkflowRun {
  const run = {
    workflow_name: 'build-feature',
    conversation_id: 'cli-conv',
    parent_conversation_id: null,
    parent_run_id: null,
    codebase_id: null,
    user_message: 'Build the feature',
    outcome: null,
    metadata: { follow_up: { conversation_id: CHAT_DB_ID } },
    started_at: new Date(NOW - 60_000),
    completed_at: ['completed', 'failed', 'cancelled'].includes(overrides.status)
      ? new Date(NOW - 1_000)
      : null,
    ...overrides,
  } as WorkflowRun;
  runs.set(run.id, run);
  return run;
}

const adapterSendMessage = mock(async (..._args: unknown[]) => undefined);
const adapter = {
  sendMessage: adapterSendMessage,
  getPlatformType: () => 'telegram',
  getStreamingMode: () => 'batch',
} as unknown as IPlatformAdapter;

let lockManager: ConversationLockManager;

function options(): Parameters<typeof runFollowUpTick>[0] {
  return { platforms: new Map([['telegram', adapter]]), lockManager, intervalMs: 15_000 };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const stats = lockManager.getStats();
    if (stats.active === 0 && stats.queuedTotal === 0) return;
    await Bun.sleep(1);
  }
  throw new Error('conversation lock did not settle');
}

async function ticks(count: number, now = NOW): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await runFollowUpTick(options(), now);
    await settle();
  }
}

function marks(): WorkflowEventRow[] {
  return events.filter(e => e.event_type === 'chat_follow_up_sent');
}

function wakeTexts(): string[] {
  return mockHandleMessage.mock.calls.map(call => call[2] as string);
}

beforeEach(() => {
  runs.clear();
  events = [];
  sessions = [];
  conversationPlatform = 'telegram';
  attentionOverrides.clear();
  mockHandleMessage.mockClear();
  mockListWorkflowRuns.mockClear();
  mockPersistWorkflowEvent.mockClear();
  adapterSendMessage.mockClear();
  lockManager = new ConversationLockManager(5);
  enableRunFollowUp('telegram');
});

afterEach(() => {
  stopRunFollowUpService();
  disableRunFollowUp('telegram');
});

describe('runFollowUpTick', () => {
  test.each([
    ['completed', { status: 'completed' as const }, 'What happened: finished'],
    [
      'failed',
      {
        status: 'failed' as const,
        metadata: { error: 'tests broke\nstack', follow_up: { conversation_id: CHAT_DB_ID } },
      },
      'What happened: failed: tests broke',
    ],
    ['cancelled', { status: 'cancelled' as const }, 'What happened: cancelled'],
    [
      'gate',
      {
        status: 'paused' as const,
        metadata: {
          approval: { type: 'approval', nodeId: 'review', message: 'Merge it?' },
          follow_up: { conversation_id: CHAT_DB_ID },
        },
      },
      'What happened: needs a decision',
    ],
    [
      'action-required',
      {
        status: 'paused' as const,
        metadata: {
          wait: {
            kind: 'attention',
            owner: 'node',
            nodeId: 'deploy',
            message: 'Rotate the key',
            waitingSince: new Date(NOW).toISOString(),
          },
          follow_up: { conversation_id: CHAT_DB_ID },
        },
      },
      'What happened: needs an outside action: Rotate the key',
    ],
  ])('wakes the chat once across three ticks for a %s run', async (_label, row, expected) => {
    putRun({ id: 'run-1', ...row });
    appendEvent('run-1', 'workflow_started', {});

    await ticks(3);

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const [calledAdapter, chatId, text, context] = mockHandleMessage.mock.calls[0] ?? [];
    expect(calledAdapter).toBe(adapter);
    expect(chatId).toBe(CHAT_ID);
    expect(text).toStartWith(RUN_FOLLOW_UP_WAKE_MARKER);
    expect(text).toContain(expected);
    // The turn runs as the chat's own user: no userId is passed.
    expect(context).toEqual({ isolationHints: { workflowType: 'thread', workflowId: CHAT_ID } });
    expect(marks()).toHaveLength(1);
    expect(marks()[0]?.data).toMatchObject({ mode: 'wake', covers: events[0]?.id });
    expect(adapterSendMessage).not.toHaveBeenCalled();
  });

  test('reports a lost owner only on a later sighting past the grace period', async () => {
    putRun({ id: 'run-1', status: 'running' });
    attentionOverrides.set('run-1', {
      kind: 'owner_lost',
      runId: 'run-1',
      observedStatus: 'running',
    });
    const confirmAfter = RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS + 15_000;

    await ticks(1, NOW);
    expect(mockHandleMessage).not.toHaveBeenCalled();
    await ticks(1, NOW + confirmAfter);
    expect(mockHandleMessage).not.toHaveBeenCalled();

    await ticks(2, NOW + confirmAfter + 1);
    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    expect(wakeTexts()[0]).toContain('may have lost its process while still marked running');
  });

  test('forgets an owner-loss sighting once the run answers normally again', async () => {
    putRun({ id: 'run-1', status: 'running' });
    const lost: RunWaitResult = { kind: 'owner_lost', runId: 'run-1', observedStatus: 'running' };
    const late = NOW + RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS + 60_000;

    attentionOverrides.set('run-1', lost);
    await ticks(1, NOW);
    attentionOverrides.delete('run-1');
    await ticks(1, NOW + 1_000);
    attentionOverrides.set('run-1', lost);
    await ticks(1, late);

    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('never asks about pending runs', async () => {
    putRun({ id: 'run-1', status: 'pending' });

    await ticks(2);

    for (const [query] of mockListWorkflowRuns.mock.calls) {
      expect(query?.status).not.toContain('pending');
    }
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('marks a gate that sits on a child run on the child', async () => {
    putRun({ id: 'run-1', status: 'paused' });
    putRun({
      id: 'child-1',
      status: 'paused',
      parent_run_id: 'run-1',
      metadata: { approval: { type: 'approval', nodeId: 'review', message: 'Ship it?' } },
    });
    const childStart = appendEvent('child-1', 'workflow_started', {});
    attentionOverrides.set('run-1', {
      kind: 'attention',
      attention: {
        kind: 'awaiting_response',
        runId: 'run-1',
        respondTo: { runId: 'child-1', nodeId: 'review' },
        message: 'Ship it?',
      },
    });

    await ticks(2);

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    expect(wakeTexts()[0]).toContain('child-1');
    expect(marks()).toHaveLength(1);
    expect(marks()[0]?.workflow_run_id).toBe('child-1');
    expect(marks()[0]?.data.covers).toBe(childStart);
  });

  test('wakes again for a second gate after the run was resumed', async () => {
    const gate = (nodeId: string): WorkflowRun['metadata'] => ({
      approval: { type: 'approval', nodeId, message: `${nodeId}?` },
      follow_up: { conversation_id: CHAT_DB_ID },
    });
    putRun({ id: 'run-1', status: 'paused', metadata: gate('plan') });
    appendEvent('run-1', 'workflow_started', {});
    await ticks(2);

    putRun({ id: 'run-1', status: 'paused', metadata: gate('merge') });
    appendEvent('run-1', 'workflow_started', {});
    await ticks(2);

    expect(mockHandleMessage).toHaveBeenCalledTimes(2);
    expect(marks()).toHaveLength(2);
  });

  test('sends a short note instead of a wake when the chat was reset after launch', async () => {
    putRun({ id: 'run-1', status: 'completed' });
    sessions = [{ ended_reason: 'reset-requested', ended_at: new Date(NOW - 30_000) } as Session];

    await ticks(2);

    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(adapterSendMessage).toHaveBeenCalledTimes(1);
    const [chatId, note] = adapterSendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe(CHAT_ID);
    expect(note).toBe(
      'Run run-1 (build-feature) that this chat started has finished. Details: /workflow status'
    );
    expect(marks()[0]?.data).toMatchObject({ mode: 'note' });
  });

  test('a reset before the run started still wakes the chat', async () => {
    putRun({ id: 'run-1', status: 'completed' });
    sessions = [{ ended_reason: 'reset-requested', ended_at: new Date(NOW - 120_000) } as Session];

    await ticks(1);

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    expect(adapterSendMessage).not.toHaveBeenCalled();
  });

  test('sends nothing for a run that /reset cancelled, and marks it skipped', async () => {
    putRun({ id: 'run-1', status: 'cancelled' });
    appendEvent('run-1', 'workflow_cancelled', { cancel_reason: 'conversation_reset' });

    await ticks(2);

    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(adapterSendMessage).not.toHaveBeenCalled();
    expect(marks()).toHaveLength(1);
    expect(marks()[0]?.data).toMatchObject({ mode: 'skipped' });
  });

  test('ignores a run that no chat stamped', async () => {
    putRun({ id: 'run-1', status: 'completed', metadata: {} });

    await ticks(2);

    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockPersistWorkflowEvent).not.toHaveBeenCalled();
  });

  test('ignores a chat whose platform does not have follow-up enabled', async () => {
    putRun({ id: 'run-1', status: 'completed' });
    disableRunFollowUp('telegram');

    await ticks(2);
    conversationPlatform = 'slack';
    enableRunFollowUp('telegram');
    await ticks(2);

    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(adapterSendMessage).not.toHaveBeenCalled();
    expect(mockPersistWorkflowEvent).not.toHaveBeenCalled();
  });

  test('queues one wake behind a busy chat, not one per tick', async () => {
    putRun({ id: 'run-1', status: 'completed' });
    let release = (): void => undefined;
    await lockManager.acquireLock(
      CHAT_ID,
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );

    for (let i = 0; i < 3; i += 1) await runFollowUpTick(options(), NOW);
    expect(lockManager.getStats().queuedTotal).toBe(1);
    expect(mockHandleMessage).not.toHaveBeenCalled();

    release();
    await settle();
    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    expect(marks()).toHaveLength(1);
  });

  test('a queued wake does nothing when the run moved on before the chat was free', async () => {
    putRun({
      id: 'run-1',
      status: 'paused',
      metadata: {
        approval: { type: 'approval', nodeId: 'review', message: 'Merge it?' },
        follow_up: { conversation_id: CHAT_DB_ID },
      },
    });
    let release = (): void => undefined;
    await lockManager.acquireLock(
      CHAT_ID,
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );

    await runFollowUpTick(options(), NOW);
    putRun({ id: 'run-1', status: 'running' });
    release();
    await settle();

    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockPersistWorkflowEvent).not.toHaveBeenCalled();
  });
});
