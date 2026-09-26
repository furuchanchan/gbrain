import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

// gbrain#5449 — PGLite's inline automatic checkpoint can self-deadlock when
// it fires mid buffer-flush on brains larger than shared_buffers. The engine
// pre-empts it: every 25 committed transactions it measures WAL distance to
// the last redo LSN and issues a top-level CHECKPOINT past
// GBRAIN_PG_CHECKPOINT_MB.
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

const redoLsn = async (): Promise<string> => {
  const { rows } = await engine.db.query<{ redo_lsn: string }>(
    'SELECT redo_lsn FROM pg_control_checkpoint()',
  );
  return rows[0].redo_lsn;
};

describe('PGLite WAL checkpoint guard (#5449)', () => {
  test('issues a top-level CHECKPOINT once WAL distance crosses the threshold', async () => withEnv({ GBRAIN_PG_CHECKPOINT_MB: '0.0001' }, async () => {
    const before = await redoLsn();
    // 25 committed transactions is the guard's probe cadence; each writes WAL.
    for (let i = 0; i < 25; i++) {
      await engine.transaction(async (tx) => {
        await tx.executeRaw(`INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [`ckpt-${i}`]);
      });
    }
    // redo_lsn only advances when a checkpoint runs; a top-level CHECKPOINT
    // proves the guard fired (PGLite has no background checkpointer).
    const after = await redoLsn();
    expect(after).not.toBe(before);
  }), 60_000);

  test('non-positive GBRAIN_PG_CHECKPOINT_MB disables the guard', async () => withEnv({ GBRAIN_PG_CHECKPOINT_MB: '0' }, async () => {
    const before = await redoLsn();
    for (let i = 0; i < 26; i++) {
      await engine.transaction(async (tx) => {
        await tx.executeRaw('SELECT 1');
      });
    }
    // PGLite has no background checkpointer, so nothing else can advance it.
    expect(await redoLsn()).toBe(before);
  }), 60_000);
});
