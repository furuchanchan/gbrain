/**
 * #6249 — `edge-proposals list --limit` obeys the D4 numeric-flag contract:
 * a malformed, out-of-range or missing value (either spelling) is a usage
 * error before any query, never `LIMIT NaN` reaching the database; the
 * `--limit=N` spelling is honored; valid values keep the 1000 cap.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importFromContent } from '../src/core/import-file.ts';
import { runEdgeProposals } from '../src/commands/edge-proposals.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'ep-home-'));
  const audit = mkdtempSync(join(tmpdir(), 'ep-audit-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(audit, { recursive: true, force: true });
  }
}

async function seedProposals(n: number): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ep-brain-'));
  await engine.executeRaw(`INSERT INTO sources(id, name, local_path) VALUES ('main', 'main', $1)`, [root]);
  const md = (s: string) => `---\ntitle: ${s}\ntype: person\n---\n${s}`;
  await importFromContent(engine, 'people/sub', md('subject'), { sourceId: 'main' });
  await importFromContent(engine, 'people/a', md('a'), { sourceId: 'main' });
  await importFromContent(engine, 'people/b', md('b'), { sourceId: 'main' });
  await importFromContent(engine, 'people/c', md('c'), { sourceId: 'main' });
  const ids = Object.fromEntries((await engine.executeRaw<{ id: number; slug: string }>(
    `SELECT id, slug FROM pages WHERE slug LIKE 'people/%'`, [])).map(r => [r.slug, r.id]));
  for (let i = 0; i < n; i++) {
    await engine.executeRaw(
      `INSERT INTO link_edge_proposals (source_id, from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash, status)
       VALUES ('main', $1, $2, $3, 'works_with', $4, 'proposed')`,
      [ids['people/sub'], ids['people/a'], [ids['people/b'], ids['people/c']][i % 2], `hash-${i}`]);
  }
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

describe('#6249 edge-proposals list --limit validation', () => {
  for (const argv of [
    ['--limit', 'abc'],
    ['--limit', '0'],
    ['--limit', '-2'],
    ['--limit', '1.5'],
    ['--limit', '2001'],
    ['--limit', '--json'],
    ['--limit=abc'],
    ['--limit=0'],
  ]) {
    test(`${argv.join(' ')} is a usage error, not a database error`, async () => {
      await withHome(async () => {
        await seedProposals(1);
        let thrown: unknown;
        try {
          await capture(() => runEdgeProposals(engine, ['list', ...argv]));
        } catch (e) { thrown = e; }
        expect((thrown as { code?: string }).code).toBe('invalid_params');
        expect(String((thrown as Error).message)).toContain('--limit');
      });
    });
  }

  test('bare --limit with no value is a usage error', async () => {
    await withHome(async () => {
      await seedProposals(1);
      let thrown: unknown;
      try {
        await capture(() => runEdgeProposals(engine, ['list', '--limit']));
      } catch (e) { thrown = e; }
      expect((thrown as { code?: string }).code).toBe('invalid_params');
    });
  });

  test('--limit=N is honored (was silently ignored)', async () => {
    await withHome(async () => {
      await seedProposals(3);
      const out = await capture(() => runEdgeProposals(engine, ['list', '--limit=2']));
      expect(out.match(/^#\d+/gm)?.length).toBe(2);
    });
  });

  test('--limit N is honored and the default still lists all rows', async () => {
    await withHome(async () => {
      await seedProposals(3);
      const capped = await capture(() => runEdgeProposals(engine, ['list', '--limit', '2']));
      expect(capped.match(/^#\d+/gm)?.length).toBe(2);
      const all = await capture(() => runEdgeProposals(engine, ['list']));
      expect(all.match(/^#\d+/gm)?.length).toBe(3);
    });
  });
});
