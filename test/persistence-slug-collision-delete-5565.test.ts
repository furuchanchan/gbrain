/**
 * #5565 (delete-the-skipped-twin follow-up to #5694): when two tracked files
 * slugify to one page, the collision loser is skipped but stays a tracked
 * file. `git rm`-ing the loser emitted a `delete` entry whose path never
 * owned the slug — discovery resolved the slug to the kept twin's page and
 * threw `page_identity_changed`, wedging the source with no supported repair
 * (reproduced by the maintainer on master: "Removing the skipped twin still
 * fails"). The delete entry now retires instead of throwing; a mismatched
 * IMPORT still throws because adopting a new origin is a real identity
 * change. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-collision-delete-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string, message = 'test content'): string {
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}
function write(root: string, path: string, body: string) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, body); }
async function fixture(engine: BrainEngine, files: Record<string, string>) {
  const id = `coll-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) write(root, path, body);
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;
async function livePage(engine: BrainEngine, slug: string, sourceId: string) {
  const [row] = await engine.executeRaw<{ id: number; source_path: string | null }>(
    'SELECT id,source_path FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  return row ?? null;
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) { await engine.executeRaw('DELETE FROM oauth_clients WHERE source_id=$1', [id]); await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); }
      await engine.disconnect();
    }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('deleting the skipped twin of a slug collision syncs cleanly and keeps the page', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {
      'notes/instalación-en-servidor.md': note('Instalación', 'Accented twin body.'),
      'notes/instalacion-en-servidor.md': note('Instalacion', 'ASCII twin body.'),
      'notes/bystander.md': note('Bystander', 'An unrelated note.'),
    });
    const first = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(first.slugCollisions).toEqual([{ slug: 'notes/instalacion-en-servidor', kept: 'notes/instalacion-en-servidor.md', skipped: ['notes/instalación-en-servidor.md'] }]);
    const owner = await livePage(engine, 'notes/instalacion-en-servidor', f.id);
    expect(owner?.source_path).toBe('notes/instalacion-en-servidor.md');
    // The skipped twin is removed from the tree: its delete entry never owned
    // the slug, so the sync must not adopt it as the page's deletion.
    git(f.root, 'rm', '-q', 'notes/instalación-en-servidor.md');
    commit(f.root, 'drop the accented twin');
    const next = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(['synced', 'up_to_date']).toContain(next.status);
    expect(next.deleted ?? 0).toBe(0);
    const page = await livePage(engine, 'notes/instalacion-en-servidor', f.id);
    expect(page?.id).toBe(owner!.id);
    expect(page?.source_path).toBe('notes/instalacion-en-servidor.md');
    expect(await engine.getPage('notes/bystander', { sourceId: f.id })).not.toBeNull();
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state<>'committed'", [f.id])).toEqual([]);
    // A later full sync converges on the single remaining file.
    expect((await performManagedSync(engine, { sourceId: f.id, noPull: true, full: true })).slugCollisions).toBeUndefined();
    expect(await livePage(engine, 'notes/instalacion-en-servidor', f.id)).not.toBeNull();
  }
}), 180_000);

test('deleting the kept twin still soft-deletes its page', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {
      'notes/instalación-en-servidor.md': note('Instalación', 'Accented twin body.'),
      'notes/instalacion-en-servidor.md': note('Instalacion', 'ASCII twin body.'),
    });
    const first = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(first.slugCollisions?.[0]?.skipped).toEqual(['notes/instalación-en-servidor.md']);
    // Remove BOTH twins: the kept one carries the page, so its page soft-deletes.
    git(f.root, 'rm', '-q', 'notes/instalación-en-servidor.md', 'notes/instalacion-en-servidor.md');
    commit(f.root, 'drop both twins');
    const next = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(next.deleted).toBe(1);
    expect(await livePage(engine, 'notes/instalacion-en-servidor', f.id)).toBeNull();
  }
}), 180_000);

test('renaming the skipped twin retires its delete and imports the new path', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {
      'notes/instalación-en-servidor.md': note('Instalación', 'Accented twin body.'),
      'notes/instalacion-en-servidor.md': note('Instalacion', 'ASCII twin body.'),
    });
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    const owner = await livePage(engine, 'notes/instalacion-en-servidor', f.id);
    // Issue case 2: a rename of the non-origin twin = delete + import in one
    // delta. The delete retires; the renamed file imports as a new page.
    git(f.root, 'mv', 'notes/instalación-en-servidor.md', 'notes/instalación-alternativa.md');
    commit(f.root, 'rename the accented twin');
    const next = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(next.status).toBe('synced');
    expect(next.deleted ?? 0).toBe(0);
    const page = await livePage(engine, 'notes/instalacion-en-servidor', f.id);
    expect(page?.id).toBe(owner!.id);
    expect(await livePage(engine, 'notes/instalacion-alternativa', f.id)).not.toBeNull();
  }
}), 180_000);
