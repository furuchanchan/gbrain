import type { Page } from '../core/types.ts';

/**
 * Upper bound honored for a page's own `conversation_segment_gap_minutes`
 * frontmatter override — one week. Anything larger is treated as invalid
 * rather than silently collapsing a whole conversation into one segment.
 */
export const MAX_SEGMENT_GAP_MINUTES = 10_080;

/**
 * Frontmatter key a collector can set to declare its own message cadence.
 * #5918: `splitIntoSegments` already takes `gapMinutes`, but `processPage`
 * never passed one, so every page was split on the global default.
 */
export const CONVERSATION_SEGMENT_GAP_MINUTES_KEY =
  'conversation_segment_gap_minutes';

/**
 * Resolve a page's own `conversation_segment_gap_minutes` frontmatter into a
 * `gapMinutes` override. Accepts a positive integer (or an integer-valued
 * numeric string) up to MAX_SEGMENT_GAP_MINUTES; anything else is ignored
 * with a warning so a malformed value can't silently reshape segmentation.
 */
export function pageSegmentGapMinutes(page: Page): number | undefined {
  const raw = page.frontmatter?.[CONVERSATION_SEGMENT_GAP_MINUTES_KEY];
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw.trim())
      ? Number(raw.trim())
      : NaN;
  if (Number.isInteger(value) && value > 0 && value <= MAX_SEGMENT_GAP_MINUTES) {
    return value;
  }
  process.stderr.write(
    `[extract-conversation-facts] ${page.slug}: ignoring invalid ${CONVERSATION_SEGMENT_GAP_MINUTES_KEY}=${JSON.stringify(raw)} (expected a positive integer <= ${MAX_SEGMENT_GAP_MINUTES})\n`,
  );
  return undefined;
}
