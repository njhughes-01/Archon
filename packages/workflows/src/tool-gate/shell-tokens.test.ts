import { describe, expect, test } from 'bun:test';
import { parseShell, resolveWord, type ShellCommand } from './shell-tokens';

const HOME = '/home/tester';

function heads(text: string): string[] {
  return parseShell(text).commands.map(command => command.head);
}

function only(text: string): ShellCommand {
  const { commands } = parseShell(text);
  if (commands.length !== 1) {
    throw new Error(`expected one command, got ${String(commands.length)}`);
  }
  const [command] = commands;
  if (command === undefined) throw new Error('unreachable');
  return command;
}

function argTexts(command: ShellCommand): string[] {
  return command.args.map(word => resolveWord(word, HOME).text);
}

describe('parseShell: splitting', () => {
  test('splits on ; && || | & and newlines', () => {
    expect(heads('a; b && c || d | e & f\ng')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  test('a pipe keeps both sides in one pipeline, other separators start a new one', () => {
    const { commands } = parseShell('a | b && c | d');
    expect(commands.map(command => command.pipeline)).toEqual([0, 0, 1, 1]);
  });

  test('a separator inside quotes does not split', () => {
    expect(heads('echo "a; b && c" \'d | e\'')).toEqual(['echo']);
  });

  test('a backslash-newline continues the line', () => {
    const command = only('git \\\n  status');
    expect(command.head).toBe('git');
    expect(argTexts(command)).toEqual(['status']);
  });

  test('a comment runs to the end of the line and hides nothing after it', () => {
    expect(heads('# rm everything\nls # trailing\npwd')).toEqual(['ls', 'pwd']);
  });

  test('a # inside a word is not a comment', () => {
    expect(argTexts(only('echo a#b'))).toEqual(['a#b']);
  });

  test('control keywords are stripped so the command after them is still read', () => {
    expect(heads('if true; then git status; else ls; fi')).toEqual(['true', 'git', 'ls']);
    expect(heads('while read line; do echo x; done')).toEqual(['read', 'echo']);
  });

  test('a subshell is split into its commands, which share a scope inside the outer one', () => {
    const { commands, scopeParents } = parseShell('(cd build && make); ls; (pwd)');
    const [cd, make, ls, pwd] = commands;
    expect(commands.map(command => command.head)).toEqual(['cd', 'make', 'ls', 'pwd']);
    expect(cd?.scope).toBe(make?.scope ?? -1);
    expect(cd?.scope).not.toBe(ls?.scope ?? -1);
    expect(pwd?.scope).not.toBe(cd?.scope ?? -1);
    expect(scopeParents[cd?.scope ?? -1]).toBe(ls?.scope ?? -1);
    expect(scopeParents[pwd?.scope ?? -1]).toBe(ls?.scope ?? -1);
    expect(scopeParents[ls?.scope ?? -1]).toBeUndefined();
  });

  test('a substitution body runs in its own scope inside the command that holds it', () => {
    const { commands, scopeParents } = parseShell('echo $(cd src && ls)');
    const [echo, cd] = commands;
    expect(scopeParents[cd?.scope ?? -1]).toBe(echo?.scope ?? -1);
  });
});

describe('parseShell: quoting and the argv head', () => {
  test.each([
    ['"git" status', 'git'],
    ["g''it status", 'git'],
    ['g"i"t status', 'git'],
    ['\\git status', 'git'],
    ['/usr/bin/git status', 'git'],
    ['./node_modules/.bin/tsc --noEmit', 'tsc'],
  ])('%s has head %s', (text, head) => {
    expect(only(text).head).toBe(head);
  });

  test('quoted flags lose their quotes', () => {
    expect(argTexts(only('git push "--force" \'origin\' ma""in'))).toEqual([
      'push',
      '--force',
      'origin',
      'main',
    ]);
  });

  test('single quotes keep $ and backticks literal', () => {
    const command = only("echo '$HOME `id` $(id)'");
    expect(command.opaque).toEqual([]);
    expect(resolveWord(command.args[0], HOME)).toEqual({
      text: '$HOME `id` $(id)',
      dynamic: false,
      glob: false,
    });
  });

  test('an unterminated quote is opaque', () => {
    expect(parseShell('echo "abc').opaque).toContain('unterminated_quote');
    expect(parseShell("echo 'abc").opaque).toContain('unterminated_quote');
  });

  test('a variable as the head is opaque', () => {
    const command = only('$TOOL --version');
    expect(command.head).toBe('');
    expect(command.opaque).toContain('variable_head');
  });
});

describe('parseShell: env assignments and wrappers', () => {
  test('leading env assignments are stripped and recorded', () => {
    const command = only('FOO=bar BAZ="a b" git status');
    expect(command.head).toBe('git');
    expect(command.assignments).toEqual(['FOO', 'BAZ']);
    expect(argTexts(command)).toEqual(['status']);
  });

  test('an assignment after the head is an argument', () => {
    const command = only('echo TOKEN=x');
    expect(command.assignments).toEqual([]);
    expect(argTexts(command)).toEqual(['TOKEN=x']);
  });

  test.each([
    ['sudo rm -rf build', ['sudo'], 'rm', ['-rf', 'build']],
    ['sudo -u deploy -E rm x', ['sudo'], 'rm', ['x']],
    ['env -i FOO=1 git status', ['env'], 'git', ['status']],
    ['timeout -s KILL 30 git status', ['timeout'], 'git', ['status']],
    ['timeout 5m bun run test', ['timeout'], 'bun', ['run', 'test']],
    ['nice -n 10 make', ['nice'], 'make', []],
    ['nohup make build', ['nohup'], 'make', ['build']],
    ['sudo timeout 5 env A=1 nice rm x', ['sudo', 'timeout', 'env', 'nice'], 'rm', ['x']],
    ['busybox rm -f x', ['busybox'], 'rm', ['-f', 'x']],
    ['setsid ionice -c 3 make', ['setsid', 'ionice'], 'make', []],
    ['xargs -n 10 rm -f', ['xargs'], 'rm', ['-f']],
    ['xargs -I {} mv {} dest', ['xargs'], 'mv', ['{}', 'dest']],
  ])('%s', (text, wrappers, head, args) => {
    const command = only(text);
    expect(command.wrappers).toEqual(wrappers);
    expect(command.head).toBe(head);
    expect(argTexts(command)).toEqual(args);
  });

  test('xargs marks the command opaque: its arguments arrive on stdin', () => {
    expect(only('xargs rm').opaque).toContain('xargs');
  });

  test('env with nothing to run stays the head: it prints the environment', () => {
    const command = only('env');
    expect(command.head).toBe('env');
    expect(command.wrappers).toEqual([]);
  });

  test('command -v is a lookup, not a wrapper', () => {
    expect(only('command -v git').head).toBe('command');
  });
});

describe('parseShell: redirections', () => {
  test('a file redirection is a write with its target', () => {
    const command = only('echo hi > out.txt');
    expect(argTexts(command)).toEqual(['hi']);
    expect(
      command.redirections.map(r => [r.operator, r.write, resolveWord(r.target, HOME).text])
    ).toEqual([['>', true, 'out.txt']]);
  });

  test.each([
    ['cmd >> log', '>>', true],
    ['cmd 2> err', '>', true],
    ['cmd &> all', '&>', true],
    ['cmd >| forced', '>|', true],
    ['cmd < input', '<', false],
    ['cmd 2>&1', '>&', false],
    ['cmd >&2', '>&', false],
    ['cmd >& both.log', '>&', true],
  ])('%s', (text, operator, write) => {
    const [redirection] = only(text).redirections;
    expect<string | undefined>(redirection?.operator).toBe(operator);
    expect(redirection?.write).toBe(write);
  });

  test('the fd number before a redirection is not an argument', () => {
    expect(argTexts(only('make 2> err.log'))).toEqual([]);
  });

  test('a heredoc body is data, not commands', () => {
    const { commands } = parseShell('cat <<EOF > notes.md\nrm -rf /\nEOF\nls');
    expect(commands.map(command => command.head)).toEqual(['cat', 'ls']);
    expect(commands[0]?.opaque).toEqual([]);
  });

  test('a substitution in an unquoted heredoc body still runs, so it is read', () => {
    const { commands } = parseShell('cat <<EOF\nat $(date) by `whoami`\nEOF');
    expect(commands.map(command => command.head)).toEqual(['cat', 'date', 'whoami']);
    expect(commands[0]?.opaque).toContain('command_substitution');
  });

  test('a quoted heredoc delimiter turns the body into plain text', () => {
    const { commands } = parseShell("cat <<'EOF'\nat $(date)\nEOF");
    expect(commands.map(command => command.head)).toEqual(['cat']);
    expect(commands[0]?.opaque).toEqual([]);
  });

  test('a heredoc fed to an interpreter is opaque', () => {
    expect(only('python3 <<EOF\nprint(1)\nEOF').opaque).toContain('heredoc');
  });

  test('a heredoc fed to a shell is opaque and its body is parsed as commands', () => {
    const { commands } = parseShell("bash <<'EOF'\ngit status\nEOF");
    expect(commands.map(command => command.head)).toEqual(['bash', 'git']);
    expect(commands[0]?.opaque).toContain('heredoc');
    expect(commands[1]?.parent).toBe(0);
  });
});

describe('parseShell: opaque constructs', () => {
  test('command substitution is opaque and its body is parsed too', () => {
    const { commands } = parseShell('echo $(git rev-parse HEAD)');
    expect(commands.map(command => command.head)).toEqual(['echo', 'git']);
    expect(commands[0]?.opaque).toContain('command_substitution');
    expect(commands[1]?.parent).toBe(0);
  });

  test('command substitution inside double quotes is still seen', () => {
    const { commands } = parseShell('echo "now: $(date)"');
    expect(commands.map(command => command.head)).toEqual(['echo', 'date']);
  });

  test('backticks are opaque and parsed', () => {
    const { commands } = parseShell('echo `whoami`');
    expect(commands[0]?.opaque).toContain('command_substitution');
    expect(commands[1]?.head).toBe('whoami');
  });

  test('process substitution is opaque and parsed', () => {
    const { commands } = parseShell('diff <(sort a) <(sort b)');
    expect(commands[0]?.opaque).toContain('process_substitution');
    expect(commands.slice(1).map(command => command.head)).toEqual(['sort', 'sort']);
  });

  test('a substitution inside arithmetic is followed', () => {
    expect(heads('echo $(( 1 + $(id -u) ))')).toEqual(['echo', 'id']);
  });

  test('env that changes directory or runs a string is opaque', () => {
    expect(only('env -C sub make').opaque).toContain('wrapper_option');
    const split = parseShell("env -S 'make build'");
    expect(split.commands[0]?.opaque).toContain('wrapper_option');
    expect(split.commands[1]?.head).toBe('make');
  });

  test('nested substitutions are followed', () => {
    expect(heads('echo $(echo $(id))')).toEqual(['echo', 'echo', 'id']);
  });

  test('bash -c with a literal string is opaque and the string is parsed', () => {
    const { commands } = parseShell("bash -c 'git status && ls'");
    expect(commands.map(command => command.head)).toEqual(['bash', 'git', 'ls']);
    expect(commands[0]?.opaque).toContain('shell_dash_c');
  });

  test('bash -lc is the same construct', () => {
    expect(heads('bash -lc "ls"')).toEqual(['bash', 'ls']);
  });

  test('bash -c with a variable string is opaque with nothing to parse', () => {
    const { commands } = parseShell('bash -c "$CMD"');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.opaque).toContain('shell_dash_c');
  });

  test('eval is opaque and a literal argument is parsed', () => {
    const { commands } = parseShell("eval 'git status'");
    expect(commands[0]?.opaque).toContain('eval');
    expect(commands[1]?.head).toBe('git');
  });

  test('find -exec is opaque and the command it runs is read', () => {
    const { commands } = parseShell("find . -name '*.tmp' -exec rm -f {} \\;");
    expect(commands[0]?.opaque).toContain('find_exec');
    expect(commands[1]?.head).toBe('rm');
    expect(commands[1]?.parent).toBe(0);
  });

  test('alias and function definitions are opaque', () => {
    expect(only("alias gs='git status'").opaque).toContain('alias_or_function');
    const parsed = parseShell('cleanup() { rm -rf build; }; cleanup');
    expect(parsed.opaque).toContain('alias_or_function');
    expect(parsed.commands.map(command => command.head)).toEqual(['rm', 'cleanup']);
  });

  test('nesting past the depth cap is opaque rather than followed forever', () => {
    let text = 'ls';
    for (let i = 0; i < 12; i++) text = `bash -c ${JSON.stringify(text)}`;
    const parsed = parseShell(text);
    expect([...parsed.opaque, ...parsed.commands.flatMap(c => c.opaque)]).toContain(
      'nesting_limit'
    );
  });
});

describe('resolveWord', () => {
  function firstArg(text: string): ReturnType<typeof resolveWord> {
    const [word] = only(text).args;
    if (word === undefined) throw new Error('no argument');
    return resolveWord(word, HOME);
  }

  test('a leading tilde and $HOME resolve to the home directory', () => {
    expect(firstArg('ls ~')).toEqual({ text: HOME, dynamic: false, glob: false });
    expect(firstArg('ls ~/x')).toEqual({ text: `${HOME}/x`, dynamic: false, glob: false });
    expect(firstArg('ls "$HOME"/x')).toEqual({ text: `${HOME}/x`, dynamic: false, glob: false });
    expect(firstArg('ls ${HOME}')).toEqual({ text: HOME, dynamic: false, glob: false });
  });

  test('a tilde that is quoted, mid-word or names a user is not the home directory', () => {
    expect(firstArg('ls "~"').text).toBe('~');
    expect(firstArg('ls HEAD~1').text).toBe('HEAD~1');
    expect(firstArg('ls ~root').dynamic).toBe(true);
  });

  test('any other variable makes the word dynamic', () => {
    expect(firstArg('ls "$DIR"/x')).toEqual({ text: '$DIR/x', dynamic: true, glob: false });
    expect(firstArg('ls ${DIR:-/}').dynamic).toBe(true);
  });

  test('$PWD stands for the working directory when it starts a path', () => {
    expect(firstArg('ls "$PWD"')).toEqual({ text: '.', dynamic: false, glob: false });
    expect(firstArg('ls $PWD/src')).toEqual({ text: './src', dynamic: false, glob: false });
    expect(firstArg('ls ${PWD}/src').text).toBe('./src');
    // `${PWD}x` is a sibling of the working directory, which only the shell can name.
    expect(firstArg('ls ${PWD}x').dynamic).toBe(true);
    expect(firstArg('ls a/$PWD').dynamic).toBe(true);
  });

  test("$'...' is decoded when every escape in it is a plain one", () => {
    expect(firstArg("ls $'\\x2f'")).toEqual({ text: '/', dynamic: false, glob: false });
    expect(firstArg("ls $'a\\tb\\n\\\\\\''").text).toBe("a\tb\n\\'");
    expect(firstArg("ls $'\\055\\055force'").text).toBe('--force');
    expect(firstArg("ls $'\\u002dx'").text).toBe('-x');
    expect(firstArg("ls $'\\cA'").dynamic).toBe(true);
  });

  test('an unquoted glob is flagged, a quoted one is literal', () => {
    expect(firstArg('ls src/*.ts')).toEqual({ text: 'src/*.ts', dynamic: false, glob: true });
    expect(firstArg('ls "src/*.ts"')).toEqual({ text: 'src/*.ts', dynamic: false, glob: false });
    expect(firstArg('ls .[e]nv').glob).toBe(true);
  });

  test('brace expansion makes the word dynamic', () => {
    expect(firstArg('ls /{etc,usr}').dynamic).toBe(true);
    expect(firstArg('ls {}').dynamic).toBe(false);
  });
});
