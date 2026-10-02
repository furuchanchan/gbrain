/**
 * ingest-facts.ts — the `--facts` lane of transcripts ingest (cathedral-4).
 *
 * ONE `runExtractConversationFactsCore` invocation per run (the batch
 * `slugs` selector), wrapped in ONE `withBudgetTracker` — passing a tracker
 * via opts alone is not accounting (the gateway reads AsyncLocalStorage),
 * and per-slug core invocations multiply config resolution, checkpoint IO,
 * and receipt writes by page count.
 *
 * Targets EVERY slug the ingest touched, INCLUDING hash-skipped pages (an
 * earlier no-facts import then a re-run with the facts flag must still
 * extract); the extractor's durable-outcome/version-token gate dedupes the
 * already-extracted ones. Respects the brain-wide `facts.extraction_enabled`
 * kill-switch with a notice, never a throw (the core throws on disabled; the
 * pre-check is the sweep pattern).
 */

import type { BrainEngine } from '../engine.ts';
import { getFactsExtractionModel, isFactsExtractionEnabled } from '../facts/extract.ts';
import { BudgetTracker, isModelPriceable, loadPricingOverrides } from '../budget/budget-tracker.ts';
import { withBudgetTracker } from '../ai/gateway.ts';
import {
  DEFAULT_MAX_COST_USD,
  runExtractConversationFactsCore,
} from '../../commands/extract-conversation-facts.ts';

export interface IngestFactsResult {
  pages: number;
  spentUsd?: number;
  skippedDisabled?: boolean;
}

export async function runIngestFacts(
  engine: BrainEngine,
  opts: { sourceId: string; slugs: string[]; maxCostUsd?: number; quiet?: boolean },
): Promise<IngestFactsResult> {
  if (!(await isFactsExtractionEnabled(engine))) {
    if (!opts.quiet) {
      console.error(
        'transcripts ingest: facts extraction is disabled brain-wide ' +
          '(facts.extraction_enabled=false) — pages imported, facts skipped',
      );
    }
    return { pages: 0, skippedDisabled: true };
  }

  // #5823: same defaulted-cap pattern as the CLI core and the cycle phase —
  // a USD cap can't bound an unpriced model (TX2 hard-fails the first call
  // at $0 with no_pricing), so the DEFAULTED cap drops while an explicit
  // maxCostUsd stays enforced.
  const pricingOverrides = await loadPricingOverrides(engine);
  const extractionModel = await getFactsExtractionModel(engine);
  const dropDefaultCap =
    opts.maxCostUsd === undefined && !isModelPriceable(extractionModel, 'chat', pricingOverrides);
  if (dropDefaultCap) {
    console.error(
      `[transcripts-ingest-facts] model "${extractionModel}" is not in the pricing maps; ` +
        `running without the default $${DEFAULT_MAX_COST_USD} cost gate. Add ` +
        `pricing.overrides or pass an explicit --max-cost-usd to fail closed.`,
    );
  }

  const tracker = new BudgetTracker({
    maxCostUsd: dropDefaultCap ? undefined : (opts.maxCostUsd ?? DEFAULT_MAX_COST_USD),
    label: 'transcripts-ingest-facts',
    pricingOverrides,
  });
  await withBudgetTracker(tracker, () =>
    runExtractConversationFactsCore(engine, {
      sourceId: opts.sourceId,
      slugs: opts.slugs,
      budgetTracker: tracker,
    }),
  );
  return { pages: opts.slugs.length, spentUsd: tracker.totalSpent };
}
