import { describe, expect, test } from 'bun:test';
import { parseWorkflow } from './loader';
import { summarizeParseWarnings } from './parse-warning-summary';

function envRead(node: string, variable: string): string {
  return (
    `Node '${node}' script (/pack/scripts/${node}.ts line 14) reads environment variable ` +
    `'${variable}', which is not provided by its bindings, declared inputs, or the engine. ` +
    `Available bindings/inputs: 'errors', 'pr'.`
  );
}

describe('summarizeParseWarnings', () => {
  test('folds the same unprovided variable read by many nodes into one line', () => {
    const summary = summarizeParseWarnings([
      envRead('ci-note', 'PACK_SETTING'),
      envRead('read-pr-body', 'PACK_SETTING'),
      envRead('flip-ready', 'PACK_SETTING'),
    ]);

    expect(summary).toEqual([
      "3 nodes ('ci-note', 'read-pr-body', 'flip-ready') read environment variable " +
        "'PACK_SETTING', which is not provided by their bindings, declared inputs, or the engine.",
    ]);
  });

  test('keeps a single read, other warnings and distinct variables as they are', () => {
    const unknownKey = "Node 'plan': unknown key 'interactive' will be ignored.";
    const single = envRead('verify', 'PROJECT_TOKEN');

    expect(
      summarizeParseWarnings([
        unknownKey,
        envRead('a', 'ONE'),
        single,
        envRead('b', 'ONE'),
        unknownKey,
      ])
    ).toEqual([
      unknownKey,
      "2 nodes ('a', 'b') read environment variable 'ONE', which is not provided by their " +
        'bindings, declared inputs, or the engine.',
      single,
    ]);
  });

  test('folds the warnings the validator really writes', () => {
    const result = parseWorkflow(
      `name: two-readers
description: Two nodes read the same ambient variable
nodes:
  - id: first
    script: |
      console.log(process.env.PROJECT_TOKEN)
    runtime: bun
  - id: second
    script: |
      console.log(process.env.PROJECT_TOKEN)
    runtime: bun
    depends_on: [first]
`,
      'two-readers.yaml'
    );

    expect(result.warnings).toHaveLength(2);
    expect(summarizeParseWarnings(result.warnings ?? [])).toEqual([
      "2 nodes ('first', 'second') read environment variable 'PROJECT_TOKEN', which is not " +
        'provided by their bindings, declared inputs, or the engine.',
    ]);
  });
});
