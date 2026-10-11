import { describe, expect, test } from 'bun:test';
import {
  MAX_SCRIPT_ITEMS,
  MAX_WRAPPER_DEPTH,
  parseArgv,
  parseShell,
  renderWord,
  resolveWord,
  shellInvocation,
  type ShellCommand,
} from './shell-tokens';

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

  test('a program handed to an interpreter on a heredoc is left for the rules to read, like `-c` code', () => {
    const command = only('python3 <<EOF\nprint(1)\nEOF');
    expect(command.opaque).not.toContain('heredoc');
    expect(command.stdin.join('')).toContain('print(1)');
  });

  test('a heredoc fed to a command that is neither a sink nor an interpreter is opaque', () => {
    expect(only('mytool <<EOF\nprint(1)\nEOF').opaque).toContain('heredoc');
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

  test('env -C is where the command runs; env -S is a script, attached or not', () => {
    const moved = only('env -C sub make');
    expect(moved.head).toBe('make');
    expect(moved.chdir === undefined ? undefined : resolveWord(moved.chdir, HOME).text).toBe('sub');
    expect(moved.opaque).toEqual([]);
    for (const text of [
      "env -S 'make build'",
      "env -S'make build'",
      "env --split-string='make build'",
    ]) {
      const split = parseShell(text);
      expect(split.commands[0]?.opaque).toContain('wrapper_option');
      expect(split.commands[1]?.head).toBe('make');
    }
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

  test('bash -c with a variable string is opaque, and the string is read as written', () => {
    const { commands } = parseShell('bash -c "$CMD"');
    expect(commands[0]?.opaque).toContain('shell_dash_c');
    expect(commands[1]?.opaque).toContain('variable_head');
  });

  test('a -c script holding expansions is still read, expansions kept as written', () => {
    const { commands } = parseShell('bash -c "cd $DIR && rm -rf $HOME"');
    expect(commands.map(command => command.head)).toEqual(['bash', 'cd', 'rm']);
    expect(argTexts(commands[2] as ShellCommand)).toEqual(['-rf', HOME]);
  });

  test.each([
    ["bash -c -- 'ls a'", 'ls a'],
    ["sh -c -e 'ls b'", 'ls b'],
    ["bash -o pipefail -c 'ls c'", 'ls c'],
    ["bash -lc 'ls d' arg0", 'ls d'],
  ])('the script of %s is the first word that is not an option', (text, script) => {
    const [shell, nested] = parseShell(text).commands;
    expect(shellInvocation(shell?.args ?? []).dashC).toBe(true);
    expect(nested === undefined ? '' : `${nested.head} ${argTexts(nested).join(' ')}`).toBe(script);
  });

  test('a shell without -c has no script', () => {
    const invocation = shellInvocation(only('bash run.sh --flag').args);
    expect(invocation.dashC).toBe(false);
    expect(invocation.script).toBeUndefined();
    expect(invocation.operands.map(renderWord)).toEqual(['run.sh', '--flag']);
  });

  test('an alias value is read as the script it will run', () => {
    const { commands } = parseShell("alias wipe='git status'");
    expect(commands.map(command => command.head)).toEqual(['alias', 'git']);
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
    expect(parseShell("alias gs='git status'").commands[0]?.opaque).toContain('alias_or_function');
    expect(heads('function wipe { rm -rf build; }; wipe')).toEqual(['rm', 'wipe']);
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

describe('parseShell: heredoc delimiters are never expanded', () => {
  test.each([
    ['<<$HOME', '$HOME'],
    ['<<"$HOME"', '$HOME'],
    ['<<${HOME}', '${HOME}'],
    ['<<$PWD', '$PWD'],
    ['<<~', '~'],
    ["<<'E O F'", 'E O F'],
    ['<<\\EOF', 'EOF'],
    ['<<$(echo hi)', '$(echo hi)'],
  ])('cat %s ends at a line reading %s', (operator, terminator) => {
    const { commands } = parseShell(`cat ${operator}\nbody line\n${terminator}\nls`);
    expect(commands.map(command => command.head)).toEqual(['cat', 'ls']);
    expect(commands[0]?.stdin).toEqual(['body line']);
  });

  test('a line that only looks like the expanded delimiter does not end the body', () => {
    const { commands } = parseShell('cat <<$HOME\n~\n$HOME\nls');
    expect(commands.map(command => command.head)).toEqual(['cat', 'ls']);
    expect(commands[0]?.stdin).toEqual(['~']);
  });
});

describe('parseShell: arithmetic is one word, not a redirection', () => {
  test.each([
    'echo $[1<<2]',
    'echo $((1<<2))',
    '(( x = 1 << 2 ))',
    'if (( x << 2 )); then true; fi',
  ])('%s leaves the next line a command', text => {
    const { commands } = parseShell(`${text}\nls\n2`);
    expect(commands.some(command => command.head === 'ls')).toBe(true);
    expect(commands.flatMap(command => command.stdin).join('\n')).not.toContain('ls');
  });

  test('nested subshells are not arithmetic', () => {
    expect(heads('((ls; pwd) | wc)')).toEqual(['ls', 'pwd', 'wc']);
  });

  test('a substitution inside old-style arithmetic is followed', () => {
    expect(heads('echo $[ $(id -u) + 1 ]')).toEqual(['echo', 'id']);
  });
});

describe('parseShell: wrappers', () => {
  test('a long chain of nested wrappers is stripped to the command behind it', () => {
    const command = only(`${'nice '.repeat(20)}git status`);
    expect(command.head).toBe('git');
    expect(command.wrappers).toHaveLength(20);
  });

  test('a run of empty substitutions is not free: each script read costs one item of the budget', () => {
    const empty = '$()';
    expect(parseShell(`echo "${empty.repeat(100)}"`).overBudget).toBe(false);
    expect(parseShell(`echo "${empty.repeat(MAX_SCRIPT_ITEMS + 1)}"`).overBudget).toBe(true);
  });

  test('a chain longer than is peeled puts the script over its reading budget, never hides the command', () => {
    expect(parseShell(`${'nice '.repeat(MAX_WRAPPER_DEPTH)}git status`).overBudget).toBe(false);
    expect(parseShell(`${'nice '.repeat(MAX_WRAPPER_DEPTH + 1)}git status`).overBudget).toBe(true);
  });

  test('a value attached to a wrapper option or ending a cluster is consumed', () => {
    expect(only('sudo -uroot rm x').head).toBe('rm');
    expect(only('timeout -sKILL 5 make').head).toBe('make');
    expect(only('xargs -0n1 rm').head).toBe('rm');
    expect(only('nice -n5 make').head).toBe('make');
  });

  test('a file a wrapper writes is recorded, attached or separate', () => {
    for (const text of ['time -o out.txt ls', 'time -oout.txt ls', 'strace -f -o out.txt ls']) {
      const command = only(text);
      expect(command.head).toBe('ls');
      expect(command.wrapperTargets.map(renderWord)).toEqual(['out.txt']);
    }
  });

  test('words a wrapper consumed stay visible', () => {
    expect(only('xargs -a list.txt echo').wrapperWords.map(renderWord)).toEqual(['-a', 'list.txt']);
    expect(only('flock build/lock make').wrapperWords.map(renderWord)).toEqual(['build/lock']);
  });

  test('$SHELL as the command is a shell', () => {
    const command = only('$SHELL');
    expect(command.head).toBe('sh');
    expect(command.opaque).toContain('variable_head');
  });
});

describe('parseShell: groups stay inside the pipeline they stand in', () => {
  function piped(text: string, from: string, to: string): boolean {
    const { commands } = parseShell(text);
    const earlier = commands.find(command => command.head === from);
    const later = commands.find(command => command.head === to);
    if (earlier === undefined || later === undefined) throw new Error('command not found');
    // Deepest pipeline the two share, and whether the first sits at an earlier stage of it.
    for (let level = earlier.pipelinePath.length - 1; level >= 0; level--) {
      const mine = earlier.pipelinePath[level];
      const theirs = later.pipelinePath.find(stage => stage.id === mine?.id);
      if (mine !== undefined && theirs !== undefined) return mine.stage < theirs.stage;
    }
    return false;
  }

  test.each([
    '(curl u) | sh',
    '{ curl u; } | sh',
    'curl u | (sh)',
    'curl u | { sh; }',
    'curl u | if true; then sh; fi',
    'curl u | while read l; do sh; done',
    '(true; curl u) | cat | sh',
    '( (curl u) ) | sh',
  ])('%s pipes curl into sh', text => {
    expect(piped(text, 'curl', 'sh')).toBe(true);
  });

  test.each([
    '(curl u; sh)',
    'curl u; sh',
    '(curl u > f; cat f | sh)',
    '{ curl u; }; sh',
    'if curl u; then sh; fi',
    'sh | curl u',
  ])('%s does not', text => {
    expect(piped(text, 'curl', 'sh')).toBe(false);
  });

  test('a case pattern is not a command and does not unbalance the groups', () => {
    const { commands } = parseShell('case "$x" in a*) ls ;; *) pwd ;; esac; (cd src); id');
    expect(commands.map(command => command.head)).toEqual(['ls', 'pwd', 'cd', 'id']);
    expect(commands.every(command => !command.opaque.includes('variable_head'))).toBe(true);
  });
});

describe('parseShell: output process substitution', () => {
  test('the command inside >( ) reads what its holder writes', () => {
    const { commands } = parseShell('curl u | tee >(sh) > /dev/null');
    const sh = commands.find(command => command.head === 'sh');
    expect(sh?.via).toBe('sink');
    expect(commands[sh?.parent ?? -1]?.head).toBe('tee');
  });

  test('the command inside <( ) is an ordinary substitution', () => {
    const { commands } = parseShell('diff <(sort a) b');
    expect(commands.find(command => command.head === 'sort')?.via).toBe('substitution');
  });
});

describe('tilde after = in an assignment-shaped argument', () => {
  test('is the home directory, as bash expands it', () => {
    const [arg] = only('dd of=~/.profile').args;
    expect(arg === undefined ? '' : resolveWord(arg, HOME).text).toBe(`of=${HOME}/.profile`);
    const [paths] = only('tool PATH=~/a:~/b').args;
    expect(paths === undefined ? '' : resolveWord(paths, HOME).text).toBe(
      `PATH=${HOME}/a:${HOME}/b`
    );
  });

  test('is literal after a flag or in the middle of a plain word', () => {
    const [flag] = only('tool --out=~/x').args;
    expect(flag === undefined ? '' : resolveWord(flag, HOME).text).toBe('--out=~/x');
    const [plain] = only('ls a~/b').args;
    expect(plain === undefined ? '' : resolveWord(plain, HOME).text).toBe('a~/b');
  });
});

describe('parseArgv', () => {
  test('reads already-split words as one command, wrappers and scripts included', () => {
    const words = only("x sudo bash -c 'ls'").args;
    const { commands } = parseArgv(words);
    expect(commands.map(command => command.head)).toEqual(['bash', 'ls']);
    expect(commands[0]?.wrappers).toEqual(['sudo']);
  });

  test('a keyword among the words is an ordinary word', () => {
    expect(parseArgv(only('x if then').args).commands[0]?.head).toBe('if');
  });
});
