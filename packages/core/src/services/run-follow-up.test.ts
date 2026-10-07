import { afterEach, describe, expect, test } from 'bun:test';
import {
  RUN_FOLLOW_UP_WAKE_MARKER,
  disableRunFollowUp,
  enableRunFollowUp,
  formatRunFollowUpNote,
  formatRunFollowUpWake,
  isRunFollowUpEnabled,
  type RunFollowUpEvent,
} from './run-follow-up';

const AUTOMATIC_TURN_RULE =
  'This is an automatic turn. Never approve, reject, respond to, resume, cancel or abandon a run in this turn ' +
  'unless the user already gave that exact decision in this chat. Otherwise put the decision to the user and stop.';

const RUN = {
  id: '0123456789abcdef0123456789abcdef',
  workflow_name: 'archon-ship',
  user_message: 'Ship the follow-up feature',
};

const gateRun = {
  id: 'child-run-1',
  workflow_name: 'child-flow',
  status: 'paused' as const,
  metadata: { approval: { type: 'approval', nodeId: 'review', message: 'Merge it?' } },
};

const EVENTS: readonly [string, RunFollowUpEvent, string][] = [
  [
    'completed',
    { kind: 'terminal', status: 'completed', outcome: null, error: undefined },
    'What happened: finished',
  ],
  [
    'completed with a failed outcome',
    { kind: 'terminal', status: 'completed', outcome: 'failed', error: undefined },
    'What happened: finished with outcome failed',
  ],
  [
    'failed',
    { kind: 'terminal', status: 'failed', outcome: null, error: 'boom\nstack line' },
    'What happened: failed: boom\n',
  ],
  [
    'cancelled',
    { kind: 'terminal', status: 'cancelled', outcome: null, error: undefined },
    'What happened: cancelled',
  ],
  ['a gate', { kind: 'awaiting_response', gateRun }, 'What happened: needs a decision'],
  [
    'an outside action',
    { kind: 'action_required', message: 'Rotate the key' },
    'What happened: needs an outside action: Rotate the key',
  ],
  [
    'a lost owner',
    { kind: 'owner_lost', observedStatus: 'running' },
    'What happened: may have lost its process while still marked running; check it and ask the user before abandoning or resuming it',
  ],
  [
    'an unreadable state',
    { kind: 'unreadable', detail: 'paused with no approval gate' },
    'What happened: stuck: paused with no approval gate',
  ],
];

describe('run follow-up registry', () => {
  afterEach(() => {
    disableRunFollowUp('telegram');
  });

  test('is off until a platform is enabled, and only for that platform', () => {
    expect(isRunFollowUpEnabled('telegram')).toBe(false);
    enableRunFollowUp('telegram');
    expect(isRunFollowUpEnabled('telegram')).toBe(true);
    expect(isRunFollowUpEnabled('web')).toBe(false);
    disableRunFollowUp('telegram');
    expect(isRunFollowUpEnabled('telegram')).toBe(false);
  });
});

describe('formatRunFollowUpWake', () => {
  test.each(EVENTS)('describes %s', (_label, event, expected) => {
    const text = formatRunFollowUpWake({ run: RUN, event, surface: {} });
    expect(text.split('\n')[0]).toBe(RUN_FOLLOW_UP_WAKE_MARKER);
    expect(text).toContain(RUN.id);
    expect(text).toContain(RUN.workflow_name);
    expect(text).toContain(expected);
    expect(text).toContain(AUTOMATIC_TURN_RULE);
  });

  test('a failure reports only the first line of the error', () => {
    const text = formatRunFollowUpWake({ run: RUN, event: EVENTS[2][1], surface: {} });
    expect(text).not.toContain('stack line');
  });

  test('cuts the original request to 300 characters', () => {
    const text = formatRunFollowUpWake({
      run: { ...RUN, user_message: 'x'.repeat(400) },
      event: EVENTS[0][1],
      surface: {},
    });
    expect(text).toContain('x'.repeat(300));
    expect(text).not.toContain('x'.repeat(301));
  });

  test('a gate carries the paused-gate section for the run that owns the gate', () => {
    const text = formatRunFollowUpWake({ run: RUN, event: EVENTS[4][1], surface: {} });
    expect(text).toContain('## Paused Approval Gate');
    expect(text).toContain('child-run-1');
    expect(text).toContain('Merge it?');
  });

  test('only a gate carries the paused-gate section', () => {
    const text = formatRunFollowUpWake({ run: RUN, event: EVENTS[0][1], surface: {} });
    expect(text).not.toContain('## Paused Approval Gate');
  });
});

describe('formatRunFollowUpNote', () => {
  test('names the short run id and workflow, and points at the status command', () => {
    const text = formatRunFollowUpNote({ run: RUN, event: EVENTS[0][1], surface: {} });
    expect(text).toContain('01234567');
    expect(text).not.toContain(RUN.id);
    expect(text).toContain('archon-ship');
    expect(text).toContain('/workflow status');
    expect(text).not.toContain(RUN_FOLLOW_UP_WAKE_MARKER);
    expect(text.split('\n').length).toBeLessThanOrEqual(2);
  });

  test('spells the status command the way the surface accepts it', () => {
    const text = formatRunFollowUpNote({
      run: RUN,
      event: EVENTS[1][1],
      surface: { formatWorkflowCommand: command => `!wf ${command}` },
    });
    expect(text).toContain('!wf status');
  });
});
