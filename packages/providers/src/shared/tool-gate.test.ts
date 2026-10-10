import { describe, expect, mock, test } from 'bun:test';
import type { ToolActionDecision, ToolActionRequest } from '../types';
import {
  askToolGate,
  formatToolGateDenial,
  pathLikeInputTargets,
  readPatchTargets,
  toolGateFailure,
} from './tool-gate';

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

describe('pathLikeInputTargets', () => {
  test('reads every field an unknown tool commonly names a file in', () => {
    expect(
      pathLikeInputTargets({
        file_path: '/a',
        path: 'b',
        filePath: 'c',
        filename: 'd',
        notebook_path: 'e.ipynb',
        target_file: 'f',
        destination: '../g',
        paths: ['h', 'i'],
        files: ['j'],
      })
    ).toEqual(['/a', 'b', 'c', 'd', 'e.ipynb', 'f', '../g', 'h', 'i', 'j']);
  });

  test('a MultiEdit-shaped input names its target', () => {
    expect(pathLikeInputTargets({ file_path: '/etc/hosts', edits: [{ old_string: 'a' }] })).toEqual(
      ['/etc/hosts']
    );
  });

  test('skips values that are not text and names each target once', () => {
    expect(
      pathLikeInputTargets({
        path: 7,
        file_path: '',
        filename: null,
        destination: { nested: 'x' },
        paths: ['a', 3, null, 'a', ''],
        files: 'not-a-list',
        content: 'path: /etc/hosts',
      })
    ).toEqual(['a']);
  });

  test('an input with no such field names nothing', () => {
    expect(pathLikeInputTargets({ prompt: 'do it' })).toEqual([]);
  });
});

