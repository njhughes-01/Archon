/**
 * The programs a gated Codex run needs on disk, as text. They are written into
 * the run's private directory rather than shipped as files, so a compiled
 * Archon binary — which has no source tree beside it — carries them too.
 *
 * Codex lets a tool run whenever its hook fails: a crash, a timeout, output it
 * cannot parse, even a denial with an empty reason. So nothing here may fail
 * open. Every path that is not a verified "allow" ends in exit status 2 with a
 * reason on stderr, which is Codex's blocking exit. Stdout is never used,
 * because Codex runs hooks through the user's login shell and a profile that
 * prints there would corrupt a JSON answer into an ignored one.
 */

/** Exit status Codex reads as "block this tool call; the reason is on stderr". */
export const HOOK_BLOCK_EXIT_CODE = 2;

/** Shown to the model when the hook cannot get a decision from the provider. */
export const GATE_UNREACHABLE_REASON =
  "Archon's tool gate is unreachable, so this action was not run. Do not retry it; report the work as blocked in your output.";

/** Quotes one word for a POSIX shell. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The hook body, run by Archon's own runtime. It forwards Codex's payload over
 * the run's socket and exits 0 only on an answer that carries the run's token
 * and says "allow".
 *
 * `argv[2]` is its deadline in milliseconds.
 */
export function renderHookProgram(): string {
  return `// Archon tool gate hook for Codex. Written per run; removed when the run ends.
// Exit 0 lets the tool run. Exit ${String(HOOK_BLOCK_EXIT_CODE)} blocks it, with the reason on stderr.
import net from 'node:net';
import { readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNREACHABLE = ${JSON.stringify(GATE_UNREACHABLE_REASON)};
const directory = path.dirname(fileURLToPath(import.meta.url));
const deadlineMs = Number(process.argv[2]);

function block(reason) {
  try {
    writeSync(2, reason + '\\n');
  } catch {}
  process.exit(${String(HOOK_BLOCK_EXIT_CODE)});
}

setTimeout(() => block(UNREACHABLE), Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 1);

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  // Read first: every exit below then happens after Codex has finished writing.
  const input = await readStdin();
  const token = readFileSync(path.join(directory, 'token'), 'utf8').trim();
  if (token === '') block(UNREACHABLE);
  const payload = JSON.parse(input);
  const socket = net.connect(path.join(directory, 'gate.sock'));
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write(JSON.stringify({ token, payload }) + '\\n');
  });
  socket.on('data', chunk => {
    buffer += chunk;
    const end = buffer.indexOf('\\n');
    if (end === -1) return;
    let answer;
    try {
      answer = JSON.parse(buffer.slice(0, end));
    } catch {
      block(UNREACHABLE);
    }
    // Only the provider that wrote the token file can echo it back.
    if (typeof answer !== 'object' || answer === null || answer.token !== token) block(UNREACHABLE);
    if (answer.decision === 'allow') process.exit(0);
    if (answer.decision === 'deny' && typeof answer.reason === 'string' && answer.reason.trim() !== '') {
      block(answer.reason);
    }
    block(UNREACHABLE);
  });
  socket.on('error', () => block(UNREACHABLE));
  socket.on('close', () => block(UNREACHABLE));
}

main().catch(() => block(UNREACHABLE));
`;
}

/**
 * The command Codex runs as the hook. It changes into the private directory
 * first: Codex starts hooks in the repository, and the runtime reads
 * `bunfig.toml` and `.env` from its working directory, which the model can
 * write. It also turns a runtime that cannot start, or dies, into a block.
 *
 * `BUN_BE_BUN=1` makes a compiled Archon binary act as the Bun runtime it
 * embeds; a plain `bun` ignores it.
 */
export function renderHookWrapper(options: {
  directory: string;
  runtimePath: string;
  programPath: string;
  deadlineMs: number;
}): string {
  // Reads whatever is left of the payload before exiting, so Codex is never
  // left writing to a hook that has gone.
  const blocked = `cat > /dev/null 2>&1; echo ${shellQuote(GATE_UNREACHABLE_REASON)} >&2; exit ${String(HOOK_BLOCK_EXIT_CODE)}`;
  return `#!/bin/sh
# Archon tool gate hook for Codex. Written per run; removed when the run ends.
cd ${shellQuote(options.directory)} || { ${blocked}; }
BUN_BE_BUN=1 ${shellQuote(options.runtimePath)} ${shellQuote(options.programPath)} ${shellQuote(String(options.deadlineMs))}
status=$?
if [ "$status" -eq 0 ] || [ "$status" -eq ${String(HOOK_BLOCK_EXIT_CODE)} ]; then exit "$status"; fi
${blocked}
`;
}

/**
 * Stands in for the Codex binary so one extra flag reaches `codex exec`: the
 * SDK builds the command line itself and has no option for extra arguments.
 * It replaces itself with the real binary, so signals the SDK sends on abort
 * reach Codex. Anything but `exec` is refused rather than passed through,
 * because it would run without the flag and therefore without the gate.
 */
export function renderCodexLauncher(options: {
  codexCommand: readonly string[];
  flag: string;
}): string {
  return `#!/bin/sh
# Archon launcher for a gated Codex run. Written per run; removed when the run ends.
if [ "$1" != "exec" ]; then
  echo 'archon: the gated Codex launcher only supports the exec subcommand' >&2
  exit 64
fi
shift
exec ${options.codexCommand.map(shellQuote).join(' ')} exec ${shellQuote(options.flag)} "$@"
`;
}
