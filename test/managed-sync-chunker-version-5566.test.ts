// #5566 — managed sync never wrote sources.chunker_version, so a quiet source
// could never satisfy doctor sync_freshness's chunkerMatch and aged into
// WARN/FAIL. The managed checkpoint now stamps it, but only on a --full run:
// a completed full cursor admitted every file under the current pipeline,
// while an incremental checkpoint never visited unchanged files and stamping
// it would falsely certify stale pages (managed discovery has no
// chunker-gate re-walk the way legacy preflight does).
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
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-chunker-version-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim(); }
function commit(root: string, message = 'test content'): string { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); }
async function fixture(engine: BrainEngine, files: Record<string,string>) {
  const id = `cv-${randomUUID().replace(/-/g,'').slice(0,20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) { const full = join(root,path); mkdirSync(join(full,'..'), { recursive:true }); writeFileSync(full, body); }
  const head = commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id,root]);
  await claimWorktree(engine,id,root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, head };
}
async function storedChunkerVersion(engine: BrainEngine, sourceId: string) {
  const [row] = await engine.executeRaw<{ chunker_version: string | null }>(`SELECT chunker_version FROM sources WHERE id=$1`, [sourceId]);
  return row?.chunker_version ?? null;
}
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) { await engine.executeRaw('DELETE FROM oauth_clients WHERE source_id=$1', [id]); await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); } await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home,{recursive:true,force:true});
});

test('a --full managed run stamps sources.chunker_version', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'notes/one.md': '---\ntitle: One\n---\nFirst page body.\n' });
    const result = await performManagedSync(engine, { sourceId: f.id, noPull: true, full: true });
    expect(result.status).toBe('first_sync');
    expect(await storedChunkerVersion(engine, f.id)).toBe(String(CHUNKER_VERSION));
  }
}),120_000);

test('an incremental managed run does NOT stamp chunker_version (#5566)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'notes/two.md': '---\ntitle: Two\n---\nSecond page body.\n' });
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    // Simulate a brain synced before the current chunker shipped.
    await engine.executeRaw(`UPDATE sources SET chunker_version='6' WHERE id=$1`, [f.id]);
    // An incremental checkpoint lands (a file changed) but must not certify
    // the whole corpus at the new chunker — unchanged files were never visited.
    writeFileSync(join(f.root, 'notes/three.md'), '---\ntitle: Three\n---\nThird page body.\n');
    commit(f.root, 'add three');
    const second = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(second.status).not.toBe('up_to_date');
    expect(await storedChunkerVersion(engine, f.id)).toBe('6');
    // The issue's repro: a quiet source can only recover via a full re-chunk.
    const full = await performManagedSync(engine, { sourceId: f.id, noPull: true, full: true });
    expect(full.status).not.toBe('blocked_by_failures');
    expect(await storedChunkerVersion(engine, f.id)).toBe(String(CHUNKER_VERSION));
  }
}),120_000);

test('an up_to_date run leaves a stale stamp untouched until --full', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'notes/four.md': '---\ntitle: Four\n---\nFourth page body.\n' });
    await performManagedSync(engine, { sourceId: f.id, noPull: true, full: true });
    await engine.executeRaw(`UPDATE sources SET chunker_version='6' WHERE id=$1`, [f.id]);
    expect((await performManagedSync(engine, { sourceId: f.id, noPull: true })).status).toBe('up_to_date');
    expect(await storedChunkerVersion(engine, f.id)).toBe('6');
    await performManagedSync(engine, { sourceId: f.id, noPull: true, full: true });
    expect(await storedChunkerVersion(engine, f.id)).toBe(String(CHUNKER_VERSION));
  }
}),120_000);
