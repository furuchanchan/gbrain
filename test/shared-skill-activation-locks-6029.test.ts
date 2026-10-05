/**
 * #6029: `writer activate --shared-skills` ignored `--cleanup-dead-local-locks`
 * — a stale `gbrain_cycle_locks` row held by a provably dead local process
 * refused shared-skill activation forever (writer_not_quiesced), with no way
 * to clear it. The shared-skill path now applies the same rule as base
 * `activatePersistence`: only an explicitly requested, provably dead local
 * holder (`dead_eligible`) is cleaned inside the activation transaction; a
 * live holder or an unrequested flag still refuses.
 * Runs on PGLite and, through test/e2e, Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
let closePostgres: (() => Promise<void>) | undefined;
const dirs: string[] = [];
let pgEngine: BrainEngine | undefined;

beforeAll(async () => {
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    pgEngine = pg.engine; closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  if (pgEngine) { await disposePersistenceConsumer(pgEngine); await pgEngine.disconnect(); }
  await closePostgres?.();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const DEAD_PID = 2147480000; // > Linux pid_max — provably ESRCH
const DEAD_LOCK = `INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,acquired_at,ttl_expires_at)
  VALUES('dead-cycle-lock',$1,$2,now()-interval '2 hours',now()-interval '1 hour')`;

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

for (const backend of backends) {
  test(`${backend}: a dead local cycle-lock is cleaned only on explicit request (#6029)`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-activate-')); dirs.push(home);
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = backend === 'postgres' ? { engine: pgEngine!, close: async () => {} } : await isolatedSharedSkillsEngine();
      try {
        const root = join(home, 'content'); mkdirSync(root);
        // A dedicated source for this test keeps the shared engine's default source untouched.
        await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)", [`shared-${backend}`, root]);
        await claimWorktree(engine, `shared-${backend}`, root);
        const lockCount = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM gbrain_cycle_locks'))[0].n;

        // Dead holder without the flag: refused, row untouched.
        await engine.executeRaw(DEAD_LOCK, [DEAD_PID, hostname()]);
        const refused = await refusal(() => activateSharedSkillPersistence(engine, { confirmQuiesced: true }));
        expect(refused.code).toBe('writer_not_quiesced');
        expect(await lockCount()).toBe(1);

        // A live local holder still refuses even with the flag.
        await engine.executeRaw("INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,ttl_expires_at) VALUES('live-cycle-lock',$1,$2,now()+interval '1 hour')", [process.pid, hostname()]);
        const liveRefused = await refusal(() => activateSharedSkillPersistence(engine, { confirmQuiesced: true, cleanupDeadLocalLocks: true }));
        expect(liveRefused.code).toBe('writer_not_quiesced');
        await engine.executeRaw("DELETE FROM gbrain_cycle_locks WHERE id='live-cycle-lock'");

        // Dry run with the flag reports the dead row without deleting it.
        const dry = await activateSharedSkillPersistence(engine, { confirmQuiesced: true, dryRun: true, cleanupDeadLocalLocks: true });
        expect(dry.activated).toBe(false);
        expect(dry.legacy_locks?.map(row => row.id)).toContain('dead-cycle-lock');
        expect(await lockCount()).toBe(1);

        // Explicit request cleans the dead holder and activates.
        const activated = await activateSharedSkillPersistence(engine, { confirmQuiesced: true, cleanupDeadLocalLocks: true });
        expect(activated.activated).toBe(true);
        expect(activated.protocol_version).toBe(2);
        expect(await lockCount()).toBe(0);
        expect((await engine.executeRaw<{ e: boolean }>('SELECT skill_bundles_enabled AS e FROM persistence_brain WHERE singleton=1'))[0].e).toBe(true);
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  }, 180_000);
}
