import type { IPlatformAdapter } from '@archon/core/types';
import type {
  ConversationLockManager,
  LockAcquisitionResult,
} from '@archon/core/utils/conversation-lock';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server');
  return cachedLog;
}

type QueuedStatus = Exclude<LockAcquisitionResult['status'], 'started'>;

// The holder of a busy conversation may be a workflow run or an ordinary chat
// turn, so the conversation notice must not claim either.
const QUEUED_NOTICES: Record<QueuedStatus, string> = {
  'queued-conversation':
    'Message received. I will handle it when the current work in this chat finishes.',
  'queued-capacity':
    'Message received. Archon is busy with other conversations; I will handle it when capacity frees up.',
};

/**
 * Run a chat platform message under the conversation lock. When the lock
 * queues it, tell the sender so a busy chat does not look like a dead bot.
 *
 * A failed notice is logged and swallowed: the message is already queued and
 * will still run, so the failure must not reach the caller's processing-error
 * handler, which would tell the user their message failed.
 */
export async function dispatchChatMessage(
  lockManager: Pick<ConversationLockManager, 'acquireLock'>,
  adapter: Pick<IPlatformAdapter, 'sendMessage' | 'getPlatformType'>,
  conversationId: string,
  handler: () => Promise<void>
): Promise<void> {
  const { status } = await lockManager.acquireLock(conversationId, handler);
  if (status === 'started') return;
  try {
    await adapter.sendMessage(conversationId, QUEUED_NOTICES[status]);
  } catch (err) {
    getLog().error(
      { err, conversationId, status, platform: adapter.getPlatformType() },
      'queued_notice_send_failed'
    );
  }
}
