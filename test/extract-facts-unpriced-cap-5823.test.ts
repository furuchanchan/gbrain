/**
 * #5823 — extract-conversation-facts on an unpriced (subscription) model.
 *
 * The bug: the DEFAULTED $5 cost gate + a model with no pricing row (e.g.
 * `claude-cli:claude-sonnet-5-5`) made every run die at $0 — TX2 hard-fails
 * the first reserve with `BudgetExhausted(no_pricing)` before a single call,
 * and the summary then told the operator to raise a cap that was never
 * spent. A USD cap can only bound priced calls, so the defaulted cap on an
 * unpriced model protects nothing and only aborts free work.
 *
 * Post-fix (same defaulted-cap pattern as embed-backfill / extract-atoms):
 *   - defaulted cap + unpriced model → the cap drops, the run proceeds;
 *   - explicit cap + unpriced model → enforced: the CLI core fails fast
 *     naming no_pricing, the cycle phase keeps the cap (every source fails
 *     no_pricing loudly);
 *   - the stop reason propagates (`budget_exhausted_reason`) and a
 *     no_pricing halt classifies as an error in the extract rollup, not an
 *     "expected limit" drained-capacity signal.
 *
 * Hermetic: PGLite + __setChatTransportForTests, same harness as
 * cycle-conversation-facts-backfill.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  resetGateway,
  configureGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { runPhaseConversationFactsBackfill } from '../src/core/cycle/conversation-facts-backfill.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';

let engine: PGLiteEngine;
let chatCalls = 0;

const CONVO_BODY = [
  '**Alice Example** (2024-03-15 9:00 AM): I just signed the offer letter for Acme Corp.',
  '**Bob Demo** (2024-03-15 9:01 AM): Congrats! What is the title?',
  '**Alice Example** (2024-03-15 9:02 AM): Staff engineer on the platform team.',
].join('\n');

/** Subscription recipe id with no pricing row — the issue's exact model. */
const UNPRICED_MODEL = 'claude-cli:claude-sonnet-5-5';
const PRICED_MODEL = 'anthropic:claude-sonnet-4-6';

async function seedSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [id, id],
  );
  await engine.putPage(`conversations/${id}-chat`, {
    type: 'conversation',
    title: `Chat in ${id}`,
    compiled_truth: CONVO_BODY,
    timeline: '',
    frontmatter: {},
  }, { sourceId: id });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  resetGateway();
  configureGateway({
    chat_model: PRICED_MODEL,
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' },
  });

  __setChatTransportForTests(async (): Promise<ChatResult> => {
    chatCalls++;
    return {
      text: JSON.stringify({
        facts: [{
          fact: 'alice example joined acme corp',
          kind: 'event',
          entity: null,
          confidence: 1.0,
          notability: 'high',
        }],
      }),
      blocks: [],
      stopReason: 'end',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: PRICED_MODEL,
      providerId: 'anthropic',
    };
  });
  __setEmbedTransportForTests(
    (async () => ({ embeddings: [Array.from({ length: 1536 }, () => 0.1)] })) as never,
  );

  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
});

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
  await engine.disconnect();
});

beforeEach(async () => {
  chatCalls = 0;
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op = 'extract-conversation-facts'`);
  await engine.executeRaw(`DELETE FROM extract_rollup_7d`);
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'conversations/%'`);
  // Cap keys UNSET = the defaulted path the issue reports.
  await engine.unsetConfig('cycle.conversation_facts_backfill.max_cost_usd');
  await engine.unsetConfig('cycle.conversation_facts_backfill.max_total_cost_usd');
  await engine.unsetConfig('facts.extraction_model');
});

describe('cycle phase — #5823 unpriced extraction model', () => {
  test('defaulted caps + unpriced model: the backfill RUNS instead of dying at $0', async () => {
    await seedSource('src-unpriced');
    await engine.setConfig('facts.extraction_model', UNPRICED_MODEL);

    const r = await runPhaseConversationFactsBackfill(engine, {});
    const d = r.details as Record<string, unknown>;
    const perSource = d.per_source as Record<
      string,
      { facts_inserted?: number; budget_exhausted?: boolean }
    >;

    // Pre-fix: 0 calls, per-source budget_exhausted=true with $0 spent.
    expect(chatCalls).toBeGreaterThan(0);
    expect(perSource['src-unpriced']?.facts_inserted).toBeGreaterThan(0);
    expect(d.sources_budget_exhausted).toBe(0);
  }, 120000);

  test('an explicitly configured cap still hard-fails unpriced calls (enforcement kept)', async () => {
    await seedSource('src-explicit');
    await engine.setConfig('facts.extraction_model', UNPRICED_MODEL);
    await engine.setConfig('cycle.conversation_facts_backfill.max_cost_usd', '1');

    const r = await runPhaseConversationFactsBackfill(engine, {});
    const d = r.details as Record<string, unknown>;
    const perSource = d.per_source as Record<
      string,
      { budget_exhausted?: boolean; budget_exhausted_reason?: string }
    >;

    expect(perSource['src-explicit']?.budget_exhausted).toBe(true);
    expect(perSource['src-explicit']?.budget_exhausted_reason).toBe('no_pricing');
    expect(chatCalls).toBe(0);
  }, 120000);
});

describe('CLI core — #5823 unpriced extraction model', () => {
  test('no --max-cost-usd (defaulted cap): the run proceeds uncapped', async () => {
    await seedSource('src-cli-default');
    await engine.setConfig('facts.extraction_model', UNPRICED_MODEL);

    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'src-cli-default',
      sleepMs: 0,
    });

    expect(chatCalls).toBeGreaterThan(0);
    expect(result.facts_inserted).toBeGreaterThan(0);
    expect(result.budget_exhausted).not.toBe(true);
  }, 120000);

  test('explicit --max-cost-usd + unpriced model fails fast naming no_pricing', async () => {
    await seedSource('src-cli-explicit');
    await engine.setConfig('facts.extraction_model', UNPRICED_MODEL);

    await expect(
      runExtractConversationFactsCore(engine, {
        sourceId: 'src-cli-explicit',
        sleepMs: 0,
        maxCostUsd: 1,
      }),
    ).rejects.toThrow(/no_pricing/);
    expect(chatCalls).toBe(0);
  }, 120000);

  test('control: priced model under the defaulted cap still extracts normally', async () => {
    await seedSource('src-priced');
    await engine.setConfig('facts.extraction_model', PRICED_MODEL);

    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'src-priced',
      sleepMs: 0,
    });

    expect(chatCalls).toBeGreaterThan(0);
    expect(result.facts_inserted).toBeGreaterThan(0);
    expect(result.budget_exhausted).not.toBe(true);
  }, 120000);
});
