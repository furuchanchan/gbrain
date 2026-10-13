/**
 * #6610 regression: on a classic brain, `extract_facts` could never fence an
 * unfenced fact row whose entity page is database-only. `planUnfencedFacts`
 * saw the derived canonical file missing, pushed the page into
 * `missing_files` ("fenced by the cycle on the host that holds the file" —
 * no such host), and booked a `facts.fence` halt every run while
 * `pendingLegacyRows` kept the row gating the phantom-redirect pass.
 *
 * Fix: a page with no recorded `source_path` is database-only by
 * construction, so it fences through the database body (like `remember` and
 * the managed path) instead of waiting for a file that can never exist. A
 * page WITH a recorded path keeps the missing-file verdict — its file may
 * return.
 *
 * Pinned here: an unmanaged brain (filesystem source, managed off), a page
 * committed database-only (no `source_path`, no file), and a fact inserted
 * unfenced before the page existed. The plan keeps the group out of
 * `missing_files` as `dbOnly`; fencing stamps `row_num` and mirrors the
 * fence into the page body; a second run is a no-op.
 */

import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { fenceUnfencedFacts, planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { testBackends, requirePostgresTestDatabase } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'people/carol-example';
const CLAIM = 'Carol Example prefers coffee';

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: an unfenced row on a database-only page fences through the DB body, not missing_files`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-dbonly-6610-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          expect(await managedPersistenceEnabled(engine)).toBe(false);
          const root = join(home, 'brain');
          mkdirSync(join(root, 'people'), { recursive: true });
          await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);

          // Fact saved before its entity page exists: unfenced (row_num NULL),
          // entity_slug set — remember's legacy DB-only path.
          const fact = await engine.insertFact(
            { fact: CLAIM, kind: 'fact', confidence: 1, source: 'remember', visibility: 'world', notability: 'medium', entity_slug: SLUG },
            { source_id: 'default' },
          );

          // Page created database-only: no source_path, no canonical file.
          await engine.putPage(SLUG, { type: 'person', title: 'Carol Example', compiled_truth: '# Carol Example\n' });
          const [pathRow] = await engine.executeRaw<{ source_path: string | null }>(
            'SELECT source_path FROM pages WHERE slug = $1 AND source_id = $2', [SLUG, 'default']);
          expect(pathRow.source_path).toBeNull();

          // The plan keeps the group: db-only, not missing_files.
          const plan = await planUnfencedFacts(engine, { sourceId: 'default' });
          const key = `default\0${SLUG}`;
          expect(plan.groups.has(key)).toBe(true);
          expect(plan.dbOnly.has(key)).toBe(true);
          expect(plan.outcome.missing_files).toEqual([]);

          const outcome = await fenceUnfencedFacts(engine, plan);
          expect(outcome.fenced).toBe(1);
          expect(outcome.failed_pages).toEqual([]);
          expect(outcome.missing_files).toEqual([]);

          const [row] = await engine.executeRaw<{ row_num: number | null; source_markdown_slug: string | null }>(
            'SELECT row_num, source_markdown_slug FROM facts WHERE id = $1', [fact.id]);
          expect(row.row_num).toBe(1);
          expect(row.source_markdown_slug).toBe(SLUG);

          // The fence is readable in the page's stored body.
          const page = await engine.getPage(SLUG, { sourceId: 'default' });
          expect(parseFactsFence(page!.compiled_truth).facts.map(f => f.claim)).toEqual([CLAIM]);

          // Idempotent: nothing remains to fence, nothing halts.
          const again = await fenceUnfencedFacts(engine, await planUnfencedFacts(engine, { sourceId: 'default' }));
          expect(again.fenced).toBe(0);
          expect(again.missing_files).toEqual([]);
          expect(again.failed_pages).toEqual([]);
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);

  test(`${backend}: a page with a recorded source_path but missing file still reports missing_files`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-dbonly-6610b-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          expect(await managedPersistenceEnabled(engine)).toBe(false);
          const root = join(home, 'brain');
          mkdirSync(join(root, 'people'), { recursive: true });
          await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);

          await engine.insertFact(
            { fact: CLAIM, kind: 'fact', confidence: 1, source: 'remember', visibility: 'world', notability: 'medium', entity_slug: SLUG },
            { source_id: 'default' },
          );
          // File-backed page whose canonical file vanished (sync deletion on
          // another host): recorded source_path, no file — keeps the old verdict.
          const row = await engine.putPage(SLUG, { type: 'person', title: 'Carol Example', compiled_truth: '# Carol Example\n' });
          await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${SLUG}.md`, row.id]);

          const plan = await planUnfencedFacts(engine, { sourceId: 'default' });
          const key = `default\0${SLUG}`;
          expect(plan.groups.has(key)).toBe(false);
          expect(plan.dbOnly.has(key)).toBe(false);
          expect(plan.outcome.missing_files.length).toBe(1);
          expect(plan.outcome.missing_files[0]).toContain(SLUG);
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
}
