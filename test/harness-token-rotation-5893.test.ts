/**
 * #5893 — harness token rotation carries the prior token's operator-set
 * takes_holders into the fresh mint instead of resetting to ['world'].
 *
 * `readRotatedTakesHolders` is the read half (token-mint.ts); the apply-side
 * wiring that passes `preserveTakesHoldersFrom` for each rotating-out token
 * id is asserted in bootstrap-harness.serial.test.ts's mint-first [C7]
 * rotation test.
 *
 * PGLite: validates the real access_tokens row round-trip, not a stub.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { mintLegacyToken, readRotatedTakesHolders } from '../src/core/token-mint.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function takesHoldersOf(id: string): Promise<unknown> {
  const rows = await engine.executeRaw<{ permissions: { takes_holders?: unknown } }>(
    `SELECT permissions FROM access_tokens WHERE id = $1::uuid`, [id]);
  return rows[0]?.permissions?.takes_holders;
}

describe('readRotatedTakesHolders', () => {
  test('returns the prior token\'s operator-widened holder list', async () => {
    const prior = await mintLegacyToken(engine, {
      name: 'bootstrap-harness', takesHolders: ['world', 'garry', 'team'],
      scopes: ['read', 'write'], allowedOperations: ['recall', 'remember'],
    });
    expect(await readRotatedTakesHolders(engine, prior.id)).toEqual(['world', 'garry', 'team']);
  });

  test('default mint reads back as ["world"]', async () => {
    const prior = await mintLegacyToken(engine, {
      name: 'bootstrap-harness', takesHolders: [], scopes: ['read'],
    });
    expect(await readRotatedTakesHolders(engine, prior.id)).toEqual(['world']);
  });

  test('unknown id or damaged permissions → undefined (documented default wins)', async () => {
    expect(await readRotatedTakesHolders(engine, '33333333-3333-3333-3333-333333333333')).toBeUndefined();
    const prior = await mintLegacyToken(engine, {
      name: 'bootstrap-harness', takesHolders: ['world', 'garry'], scopes: ['read'],
    });
    // Historical double-encode damage: permissions as a jsonb STRING scalar.
    await engine.executeRaw(
      `UPDATE access_tokens SET permissions = '"not-an-object"'::jsonb WHERE id = $1::uuid`, [prior.id]);
    expect(await readRotatedTakesHolders(engine, prior.id)).toBeUndefined();
  });
});

describe('rotation carry-through', () => {
  test('a fresh mint seeded from the prior id keeps the widened holder list', async () => {
    const prior = await mintLegacyToken(engine, {
      name: 'bootstrap-harness', takesHolders: ['world', 'garry', 'team'], scopes: ['read', 'write'],
    });
    const carried = await readRotatedTakesHolders(engine, prior.id) ?? ['world'];
    const next = await mintLegacyToken(engine, {
      name: 'bootstrap-harness', takesHolders: carried, scopes: ['read', 'write'],
    });
    expect(await takesHoldersOf(next.id)).toEqual(['world', 'garry', 'team']);
  });
});
