/**
 * #6000: when one repair kind's own preview cannot run (e.g. the
 * attribution-backfill journal join hitting a statement timeout on a large
 * Postgres brain), `planRepairSteps` must not take the whole
 * --remediation-plan / --remediate run down. The kind stays listed with its
 * failure reason (`preview_failed`), the rest of the plan still builds, and
 * `runRepairSteps` surfaces that step as failed instead of re-throwing the
 * preview error inside the run.
 *
 * The throwing preview is reproduced deterministically by renaming the
 * column attribution-backfill's preview queries read, so its plan() raises
 * an undefined-column error — the same throw class a cancelled statement
 * produces (an engine-level error, not an OperationError).
 * Runs on PGLite and, through test/e2e, Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { planRepairSteps, runRepairSteps } from '../src/core/remediation/repairs.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

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
});

for (const backend of backends) {
  test(`${backend}: a repair kind whose preview throws is listed as preview_failed, not fatal (#6000)`, async () => {
    const engine = engines[backends.indexOf(backend)];
    // attribution-backfill's preview reads pages.revision_write_request_id;
    // rename it so the preview throws (statement timeout / engine error class).
    await engine.executeRaw('ALTER TABLE pages RENAME COLUMN revision_write_request_id TO revision_write_request_id_broken');
    try {
      const steps = await planRepairSteps(engine, { noEmbed: true });
      const failed = steps.find(step => step.kind === 'attribution-backfill');
      expect(failed?.preview_failed).toBeTruthy();
      expect(failed?.affected).toBe(0);
      expect(failed?.command).toContain('attribution-backfill');
      expect(failed?.rationale).toContain('preview failed');
      // The rest of the plan still builds.
      expect(steps.every(step => step.id.startsWith('repair:'))).toBe(true);
      // A preview-failed step is surfaced as failed by runRepairSteps rather
      // than re-running (and re-throwing) the same unplannable preview.
      const results = await runRepairSteps(engine, [failed!], { remote: false, remainingUsd: () => undefined });
      expect(results[0].status).toBe('failed');
      expect(results[0].message).toContain('Preview failed');
      expect(results[0].applied).toBe(0);
    } finally {
      await engine.executeRaw('ALTER TABLE pages RENAME COLUMN revision_write_request_id_broken TO revision_write_request_id');
    }
    // Restored schema plans normally again: no preview_failed flag.
    const healthy = await planRepairSteps(engine, { noEmbed: true });
    expect(healthy.find(step => step.kind === 'attribution-backfill')?.preview_failed).toBeUndefined();
  }, 180_000);
}
