/**
 * #5353 — doctor surfaces a durable managed-sync cursor frozen on a terminal
 * write receipt. sync_freshness cannot see this lane (it measures commit
 * lag, not cursor liveness), so a single unimportable file permanently
 * blocked every later incremental sync with `blocked_by_failures` while
 * doctor stayed green.
 *
 * The wedge is the JOIN: a terminal persistence_request only counts while an
 * op_checkpoints managed-sync cursor's pending.requestId still points at it.
 * Seeds verify: frozen terminal → fail naming source/path/error + repair
 * hint; committed / in-flight / orphaned (no cursor points at it) receipts
 * → ok; remote surface → aggregate counts, never a path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { doctorSource } from './helpers/doctor-source.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkManagedSyncWedge } from '../src/commands/doctor/checks/managed-sync-wedge.ts';

let engine: PGLiteEngine;

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ORPHAN_ID = '22222222-2222-4222-8222-222222222222';
const INCARNATION = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op = 'managed-sync'`);
  await engine.executeRaw(`DELETE FROM persistence_requests`);
});

async function seedReceipt(
  requestId: string,
  state: string,
  opts: { path?: string; errorCode?: string; kind?: string } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO persistence_requests
       (principal_kind, principal_id, request_id, operation, source_id,
        source_incarnation, slug, digest, intent, authority, state,
        error_code, intent_bytes, terminal_reservation, completed_at)
     VALUES ('local_cli', 'test', $1::uuid, 'submit_job', 'default',
             $2::uuid, 'notes/broken', 'digest',
             $3::text::jsonb, '{"v":1}'::jsonb, $4, $5, 10, 0,
             CASE WHEN $4 IN ('queued','running','recovering') THEN NULL ELSE now() END)`,
    [
      requestId,
      INCARNATION,
      JSON.stringify({ kind: opts.kind ?? 'managed_sync_import', path: opts.path ?? 'notes/broken.md' }),
      state,
      opts.errorCode ?? null,
    ],
  );
}

async function seedCursor(requestId: string | null): Promise<void> {
  const header = {
    sourceId: 'default',
    root: '/repo',
    from: 'aaa0000',
    target: 'bbb1111',
    runId: 'run-1',
    index: 0,
    total: 3,
    authority: { writer: { principal: { kind: 'local_cli', id: 'test' } } },
    counts: { added: 0, modified: 0, deleted: 0, chunks: 0 },
    ...(requestId
      ? { pending: { requestId, slug: 'notes/broken', pageId: null, intent: { kind: 'managed_sync_import', path: 'notes/broken.md' } } }
      : {}),
  };
  await engine.executeRaw(
    `INSERT INTO op_checkpoints (op, fingerprint, completed_keys)
     VALUES ('managed-sync', 'fp-test', $1::text::jsonb)`,
    [JSON.stringify([header])],
  );
}

describe('#5353 — managed_sync_wedge doctor check', () => {
  it('fails when a cursor pending points at a terminal failed receipt', async () => {
    await seedReceipt(REQUEST_ID, 'failed', { errorCode: 'page_parse_failed' });
    await seedCursor(REQUEST_ID);
    const check = await checkManagedSyncWedge(engine);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('notes/broken.md');
    expect(check.message).toContain('page_parse_failed');
    expect(check.message).toContain('--retry-failed');
  });

  it('reports ok when no managed-sync cursor exists', async () => {
    const check = await checkManagedSyncWedge(engine);
    expect(check.status).toBe('ok');
  });

  it('reports ok when the pending receipt is committed (cursor advanced)', async () => {
    await seedReceipt(REQUEST_ID, 'committed');
    await seedCursor(REQUEST_ID);
    const check = await checkManagedSyncWedge(engine);
    expect(check.status).toBe('ok');
  });

  it('reports ok for in-flight non-terminal receipts (writer_pending resumes)', async () => {
    await seedReceipt(REQUEST_ID, 'running');
    await seedCursor(REQUEST_ID);
    const check = await checkManagedSyncWedge(engine);
    expect(check.status).toBe('ok');
  });

  it('ignores orphaned terminal receipts no cursor points at (post-retry state)', async () => {
    await seedReceipt(ORPHAN_ID, 'failed');
    await seedCursor(REQUEST_ID); // pending points at a different, missing request → no wedge
    const check = await checkManagedSyncWedge(engine);
    expect(check.status).toBe('ok');
  });

  it('remote surface returns aggregate counts and never a path', async () => {
    await seedReceipt(REQUEST_ID, 'cancelled');
    await seedCursor(REQUEST_ID);
    const check = await checkManagedSyncWedge(engine, { remote: true });
    expect(check.status).toBe('fail');
    expect(check.message).not.toContain('notes/broken.md');
    expect(check.message).toContain('1 terminal');
    expect(JSON.stringify(check.details ?? {})).not.toContain('notes/broken.md');
  });
});

describe('#5353 — doctor source-text guard', () => {
  it('the check module is registered in doctor-categories', async () => {
    const { categorizeCheck } = await import('../src/core/doctor-categories.ts');
    expect(categorizeCheck('managed_sync_wedge')).toBe('brain');
  });
});
