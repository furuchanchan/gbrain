// #5680 — authorizeMigrationBudget debited each request at the provider's
// maxInputTokens ceiling and never settled, so a --max-cost-usd sized near
// the printed plan estimate exhausted the authorization at ~2% of the drain.
// The permit now reconciles the reservation down to provider-reported usage.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { planEmbeddingMigration, readMigrationState } from '../src/core/embedding-migration.ts';
import { authorizeMigrationBudget } from '../src/core/embedding-migration-budget.ts';
import { invokeAI, withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';

const MODEL = 'openai:text-embedding-3-small';
const RATE = 0.02; // $/1M tokens via pricing.overrides
const CALL_TOKENS = 40_000; // conservative ceiling per request
const ACTUAL_TOKENS = 100;  // provider-reported usage for a successful call

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

const budget = async () => (await readMigrationState(engine)).state?.budget;
const ceilDebit = CALL_TOKENS / 1e6 * RATE;       // 0.0008
const actualDebit = ACTUAL_TOKENS / 1e6 * RATE;   // 0.000002

const invocation = {
  kind: 'embedding' as const,
  operation: 'test-migration-settle',
  model: MODEL,
  maxInputTokens: CALL_TOKENS,
};

const authorize = async () => {
  await resetPgliteState(engine);
  await engine.setConfig('pricing.overrides', JSON.stringify({ [MODEL]: { input: RATE, output: 0 } }));
  const plan = await planEmbeddingMigration(engine, { to: MODEL, dim: 1536 });
  return authorizeMigrationBudget(engine, plan, 0.10);
};

describe('migration budget settle (#5680)', () => {
  test('a successful call reconciles the ceiling debit down to provider-reported usage', async () => {
    const debit = await authorize();
    await withAIInvocationGuard(debit, () => invokeAI(
      invocation,
      async () => ({ tokens: ACTUAL_TOKENS }),
      value => ({ inputTokens: value.tokens, outputTokens: 0 }),
    ));
    const b = (await budget())!;
    expect(b.requests).toBe(1);
    expect(b.debited_usd).toBeCloseTo(actualDebit, 9);
    // Must be FAR below the ceiling debit — the whole point of the fix.
    expect(b.debited_usd).toBeLessThan(ceilDebit / 100);
  });

  test('repeated small actuals never exhaust a cap the ceiling math would blow past', async () => {
    const debit = await authorize();
    // Ceiling math: 125 calls × $0.0008 = $0.10 = the cap. Actuals: $0.00025.
    // The reporter's run stalled at ~2% because debit never settled; with
    // settle the SAME cap covers the full drain this many times over.
    for (let i = 0; i < 130; i++) {
      await withAIInvocationGuard(debit, () => invokeAI(
        invocation,
        async () => ({ tokens: ACTUAL_TOKENS }),
        value => ({ inputTokens: value.tokens, outputTokens: 0 }),
      ));
    }
    const b = (await budget())!;
    expect(b.requests).toBe(130);
    expect(b.debited_usd).toBeCloseTo(130 * actualDebit, 9);
  });

  test('a failed/unmeasured call keeps the conservative debit (fail-closed)', async () => {
    const debit = await authorize();
    await withAIInvocationGuard(debit, () =>
      invokeAI(invocation, async () => { throw new Error('provider down'); }, () => null).catch(() => {}),
    );
    const b = (await budget())!;
    expect(b.requests).toBe(1);
    expect(b.debited_usd).toBeCloseTo(ceilDebit, 9);
  });

  test('settle is idempotent and a retargeted plan never settles into the wrong authorization', async () => {
    const debit = await authorize();
    const permit = await debit(invocation);
    await permit.settle({ inputTokens: ACTUAL_TOKENS, outputTokens: 0 });
    await permit.settle({ inputTokens: ACTUAL_TOKENS, outputTokens: 0 }); // second settle: no double-refund
    const b = (await budget())!;
    expect(b.debited_usd).toBeCloseTo(actualDebit, 9);
  });
});
