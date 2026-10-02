/**
 * #5514: `writer activate` on an already-enabled brain returns
 * `activated:false` — truthfully (the invocation transitioned nothing) but
 * indistinguishably from a failed activation. The reporter read
 * `{"enabled": true, "activated": false}` as "activation silently failed"
 * and chased the wrong layer (the real gap was the stopped ingress
 * consumer, visible in `writer status`). The no-op now carries
 * `reason:'already_enabled'` + `next_action` on BOTH return paths: the
 * early no-expectedState return and the in-transaction return reached
 * when a reviewed expected_state is provided.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';

const engine = new PGLiteEngine();
let schemaVersion: string;

async function fixture(run: (home: string, sourceId: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-activate-reason-'));
  const root = join(home, 'canonical'); mkdirSync(root);
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await disposePersistenceConsumer(engine); await resetPgliteState(engine); await engine.setConfig('version', schemaVersion);
      const sourceId = `activate-${randomUUID().slice(0, 12)}`;
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      try {
        await claimWorktree(engine, sourceId, root);
        await registerLocalWriter(engine, 'cli');
        await run(home, sourceId);
      } finally { await disposePersistenceConsumer(engine); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

beforeAll(async () => {
  await engine.connect({}); await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
}, 120_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine); await engine.disconnect();
});

test('#5514 re-activate reports reason:already_enabled on both no-op paths', () => fixture(async (home, sourceId) => {
  const first = await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') });
  expect(first).toMatchObject({ enabled: true, activated: true });

  // Path 1: early return when no expected_state is provided.
  const repeat = await activatePersistence(engine, { confirmQuiesced: true });
  expect(repeat).toMatchObject({ enabled: true, activated: false, reason: 'already_enabled', filesystem_sources: 1 });
  expect(repeat.next_action).toContain('writer status');

  // Path 2: the reviewed expected_state route reaches the same no-op inside
  // the transaction — identical reason, so the envelope is unambiguous.
  const reviewed = await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') });
  expect(reviewed).toMatchObject({ enabled: true, activated: false, reason: 'already_enabled', filesystem_sources: 1 });
  expect(reviewed.next_action).toContain('writer status');
}), 60_000);