describe('readPatchTargets', () => {
  const patch = (...lines: string[]): string => lines.join('\n');

  test('reads add, update, move and delete headers', () => {
    expect(
      readPatchTargets(
        patch(
          '*** Begin Patch',
          '*** Add File: src/new.ts',
          '+export {};',
          '*** Update File: src/old.ts',
          '*** Move to: src/renamed.ts',
          '@@',
          '-a',
          '+b',
          '*** Delete File: /abs/gone.ts',
          '*** End Patch'
        )
      )
    ).toEqual({
      targets: ['src/new.ts', 'src/old.ts', 'src/renamed.ts', '/abs/gone.ts'],
      unreadable: false,
    });
  });

  // Both real parsers trim a header line before matching it: Codex 0.157.0
  // wrote `../out.txt` for exactly this patch, and Copilot's parser reads the
  // same target (see the oracle in community/copilot/tool-gate.test.ts).
  test('an indented header after another hunk is a target', () => {
    expect(
      readPatchTargets(
        patch(
          '*** Begin Patch',
          '*** Delete File: d.txt',
          '  *** Add File: ../out.txt',
          '+hi',
          '*** End Patch'
        )
      )
    ).toEqual({ targets: ['d.txt', '../out.txt'], unreadable: false });
  });

  test('tab and no-break-space indentation is trimmed like plain spaces', () => {
    expect(
      readPatchTargets(
        patch('*** Begin Patch', '\t*** Add File: a.txt', '+x', '\u00A0*** Delete File: b.txt')
      ).targets
    ).toEqual(['a.txt', 'b.txt']);
  });

  test('CRLF line ends are not part of the path', () => {
    expect(
      readPatchTargets(
        '*** Begin Patch\r\n*** Update File: a.ts\r\n*** Move to: b.ts\r\n@@\r\n-x\r\n+y\r\n*** End Patch\r\n'
      )
    ).toEqual({ targets: ['a.ts', 'b.ts'], unreadable: false });
  });

  test('trailing space is dropped and leading space after the marker is kept', () => {
    // Codex keeps the leading space as part of the file name; Copilot trims
    // it. Each provider settles that spelling itself.
    expect(readPatchTargets(patch('*** Add File:    a.txt   ', '+x')).targets).toEqual([
      '   a.txt',
    ]);
  });

  test('added and removed content is never a header', () => {
    expect(
      readPatchTargets(
        patch(
          '*** Begin Patch',
          '*** Update File: notes.md',
          '@@',
          '+*** Add File: decoy.md',
          '-*** Delete File: decoy.md',
          '*** End Patch'
        )
      )
    ).toEqual({ targets: ['notes.md'], unreadable: false });
  });

  test.each([
    ['a header with no path', '*** Add File:'],
    ['a header with no space before the path', '*** Add File:a.txt'],
    ['a header in another letter case', '*** add file: a.txt'],
    ['a move header in another letter case', '*** Move To: a.txt'],
    ['an indented near-miss', '   *** DELETE FILE: a.txt'],
    ['an environment header', '*** Environment ID: other-machine'],
  ])('%s makes the patch unreadable', (_label, line) => {
    const reading = readPatchTargets(
      patch('*** Begin Patch', '*** Add File: ok.txt', '+x', line, '*** End Patch')
    );

    expect(reading).toEqual({ targets: ['ok.txt'], unreadable: true });
  });

  test.each([
    ['stars spaced apart', '* * * Add File: a.txt'],
    ['no space after the stars', '***Add File: a.txt'],
    ['two spaces inside the marker', '*** Add  File: a.txt'],
    ['a tab inside the marker', '*** Add\tFile: a.txt'],
    ['a tab between the stars', '**\t* Delete File: a.txt'],
    ['a zero-width space inside the marker', '*** Add\u200B File: a.txt'],
  ])('a header-like line with %s makes the patch unreadable', (_label, line) => {
    const reading = readPatchTargets(patch('*** Begin Patch', line, '+x', '*** End Patch'));

    expect(reading).toEqual({ targets: [], unreadable: true });
  });

  // Codex CLI 0.157.0 drops a tab and a carriage return from anywhere in a
  // path: `*** Add File: .\t./out.txt` wrote `../out.txt`, one directory above
  // the working directory, and `.e\tnv` wrote `.env`. Copilot keeps the tab.
  // What a parser does with the other invisible characters is not known for
  // every version, so a path holding any of them is not guessed at.
  test.each([
    ['a tab inside a climbing path', '*** Add File: .\t./.\t./out.txt'],
    ['a tab inside a file name', '*** Add File: .e\tnv'],
    ['a tab right after the marker', '*** Update File: \t../out.txt'],
    ['a tab inside a move target', '*** Move to: .\t./out.txt'],
    ['a vertical tab inside a path', '*** Add File: a\u000Bb.txt'],
    ['an escape character inside a path', '*** Delete File: a\u001Bb.txt'],
    ['a delete character inside a path', '*** Add File: a\u007Fb.txt'],
    ['a C1 control inside a path', '*** Add File: a\u009Fb.txt'],
    ['a zero-width space inside a path', '*** Add File: .e\u200Bnv'],
    ['a soft hyphen inside a path', '*** Add File: .e\u00ADnv'],
    ['a right-to-left override inside a path', '*** Add File: a\u202Eb.txt'],
  ])('%s makes the patch unreadable and names no guessed path', (_label, line) => {
    const reading = readPatchTargets(patch('*** Begin Patch', line, '+x', '*** End Patch'));

    expect(reading).toEqual({ targets: [], unreadable: true });
  });

  test('a path with ordinary and no-break spaces inside it is read as written', () => {
    expect(
      readPatchTargets(patch('*** Add File: docs/My Notes\u00A0v2.md', '+x', '*** End Patch'))
    ).toEqual({ targets: ['docs/My Notes\u00A0v2.md'], unreadable: false });
  });

  test('tab-indented content that mentions three stars is not a header', () => {
    expect(
      readPatchTargets(
        patch(
          '*** Begin Patch',
          '*** Update File: main.go',
          '@@',
          '+\t// *** Add File: is how a patch names a new file ***',
          '-\tx := ***p',
          '*** End Patch'
        )
      )
    ).toEqual({ targets: ['main.go'], unreadable: false });
  });

  // The two parsers disagree on these characters. Copilot ends a line at a bare
  // carriage return where Codex drops the character and reads on (it wrote
  // `../out.txt` for `ok\r/../../out.txt`); Codex trims U+0085 where Copilot
  // does not, and the reverse for U+FEFF. A line that could be a header under
  // either reading is not guessed at.
  test.each([
    ['a bare carriage return inside a path', '*** Add File: ok\r/../../out.txt'],
    ['a bare carriage return before a header', '+hi\r*** Add File: ../out.txt'],
    ['a next-line character before a header', '\u0085*** Add File: a.txt'],
    ['a byte-order mark before a header', '\uFEFF*** Add File: a.txt'],
    ['a line separator before a header', '+hi\u2028*** Add File: ../out.txt'],
    ['a null byte in a path', '*** Add File: a\0.txt'],
  ])('%s makes the patch unreadable and names no guessed path', (_label, line) => {
    const reading = readPatchTargets(patch('*** Begin Patch', line, '+x', '*** End Patch'));

    expect(reading).toEqual({ targets: [], unreadable: true });
  });

  test('markdown emphasis and rules in content do not make a patch unreadable', () => {
    expect(
      readPatchTargets(
        patch(
          '*** Begin Patch',
          '*** Update File: README.md',
          '@@',
          ' ***',
          ' ***bold and italic***',
          '-old',
          '+new',
          '*** End of File',
          '*** End Patch'
        )
      )
    ).toEqual({ targets: ['README.md'], unreadable: false });
  });

  test('text that is not a patch names nothing and is not unreadable', () => {
    expect(readPatchTargets('echo hi')).toEqual({ targets: [], unreadable: false });
  });
});
