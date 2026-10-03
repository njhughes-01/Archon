import { mock, describe, test, expect, beforeEach } from 'bun:test';
import type { IPlatformAdapter } from '@archon/core/types';

const errorCalls: { obj: Record<string, unknown>; evt: string }[] = [];
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock((obj: Record<string, unknown>, evt: string) => {
    errorCalls.push({ obj, evt });
  }),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'server' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: () => mockLogger,
}));

import { ConversationLockManager } from '@archon/core/utils/conversation-lock';
import { dispatchChatMessage } from './chat-dispatch';

const sendMessage = mock(async (_conversationId: string, _message: string) => undefined);
const adapter: Pick<IPlatformAdapter, 'sendMessage' | 'getPlatformType'> = {
  sendMessage,
  getPlatformType: () => 'telegram',
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

describe('dispatchChatMessage', () => {
  beforeEach(() => {
    sendMessage.mockReset();
    sendMessage.mockImplementation(async () => undefined);
    errorCalls.length = 0;
  });

  test('a started message sends no notice', async () => {
    const lockManager = new ConversationLockManager();
    let ran = false;

    await dispatchChatMessage(lockManager, adapter, 'chat-1', async () => {
      ran = true;
    });
    await flush();

    expect(ran).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('a message queued behind busy work sends one notice and still runs later', async () => {
    const lockManager = new ConversationLockManager();
    const busy = deferred();
    let queuedRan = false;

    await dispatchChatMessage(lockManager, adapter, 'chat-1', () => busy.promise);
    await dispatchChatMessage(lockManager, adapter, 'chat-1', async () => {
      queuedRan = true;
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [conversationId, notice] = sendMessage.mock.calls[0];
    expect(conversationId).toBe('chat-1');
    expect(notice).toContain('current work in this chat finishes');
    expect(notice.toLowerCase()).not.toContain('workflow');
    expect(queuedRan).toBe(false);

    busy.resolve();
    await flush();

    expect(queuedRan).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test('a message queued at global capacity says Archon is busy elsewhere', async () => {
    const lockManager = new ConversationLockManager(1);
    const busy = deferred();
    let queuedRan = false;

    await dispatchChatMessage(lockManager, adapter, 'chat-a', () => busy.promise);
    await dispatchChatMessage(lockManager, adapter, 'chat-b', async () => {
      queuedRan = true;
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [conversationId, notice] = sendMessage.mock.calls[0];
    expect(conversationId).toBe('chat-b');
    expect(notice).toContain('busy with other conversations');
    expect(notice).toContain('capacity frees up');

    busy.resolve();
    await flush();

    expect(queuedRan).toBe(true);
  });

  test('a failed notice is logged and the queued message still runs', async () => {
    sendMessage.mockImplementation(async () => {
      throw new Error('Telegram unavailable');
    });
    const lockManager = new ConversationLockManager();
    const busy = deferred();
    let queuedRan = false;

    await dispatchChatMessage(lockManager, adapter, 'chat-1', () => busy.promise);
    await dispatchChatMessage(lockManager, adapter, 'chat-1', async () => {
      queuedRan = true;
    });

    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].evt).toBe('queued_notice_send_failed');
    expect(errorCalls[0].obj.conversationId).toBe('chat-1');

    busy.resolve();
    await flush();

    expect(queuedRan).toBe(true);
  });
});
