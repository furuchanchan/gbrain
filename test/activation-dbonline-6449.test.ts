/**
 * #6449: on a `sync.write_through=false` (database-only) brain, a rooted
 * source with no worktree binding must not block `sources writer activate`.
 * Onboarding already reports such a source `database_only` (vs
 * `claim_required` when write-through is on), so activation treats it the
 * same way — no binding is required — while the fail-closed checks stay for
 * every source that does have a root checkout in use.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { writerOnboardingPreflight } from '../src/core/persistence/onboarding.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

async function fixture(run: (home: string, live: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-activation-dbonly-'));
  const live = join(home, 'live'); mkdirSync(live);
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await disposePersistenceConsumer(engine); await resetPgliteState(engine); await engine.setConfig('version', schemaVersion);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['live-example', live]);
      await claimWorktree(engine, 'live-example', live);
      await run(home, live);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('write_through=false: an unbound rooted source activates as database-only instead of refusing writer_registration_required', () => fixture(async home => {
  const dbOnly = join(home, 'db-only'); mkdirSync(dbOnly);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['db-example', dbOnly]);
  await engine.setConfig('sync.write_through', 'false');
  const preview = await activatePersistence(engine, { confirmQuiesced: true, dryRun: true });
  expect(preview.filesystem_sources).toBe(1);
  const report = await activatePersistence(engine, { confirmQuiesced: true });
  expect(report.activated).toBe(true);
  expect(report.filesystem_sources).toBe(1);
  const onboarding = await writerOnboardingPreflight(engine, 'db-example');
  expect(onboarding.sources[0]).toMatchObject({ source_id: 'db-example', state: 'database_only', binding: 'none' });
}));

test('write_through=true keeps the fail-closed writer_registration_required for an unbound rooted source', () => fixture(async home => {
  const unclaimed = join(home, 'unclaimed'); mkdirSync(unclaimed);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['stale-example', unclaimed]);
  await engine.setConfig('sync.write_through', 'true');
  const error = await activatePersistence(engine, { confirmQuiesced: true, dryRun: true }).catch(e => e);
  expect(error).toMatchObject({ code: 'writer_registration_required' });
}));
