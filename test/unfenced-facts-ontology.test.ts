/**
 * #6264 — ontology observations (`dimension IS NOT NULL`) are never
 * fence-owned. The maintenance sweep's unfenced-facts pass must not fence
 * them onto a page's `## Facts` table (an acknowledged observation then
 * becomes a fence row; the next ordinary rewrite that doesn't list it
 * retires it as a row that left the table — N1-ci's lost-write bug), and
 * the wipe path must unstamp — not delete — a row a pre-fix sweep already
 * fenced so it survives as a pure ontology row.
 *
 * Fails when: planUnfencedFacts selects dimension rows, or
 * deleteFactsForPage / insertFacts deleteForPageFirst deletes or leaves
 * them stamped (stamped rows hold a slot in the (source_id,
 * source_markdown_slug, row_num) UNIQUE keyspace the re-insert rebuilds),
 * or listExistingFactsForPage compares them against the fence.
 * Seams: none; real PGLite for the unit tests and an
 * isolatedSharedSkillsEngine unmanaged brain for the cycle-level one.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { planUnfencedFacts, fenceableRowCount } from '../src/core/facts/unfenced-facts.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'people/sarah-chen';

describe('planUnfencedFacts skips ontology rows (#6264)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title) VALUES ('default', $1, 'person', 'Sarah')`, [SLUG]);
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await engine.executeRaw('DELETE FROM facts'); });

  test('an ontology observation is not a fence candidate; an ordinary unfenced row is', async () => {
    await engine.mergeOntologyFact({ entitySlug: SLUG, dimension: 'role', value: 'founder', source: 'meetings/a' });
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source) VALUES ('default', $1, 'Sarah advises Acme', 'fact', 'private', 'medium', 'test')`,
      [SLUG],
    );
    // Managed mode exercises the planner's page-exists path without a
    // canonical file checkout; the writer guard makes all writes refuse
    // once enabled, so the flag toggles around the read-only plan call.
    await engine.executeRaw(`UPDATE persistence_brain SET enabled = true WHERE singleton = 1`);
    try {
      const plan = await planUnfencedFacts(engine);
      expect(fenceableRowCount(plan)).toBe(1);
      expect(plan.outcome.scanned).toBe(1);
      const rows = [...plan.groups.values()].flat();
      expect(rows.map(r => r.fact)).toEqual(['Sarah advises Acme']);
    } finally {
      await engine.executeRaw(`UPDATE persistence_brain SET enabled = false WHERE singleton = 1`);
    }
  });
});

describe('page wipe unstamps — not deletes — ontology rows (#6264)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title) VALUES ('default', $1, 'person', 'Sarah')`, [SLUG]);
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await engine.executeRaw('DELETE FROM facts'); });

  /** Stamp an ontology row the way a pre-fix sweep's fence pass left it. */
  const stampOntologyRow = async () => {
    await engine.mergeOntologyFact({ entitySlug: SLUG, dimension: 'role', value: 'founder', source: 'meetings/a' });
    await engine.executeRaw(
      `UPDATE facts SET row_num = 5, source_markdown_slug = $1 WHERE dimension IS NOT NULL`,
      [SLUG],
    );
  };
  const ontologyRow = async () =>
    (await engine.executeRaw<{ id: number; row_num: number | null; source_markdown_slug: string | null; dimension: string | null }>(
      `SELECT id, row_num, source_markdown_slug, dimension FROM facts WHERE dimension IS NOT NULL`,
    ))[0];

  test('deleteFactsForPage keeps the row and clears the fence stamp', async () => {
    await stampOntologyRow();
    await engine.executeRaw(
      `INSERT INTO facts (source_id, source_markdown_slug, row_num, fact, kind, visibility, notability, source) VALUES ('default', $1, 1, 'fence fact', 'fact', 'private', 'medium', 'test')`,
      [SLUG],
    );
    const { deleted } = await engine.deleteFactsForPage(SLUG, 'default');
    expect(deleted).toBe(1); // only the genuine fence row
    const row = await ontologyRow();
    expect(row).toMatchObject({ dimension: 'role', row_num: null, source_markdown_slug: null });
    expect(await engine.getOntology(SLUG)).toHaveLength(1);
  });

  test('insertFacts deleteForPageFirst unstamps inside the transaction, freeing the row_num keyspace', async () => {
    await stampOntologyRow();
    // Re-inserting a fence row at the stamped row_num must not hit
    // idx_facts_fence_key, and the observation must survive.
    const r = await engine.insertFacts(
      [{ fact: 'Sarah joined Acme', source: 'mcp:extract_facts', row_num: 5, source_markdown_slug: SLUG }],
      { source_id: 'default' },
      { deleteForPageFirst: { slug: SLUG } },
    );
    expect(r.inserted).toBe(1);
    const row = await ontologyRow();
    expect(row).toMatchObject({ dimension: 'role', row_num: null, source_markdown_slug: null });
  });
});

describe('extract_facts reconcile keeps stamped ontology rows (#6264)', () => {
  test('a pre-fix stamped observation survives the reconcile as a pure ontology row', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-ontology-fence-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(undefined);
        try {
          const fence = `## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | Sarah advises Acme | fact | 1.0 | world | high | 2024-01-01 |  | notes |  |\n<!--- gbrain:facts:end -->\n`;
          await engine.putPage(SLUG, { type: 'person', title: 'Sarah', compiled_truth: `# Sarah\n\nProse.\n\n${fence}`, timeline: '', frontmatter: {} });
          await engine.mergeOntologyFact({ entitySlug: SLUG, dimension: 'role', value: 'founder', source: 'meetings/a' });
          // Pre-fix sweep damage: the observation was fenced onto the page.
          await engine.executeRaw(
            `UPDATE facts SET row_num = 7, source_markdown_slug = $1 WHERE dimension IS NOT NULL`,
            [SLUG],
          );
          const result = await runExtractFacts(engine, { slugs: [SLUG], pageLockRoot: home });
          expect(result.pagesFailed).toBe(0);
          // The observation stays queryable and returns to the unfenced
          // ontology state; it is not retired as a row that left the fence.
          const o = await engine.getOntology(SLUG);
          expect(o.map(r => r.value)).toEqual(['founder']);
          const [row] = await engine.executeRaw<{ row_num: number | null; source_markdown_slug: string | null; expired_at: Date | null }>(
            `SELECT row_num, source_markdown_slug, expired_at FROM facts WHERE dimension IS NOT NULL`,
          );
          expect(row).toMatchObject({ row_num: null, source_markdown_slug: null, expired_at: null });
        } finally {
          await close();
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
