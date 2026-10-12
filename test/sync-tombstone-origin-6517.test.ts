import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { discoverManagedSync } from '../src/core/persistence/sync-discovery.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

// gbrain#6517 — the sync origin census counted soft-deleted rows, so a page
// tombstoned to resolve a duplicate-origin pair kept claiming the file and
// every `gbrain sync` refused the whole source with page_identity_changed.
const home = mkdtempSync(join(tmpdir(), 'gbrain-6517-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(root: string): void {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'test content');
}
async function fixture(engine: BrainEngine, files: Record<string, string>) {
  const id = `sync-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  sources.push(id);
  const root = join(home, id);
  mkdirSync(root);
  git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({});
  await lite.initSchema();
  engines.push(lite);
}, 120_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
      await engine.disconnect();
    }
  });
  rmSync(home, { recursive: true, force: true });
});

describe('duplicate-origin twins (#6517)', () => {
  // Re-point page b at a.md so two live rows claim one origin, as the issue's
  // legacy import produced. A full sync re-selects every file.
  const makeTwins = async (engine: BrainEngine, id: string) =>
    engine.executeRaw(`UPDATE pages SET source_path='a.md' WHERE source_id=$1 AND slug='b'`, [id]);
  const tombstone = async (engine: BrainEngine, id: string, slug: string) =>
    engine.transaction(tx => withCoordinatedWrite(tx, [id], () => tx.softDeletePage(slug, { sourceId: id }), TEST_WRITE_ATTRIBUTION));

  test('two LIVE pages claiming one origin still refuse discovery', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const f = await fixture(engine, { 'a.md': 'The kept page.\n', 'b.md': 'The losing twin.\n' });
      await performManagedSync(engine, { sourceId: f.id, noPull: true });
      await makeTwins(engine, f.id);
      await expect(discoverManagedSync(engine, { sourceId: f.id, noPull: true, full: true }))
        .rejects.toMatchObject({ code: 'page_identity_changed' });
    }
  }), 120_000);

  test('a soft-deleted twin stops claiming the origin; discovery proceeds', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const f = await fixture(engine, { 'a.md': 'The kept page.\n', 'b.md': 'The losing twin.\n' });
      await performManagedSync(engine, { sourceId: f.id, noPull: true });
      await makeTwins(engine, f.id);
      await expect(discoverManagedSync(engine, { sourceId: f.id, noPull: true, full: true }))
        .rejects.toMatchObject({ code: 'page_identity_changed' });
      // The documented keep-one path: soft-delete the loser.
      await tombstone(engine, f.id, 'b');
      const discovery = await discoverManagedSync(engine, { sourceId: f.id, noPull: true, full: true });
      const entry = discovery.entries.find(e => e.sourcePath === 'a.md');
      expect(entry?.slug).toBe('a');
      const live = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug`, [f.id]);
      expect(live.map(p => p.slug)).toEqual(['a']);
    }
  }), 120_000);

  test('a file returning to a tombstoned origin still revives the tombstone row', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const f = await fixture(engine, { 'a.md': 'Original page.\n' });
      const synced = await performManagedSync(engine, { sourceId: f.id, noPull: true });
      expect(synced.added).toBe(1);
      const [row] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id=$1 AND slug='a'`, [f.id]);
      await tombstone(engine, f.id, 'a');
      // The tombstone's slug is still held: re-import must revive it, not mint a duplicate.
      const discovery = await discoverManagedSync(engine, { sourceId: f.id, noPull: true, full: true });
      const entry = discovery.entries.find(e => e.sourcePath === 'a.md');
      expect(entry?.slug).toBe('a');
      expect(entry?.pageId).toBe(row!.id);
    }
  }), 120_000);
});
