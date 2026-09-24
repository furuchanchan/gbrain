/**
 * #5386 — a single-source `sync` on a worker-backed engine that defers
 * embeddings for a >100-file diff delivered neither an embed-backfill job
 * nor the manual-drain outcome, stranding every created chunk until a
 * manual `gbrain embed --stale`. `singleSourceDeferralDeliverable` unifies
 * the delivery predicate with `sync --all`: intrinsic large-sync deferrals
 * deliver when a worker surface exists and `sync.federated_v2` is on, and
 * always when there is no worker surface (manual-drain outcome).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  singleSourceDeferralDeliverable,
} from '../src/core/sync-embed-backfill.ts';
import { embedBackfillWorkerSurface } from '../src/core/minions/embed-backfill-admission.ts';
import { FEDERATED_V2_CONFIG_KEY } from '../src/core/feature-flags.ts';

let engine: PGLiteEngine;
let workerBackedEngine: BrainEngine;
let workerSurface: ReturnType<typeof embedBackfillWorkerSurface>;
let noWorkerSurface: ReturnType<typeof embedBackfillWorkerSurface>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  workerBackedEngine = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'kind') return 'postgres';
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
  workerSurface = embedBackfillWorkerSurface(workerBackedEngine);
  noWorkerSurface = embedBackfillWorkerSurface(engine);
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

describe('singleSourceDeferralDeliverable (#5386)', () => {
  test('no deferral to deliver → false', async () => {
    expect(await singleSourceDeferralDeliverable(workerBackedEngine, {
      autoDefer: false, workerSurface, embedDeferralReason: undefined,
    })).toBe(false);
  });

  test('planned auto-defer always delivers, whatever the surface', async () => {
    expect(await singleSourceDeferralDeliverable(engine, {
      autoDefer: true, workerSurface: noWorkerSurface, embedDeferralReason: undefined,
    })).toBe(true);
    expect(await singleSourceDeferralDeliverable(workerBackedEngine, {
      autoDefer: true, workerSurface, embedDeferralReason: undefined,
    })).toBe(true);
  });

  test('large_sync on a no-worker surface still delivers (manual drain)', async () => {
    expect(await singleSourceDeferralDeliverable(engine, {
      autoDefer: false, workerSurface: noWorkerSurface, embedDeferralReason: 'large_sync',
    })).toBe(true);
  });

  test('large_sync on a worker-backed surface delivers when federated_v2 is on', async () => {
    await engine.setConfig(FEDERATED_V2_CONFIG_KEY, 'true');
    expect(await singleSourceDeferralDeliverable(workerBackedEngine, {
      autoDefer: false, workerSurface, embedDeferralReason: 'large_sync',
    })).toBe(true);
  });

  test('large_sync defaults to delivering when the flag is unset', async () => {
    await engine.executeRaw('DELETE FROM config WHERE key = $1', [FEDERATED_V2_CONFIG_KEY]);
    expect(await singleSourceDeferralDeliverable(workerBackedEngine, {
      autoDefer: false, workerSurface, embedDeferralReason: 'large_sync',
    })).toBe(true);
  });

  test('federated_v2 off preserves the worker-backed rollback', async () => {
    await engine.setConfig(FEDERATED_V2_CONFIG_KEY, 'false');
    try {
      expect(await singleSourceDeferralDeliverable(workerBackedEngine, {
        autoDefer: false, workerSurface, embedDeferralReason: 'large_sync',
      })).toBe(false);
    } finally {
      await engine.executeRaw('DELETE FROM config WHERE key = $1', [FEDERATED_V2_CONFIG_KEY]);
    }
  });
});
