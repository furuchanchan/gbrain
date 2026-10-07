/**
 * #6193 — `edge-proposals list --json` must emit one valid JSON document
 * even when Postgres returns int8 ids as bigint (plain JSON.stringify
 * throws 'Do not know how to serialize a BigInt'). PGLite returns numbers,
 * so the test wraps executeRaw to hand back the Postgres wire shape.
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
  const home = mkdtempSync(join(tmpdir(), 'ep19-home-'));
  const audit = mkdtempSync(join(tmpdir(), 'ep19-audit-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(audit, { recursive: true, force: true });
  }
}

async function seedProposal(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ep19-brain-'));
  await engine.executeRaw(`INSERT INTO sources(id, name, local_path) VALUES ('main', 'main', $1)`, [root]);
  const md = (s: string) => `---\ntitle: ${s}\ntype: person\n---\n${s}`;
  for (const s of ['sub', 'a', 'b']) await importFromContent(engine, `people/${s}`, md(s), { sourceId: 'main' });
  const ids = Object.fromEntries((await engine.executeRaw<{ id: number; slug: string }>(
    `SELECT id, slug FROM pages WHERE slug LIKE 'people/%'`, [])).map(r => [r.slug, r.id]));
  await engine.executeRaw(
    `INSERT INTO link_edge_proposals (source_id, from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash, status)
     VALUES ('main', $1, $2, $3, 'works_with', 'h1', 'proposed')`,
    [ids['people/sub'], ids['people/a'], ids['people/b']]);
}

/** Force the Postgres wire shape: bigint ids on proposal rows. */
function withBigintIds<T>(fn: () => Promise<T>): Promise<T> {
  const orig = engine.executeRaw.bind(engine);
  engine.executeRaw = (async (sql: string, params?: unknown[]) => {
    const rows = await orig(sql, params as never[]) as Array<Record<string, unknown>>;
    if (String(sql).includes('link_edge_proposals')) return rows.map(r => ({ ...r, id: BigInt(r.id as number) }));
    return rows;
  }) as typeof engine.executeRaw;
  return fn().finally(() => { engine.executeRaw = orig; });
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

describe('#6193 edge-proposals --json survives bigint ids', () => {
  test('list --json and show --json emit valid JSON with string ids', async () => {
    await withHome(async () => {
      await seedProposal();
      const listOut = await withBigintIds(() => capture(() => runEdgeProposals(engine, ['list', '--json'])));
      const list = JSON.parse(listOut) as Array<Record<string, unknown>>;
      expect(list.length).toBe(1);
      expect(list[0].status).toBe('proposed');
      expect(typeof list[0].id).toBe('string');

      const showOut = await withBigintIds(() => capture(() => runEdgeProposals(engine, ['show', '1', '--json'])));
      const show = JSON.parse(showOut) as Record<string, unknown>;
      expect(show.status).toBe('proposed');
      expect(typeof show.id).toBe('string');
    });
  });
});
