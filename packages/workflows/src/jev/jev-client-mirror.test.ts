/**
 * The SDLC pack carries a copy of the Jev client. A pack script runs with relative
 * imports inside its own pack and the standard library and nothing else, so it cannot
 * import this package, and the pack's copy is the one a bundled workflow executes.
 *
 * `jev-client.ts` here is the owner; the copy must be the same bytes. This is the enforced
 * conformance between the two: a change made to one side only fails here.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';

const OWNER = join(import.meta.dir, 'jev-client.ts');
const PACK_COPY = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '.archon',
  'workflows',
  'sdlc',
  '.shared',
  'jev-client.ts'
);

test('the SDLC pack carries the Jev client byte for byte', async () => {
  const [owner, copy] = await Promise.all([Bun.file(OWNER).text(), Bun.file(PACK_COPY).text()]);
  // Not `toBe`: a mismatch would print both files. The fix is the same either way.
  expect(
    copy === owner,
    'Edit packages/workflows/src/jev/jev-client.ts, then copy it over .archon/workflows/sdlc/.shared/jev-client.ts'
  ).toBe(true);
});

test('the client imports nothing, so the copy can run where no package resolves', async () => {
  const source = await Bun.file(OWNER).text();
  expect(source).not.toMatch(/^\s*import\s/m);
  expect(source).not.toMatch(/\bfrom\s+['"]/);
  expect(source).not.toMatch(/\brequire\(/);
});
