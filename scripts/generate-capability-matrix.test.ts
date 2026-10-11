import { describe, expect, test } from 'bun:test';
import { CODEX_CAPABILITIES } from '../packages/providers/src/codex/capabilities';
import { renderCell } from './generate-capability-matrix';

describe('capability matrix reporting availability', () => {
  test('distinguishes omitted legacy declarations from explicit support and non-support', () => {
    const legacy = { ...CODEX_CAPABILITIES };
    delete legacy.tokenReporting;
    delete legacy.stopReasonReporting;
    delete legacy.turnCountReporting;
    delete legacy.resolvedModelReporting;
    for (const key of [
      'tokenReporting',
      'stopReasonReporting',
      'turnCountReporting',
      'resolvedModelReporting',
    ] as const) {
      expect(renderCell(legacy, key)).toBe('Unknown');
      expect(renderCell({ ...legacy, [key]: false }, key)).toBe('❌');
      expect(renderCell({ ...legacy, [key]: true }, key)).toBe('✅');
    }
    expect(renderCell({ ...legacy, sessionFork: undefined }, 'sessionFork')).toBe('❌');
  });

  test('a provider that does not declare the tool action gate cannot honour it', () => {
    // The engine refuses such a provider when the gate is on, so "Unknown" would mislead.
    const undeclared = { ...CODEX_CAPABILITIES };
    delete undeclared.toolActionGate;
    expect(renderCell(undeclared, 'toolActionGate')).toBe('❌');
    expect(renderCell({ ...undeclared, toolActionGate: false }, 'toolActionGate')).toBe('❌');
    expect(renderCell({ ...undeclared, toolActionGate: true }, 'toolActionGate')).toBe('✅');
  });
});
