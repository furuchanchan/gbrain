/**
 * #5918: a conversation page can declare its own segmentation gap via
 * `conversation_segment_gap_minutes` frontmatter. `splitIntoSegments` always
 * accepted `gapMinutes`; `processPage` now resolves the page's value and
 * passes it to both call sites. Invalid values are ignored with a warning so
 * a malformed override can't silently reshape segmentation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  MAX_SEGMENT_GAP_MINUTES,
  pageSegmentGapMinutes,
} from '../src/commands/extract-conversation-facts-segment-gap.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import type { Page } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
});

const pageWith = (frontmatter: Record<string, unknown>): Page =>
  ({ slug: 'conversations/test', frontmatter }) as Page;

// Four messages, a 40-minute gap in the middle. The global default gap is
// 30 minutes → 2 segments; a page gap of 60 → 1 segment.
const TRANSCRIPT =
  '**Alice** (2024-03-15 9:00 AM): first\n' +
  '**Bob** (2024-03-15 9:01 AM): second\n' +
  '**Alice** (2024-03-15 9:40 AM): third\n' +
  '**Bob** (2024-03-15 9:41 AM): fourth';

async function seed(frontmatter: Record<string, unknown>): Promise<void> {
  await engine.putPage('conversations/custom-gap', {
    type: 'conversation',
    title: 'Custom gap',
    compiled_truth: TRANSCRIPT,
    timeline: '',
    frontmatter,
  });
}

describe('pageSegmentGapMinutes', () => {
  test('accepts a positive bounded integer, number or numeric string', () => {
    expect(pageSegmentGapMinutes(pageWith({}))).toBeUndefined();
    expect(
      pageSegmentGapMinutes(pageWith({ conversation_segment_gap_minutes: 60 })),
    ).toBe(60);
    expect(
      pageSegmentGapMinutes(pageWith({ conversation_segment_gap_minutes: '90' })),
    ).toBe(90);
  });

  test('ignores invalid values with a warning', () => {
    for (const bad of [0, -5, 1.5, 'abc', true, MAX_SEGMENT_GAP_MINUTES + 1]) {
      expect(
        pageSegmentGapMinutes(pageWith({ conversation_segment_gap_minutes: bad })),
        JSON.stringify(bad),
      ).toBeUndefined();
    }
    expect(
      pageSegmentGapMinutes(
        pageWith({ conversation_segment_gap_minutes: MAX_SEGMENT_GAP_MINUTES }),
      ),
    ).toBe(MAX_SEGMENT_GAP_MINUTES);
  });
});

describe('processPage honors the page gap', () => {
  test('a 60-minute page gap keeps 40-minute-separated messages in one segment', async () => {
    await seed({ conversation_segment_gap_minutes: 60 });
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/custom-gap',
      dryRun: true,
      sleepMs: 0,
    });
    expect(result.segments_processed).toBe(1);
  });

  test('the global default still splits the same page at 30 minutes', async () => {
    await seed({});
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/custom-gap',
      dryRun: true,
      sleepMs: 0,
    });
    expect(result.segments_processed).toBe(2);
  });
});
