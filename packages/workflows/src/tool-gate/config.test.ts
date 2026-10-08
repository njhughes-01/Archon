import { describe, expect, test } from 'bun:test';
import { mergeToolGateConfig, parseToolGateConfig } from './config';

describe('parseToolGateConfig', () => {
  test('reads the switch and both lists', () => {
    expect(
      parseToolGateConfig(
        {
          enabled: true,
          protectedBranches: [' dev ', 'release'],
          verificationCommands: ['make  check'],
        },
        'global config'
      )
    ).toEqual({
      enabled: true,
      protectedBranches: ['dev', 'release'],
      verificationCommands: ['make  check'],
    });
  });

  test('an empty block sets nothing', () => {
    expect(parseToolGateConfig({}, 'global config')).toEqual({});
  });

  test.each([
    ['a value that is not a block', true, /toolGate in repo config must be a mapping/],
    ['a list', ['enabled'], /toolGate in repo config must be a mapping/],
    ['a misspelled key', { enable: true }, /unknown key 'enable'/],
    ['a switch that is not a boolean', { enabled: 'yes' }, /toolGate.enabled .* true or false/],
    [
      'branches that are not a list',
      { protectedBranches: 'main' },
      /toolGate.protectedBranches .* list of non-empty strings/,
    ],
    [
      'a branch that is not text',
      { protectedBranches: ['main', 7] },
      /toolGate.protectedBranches .* list of non-empty strings/,
    ],
    [
      'an empty command',
      { verificationCommands: ['  '] },
      /toolGate.verificationCommands .* list of non-empty strings/,
    ],
  ])('%s is refused, naming the source', (_name, value, message) => {
    expect(() => parseToolGateConfig(value, 'repo config')).toThrow(message);
    expect(() => parseToolGateConfig(value, 'repo config')).toThrow(/repo config/);
  });
});

describe('mergeToolGateConfig', () => {
  test('a layer that only switches the gate on has empty lists', () => {
    expect(mergeToolGateConfig(undefined, { enabled: true })).toEqual({
      enabled: true,
      protectedBranches: [],
      verificationCommands: [],
    });
  });

  test('a layer that names lists without the switch leaves the gate off', () => {
    expect(mergeToolGateConfig(undefined, { protectedBranches: ['dev'] })).toEqual({
      enabled: false,
      protectedBranches: ['dev'],
      verificationCommands: [],
    });
  });

  test('a later layer can switch the gate on', () => {
    const install = mergeToolGateConfig(undefined, { enabled: false });
    expect(mergeToolGateConfig(install, { enabled: true }).enabled).toBe(true);
  });

  test('a later layer cannot switch the gate off', () => {
    const install = mergeToolGateConfig(undefined, { enabled: true, protectedBranches: ['dev'] });
    expect(mergeToolGateConfig(install, { enabled: false })).toEqual({
      enabled: true,
      protectedBranches: ['dev'],
      verificationCommands: [],
    });
  });

  test('lists add up across layers without duplicates; a later layer cannot remove an entry', () => {
    const install = mergeToolGateConfig(undefined, {
      enabled: true,
      protectedBranches: ['dev', 'release'],
      verificationCommands: ['make check'],
    });
    expect(
      mergeToolGateConfig(install, {
        protectedBranches: ['release', 'staging'],
        verificationCommands: [],
      })
    ).toEqual({
      enabled: true,
      protectedBranches: ['dev', 'release', 'staging'],
      verificationCommands: ['make check'],
    });
  });
});
