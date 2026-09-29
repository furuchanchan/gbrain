// #5686 — a completed source cycle stamps last_source_cycle_at /
// last_full_cycle_at into sources.config, and the managed-connector
// checkpoint key hashed the whole config: the next sync computed a different
// fingerprint, found no saved state, and restarted Gmail's completed
// historical backfill.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  connectorCheckpointKey,
  legacyConnectorCheckpointKey,
  readConnectorCheckpoint,
} from '../src/core/persistence/connector-sync.ts';

const SOURCE_ID = 'example-google';
const INCARNATION = '00000000-0000-4000-8000-000000000001';
const BASE = {
  kind: 'google',
  g_account: 'example@example.com',
  g_services: 'gmail',
  g_history_days: 90,
};
const STAMPED = {
  ...BASE,
  last_full_cycle_at: '2030-01-02T03:04:43.000Z',
  last_source_cycle_at: '2030-01-02T03:04:43.000Z',
};
const CHECKPOINT = [{ generation: 209, state: { gmail_backfill_done: true, gmail_history_id: 'synthetic-history' } }];

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

const insertCheckpoint = (fingerprint: string, keys: unknown[]) =>
  engine.executeRaw(
    `INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-connector',$1,$2::text::jsonb)
      ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys`,
    [fingerprint, JSON.stringify(keys)]);
const deleteFingerprint = (fingerprint: string) =>
  engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [fingerprint]);

describe('connectorCheckpointKey normalization (#5686)', () => {
  test('cycle bookkeeping timestamps do not change checkpoint identity', () => {
    expect(connectorCheckpointKey(SOURCE_ID, INCARNATION, 'google', STAMPED))
      .toBe(connectorCheckpointKey(SOURCE_ID, INCARNATION, 'google', BASE));
  });

  test('real connector configuration still participates in identity', () => {
    const base = connectorCheckpointKey(SOURCE_ID, INCARNATION, 'google', BASE);
    expect(connectorCheckpointKey(SOURCE_ID, INCARNATION, 'google', { ...BASE, g_history_days: 30 })).not.toBe(base);
    expect(connectorCheckpointKey(SOURCE_ID, INCARNATION, 'google', { ...BASE, g_services: 'gmail,calendar' })).not.toBe(base);
    expect(connectorCheckpointKey(SOURCE_ID, INCARNATION, 'github', BASE)).not.toBe(base);
    expect(connectorCheckpointKey('other-source', INCARNATION, 'google', BASE)).not.toBe(base);
    expect(connectorCheckpointKey(SOURCE_ID, 'different-incarnation', 'google', BASE)).not.toBe(base);
  });
});

describe('readConnectorCheckpoint (#5686)', () => {
  test('a checkpoint written before cycle bookkeeping still resolves after the timestamps change', async () => {
    // The reported sequence: backfill committed under the unstamped config,
    // the cycle then stamped both timestamps, and the next sync missed.
    const unstampedKey = connectorCheckpointKey(SOURCE_ID, INCARNATION, 'google', BASE);
    await insertCheckpoint(unstampedKey, CHECKPOINT);
    expect(await readConnectorCheckpoint(engine, SOURCE_ID, INCARNATION, 'google', STAMPED)).toEqual(CHECKPOINT);
    await deleteFingerprint(unstampedKey);
  });

  test('a legacy full-config row is adopted verifiably and republished under the stable key', async () => {
    const legacyKey = legacyConnectorCheckpointKey(SOURCE_ID, INCARNATION, 'google', STAMPED);
    const stableKey = connectorCheckpointKey(SOURCE_ID, INCARNATION, 'google', STAMPED);
    expect(legacyKey).not.toBe(stableKey);
    await insertCheckpoint(legacyKey, CHECKPOINT);
    // Same full config → the legacy fingerprint proves equivalence.
    expect(await readConnectorCheckpoint(engine, SOURCE_ID, INCARNATION, 'google', STAMPED)).toEqual(CHECKPOINT);
    // It was republished under the stable key: a config with DIFFERENT
    // bookkeeping timestamps now resolves directly.
    const reStamped = { ...STAMPED, last_full_cycle_at: '2030-06-01T00:00:00.000Z' };
    expect(await readConnectorCheckpoint(engine, SOURCE_ID, INCARNATION, 'google', reStamped)).toEqual(CHECKPOINT);
    await deleteFingerprint(stableKey);
    await deleteFingerprint(legacyKey);
  });

  test('a row keyed under different real configuration is not adopted', async () => {
    const otherConfig = { ...BASE, g_history_days: 30 };
    const otherKey = connectorCheckpointKey(SOURCE_ID, INCARNATION, 'google', otherConfig);
    await insertCheckpoint(otherKey, CHECKPOINT);
    expect(await readConnectorCheckpoint(engine, SOURCE_ID, INCARNATION, 'google', STAMPED)).toEqual([]);
    await deleteFingerprint(otherKey);
  });
});
