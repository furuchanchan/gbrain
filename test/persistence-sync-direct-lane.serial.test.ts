/**
 * #6423: a real managed catch-up on a dual-pool Postgres engine takes the direct route for its own statements
 * and for the transaction its admission runs in — `managedSyncStatementEngine` (consumer-lane.ts) — so a
 * transaction-mode pooler can no longer hold a round-trip in a queue no server timeout ends. `transactionDirect`
 * is the discriminating signal: nothing on the unmanaged path calls it, so the fix is what makes it fire.
 */
import postgres from '#postgres';
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { consumerConnectionRoute } from '../src/core/persistence/consumer-lane.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-direct-lane-'));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
let close: (() => Promise<void>) | undefined;
afterAll(async () => { await close?.(); rmSync(home, { recursive: true, force: true }); });

test('#6423: a managed catch-up takes the direct route for its statements and its admission transaction', async () => {
  const databaseUrl = requirePostgresTestDatabase();
  assertSafeE2eDatabaseUrl(databaseUrl);
  // A dual-pool engine: GBRAIN_DIRECT_DATABASE_URL must name the SAME (fresh) database as the read pool, the way
  // a Supabase deployment's session-pooler URL does — the override is read at connect.
  const database = `gbrain_test_persistence_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(databaseUrl, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const url = new URL(databaseUrl); url.pathname = `/${database}`;
  const engine = new PostgresEngine();
  close = async () => { await engine.disconnect(); await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end(); };
  try {
    await withEnv(
      { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_DIRECT_DATABASE_URL: url.toString() },
      async () => {
        await engine.connect({ database_url: url.toString() });
        await engine.initSchema();
        expect(consumerConnectionRoute(engine as BrainEngine).lane).toBe('direct');
        // A real catch-up over the wrapped engine completes and its round-trips reach the direct lane. The
        // discriminating pin — that runManagedSync installs managedSyncStatementEngine — lives in
        // managed-sync-statement-lane.test.ts (the wire-level attribution is ambiguous: the consumer's own
        // tick statements and claims take the same direct calls).
        let directStatements = 0;
        const raw = engine.executeRawDirect.bind(engine);
        engine.executeRawDirect = async (sql, params, opts) => { directStatements++; return raw(sql, params, opts); };
        const id = `sync-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
        mkdirSync(root); await makeGitFixture(root);
        writeFileSync(join(root, 'a.md'), 'Alpha observation.\n');
        writeFileSync(join(root, 'b.md'), 'Beta observation.\n');
        git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
        await claimWorktree(engine, id, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const statementsBefore = directStatements;
        const result = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
        expect(result.status).not.toBe('failed');
        expect(directStatements).toBeGreaterThan(statementsBefore);
      });
  } catch (error) { await close(); close = undefined; throw error; }
}, 120_000);
