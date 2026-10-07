/**
 * The follow-up service against a real SQLite database file, with the real attention
 * check and the real conversation lock. Only the chat turn itself is recorded. A
 * "restart" is a stopped service plus a closed and reopened database.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IPlatformAdapter } from '@archon/core';
import { removeTempTree } from '@archon/paths/test-utils';

const mockHandleMessage = mock(async (..._args: unknown[]) => undefined);
mock.module('@archon/core', () => ({ handleMessage: mockHandleMessage }));

const { closeDatabase, getDatabase, resetDatabase } = await import('@archon/core/db/connection');
const conversationDb = await import('@archon/core/db/conversations');
const sessionDb = await import('@archon/core/db/sessions');
const workflowDb = await import('@archon/core/db/workflows');
const workflowEventsDb = await import('@archon/core/db/workflow-events');
const { ConversationLockManager } = await import('@archon/core/utils/conversation-lock');
const { getTriggerForCommand } = await import('@archon/core/state/session-transitions');
const { enableRunFollowUp, disableRunFollowUp } =
  await import('@archon/core/services/run-follow-up');
const { runFollowUpTick, stopRunFollowUpService } = await import('./run-follow-up-service');

const CHAT_ID = 'telegram-chat-1';
let root = '';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;

const adapterSendMessage = mock(async (..._args: unknown[]) => undefined);
const adapter = {
  sendMessage: adapterSendMessage,
  getPlatformType: () => 'telegram',
  getStreamingMode: () => 'batch',
} as unknown as IPlatformAdapter;

/** One service lifetime: its own lock manager, then a full tick that settles. */
async function serviceTick(): Promise<void> {
  const lockManager = new ConversationLockManager(5);
  await runFollowUpTick({ platforms: new Map([['telegram', adapter]]), lockManager });
  for (let i = 0; i < 500; i += 1) {
    const stats = lockManager.getStats();
    if (stats.active === 0 && stats.queuedTotal === 0) return;
    await Bun.sleep(2);
  }
  throw new Error('conversation lock did not settle');
}

async function restart(): Promise<void> {
  stopRunFollowUpService();
  await closeDatabase();
  resetDatabase();
}

/** A running run the chat's AI started, stamped exactly as the launch paths stamp it. */
async function startStampedRun(): Promise<string> {
  const chat = await conversationDb.getOrCreateConversation('telegram', CHAT_ID);
  const cli = await conversationDb.getOrCreateConversation('cli', 'cli-run-1');
  const run = await workflowDb.createWorkflowRun({
    workflow_name: 'e2e-deterministic',
    conversation_id: cli.id,
    user_message: 'Run the deterministic check',
    metadata: { follow_up: { conversation_id: chat.id } },
  });
  expect(await workflowDb.claimPendingWorkflowRun(run.id)).not.toBeNull();
  await workflowEventsDb.persistWorkflowEvent({
    workflow_run_id: run.id,
    event_type: 'workflow_started',
  });
  return run.id;
}

async function followUpMarks(runId: string): Promise<unknown[]> {
  const events = await workflowEventsDb.listWorkflowEvents(runId);
  return events.filter(event => event.event_type === 'chat_follow_up_sent').map(e => e.data);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'archon-run-follow-up-')));
  process.env.ARCHON_HOME = join(root, 'home');
  delete process.env.DATABASE_URL;
  resetDatabase();
  mockHandleMessage.mockClear();
  adapterSendMessage.mockClear();
  enableRunFollowUp('telegram');
});

afterEach(async () => {
  stopRunFollowUpService();
  disableRunFollowUp('telegram');
  await closeDatabase();
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

describe('run follow-up across a restart', () => {
  test('a follow-up delivered before a restart is not repeated after it', async () => {
    const runId = await startStampedRun();
    await workflowDb.completeWorkflowRun(runId, { duration_ms: 1 });

    await serviceTick();
    expect(mockHandleMessage).toHaveBeenCalledTimes(1);

    await restart();
    await serviceTick();
    await serviceTick();

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    expect(await followUpMarks(runId)).toEqual([
      expect.objectContaining({ mode: 'wake', attention: 'terminal' }),
    ]);
  });

  test('a run that ended while no service ran is followed up on the first tick', async () => {
    const runId = await startStampedRun();
    await serviceTick();
    expect(mockHandleMessage).not.toHaveBeenCalled();

    await restart();
    await workflowDb.failWorkflowRun(runId, 'the build broke');
    await serviceTick();

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    expect(mockHandleMessage.mock.calls[0]?.[1]).toBe(CHAT_ID);
    expect(mockHandleMessage.mock.calls[0]?.[2]).toContain('failed: the build broke');
  });

  test('a chat reset after launch gets a note, read from the real session rows', async () => {
    const runId = await startStampedRun();
    // SQLite timestamps have one-second resolution; the run must visibly predate the reset.
    await getDatabase().query(
      `UPDATE remote_agent_workflow_runs SET started_at = datetime('now', '-1 minute') WHERE id = $1`,
      [runId]
    );
    const chat = await conversationDb.getOrCreateConversation('telegram', CHAT_ID);
    const session = await sessionDb.createSession({
      conversation_id: chat.id,
      ai_assistant_type: 'claude',
    });
    await sessionDb.deactivateSession(session.id, getTriggerForCommand('reset'));
    await workflowDb.completeWorkflowRun(runId, { duration_ms: 1 });

    await serviceTick();
    await serviceTick();

    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(adapterSendMessage).toHaveBeenCalledTimes(1);
    expect(await followUpMarks(runId)).toEqual([expect.objectContaining({ mode: 'note' })]);
  });
});
