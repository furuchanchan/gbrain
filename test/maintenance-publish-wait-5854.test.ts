/**
 * #5854 — the managed maintenance publish wait is operator-configurable.
 *
 * `submitMaintenance` used to wait a fixed 5s for the writer to commit; a
 * busy writer lane (pooler, other writes) legitimately commits later and
 * the caller got `write_pending` — dream.synthesize's recurring
 * SYNTH_PHASE_FAIL. `persistence.maintenance_publish_wait_ms` now sets the
 * wait, read via `readMaintenancePublishWaitMs` (same key/parse convention
 * as the other persistence.* keys).
 *
 * Behavioral cell: hold the source's worktree lock so the consumer cannot
 * claim the admitted write (the managed-maintenance.test.ts trick), then
 * measure how long the publish path actually waits — it must track the
 * configured value, not the old fixed 5s default.
 */
import { describe, test, expect } from 'bun:test';
import { managedBrain } from './helpers/managed-brain.ts';
import { maintenancePreflight, submitMaintenanceIntent } from '../src/core/persistence/prepared-maintenance.ts';
import { getWorktreeBinding, acquireWorktree } from '../src/core/persistence/ownership.ts';
import { readMaintenancePublishWaitMs, DEFAULT_MAINTENANCE_PUBLISH_WAIT_MS,
  MAINTENANCE_PUBLISH_WAIT_MS_KEY } from '../src/core/persistence/limits.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

describe('#5854 maintenance publish wait', () => {
  test('the key is registered and readMaintenancePublishWaitMs honors it', async () => {
    expect(KNOWN_CONFIG_KEYS).toContain(MAINTENANCE_PUBLISH_WAIT_MS_KEY);
    await managedBrain(async ({ engine }) => {
      expect(await readMaintenancePublishWaitMs(engine)).toBe(DEFAULT_MAINTENANCE_PUBLISH_WAIT_MS);
      await engine.setConfig(MAINTENANCE_PUBLISH_WAIT_MS_KEY, '12345');
      expect(await readMaintenancePublishWaitMs(engine)).toBe(12345);
      await engine.setConfig(MAINTENANCE_PUBLISH_WAIT_MS_KEY, 'not-a-number');
      await expect(readMaintenancePublishWaitMs(engine)).rejects.toMatchObject({ code: 'invalid_params' });
    });
  });

  test('a configured wait bounds the submit path — locked writer, tiny wait', async () => {
    await managedBrain(async ({ engine }) => {
      await engine.setConfig(MAINTENANCE_PUBLISH_WAIT_MS_KEY, '50');
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const binding = (await getWorktreeBinding(engine, 'default'))!;
      // Hold the worktree lock so the consumer cannot claim the write —
      // the admitted row stays queued and the submit path must wait
      // exactly waitMs before surfacing write_pending.
      const lock = (await acquireWorktree(binding, 5000))!;
      expect(lock).not.toBeNull();
      try {
        const started = performance.now();
        await expect(submitMaintenanceIntent(engine, authority, 'notes/example',
          { kind: 'managed_maintenance_page', content: '---\ntitle: Example\n---\nBody.', expected_revision: null }))
          .rejects.toMatchObject({ code: 'write_pending' });
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(3000);
      } finally { await lock.release(); }
    });
  }, 20_000);
});
