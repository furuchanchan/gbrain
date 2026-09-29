import type { BrainEngine } from './engine.ts';
import { BudgetTracker, loadPricingOverrides } from './budget/budget-tracker.ts';
import { usageCostUsd } from './budget/reservation-cost.ts';
import type { AIInvocation, AIInvocationPermit, AIInvocationUsage } from './ai/invocation-guard.ts';
import { MIGRATION_STATE_KEY, readMigrationState, type EmbeddingMigrationPlan, type MigrationState } from './embedding-migration.ts';
import type { DbLockHandle } from './db-lock.ts';

export async function assertMigrationLeases(engine: BrainEngine, locks: DbLockHandle[]) {
  if (!locks.length) return;
  const owned = await engine.executeRaw<{ id: string; token: string }>(`SELECT id,acquisition_token::text AS token
    FROM gbrain_cycle_locks WHERE id=ANY($1::text[]) AND ttl_expires_at>now() ORDER BY id FOR SHARE`, [locks.map(lock => lock.id)]);
  if (owned.length !== locks.length || locks.some(lock => !owned.some(row => row.id === lock.id && row.token === lock.acquisitionToken))) {
    throw new Error('Migration lease lost; authorization debit and provider dispatch refused');
  }
}

export async function authorizeMigrationBudget(engine: BrainEngine, plan: EmbeddingMigrationPlan, maxCostUsd?: number, locks: DbLockHandle[] = [], rerankerModel?: string) {
  const prior = await readMigrationState(engine);
  if (prior.corrupt) {
    let legacy = false;
    try {
      const raw = JSON.parse(prior.raw ?? 'null');
      legacy = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        && !Object.hasOwn(raw, 'budget') && !Object.hasOwn(raw, 'authorization_version');
    } catch {}
    if (!legacy || maxCostUsd === undefined) throw new Error('Migration state is corrupt; no paid request or invalidation was authorized. Inspect migrate embeddings --status.');
  }
  const same = prior.state?.to_model === plan.to_model && prior.state.to_dims === plan.to_dims;
  const state: MigrationState = same ? prior.state! : {
    version: 2, to_model: plan.to_model, to_dims: plan.to_dims, from_model: plan.from_model,
    from_dims: plan.from_dims, started_at: new Date().toISOString(),
  };
  const old = state.budget;
  if (state.authorization_version && !old) throw new Error('Migration authorization is missing; automatic renewal refused');
  if (old && (!Number.isFinite(old.max_cost_usd) || old.max_cost_usd < 0 || !Number.isFinite(old.debited_usd)
    || old.debited_usd < 0 || !Number.isSafeInteger(old.requests) || old.requests < 0)) {
    throw new Error('Migration authorization is corrupt; no request dispatched');
  }
  if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)) throw new Error('--max-cost-usd must be finite and nonnegative');
  if (!old && maxCostUsd === undefined) throw new Error('Paid work requires explicit --max-cost-usd. Preview with --dry-run; resume retains spent authorization.');
  state.budget = { max_cost_usd: maxCostUsd ?? old!.max_cost_usd, debited_usd: old?.debited_usd ?? 0, requests: old?.requests ?? 0 };
  state.authorization_version = 1;
  if (!same && prior.state) {
    state.retargeted_at = state.started_at;
    state.superseded = [...prior.state.superseded ?? [], { to_model: prior.state.to_model, to_dims: prior.state.to_dims, started_at: prior.state.started_at }];
  }
  await engine.transaction(async tx => {
    await assertMigrationLeases(tx, locks);
    await tx.setConfig(MIGRATION_STATE_KEY, JSON.stringify(state));
  });
  const pricingOverrides = await loadPricingOverrides(engine);
  return async (call: AIInvocation): Promise<AIInvocationPermit> => {
    if (call.kind !== 'embedding' && call.kind !== 'rerank') throw new Error('Migration permits embedding and reranker probes only');
    if (call.model !== (call.kind === 'embedding' ? plan.to_model : rerankerModel)) throw new Error('Provider model differs from the authorized migration plan; no request dispatched');
    if (!Number.isSafeInteger(call.maxInputTokens) || call.maxInputTokens! <= 0) throw new Error('Provider request has no conservative input ceiling; no request dispatched');
    let debitedUsd = 0;
    await engine.transaction(async tx => {
      await assertMigrationLeases(tx, locks);
      await tx.executeRaw('SELECT key FROM config WHERE key=$1 FOR UPDATE', [MIGRATION_STATE_KEY]);
      const current = (await readMigrationState(tx)).state;
      if (!current?.budget || current.to_model !== plan.to_model || current.to_dims !== plan.to_dims) throw new Error('Migration authorization changed; no request dispatched');
      if (![current.budget.max_cost_usd, current.budget.debited_usd].every(n => Number.isFinite(n) && n >= 0)
        || !Number.isSafeInteger(current.budget.requests) || current.budget.requests < 0) throw new Error('Migration authorization is corrupt; no request dispatched');
      const tracker = new BudgetTracker({ label: 'embedding-migration', maxCostUsd: Math.max(0, current.budget.max_cost_usd-current.budget.debited_usd), pricingOverrides });
      const estimate = { modelId: call.model, kind: call.kind === 'embedding' ? 'embed' as const : 'rerank' as const,
        estimatedInputTokens: call.maxInputTokens!, maxOutputTokens: 0 };
      tracker.reserve(estimate);
      tracker.record({ modelId: call.model, kind: estimate.kind, inputTokens: call.maxInputTokens!, outputTokens: 0 });
      debitedUsd = tracker.totalSpent;
      current.budget.debited_usd += debitedUsd;
      current.budget.requests++;
      await tx.setConfig(MIGRATION_STATE_KEY, JSON.stringify(current));
    });
    let settled = false;
    return { settle: async (usage: AIInvocationUsage | null) => {
      // #5680 — the debit is a reservation at the provider's maxInputTokens
      // ceiling; reconcile it down to provider-reported usage once the call
      // lands. Usage null (failed/unmeasured call) keeps the conservative
      // debit — never under-count a spent request. Unpriced actuals keep it
      // too (the reserve already priced this model).
      if (settled || usage === null) return;
      settled = true;
      const actualCost = usageCostUsd(call.model, usage.inputTokens, usage.outputTokens,
        call.kind === 'embedding' ? 'embed' : 'rerank', pricingOverrides);
      if (actualCost === null || actualCost >= debitedUsd) return;
      await engine.transaction(async tx => {
        await assertMigrationLeases(tx, locks);
        await tx.executeRaw('SELECT key FROM config WHERE key=$1 FOR UPDATE', [MIGRATION_STATE_KEY]);
        const current = (await readMigrationState(tx)).state;
        if (!current?.budget || current.to_model !== plan.to_model || current.to_dims !== plan.to_dims) return;
        current.budget.debited_usd = Math.max(0, current.budget.debited_usd - (debitedUsd - actualCost));
        await tx.setConfig(MIGRATION_STATE_KEY, JSON.stringify(current));
      });
    } };
  };
}
