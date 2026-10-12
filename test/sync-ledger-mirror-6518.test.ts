import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncFailures } from '../src/commands/doctor/checks/sync-failures.ts';
import { recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { withEnv } from './helpers/with-env.ts';

// gbrain#6518 — a durable managed-sync-failure row retired by an engine-side
// path leaves its local-ledger mirror row behind: `doctor --fast` (no engine)
// then keeps reporting an unresolved failure nothing can clear, and
// `sync status` shows a cursor pinned to an incarnation no sync can select.
const home = mkdtempSync(join(tmpdir(), 'gbrain-6518-'));
const env = { GBRAIN_SYNC_FAILURES_DIR: home };

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('TRUNCATE sources CASCADE');
  rmSync(join(home, 'sync-failures.jsonl'), { force: true });
});

const INCARNATION = '11111111-1111-1111-1111-111111111111';

async function seedSource() {
  await engine.executeRaw(`INSERT INTO sources(id,name,incarnation) VALUES('src-x','src-x',$1)`, [INCARNATION]);
}

const failure = (cursorKey: string) => ({
  source_id: 'src-x', source_incarnation: INCARNATION, path: 'a.md', code: 'recovery_required',
  message: 'synthetic failure', request_id: null, run_id: 'run-1', target: 'deadbeef',
  cursor_key: cursorKey, phase: 'receipt' as const, state: 'failed', observation_id: `obs-${cursorKey}`,
});

describe('managed sync ledger mirror pruning (#6518)', () => {
  test('a mirror row with no durable failure is pruned on an engine read; doctor --fast then reports clean', async () => withEnv(env, async () => {
    await seedSource();
    await recordManagedSyncFailure(engine, failure('ck-1'));
    expect(loadSyncFailures().filter(row => row.managed_cursor_key === 'ck-1').length).toBe(1);

    // Retire the durable row without the mirror path, as an engine-side repair can.
    await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op='managed-sync-failure'`);
    expect(loadSyncFailures().filter(row => row.managed_cursor_key === 'ck-1').length).toBe(1);

    // An engine-connected read prunes the ghost mirror row.
    await checkSyncFailures(engine, { remote: false });
    expect(loadSyncFailures().filter(row => row.managed_cursor_key === 'ck-1').length).toBe(0);

    // The no-engine check (doctor --fast) no longer counts it as unresolved.
    const fast = await checkSyncFailures(null, { remote: false });
    expect(fast === null || fast.status === 'ok').toBe(true);
  }));

  test('a mirror row whose key still has a durable failure is kept', async () => withEnv(env, async () => {
    await seedSource();
    await recordManagedSyncFailure(engine, failure('ck-2'));
    await checkSyncFailures(engine, { remote: false });
    expect(loadSyncFailures().filter(row => row.managed_cursor_key === 'ck-2').length).toBe(1);
  }));
});

describe('sync status cursor incarnation filter (#6518)', () => {
  test('a cursor recorded under another incarnation is not reported as resumable', async () => withEnv(env, async () => {
    await seedSource();
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync','ck-old',$1::text::jsonb)`, [JSON.stringify([{
      sourceId: 'src-x', incarnation: '22222222-2222-2222-2222-222222222222', runId: 'run-old',
      index: 0, total: 1, target: 'cafe0000', done: false,
    }])]);
    const status = await readSyncStatus(engine, 'src-x');
    expect(status.cursor).toBeNull();
  }));

  test('a cursor recorded under the current incarnation is still reported', async () => withEnv(env, async () => {
    await seedSource();
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync','ck-live',$1::text::jsonb)`, [JSON.stringify([{
      sourceId: 'src-x', incarnation: INCARNATION, runId: 'run-live',
      index: 0, total: 1, target: 'cafe0000', done: false,
    }])]);
    const status = await readSyncStatus(engine, 'src-x');
    expect(status.cursor).not.toBeNull();
    expect(status.cursor!.done).toBe(false);
  }));
});
