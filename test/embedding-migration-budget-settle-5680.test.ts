import { afterAll, beforeAll, beforeEach, test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { authorizeMigrationBudget } from '../src/core/embedding-migration-budget.ts';
import { MIGRATION_STATE_KEY } from '../src/core/embedding-migration.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });
afterAll(async () => { await engine.disconnect(); resetGateway(); });

const PLAN = {
  from_model: 'openai:text-embedding-3-small', from_dims: 1536,
  column_dims: 1536, to_model: 'openai:text-embedding-3-small', to_dims: 1536,
  dim_change: false, chunks_to_embed: 10, total_chars: 1000,
  null_signature_chunks: 0, false_stamped_chunks: 0, est_cost_usd: 0,
  price_known: true, resuming: false, reranker_warning: null,
  signature_census: [], synopsis_tier_pages: 0,
};
const CALL = { operation: 'embed', model: 'openai:text-embedding-3-small', kind: 'embedding' as const, maxInputTokens: 100_000 };
const debited = async () => {
  const state = JSON.parse((await engine.getConfig(MIGRATION_STATE_KEY)) ?? '{}') as { budget?: { debited_usd: number; requests: number } };
  return state.budget;
};

// #5680: each request was debited at its maxInputTokens ceiling ($0.002) and
// settle() was a no-op, so --max-cost-usd ran ~75x above real spend and a cap
// near the printed estimate stalled the run at ~2%.
test('migration budget settle credits ceiling debit down to measured usage (#5680)', async () => {
  const debit = await authorizeMigrationBudget(engine, PLAN, 0.30);
  const permit = await debit(CALL);
  expect((await debited())!.debited_usd).toBeCloseTo(0.002, 6); // 100k ceiling tokens at $0.02/Mtok
  await permit.settle({ inputTokens: 2_000, outputTokens: 0 });
  const settled = (await debited())!;
  expect(settled.debited_usd).toBeCloseTo(0.00004, 6); // actual usage only
  expect(settled.requests).toBe(1);
  // The credited authorization admits the next request — the wedge is gone.
  const next = await debit(CALL);
  expect((await debited())!.debited_usd).toBeCloseTo(0.00004 + 0.002, 6);
  await next.settle({ inputTokens: 2_000, outputTokens: 0 });
  expect((await debited())!.debited_usd).toBeCloseTo(0.00008, 6);
});

test('migration budget keeps the ceiling debit on an ambiguous attempt (#5680)', async () => {
  const debit = await authorizeMigrationBudget(engine, PLAN, 0.30);
  const permit = await debit(CALL);
  await permit.settle(null);
  expect((await debited())!.debited_usd).toBeCloseTo(0.002, 6); // no release on null usage
});

test('migration budget refusal reports the operator cap, not the remainder (#5680)', async () => {
  const debit = await authorizeMigrationBudget(engine, PLAN, 0.003);
  const first = await debit(CALL);
  await first.settle({ inputTokens: 5_000, outputTokens: 0 }); // settles to $0.0001 — remaining $0.0029 < $0.002 ceiling? no: $0.0029 > $0.002 → admit
  const second = await debit(CALL);
  await second.settle({ inputTokens: 5_000, outputTokens: 0 }); // debited $0.0002, remaining $0.0028
  const third = await debit(CALL); // ceiling $0.002 fits $0.0028 → admit
  await third.settle({ inputTokens: 140_000, outputTokens: 0 }); // actual over ceiling → ceiling debit kept: debited $0.0022, remaining $0.0008
  let refusal: unknown;
  try { await debit(CALL); } catch (error) { refusal = error; }
  expect((refusal as Error).message).toContain('--max-cost-usd $0.0030');
  expect((refusal as Error).message).toContain('debited $0.0022');
  expect((refusal as Error).message).not.toContain('--max-cost $0.00');
});
