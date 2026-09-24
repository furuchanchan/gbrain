import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { refreshManagedFilesystemRoots, assertManagedFilesystemWrite } from '../src/core/persistence/filesystem-guard.ts';
import { fixtures, initializeFixtures, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-root-refresh-'));
const config: HarnessConfig = {
  kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 5105, schedules: 0, operations: 0,
  sourceIds: ['root-refresh'], principalIds: [randomUUID()],
};
let engine: PGLiteEngine;

beforeAll(async () => withEnv({ GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home }, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
}), 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('unchanged bound roots retain their durable records without replacement', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const [source] = await fixtures(engine, config);
  await refreshManagedFilesystemRoots(engine);
  const directory = join(home, '.gbrain', 'persistence', 'managed-roots');
  const records = () => readdirSync(directory).filter(file => file.endsWith('.json')).map(file => {
    const path = join(directory, file);
    const stat = statSync(path, { bigint: true });
    return { file, inode: stat.ino, modified: stat.mtimeNs, bytes: readFileSync(path, 'utf8') };
  });
  const before = records();
  expect(before).toHaveLength(1);
  await refreshManagedFilesystemRoots(engine);
  expect(records()).toEqual(before);
  expect(JSON.parse(before[0].bytes)).toMatchObject({ source_id: source.id, worktree_id: source.binding.worktree_id });
  expect(() => assertManagedFilesystemWrite(join(source.root, 'note.md'))).toThrow('managed canonical worktree');
}));

test('unbound and moved source paths remain fenced alongside the original bound root', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const [source] = await fixtures(engine, config);
  const unbound = join(home, 'unbound'); mkdirSync(unbound);
  const moved = join(home, 'moved'); mkdirSync(moved);
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['unbound-refresh', unbound]);
    await tx.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [moved, source.id]);
  });
  await refreshManagedFilesystemRoots(engine);
  for (const root of [source.root, unbound, moved]) {
    expect(() => assertManagedFilesystemWrite(join(root, 'note.md'))).toThrow('managed canonical worktree');
  }
  const records = readdirSync(join(home, '.gbrain', 'persistence', 'managed-roots'));
  expect(records.filter(file => file.endsWith('.json'))).toHaveLength(3);
}));

test('unchanged refresh issues no chmod and no directory fsync (#5297)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { __registryFsStats } = await import('../src/core/persistence/root-registry.ts');
  await fixtures(engine, config);
  await refreshManagedFilesystemRoots(engine);
  __registryFsStats.chmods = 0;
  __registryFsStats.dirSyncs = 0;
  await refreshManagedFilesystemRoots(engine);
  expect(__registryFsStats.chmods).toBe(0);
  expect(__registryFsStats.dirSyncs).toBe(0);
}));

test('permission drift on a record is still repaired (#5297)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { __registryFsStats } = await import('../src/core/persistence/root-registry.ts');
  await fixtures(engine, config);
  await refreshManagedFilesystemRoots(engine);
  const directory = join(home, '.gbrain', 'persistence', 'managed-roots');
  const recordFile = readdirSync(directory).find(file => file.endsWith('.json'))!;
  const recordPath = join(directory, recordFile);
  chmodSync(recordPath, 0o644);
  __registryFsStats.chmods = 0;
  __registryFsStats.dirSyncs = 0;
  await refreshManagedFilesystemRoots(engine);
  expect(statSync(recordPath).mode & 0o777).toBe(0o600);
  expect(__registryFsStats.chmods).toBeGreaterThanOrEqual(1);
  expect(__registryFsStats.dirSyncs).toBe(0);
}));
