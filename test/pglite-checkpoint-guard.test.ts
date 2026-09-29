import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

// gbrain#5449 — PGLite's inline automatic checkpoint can self-deadlock when
// it fires mid buffer-flush on brains larger than shared_buffers. The engine
// pre-empts it: after every committed transaction it measures WAL distance
// to the last redo LSN and issues a top-level CHECKPOINT once the distance
// passes GBRAIN_PG_CHECKPOINT_MB, so a crossed threshold never survives
// into the next transaction's flush path.
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
  test('a single committed transaction over the threshold checkpoints immediately', async () => withEnv({ GBRAIN_PG_CHECKPOINT_MB: '0.0001' }, async () => {
    const before = await redoLsn();
    // ONE transaction — not the old 25-commit cadence. The probe must run
    // postcommit of this very tx and checkpoint before any next tx exists.
    await engine.transaction(async (tx) => {
      await tx.executeRaw(`INSERT INTO sources(id,name) VALUES('ckpt-single','ckpt-single') ON CONFLICT DO NOTHING`, []);
    });
    // redo_lsn only advances when a checkpoint runs; a top-level CHECKPOINT
    // proves the guard fired (PGLite has no background checkpointer).
    expect(await redoLsn()).not.toBe(before);
  }), 60_000);

  test('WAL distance never carries past the threshold into a second transaction', async () => withEnv({ GBRAIN_PG_CHECKPOINT_MB: '0.0001' }, async () => {
    const dist = async () => (await engine.db.query<{ mb: number }>(
      `SELECT (pg_wal_lsn_diff(pg_current_wal_lsn(), redo_lsn) / 1048576)::float8 AS mb FROM pg_control_checkpoint()`,
    )).rows[0].mb;
    for (let i = 0; i < 5; i++) {
      await engine.transaction(async (tx) => {
        await tx.executeRaw(`INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [`ckpt-nocarry-${i}`]);
      });
      // Postcommit: the guard already ran for THIS tx, so the only residual
      // WAL distance entering the next transaction is this tx's own tail
      // (bytes) — never a carried-over backlog approaching the threshold.
      expect(await dist()).toBeLessThan(0.01);
    }
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
