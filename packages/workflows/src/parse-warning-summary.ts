/**
 * Folds parse warnings for a surface that shows them to a person.
 *
 * The exec-input check writes one warning per node, so a pack whose scripts all
 * read the same ambient variable produces the same paragraph once per node. The
 * full list stays on the run (`workflow_parse_warnings`) and in the CLI; a chat
 * message gets one line per variable instead.
 */

const ENVIRONMENT_READ =
  /^Node '([^']+)' .* reads environment variable '([^']+)', which is not provided by its bindings, declared inputs, or the engine\./;

interface EnvironmentReadGroup {
  readonly variable: string;
  readonly nodes: string[];
  readonly first: string;
}

export function summarizeParseWarnings(warnings: readonly string[]): string[] {
  const entries: (string | EnvironmentReadGroup)[] = [];
  const groups = new Map<string, EnvironmentReadGroup>();
  const seen = new Set<string>();

  for (const warning of warnings) {
    if (seen.has(warning)) continue;
    seen.add(warning);

    const match = ENVIRONMENT_READ.exec(warning);
    if (match === null) {
      entries.push(warning);
      continue;
    }
    const [, node, variable] = match;
    const group = groups.get(variable);
    if (group === undefined) {
      const created = { variable, nodes: [node], first: warning };
      groups.set(variable, created);
      entries.push(created);
    } else if (!group.nodes.includes(node)) {
      group.nodes.push(node);
    }
  }

  return entries.map(entry => {
    if (typeof entry === 'string') return entry;
    if (entry.nodes.length === 1) return entry.first;
    const nodes = entry.nodes.map(node => `'${node}'`).join(', ');
    return (
      `${String(entry.nodes.length)} nodes (${nodes}) read environment variable ` +
      `'${entry.variable}', which is not provided by their bindings, declared inputs, or the engine.`
    );
  });
}
