/**
 * #5731 regression — a managed write to a fenceless page must NOT expire
 * cli:-origin (extractor-sourced) facts.
 *
 * canonical-projections' fence reconcile expired EVERY row_num-bearing fact
 * not present in the incoming fence. Conversation pages carry no `## Facts`
 * fence, so the incoming set is empty and any managed write (reconcile
 * --apply, add_timeline_entry) expired the page's extractor facts (20,593 of
 * 20,820 active facts in the report). The fix scopes the expiry to
 * fence-owned rows — `COALESCE(source,'') NOT LIKE 'cli:%'` — mirroring the
 * excludeSourcePrefixes: ['cli:'] guard deleteFactsForPage already applies on
 * the wipe path (#1928). NULL/empty source stays fence-owned by convention.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { prepareCanonicalProjections } from '../src/core/persistence/canonical-projections.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
const SRC = 'default';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

const fence = (rows: string) =>
  `## Facts\n\n${FACTS_FENCE_BEGIN}\n` +
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n' +
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n' +
  `${rows}\n${FACTS_FENCE_END}\n`;

async function put(slug: string, body: string) {
  await engine.putPage(slug, { type: 'entity', title: slug, compiled_truth: body }, { sourceId: SRC });
}

/** Run the projection a managed write would apply for `nextBody` (prior = stored page). */
async function projectNext(slug: string, nextBody: string) {
  const prior = await engine.readPageSnapshot(slug, { sourceId: SRC });
  const project = await prepareCanonicalProjections(engine, parseMarkdown(nextBody, slug), slug, SRC, prior, 'editing');
  await engine.transaction(tx => withCoordinatedWrite(tx, [SRC], () => project(tx)));
}

async function factRows(slug: string) {
  return engine.executeRaw<{ row_num: number | null; source: string | null; expired_at: string | null }>(
    `SELECT row_num, COALESCE(source, '') AS source, expired_at::text AS expired_at FROM facts
       WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id`, [SRC, slug]);
}

describe('#5731 canonical projection expires only fence-owned facts', () => {
  test('managed write to a fenceless page keeps cli:-origin extractor facts', async () => {
    const slug = 'conversations/5731-repro';
    await put(slug, 'chat transcript body');
    await engine.insertFacts(
      [
        { fact: 'alice prefers async standups', kind: 'fact', source: 'cli:extract-conversation-facts', row_num: 0, source_markdown_slug: slug },
        { fact: 'alice owns the payments roadmap', kind: 'fact', source: 'cli:extract-conversation-facts', row_num: 1, source_markdown_slug: slug },
        // fence-owned by convention (non-cli source) — still in expiry scope.
        { fact: 'stale fence fact', kind: 'fact', source: 'fence', row_num: 2, source_markdown_slug: slug },
        // empty source is fence-default — also stays in expiry scope.
        { fact: 'blank-source fact', kind: 'fact', source: '', row_num: 3, source_markdown_slug: slug },
      ],
      { source_id: SRC },
    );

    await projectNext(slug, 'chat transcript body — edited, still no facts fence');

    const rows = await factRows(slug);
    expect(rows.map(r => [r.row_num, r.source, r.expired_at !== null] as const)).toEqual([
      [0, 'cli:extract-conversation-facts', false],
      [1, 'cli:extract-conversation-facts', false],
      [null, 'fence', true],
      [null, '', true],
    ]);
  });

  test('a fence row dropped from the fence still expires (fenced page)', async () => {
    const slug = 'people/5731-fence';
    const v1 = fence('| 1 | kept claim | fact | 1.0 | private | medium | | | | |');
    await put(slug, v1);
    await projectNext(slug, v1); // materializes the fence row into facts

    expect((await factRows(slug)).map(r => [r.row_num, r.expired_at !== null])).toEqual([[1, false]]);

    await projectNext(slug, 'body without a facts fence'); // fence removed entirely
    const rows = await factRows(slug);
    expect(rows[0].expired_at).not.toBeNull();
    expect(rows[0].row_num).toBeNull();
  });
});
