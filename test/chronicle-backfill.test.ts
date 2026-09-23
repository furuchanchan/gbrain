/**
 * v0.42.x — Life Chronicle (#2390) backfill op (Phase A.8).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const mkCtx = (): OperationContext => ({ engine, remote: false, sourceId: 'default' } as unknown as OperationContext);
const LONG = 'B'.repeat(120);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'chronicle_extract'`);
  await engine.executeRaw(`DELETE FROM pages WHERE type IN ('meeting','diary')`);
});

describe('chronicle_backfill op', () => {
  test('dry-run counts eligible meetings without enqueuing', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    await engine.putPage('life/diary/d1', { type: 'diary', title: 'd1', compiled_truth: LONG }); // excluded
    const r = await operationsByName.chronicle_backfill.handler(mkCtx(), { dry_run: true }) as { eligible: number; enqueued: number };
    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(0);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name='chronicle_extract'`);
    expect(Number(jobs[0].n)).toBe(0);
  });

  test('enqueues one chronicle_extract per eligible meeting', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
    const r = await operationsByName.chronicle_backfill.handler(mkCtx(), {}) as { eligible: number; enqueued: number; errors: unknown[] };
    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(2);
    expect(r.errors).toHaveLength(0);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name='chronicle_extract'`);
    expect(Number(jobs[0].n)).toBe(2);
  });

  test('unscoped backfill enqueues each page under its own source', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other-src', 'other-src') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('meetings/default-src', { type: 'meeting', title: 'default', compiled_truth: LONG });
    await engine.putPage('meetings/other-src', { type: 'meeting', title: 'other', compiled_truth: LONG }, { sourceId: 'other-src' });
    const ctx = { engine, remote: false } as unknown as OperationContext;

    const r = await operationsByName.chronicle_backfill.handler(ctx, {}) as { eligible: number; enqueued: number; errors: unknown[] };

    expect(r.eligible).toBe(2);
    expect(r.enqueued).toBe(2);
    expect(r.errors).toHaveLength(0);
    const jobs = await engine.executeRaw<{ data: { slug: string; sourceId: string } }>(
      `SELECT data FROM minion_jobs WHERE name='chronicle_extract' ORDER BY data->>'slug'`
    );
    expect(jobs.map((j) => j.data)).toEqual([
      { slug: 'meetings/default-src', sourceId: 'default' },
      { slug: 'meetings/other-src', sourceId: 'other-src' },
    ]);
  });

  test('honors the configured backfill limit when no explicit limit is supplied', async () => {
    await engine.setConfig('chronicle.backfill.limit', '1');
    try {
      await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
      await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });
      const r = await operationsByName.chronicle_backfill.handler(mkCtx(), {}) as { limit: number; enqueued: number; errors: unknown[] };
      expect(r.limit).toBe(1);
      expect(r.enqueued).toBe(1);
      expect(r.errors).toHaveLength(0);
    } finally {
      await engine.setConfig('chronicle.backfill.limit', '');
    }
  });

  test('advances past a completed no-events page instead of starving the next batch', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('meetings/m2', { type: 'meeting', title: 'm2', compiled_truth: LONG });

    const first = await operationsByName.chronicle_backfill.handler(mkCtx(), { limit: 1 }) as { enqueued: number; already_covered: number };
    expect(first.enqueued).toBe(1);
    expect(first.already_covered).toBe(0);

    const firstJobs = await engine.executeRaw<{ id: number; slug: string }>(
      `SELECT id, data->>'slug' AS slug FROM minion_jobs WHERE name='chronicle_extract' ORDER BY id`);
    expect(firstJobs).toHaveLength(1);
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='completed',
         result='{"status":"no_events","events_written":0}'::jsonb,
         finished_at=now(), updated_at=now() WHERE id=$1`, [firstJobs[0]!.id]);

    const second = await operationsByName.chronicle_backfill.handler(mkCtx(), { limit: 1 }) as { enqueued: number; already_covered: number };
    expect(second.enqueued).toBe(1);
    expect(second.already_covered).toBe(1);

    const allJobs = await engine.executeRaw<{ slug: string }>(
      `SELECT data->>'slug' AS slug FROM minion_jobs WHERE name='chronicle_extract' ORDER BY id`);
    expect(allJobs).toHaveLength(2);
    expect(allJobs[1]!.slug).not.toBe(allJobs[0]!.slug);
  });

  test('skips outside the configured run hour unless forced', async () => {
    const nextHour = (new Date().getUTCHours() + 1) % 24;
    await engine.setConfig('chronicle.backfill.run_hour_utc', String(nextHour));
    try {
      await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
      const skipped = await operationsByName.chronicle_backfill.handler(mkCtx(), {}) as { skipped?: string; enqueued: number };
      expect(skipped.skipped).toBe('scheduled_window_inactive');
      expect(skipped.enqueued).toBe(0);
      const forced = await operationsByName.chronicle_backfill.handler(mkCtx(), { force: true }) as { enqueued: number; errors: unknown[] };
      expect(forced.enqueued).toBe(1);
      expect(forced.errors).toHaveLength(0);
    } finally {
      await engine.setConfig('chronicle.backfill.run_hour_utc', '');
    }
  });
});
