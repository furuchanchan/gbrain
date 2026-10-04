/**
 * #5988: on a managed brain, a file whose frontmatter cannot parse is
 * quarantined instead of blocking the whole source — the cursor advances past
 * it, the ledger records it (state 'quarantined'), the sync result reports
 * `quarantinedFiles`/`quarantinedPaths`, and a repaired file imports on the
 * next run because its changed hash produces a new manifest entry.
 * Runs on PGLite and, through test/e2e, Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const dirs: string[] = [];

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_url: '' }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commitRaw(root: string, path: string, content: string) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
  git(root, 'add', '.'); git(root, 'commit', '-qm', `add ${path}`);
}
const note = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n${body}\n`;
const BROKEN = '---\ntitle: broken\ntype: note\nauthor: PYMNTS (original: https://www.example.com/news)\n---\nUnparseable frontmatter.\n';

for (const backend of backends) {
  test(`${backend}: an unparseable frontmatter file is quarantined, not blocking; a repaired file imports (#5988)`, async () => {
    const engine = engines[backends.indexOf(backend)];
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-quarantine-')); dirs.push(dir);
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    commitRaw(root, 'notes/good.md', note('good', 'A parseable page.'));
    commitRaw(root, 'notes/bad.md', BROKEN);
    const sourceId = `quarantine-${backend}`;
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        const first = await performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true });
        expect(first.status).not.toBe('blocked_by_failures');
        expect(first.quarantinedFiles).toBe(1);
        expect(first.quarantinedPaths).toContain('notes/bad.md');
        // The parseable sibling imported; the broken file did not.
        expect(await engine.getPage('notes/good', { sourceId })).not.toBeNull();
        expect(await engine.getPage('notes/bad', { sourceId })).toBeNull();
        // The failures ledger keeps the quarantine record for doctor.
        const ledger = await readManagedSyncFailures(engine, [sourceId]);
        const entry = ledger.find(f => f.path === 'notes/bad.md');
        expect(entry).toMatchObject({ code: 'invalid_frontmatter', state: 'quarantined', request_id: null });
        expect(entry?.message).toContain('Invalid YAML frontmatter');
        // A second run is not blocked and does not double-count the file.
        const again = await performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true });
        expect(again.status).not.toBe('blocked_by_failures');

        // Repaired content produces a new manifest entry and imports normally.
        commitRaw(root, 'notes/bad.md', note('broken', 'Now parseable.'));
        const fixed = await performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true });
        expect(fixed.status).not.toBe('blocked_by_failures');
        expect((await engine.getPage('notes/bad', { sourceId }))?.compiled_truth).toContain('Now parseable.');
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    });
  }, 180_000);
}
