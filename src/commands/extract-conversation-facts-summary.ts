// Peeled from extract-conversation-facts.ts — terminal console summary for
// `gbrain extract-conversation-facts`. Returns the process exit code: 0 clean,
// 1 hard failures, 3 lock-busy-without-failures.
import { MAX_PAGE_BODY_BYTES, type ExtractConversationFactsResult } from './extract-conversation-facts.ts';

export function printExtractionSummary(args: {
  dryRun: boolean;
  aggregate: ExtractConversationFactsResult;
  sourceCount: number;
  totalSpent: number;
  anyBudgetExhausted: boolean;
}): number {
  const { dryRun, aggregate, sourceCount, totalSpent, anyBudgetExhausted } = args;
  const verb = dryRun ? '(dry run) would extract' : 'extracted';
  console.log(
    `\nDone: ${verb} ${aggregate.facts_extracted} facts ` +
    `(${aggregate.facts_inserted} inserted) across ${aggregate.segments_processed} segments ` +
    `from ${aggregate.pages_processed}/${aggregate.pages_considered} pages ` +
    `in ${sourceCount} source(s). ` +
    `Spent ~$${totalSpent.toFixed(4)}.`,
  );
  if (aggregate.pages_skipped > 0) {
    console.log(`  Skipped ${aggregate.pages_skipped} page(s) with no new segments since last checkpoint.`);
  }
  if (aggregate.pages_skipped_unparsed > 0) {
    console.log(`  Skipped ${aggregate.pages_skipped_unparsed} page(s) with no parseable speaker turns (content present but no pattern matched, or too few messages).`);
  }
  if (aggregate.pages_skipped_type_mismatch > 0) {
    console.log(`  Skipped ${aggregate.pages_skipped_type_mismatch} page(s) that are not a conversation type.`);
  }
  if (aggregate.pages_skipped_too_large > 0) {
    console.log(`  Skipped ${aggregate.pages_skipped_too_large} page(s) exceeding ${MAX_PAGE_BODY_BYTES / 1024 / 1024}MB body cap.`);
  }
  if (aggregate.pages_skipped_disappeared > 0) {
    console.log(`  Skipped ${aggregate.pages_skipped_disappeared} page(s) that disappeared between enumeration and fetch.`);
  }
  if (aggregate.pages_skipped_completed > 0) {
    console.log(`  Skipped ${aggregate.pages_skipped_completed} page(s) with fresh durable completion outcomes.`);
  }
  if (aggregate.pages_skipped_non_extractable > 0) {
    console.log(`  Skipped ${aggregate.pages_skipped_non_extractable} page(s) previously scanned as not extractable.`);
  }
  if (aggregate.pages_skipped_unrecognized_speaker > 0) {
    console.log(`  Declined ${aggregate.pages_skipped_unrecognized_speaker} page(s) with unrecognized speaker headings (attribution would be wrong; retried next run).`);
  }
  if (aggregate.pages_marked_non_extractable > 0) {
    console.log(`  Marked ${aggregate.pages_marked_non_extractable} page(s) as scanned, not extractable.`);
  }
  if (aggregate.pages_failed > 0) {
    console.error(`  Failed ${aggregate.pages_failed} page(s); they remain unfinished and will retry.`);
  }
  if (aggregate.pages_llm_fallback > 0) {
    console.log(`  Parsed ${aggregate.pages_llm_fallback} page(s) with the opt-in LLM fallback.`);
  }
  if (aggregate.pages_lock_skipped > 0) {
    console.log(`  Skipped ${aggregate.pages_lock_skipped} page(s) held by another worker / process (will retry next run).`);
  }
  if (aggregate.orphan_facts_cleaned > 0) {
    console.log(`  Cleaned ${aggregate.orphan_facts_cleaned} orphan fact(s) from prior partial runs (D11 replay safety).`);
  }
  if (aggregate.fallback_slugify_count > 0) {
    console.log(`  Preserved ${aggregate.fallback_slugify_count} fact(s) without an entity target after unresolved fallback_slugify.`);
  }
  if (aggregate.resolution_errors > 0) {
    console.log(`  Preserved ${aggregate.resolution_errors} fact(s) without an entity target after best-effort resolution errors.`);
  }
  if (anyBudgetExhausted) {
    console.log(`  Budget cap reached. Re-run with a higher --max-cost-usd to continue.`);
  }

  // v0.41.15.0 (codex #3): exit 3 when pages were skipped due to
  // lock-busy AND no hard failures fired. "Incomplete run, please
  // re-run" — distinct from exit 1 (hard failure) and 0 (clean).
  // anyBudgetExhausted doesn't trigger exit 3; the budget message
  // above already tells the user what to do, and exit 0 is the right
  // signal for "ran to the cap intentionally."
  if (aggregate.pages_failed > 0) {
    return 1;
  }
  if (aggregate.pages_lock_skipped > 0 && !anyBudgetExhausted) {
    return 3;
  }
  return 0;
}
