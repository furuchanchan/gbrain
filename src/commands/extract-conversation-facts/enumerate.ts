/**
 * Page enumeration for the extract-conversation-facts multi-type walk.
 *
 * #6500: OFFSET over `updated_desc` is not a total order — a >batch tie
 * cluster (bulk-imported pages share one timestamp) plus the run's own
 * updated_at bumps can return one page twice, and a batch naming a page
 * twice is refused invalid_params, blocking all of it. Keyset over
 * `updated_asc` walks a total order; `seen` guards the updated_at-bump
 * re-selection a pure keyset could still return.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { Page } from '../../core/types.ts';
import { isConversationFactsEligiblePage } from '../../core/facts/conversation-types.ts';

export const PAGE_LIST_BATCH = 10;

export interface ClaimableBatch {
  /** Pages never returned before in this walk that pass eligibility. */
  claimable: Page[];
  /** Freshly returned pages that failed eligibility. */
  skipped: number;
  /** Rows the query returned; 0 means this type's walk is exhausted. */
  batchLen: number;
  /** Cursor for the next query — the last row's column-precision stamp + slug. */
  nextKeyset: { updatedAt: string; slug: string } | undefined;
}

export async function nextClaimableBatch(
  engine: BrainEngine,
  args: {
    type: string;
    sourceId: string;
    keyset: { updatedAt: string; slug: string } | undefined;
    seen: Set<string>;
    concreteTypes: readonly string[];
    strictEligibility: boolean;
  },
): Promise<ClaimableBatch> {
  const batch = await engine.listPages({
    type: args.type,
    sourceId: args.sourceId,
    limit: PAGE_LIST_BATCH,
    sort: 'updated_asc',
    updatedAfterKeyset: args.keyset,
  });
  if (batch.length === 0) {
    return { claimable: [], skipped: 0, batchLen: 0, nextKeyset: args.keyset };
  }
  const last = batch.at(-1)!;
  if (!last.updated_at_iso) {
    throw new Error('listPages did not project updated_at_iso — keyset cursor cannot advance');
  }
  const unseen = batch.filter(page => !args.seen.has(page.slug));
  for (const page of unseen) args.seen.add(page.slug);
  const claimable = unseen.filter(page =>
    isConversationFactsEligiblePage(page, args.concreteTypes, args.strictEligibility));
  return {
    claimable,
    skipped: unseen.length - claimable.length,
    batchLen: batch.length,
    nextKeyset: { updatedAt: last.updated_at_iso, slug: last.slug },
  };
}
