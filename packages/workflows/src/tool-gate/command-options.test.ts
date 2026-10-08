import { describe, expect, test } from 'bun:test';
import {
  hasAbbreviated,
  hasOption,
  leadingOptions,
  parseOptions,
  valuesOf,
  type OptionSpec,
  type OptionWord,
} from './command-options';

function words(text: string): OptionWord[] {
  return text.split(' ').map(word => ({ text: word, dynamic: word.startsWith('$') }));
}

function texts(list: readonly OptionWord[]): string[] {
  return list.map(word => word.text);
}

const CURL: OptionSpec = { valueShort: 'odH', valueLong: ['--output', '--header'] };

describe('parseOptions: where a value can sit', () => {
  test.each([
    ['-o out url', 'out'],
    ['-oout url', 'out'],
    ['-sSLo out url', 'out'],
    ['-sSLoout url', 'out'],
    ['--output out url', 'out'],
    ['--output=out url', 'out'],
    ['url -o out', 'out'],
  ])('%s', (line, value) => {
    const parsed = parseOptions(words(line), CURL);
    expect(texts(valuesOf(parsed, '-o', '--output'))).toEqual([value]);
    expect(texts(parsed.positionals)).toEqual(['url']);
  });

  test('a value letter ends the cluster: later letters are its value, not flags', () => {
    const parsed = parseOptions(words('-odH x'), CURL);
    expect(texts(valuesOf(parsed, '-o'))).toEqual(['dH']);
    expect(hasOption(parsed, '-d', '-H')).toBe(false);
    expect(texts(parsed.positionals)).toEqual(['x']);
  });

  test('every flag letter of a cluster is recorded', () => {
    const parsed = parseOptions(words('-fdx'));
    expect(hasOption(parsed, '-f')).toBe(true);
    expect(hasOption(parsed, '-d')).toBe(true);
    expect(hasOption(parsed, '-x')).toBe(true);
    expect(hasOption(parsed, '-n')).toBe(false);
  });

  test('a value that looks like a flag is still the value', () => {
    const parsed = parseOptions(words('-e -n rest'), { valueShort: 'e' });
    expect(texts(valuesOf(parsed, '-e'))).toEqual(['-n']);
    expect(hasOption(parsed, '-n')).toBe(false);
    expect(texts(parsed.positionals)).toEqual(['rest']);
  });

  test('-- ends the options and - is a positional', () => {
    const parsed = parseOptions(words('-s -- -o out -'), CURL);
    expect(texts(parsed.positionals)).toEqual(['-o', 'out', '-']);
    expect(valuesOf(parsed, '-o')).toEqual([]);
  });

  test('a dynamic word is never an option, and can be a value', () => {
    const parsed = parseOptions(words('$FLAGS -o $OUT'), CURL);
    expect(texts(parsed.positionals)).toEqual(['$FLAGS']);
    expect(texts(valuesOf(parsed, '-o'))).toEqual(['$OUT']);
  });

  test('an unambiguous prefix of a value option takes the value too', () => {
    const spec: OptionSpec = { valueLong: ['--target-directory', '--suffix'] };
    expect(
      texts(valuesOf(parseOptions(words('--target-dir d x'), spec), '--target-directory'))
    ).toEqual(['d']);
    expect(
      texts(valuesOf(parseOptions(words('--target=d x'), spec), '--target-directory'))
    ).toEqual(['d']);
    // Too short to be anything in particular: left as a flag.
    expect(texts(parseOptions(words('--t d x'), spec).positionals)).toEqual(['d', 'x']);
  });

  test('whole-word options are not split into letters', () => {
    const spec: OptionSpec = { wholeWord: true, valueLong: ['-in', '-out'] };
    const parsed = parseOptions(words('enc -base64 -in a -out b'), spec);
    expect(texts(valuesOf(parsed, '-in'))).toEqual(['a']);
    expect(texts(valuesOf(parsed, '-out'))).toEqual(['b']);
    expect(hasOption(parsed, '-base64')).toBe(true);
    expect(hasOption(parsed, '-b')).toBe(false);
    expect(texts(parsed.positionals)).toEqual(['enc']);
  });
});

describe('leadingOptions', () => {
  test('stops at the first word that is not an option', () => {
    const lead = leadingOptions(words('-u root -E rm -rf x'), { valueShort: 'u' });
    expect(lead.count).toBe(3);
    expect(texts(valuesOf(lead, '-u'))).toEqual(['root']);
    expect(hasOption(lead, '-r')).toBe(false);
  });

  test('counts an attached value as one word and -- as the end', () => {
    expect(leadingOptions(words('-uroot rm'), { valueShort: 'u' }).count).toBe(1);
    expect(leadingOptions(words('-n -- -x'), {}).count).toBe(2);
  });
});

describe('hasAbbreviated', () => {
  test.each([
    ['--hard', true],
    ['--har', true],
    ['--h', true],
    ['--hard=1', true],
    ['--help', false],
    ['--', false],
    ['-h', false],
  ])('%s as the hard flag: %p', (word, expected) => {
    expect(hasAbbreviated(parseOptions(words(word)), '--hard', '--h')).toBe(expected);
  });

  test('the shortest accepted prefix is a floor', () => {
    const parsed = parseOptions(words('--force'));
    expect(hasAbbreviated(parsed, '--force-with-lease', '--force-w')).toBe(false);
    expect(
      hasAbbreviated(parseOptions(words('--force-wi')), '--force-with-lease', '--force-w')
    ).toBe(true);
  });
});
