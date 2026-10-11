/**
 * #6474: `extract --stale` on an unmanaged (non-managed-persistence) brain
 * fenced each stale page's ORIGIN against `targetMetadata`, read once before
 * the walk. A writer rewriting a stale page between that read and the walk
 * made its own endpoint fence stale, so the page stayed stale forever on a
 * continuously-written brain (and pre-#6272 aborted the run). The origin is
 * now fenced by `assertPageRevision` via the live snapshot revision — the
 * managed path's rule — and only genuine target changes stay stale.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import type { PageInput } from '../src/core/types.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

const notePage = (title: string, body: string): PageInput => ({ type: 'note', title, compiled_truth: body, timeline: '' });
const personPage = (title: string, body = ''): PageInput => ({ type: 'person', title, compiled_truth: body, timeline: '' });

async function stampOf(slug: string, sourceId = 'default'): Promise<string | null> {
  const rows = await engine.executeRaw<{ links_extracted_at: string | null }>(
    `SELECT links_extracted_at FROM pages WHERE slug = $1 AND source_id = $2`, [slug, sourceId],
  );
  return rows[0]?.links_extracted_at ?? null;
}

/** Wrap listStalePagesForExtraction so `rewrite` lands between the pre-walk metadata read and the per-page snapshot. */
function rewritingBetweenReadAndWalk(target: BrainEngine, rewrite: () => Promise<unknown>): BrainEngine {
  const real = target.listStalePagesForExtraction.bind(target);
  let fired = false;
  (target as { listStalePagesForExtraction: BrainEngine['listStalePagesForExtraction'] }).listStalePagesForExtraction = async (...args: Parameters<BrainEngine['listStalePagesForExtraction']>) => {
    const rows = await real(...args);
    if (!fired && rows.length) { fired = true; await rewrite(); }
    return rows;
  };
  return target;
}

describe('#6474: extract --stale survives mid-run rewrites', () => {
  test('a stale page rewritten between the metadata read and the walk still extracts and stamps', async () => {
    await engine.putPage('people/alice-example', personPage('Alice Example'));
    await engine.putPage('notes/one-example', notePage('One', 'See [[people/alice-example]].'));
    await engine.putPage('notes/two-example', notePage('Two', 'See [[people/alice-example]].'));

    rewritingBetweenReadAndWalk(engine as unknown as BrainEngine,
      () => engine.putPage('notes/one-example', notePage('One', 'Edited mid-run. See [[people/alice-example]].')));

    const r = await extractStaleFromDB(engine as unknown as BrainEngine,
      { dryRun: false, jsonMode: true, quiet: true, catchUp: false });
    expect(r.pagesProcessed).toBe(3);
    expect(await stampOf('notes/one-example')).not.toBeNull();
    expect(await stampOf('notes/two-example')).not.toBeNull();
  });

  test('a link TARGET rewritten mid-run leaves only its linking pages stale; the run completes', async () => {
    await engine.putPage('people/alice-example', personPage('Alice Example'));
    await engine.putPage('notes/one-example', notePage('One', 'See [[people/alice-example]].'));
    await engine.putPage('notes/two-example', notePage('Two', 'No links here.'));

    // Rewrite the person page (a to-endpoint) between the metadata read and
    // the walk: only pages that link to it defer; the run still completes.
    rewritingBetweenReadAndWalk(engine as unknown as BrainEngine,
      () => engine.putPage('people/alice-example', personPage('Alice Example', 'Edited mid-run.')));

    const r = await extractStaleFromDB(engine as unknown as BrainEngine,
      { dryRun: false, jsonMode: true, quiet: true, catchUp: false });
    expect(r.pagesProcessed).toBeGreaterThanOrEqual(1);
    expect(await stampOf('notes/two-example')).not.toBeNull();
  });
});
