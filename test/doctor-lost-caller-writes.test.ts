/**
 * lost_caller_writes doctor check (#6429): caller writes refused at
 * publication whose receipt still holds the intent are counted per source
 * with the explicit-only replay's preview. The warn path, the replay and the
 * clearing are exercised end to end in test/repair-failed-writes-conflict-6429.test.ts.
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { lostCallerWritesCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { REPAIR_REGISTRY } from '../src/core/repair/registry.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('a brain with no refused caller writes is ok, and the check is wired to the explicit-only replay', async () => {
  const check = await lostCallerWritesCheck(engine);
  expect(check.status).toBe('ok');
  expect(check.details).toMatchObject({ count: 0, writes: [], compacted_unreplayable: 0, repair: 'failed-writes' });
  expect(categorizeCheck('lost_caller_writes')).toBe('ops');
  const spec = WAVE_CHECKS.find(spec => spec.id === 'lost_caller_writes');
  expect(spec).toMatchObject({ resolution: 'repair', registration: 'wave' });
  expect(REPAIR_REGISTRY.find(spec => spec.kind === 'failed-writes')?.checks).toContain('lost_caller_writes');
});

// #6527: the count is retained unacknowledged intents, not the replay set.
// A `remember` refused source_changed whose intent pins no entity is counted
// here but classified `unpinned_target` by the preview — count 1, replay
// candidates 0 — so the check must not equate the two.
test('a retained intent that is not a replay candidate is counted with disclosed semantics', async () => {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', ['default']);
  await engine.putPage('notes/unpinned-target', { type: 'note', title: 'T', compiled_truth: 'body', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  const requestId = 'a1b2c3d4-0000-4000-8000-000000000001';
  await engine.executeRaw(
    `INSERT INTO persistence_requests
      (principal_kind, principal_id, request_id, operation, source_id, source_incarnation, slug,
       digest, intent, authority, intent_bytes, terminal_reservation, state, error_code, completed_at)
     VALUES ('local_cli', 'local', $1, 'remember', 'default', $2, 'notes/unpinned-target',
       'digest-6527', '{}', '{}', 2, 0, 'conflict', 'source_changed', now())`,
    [requestId, source!.incarnation]);

  const check = await lostCallerWritesCheck(engine, ['default']);
  expect(check.status).toBe('warn');
  expect(check.details).toMatchObject({
    count: 1,
    count_semantics: 'retained_unacknowledged_intents',
    replayable_count: null,
    preview_required: true,
  });
  expect(check.message).not.toContain('never landed');
  expect(check.message).not.toContain('was dropped');
  expect(check.message).toContain('preview');

  const { failedWritesRepair } = await import('../src/core/repair/failed-writes.ts');
  const plan = await failedWritesRepair.plan(engine, { brain_id: 'test', source_ids: ['default'] }, null, { apply: false });
  expect(plan.items).toHaveLength(0);
  expect(plan.listing?.[0]?.class).toBe('unpinned_target');
});
