import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { Run } from '../primitives/run';
import { ActiveRunCard } from './ActiveRunCard';

const parallelRun: Run = {
  id: 'run-parallel',
  projectId: null,
  projectName: 'Archon',
  costUsd: null,
  conversationId: null,
  conversationPlatformId: null,
  workerPlatformId: null,
  workflow: 'implement',
  origin: 'cli',
  status: 'running',
  outcome: null,
  startedAt: '2026-09-01T10:00:00.000Z',
  finishedAt: null,
  workingPath: null,
  userMessage: 'Implement the change',
  activeNodes: ['parallel-a', 'parallel-b'],
  currentNode: null,
  lastTool: null,
};

describe('ActiveRunCard', () => {
  test('renders every active node for a parallel run', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ActiveRunCard run={parallelRun} />
      </MemoryRouter>
    );

    expect(html).toContain('nodes');
    expect(html).toContain('parallel-a, parallel-b');
  });

  test('a resolved gate on a chat-started run says the chat must resume it', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ActiveRunCard
          run={{
            ...parallelRun,
            id: 'abcd1234-chat-run',
            origin: 'telegram',
            status: 'paused',
            gateResolved: 'approved',
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain(
      'Approved — continues when the Telegram conversation that started it resumes'
    );
    expect(html).toContain('abcd1234');
    expect(html).not.toContain('resuming…');
  });

  test('a rejected gate on a chat-started run does not claim rework is running', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ActiveRunCard
          run={{ ...parallelRun, origin: 'slack', status: 'paused', gateResolved: 'rejected' }}
        />
      </MemoryRouter>
    );

    expect(html).toContain('Rejected — continues when the Slack conversation that started it');
    expect(html).not.toContain('running on-reject rework');
  });

  test('a resolved gate on a web-started run still says it is resuming', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ActiveRunCard
          run={{ ...parallelRun, origin: 'web', status: 'paused', gateResolved: 'approved' }}
        />
      </MemoryRouter>
    );

    expect(html).toContain('Approved — resuming…');
  });
});
