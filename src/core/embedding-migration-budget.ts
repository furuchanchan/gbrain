import type { BrainEngine } from './engine.ts';
import { BudgetExhausted, BudgetTracker, loadPricingOverrides } from './budget/budget-tracker.ts';
import type { AIInvocation, AIInvocationPermit } from './ai/invocation-guard.ts';
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
    const estimate = { modelId: call.model, kind: call.kind === 'embedding' ? 'embed' as const : 'rerank' as const,
      estimatedInputTokens: call.maxInputTokens!, maxOutputTokens: 0 };
    let debitedCall = 0;
    await engine.transaction(async tx => {
      await assertMigrationLeases(tx, locks);
      await tx.executeRaw('SELECT key FROM config WHERE key=$1 FOR UPDATE', [MIGRATION_STATE_KEY]);
      const current = (await readMigrationState(tx)).state;
      if (!current?.budget || current.to_model !== plan.to_model || current.to_dims !== plan.to_dims) throw new Error('Migration authorization changed; no request dispatched');
      if (![current.budget.max_cost_usd, current.budget.debited_usd].every(n => Number.isFinite(n) && n >= 0)
        || !Number.isSafeInteger(current.budget.requests) || current.budget.requests < 0) throw new Error('Migration authorization is corrupt; no request dispatched');
      const tracker = new BudgetTracker({ label: 'embedding-migration', maxCostUsd: Math.max(0, current.budget.max_cost_usd-current.budget.debited_usd), pricingOverrides });
      try {
        tracker.reserve(estimate);
      } catch (error) {
        // #5680: this tracker's cap is the *remaining* authorization, so its
        // refusal text printed "--max-cost $0.00 / cumulative $0.0000" — read
        // like a parse bug next to the operator's real cap. Report those.
        if (error instanceof BudgetExhausted && error.reason === 'cost') {
          const probe = new BudgetTracker({ label: 'embedding-migration', pricingOverrides });
          probe.record({ modelId: call.model, kind: estimate.kind, inputTokens: call.maxInputTokens!, outputTokens: 0 });
          throw new BudgetExhausted(
            `embedding-migration: this request's ceiling $${probe.totalSpent.toFixed(4)} exceeds the remaining authorization ` +
              `(--max-cost-usd $${current.budget.max_cost_usd.toFixed(4)} - debited $${current.budget.debited_usd.toFixed(4)})`,
            { reason: 'cost', spent: current.budget.debited_usd, cap: current.budget.max_cost_usd, modelId: call.model });
        }
        throw error;
      }
      tracker.record({ modelId: call.model, kind: estimate.kind, inputTokens: call.maxInputTokens!, outputTokens: 0 });
      debitedCall = tracker.totalSpent;
      current.budget.debited_usd += debitedCall;
      current.budget.requests++;
      await tx.setConfig(MIGRATION_STATE_KEY, JSON.stringify(current));
    });
    // #5680: the ceiling debit holds only until the attempt reports usage —
    // settle reconciles it to real spend so the cap tracks actuals. A null
    // usage (ambiguous attempt) keeps the ceiling, per invokeAI's contract.
    return { settle: async usage => {
      if (!usage || !(debitedCall > 0)) return;
      const actual = new BudgetTracker({ label: 'embedding-migration', pricingOverrides });
      actual.record({ modelId: call.model, kind: estimate.kind,
        inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), outputTokens: usage.outputTokens ?? 0 });
      const delta = actual.totalSpent - debitedCall;
      if (delta === 0) return;
      let exhausted: BudgetExhausted | undefined;
      await engine.transaction(async tx => {
        await assertMigrationLeases(tx, locks);
        await tx.executeRaw('SELECT key FROM config WHERE key=$1 FOR UPDATE', [MIGRATION_STATE_KEY]);
        const current = (await readMigrationState(tx)).state;
        if (!current?.budget || current.to_model !== plan.to_model || current.to_dims !== plan.to_dims) return;
        // Signed delta: under-run credits authorization back, over-run
        // debits the real spend — an underestimate (a 100k-token ceiling
        // that actually cost 150k) must not silently under-account.
        current.budget.debited_usd = Math.max(0, current.budget.debited_usd + delta);
        await tx.setConfig(MIGRATION_STATE_KEY, JSON.stringify(current));
        // 1e-9 epsilon: float addition can land a hair above an exactly-at-
        // cap total (0.0001+0.0001+0.0028 ≈ 0.003000000000000001) — real
        // overage means actual spend crossed the authorization.
        if (current.budget.debited_usd - current.budget.max_cost_usd > 1e-9) {
          exhausted = new BudgetExhausted(
            `embedding-migration: settled actual spend pushed debited $${current.budget.debited_usd.toFixed(4)} past ` +
              `--max-cost-usd $${current.budget.max_cost_usd.toFixed(4)}; no further requests dispatched`,
            { reason: 'cost', spent: current.budget.debited_usd, cap: current.budget.max_cost_usd, modelId: call.model });
        }
      });
      // Thrown only after the debit commits — a rollback must not erase
      // real spend — and the exhausted durable state refuses the next
      // authorization, so dispatch stops here.
      if (exhausted) throw exhausted;
    } };
  };
}
