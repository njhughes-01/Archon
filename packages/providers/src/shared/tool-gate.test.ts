import { describe, expect, mock, test } from 'bun:test';
import type { ToolActionDecision, ToolActionRequest } from '../types';
import { askToolGate, formatToolGateDenial, toolGateFailure } from './tool-gate';

const REQUEST: ToolActionRequest = {
  toolName: 'Bash',
  kind: 'shell',
  cwd: '/repo',
  command: 'echo secret-in-input',
  input: { command: 'echo secret-in-input' },
};

function logger(): { error: ReturnType<typeof mock> } {
  return { error: mock(() => undefined) };
}

describe('askToolGate', () => {
  test('a well-formed allow is the only permission', async () => {
    const log = logger();
    const decision = await askToolGate(
      () => Promise.resolve({ action: 'allow' }),
      REQUEST,
      log,
      'x'
    );
    expect(decision).toEqual({ action: 'allow' });
    expect(log.error).not.toHaveBeenCalled();
  });

  test('a well-formed denial is passed through as it is', async () => {
    const denial: ToolActionDecision = {
      action: 'deny',
      needsApproval: true,
      reason: 'no',
      alternatives: ['do less'],
      ruleId: 'deny.example',
    };
    expect(await askToolGate(() => Promise.resolve(denial), REQUEST, logger(), 'x')).toBe(denial);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'allow'],
    ['an unknown action', { action: 'maybe' }],
    ['a denial with no reason', { action: 'deny', alternatives: [] }],
    ['a denial with no alternatives', { action: 'deny', reason: 'no' }],
  ])('%s is a denial, logged as malformed under the provider name', async (_name, answer) => {
    const log = logger();
    const decision = await askToolGate(
      () => Promise.resolve(answer as unknown as ToolActionDecision),
      REQUEST,
      log,
      'claude'
    );
    expect(decision).toMatchObject({ action: 'deny', needsApproval: false });
    expect(log.error.mock.calls[0]?.[1]).toBe('claude.tool_gate_malformed');
  });

  test('a rejected gate is a denial, logged as failed, without the request input', async () => {
    const log = logger();
    const decision = await askToolGate(
      () => Promise.reject(new Error('store is down')),
      REQUEST,
      log,
      'pi'
    );
    expect(decision).toMatchObject({ action: 'deny' });
    expect(log.error.mock.calls[0]?.[1]).toBe('pi.tool_gate_failed');
    expect(JSON.stringify(log.error.mock.calls[0]?.[0])).not.toContain('secret-in-input');
  });

  test('a gate that throws before returning a promise is a denial too', async () => {
    const decision = await askToolGate(
      () => {
        throw new Error('boom');
      },
      REQUEST,
      logger(),
      'copilot'
    );
    expect(decision.action).toBe('deny');
  });
});

describe('formatToolGateDenial', () => {
  test('gives the reason, then each alternative on its own line', () => {
    expect(
      formatToolGateDenial({
        action: 'deny',
        needsApproval: false,
        reason: 'It rewrites history.',
        alternatives: ['Push without forcing.', 'Open a pull request.'],
      })
    ).toBe(
      'Blocked by the tool gate: It rewrites history.\nAlternatives:\n- Push without forcing.\n- Open a pull request.'
    );
  });

  test('a denial with no alternatives is one line', () => {
    expect(formatToolGateDenial({ ...toolGateFailure('The gate failed.'), alternatives: [] })).toBe(
      'Blocked by the tool gate: The gate failed.'
    );
  });
});
