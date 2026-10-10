/**
 * #6423: a managed catch-up's own round-trips — freeze, admission, the cursor's compare-and-swap — run through
 * `managedSyncStatementEngine` on the engine's direct route when it has one (the consumer's statements already
 * do, #6317). A transaction-mode pooler can hold a round-trip in its own queue where no server-side timeout can
 * end it; a 208-entry catch-up froze mid-manifest that way and admitted nothing. Without a direct route the run
 * keeps the ordinary pool and names the exposure once at start.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { consumerStatementEngine, managedSyncStatementEngine, poolerExposureLine } from '../src/core/persistence/consumer-lane.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';

/** A postgres-shaped engine; `dual` says its connectionManager has a direct route, `calls` records the member each call took. */
function routedEngine(dual: boolean) {
  const calls: string[] = [];
  const engine = {
    kind: 'postgres',
    connectionManager: { isDualPoolActive: () => dual, describeMode: () => ({ direct_host: 'direct' }) },
    sql: { options: { prepare: false } },
    async executeRaw() { calls.push('executeRaw'); return []; },
    async executeRawDirect() { calls.push('executeRawDirect'); return []; },
    async transaction<T>(fn: (e: BrainEngine) => Promise<T>) { calls.push('transaction'); return fn(engine as unknown as BrainEngine); },
    async transactionDirect<T>(fn: (e: BrainEngine) => Promise<T>) { calls.push('transactionDirect'); return fn(engine as unknown as BrainEngine); },
  };
  return { engine: engine as unknown as BrainEngine, calls };
}
const directLane = () => { delete process.env.GBRAIN_CONSUMER_DIRECT_LANE; resetWriteSwitches(); };

test('#6423: a managed sync routes its statements and its transactions to the direct lane when the engine has one', async () => {
  directLane();
  const { engine, calls } = routedEngine(true);
  const sync = managedSyncStatementEngine(engine);
  await sync.executeRaw('SELECT 1');
  await sync.transaction(async () => 'admitted');
  expect(calls).toEqual(['executeRawDirect', 'transactionDirect']);
  // A bounded statement keeps its bound on the ordinary route, like the consumer's reads (#6318).
  calls.length = 0;
  await sync.executeRaw('SELECT 1', [], { timeoutMs: 50 });
  expect(calls).toEqual(['executeRaw']);
});

test('#6423: without a direct route the sync keeps the ordinary pool and names the exposure', async () => {
  directLane();
  const { engine, calls } = routedEngine(false);
  const sync = managedSyncStatementEngine(engine);
  await sync.executeRaw('SELECT 1');
  await sync.transaction(async () => 'admitted');
  expect(calls).toEqual(['executeRaw', 'transaction']);
  const line = poolerExposureLine({ lane: 'pool', pooler_mode: 'transaction' }, 'the managed sync');
  expect(line).toContain('the managed sync runs its statements through a transaction-mode pooler');
  expect(poolerExposureLine({ lane: 'direct', pooler_mode: 'transaction' }, 'the managed sync')).toBeNull();
  expect(poolerExposureLine({ lane: 'pool', pooler_mode: 'session_or_direct' }, 'the managed sync')).toBeNull();
});

test('the consumer view keeps its transactions on the ordinary pool', async () => {
  directLane();
  const { engine, calls } = routedEngine(true);
  const consumer = consumerStatementEngine(engine);
  await consumer.executeRaw('SELECT 1');
  await consumer.transaction(async () => 'tick');
  expect(calls).toEqual(['executeRawDirect', 'transaction']);
});

test('a non-postgres engine is returned unchanged', () => {
  const engine = { kind: 'pglite' } as unknown as BrainEngine;
  expect(managedSyncStatementEngine(engine)).toBe(engine);
});

test('#6423: runManagedSync installs the managed-sync statement engine and names a transaction-pooler exposure', () => {
  const src = readFileSync(new URL('../src/core/persistence/sync-run.ts', import.meta.url), 'utf8');
  // The wrap lands after the company-brain early return so the delegated runner and the drain share it;
  // managedSyncStatementRoute both emits the pooler exposure line and wraps the engine (consumer-lane.ts).
  expect(src).toMatch(/engine = managedSyncStatementRoute\(engine\);/);
  const laneSrc = readFileSync(new URL('../src/core/persistence/consumer-lane.ts', import.meta.url), 'utf8');
  expect(laneSrc).toMatch(/poolerExposureLine\(consumerConnectionRoute\(engine\), 'the managed sync'\)/);
});
