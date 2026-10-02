/**
 * #5889 — remote `searchTitles` ranks the title-only vector
 * (`to_tsvector(title)` under requireSafeChunks) with ts_rank_cd WITHOUT a
 * normalization flag: every title containing the query word once scored the
 * same, ties fell to `p.id`, and a page whose title IS the query could sit
 * below thousands of longer titles — outside the `max(2*limit, 50)` rows the
 * exact-lookup tier (#1663) reads. Length normalization (flag 2) puts the
 * shortest matching titles first.
 *
 * PGLite is real Postgres — ts_rank_cd(..., 2) behaves identically; the
 * local path (p.search_vector) is untouched.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config, last_sync_at)
     VALUES ('g1', 'g1', '{"kind":"git"}'::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
  );
});

const remote = { requireSafeChunks: true, limit: 50 } as const;

// putPage leaves text_projection_revision for the projection pass; the search
// arms gate on it, so seed it the way the pass would.
const project = async () => {
  await engine.executeRaw(
    `UPDATE pages SET text_projection_revision = knowledge_revision,
                      chunker_version = ${SAFE_FENCE_CHUNKER_VERSION}`,
  );
};

describe('searchTitles remote title arm — length normalization (#5889)', () => {
  test('an exact-title page outranks a crowd of longer one-occurrence titles for a remote caller', async () => {
    // 60 longer titles each containing the word once; they tie on the
    // unnormalized rank and pre-fix order by lowest page id.
    for (let i = 0; i < 60; i++) {
      await engine.putPage(`meetings/acme-sync-${i}`, {
        type: 'meeting',
        title: `acme weekly sync notes ${i}`,
        compiled_truth: 'notes',
      }, { sourceId: 'g1' });
    }
    // Inserted LAST (highest id): pre-fix this page sorts below all 60 ties.
    await engine.putPage('projects/acme', {
      type: 'project',
      title: 'acme',
      compiled_truth: 'the acme project',
    }, { sourceId: 'g1' });
    await project();

    const rows = await engine.searchTitles('acme', { ...remote });
    expect(rows[0]?.slug).toBe('projects/acme');
  });

  test('two exact-title pages both surface before the long-title crowd', async () => {
    for (let i = 0; i < 60; i++) {
      await engine.putPage(`meetings/acme-sync-${i}`, {
        type: 'meeting',
        title: `acme weekly sync notes ${i}`,
        compiled_truth: 'notes',
      }, { sourceId: 'g1' });
    }
    await engine.putPage('companies/acme', {
      type: 'company',
      title: 'acme',
      compiled_truth: 'the acme company',
    }, { sourceId: 'g1' });
    await engine.putPage('projects/acme', {
      type: 'project',
      title: 'acme',
      compiled_truth: 'the acme project',
    }, { sourceId: 'g1' });
    await project();

    const rows = await engine.searchTitles('acme', { ...remote });
    const firstTwo = new Set(rows.slice(0, 2).map((r) => r.slug));
    expect(firstTwo).toEqual(new Set(['companies/acme', 'projects/acme']));
  });

  test('the local (p.search_vector) arm is unchanged in shape — still returns the exact page', async () => {
    for (let i = 0; i < 60; i++) {
      await engine.putPage(`meetings/acme-sync-${i}`, {
        type: 'meeting',
        title: `acme weekly sync notes ${i}`,
        compiled_truth: 'notes',
      }, { sourceId: 'g1' });
    }
    await engine.putPage('projects/acme', {
      type: 'project',
      title: 'acme',
      compiled_truth: 'the acme project',
    }, { sourceId: 'g1' });
    await project();

    const rows = await engine.searchTitles('acme', { limit: 100 });
    expect(rows.map((r) => r.slug)).toContain('projects/acme');
  });
});
