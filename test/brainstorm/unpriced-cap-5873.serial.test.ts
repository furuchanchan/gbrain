/**
 * #5873 — brainstorm/lsd on an unpriced (subscription) chat route.
 *
 * The bug: the DEFAULTED $5 run cap + a chat model with no pricing row
 * (e.g. `claude-cli:claude-opus-5-5`, a subscription recipe) hard-failed the
 * first gateway reserve with `no_pricing` — `gbrain brainstorm`/`gbrain lsd`
 * aborted at $0 spent, and the error's own remedy (`pricing.overrides`)
 * never reached the run tracker, so declaring a rate could not fix it.
 *
 * Post-fix (the #5823 / embed-backfill defaulted-cap precedent):
 *   - defaulted cap + unpriced model → the cap drops with a stderr notice
 *     naming the model + the pricing.overrides remedy; the run proceeds;
 *   - explicit --max-cost + unpriced model → the cap stays enforced: the
 *     first real-gateway reserve fails `BudgetExhausted(no_pricing)`;
 *   - `--max-cost off|none|unlimited` opts out entirely (mirrors
 *     `enrich --max-usd off`), and the tracker receives pricing.overrides
 *     so an override-declared rate makes the model priceable;
 *   - the resolved model for the priceability probe is the same one the
 *     gateway will call (`models.chat` / `models.tier.reasoning` /
 *     file `chat_model` → `--model`), not the orchestrator's file-only pin;
 *   - doctor `brainstorm_health` warns when the resolved chat model cannot
 *     be priced under the default cap.
 *
 * Hermetic: PGLite + __setChatTransportForTests for the real-gateway lane;
 * the chatFn DI seam covers the capped-decision lane.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import type { ChunkInput } from '../../src/core/types.ts';
import {
  runBrainstorm,
  BRAINSTORM_PROFILE,
  type BrainstormProfile,
  BudgetExhausted,
} from '../../src/core/brainstorm/orchestrator.ts';
import { parseBrainstormArgs } from '../../src/commands/brainstorm.ts';
import { checkBrainstormHealth } from '../../src/commands/doctor/checks/graph-embedding.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  resetGateway,
  configureGateway,
  type ChatOpts,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

const UNPRICED_MODEL = 'claude-cli:claude-sonnet-5-5';
const PRICED_MODEL = 'anthropic:claude-sonnet-4-6';

let engine: PGLiteEngine;
let tmp: string;
let homeBackup: string | undefined;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const v = new Float32Array(dim);
  v[idx % dim] = 1.0;
  return v;
}

async function seedSmallBrain(): Promise<void> {
  const closeSlugs = ['wiki/close-a', 'wiki/close-b'];
  const farSlugs = [
    'concepts/decay-a',
    'concepts/decay-b',
    'people/founder-a',
    'people/founder-b',
  ];
  for (let i = 0; i < closeSlugs.length; i++) {
    const slug = closeSlugs[i];
    await engine.putPage(slug, {
      type: 'note',
      title: `Close ${slug}`,
      compiled_truth: `unpriced cap test fixture body for close anchor ${slug}`,
      timeline: '',
    });
    await installFixtureChunks(engine, slug, [
      {
        chunk_index: 0,
        chunk_text: `unpriced cap test ${slug}`,
        chunk_source: 'compiled_truth',
        embedding: basisEmbedding(10 + i),
        token_count: 6,
      },
    ] satisfies ChunkInput[]);
  }
  for (let i = 0; i < farSlugs.length; i++) {
    const slug = farSlugs[i];
    await engine.putPage(slug, {
      type: 'note',
      title: `Far ${slug}`,
      compiled_truth: `Far content for ${slug}: distant cross-domain body.`,
      timeline: '',
    });
    await installFixtureChunks(engine, slug, [
      {
        chunk_index: 0,
        chunk_text: `cross-domain text ${slug}`,
        chunk_source: 'compiled_truth',
        embedding: basisEmbedding(200 + i),
        token_count: 6,
      },
    ] satisfies ChunkInput[]);
  }
}

/**
 * Chat transport handling both prompt shapes: cross-generation returns a
 * numbered idea list; judge (detected by the `(close=… × far=…)` lines under
 * each `## Idea` heading) returns the batch verdict JSON the judge parser
 * expects. Reports the resolved model id so the tracker prices/fails on the
 * same model the gateway resolved.
 */
function makeChatTransport(model: string) {
  let calls = 0;
  const fn = async (opts: ChatOpts): Promise<ChatResult> => {
    calls++;
    const userMsg = opts.messages.find((m) => m.role === 'user');
    const content = typeof userMsg?.content === 'string' ? userMsg.content : '';
    const isJudge = /\(close=.* × far=.*\)/.test(content);
    if (isJudge) {
      const ideaIds = Array.from(content.matchAll(/## Idea (\S+)/g)).map((m) => m[1] as string);
      const json = {
        ideas: ideaIds.map((id) => ({
          id,
          scores: {
            originality: 4,
            resistance: 4,
            thesis_density: 4,
            concrete_grounding: 4,
            cognitive_load: 4,
          },
          note: 'mock judge',
        })),
      };
      const text = '```json\n' + JSON.stringify(json) + '\n```';
      return {
        text,
        blocks: [{ type: 'text', text }],
        stopReason: 'end',
        model,
        providerId: 'fake',
        usage: { input_tokens: 200, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
      };
    }
    const text = `1. IDEA call${calls}\n2. backup idea ${calls}\n3. extra idea ${calls}`;
    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      model,
      providerId: 'fake',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    };
  };
  return { fn, get calls() { return calls; } };
}

function configureGatewayChat(model: string): void {
  configureGateway({
    chat_model: model,
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' },
  });
}

const tinyProfile: BrainstormProfile = {
  ...BRAINSTORM_PROFILE,
  k_close: 2,
  m_far: 4,
  ideas_per_cross: 1,
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedSmallBrain();

  resetGateway();
  configureGatewayChat(PRICED_MODEL);
  __setEmbedTransportForTests(
    (async () => ({ embeddings: [Array.from({ length: 1536 }, () => 0.1)] })) as never,
  );
}, 60_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-5873-'));
  homeBackup = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
});

afterEach(() => {
  if (homeBackup === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = homeBackup;
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseBrainstormArgs — --max-cost off (#5873)', () => {
  test.each(['off', 'none', 'unlimited'])('--max-cost %s sets maxCostOff', (v) => {
    const r = parseBrainstormArgs(['hello', '--max-cost', v]);
    expect(r.error).toBeUndefined();
    expect(r.maxCostOff).toBe(true);
    expect(r.maxCost).toBeUndefined();
  });

  test('--max-cost still parses a positive float and rejects junk', () => {
    expect(parseBrainstormArgs(['hello', '--max-cost', '2.50']).maxCost).toBe(2.5);
    expect(parseBrainstormArgs(['hello', '--max-cost', 'offx']).error).toMatch(/--max-cost/);
  });
});

describe('runBrainstorm — defaulted cap on an unpriced chat route', () => {
  test('default cap drops: run completes and stderr names the unpriced model + remedy', async () => {
    const t = makeChatTransport(UNPRICED_MODEL);
    __setChatTransportForTests(t.fn);
    configureGatewayChat(UNPRICED_MODEL);
    try {
      const stderr: string[] = [];
      const result = await runBrainstorm(engine, {}, {
        question: 'unpriced cap test question',
        profile: tinyProfile,
        skipCostPreview: true,
        embedQueryFn: async () => basisEmbedding(0),
        stderrWrite: (s) => stderr.push(s),
      });
      expect(result.ideas.length).toBeGreaterThanOrEqual(1);
      expect(t.calls).toBeGreaterThanOrEqual(2); // cross calls + judge
      const notice = stderr.join('');
      expect(notice).toContain(UNPRICED_MODEL);
      expect(notice).toContain('default $5 cost cap');
      expect(notice).toContain('pricing.overrides');
    } finally {
      configureGatewayChat(PRICED_MODEL);
      __setChatTransportForTests(null);
    }
  });

  test('explicit --max-cost on an unpriced model stays enforced: first reserve fails no_pricing', async () => {
    const t = makeChatTransport(UNPRICED_MODEL);
    __setChatTransportForTests(t.fn);
    configureGatewayChat(UNPRICED_MODEL);
    try {
      let err: unknown = null;
      try {
        await runBrainstorm(engine, {}, {
          question: 'unpriced cap test question',
          profile: tinyProfile,
          skipCostPreview: true,
          maxCostUsd: 100,
          embedQueryFn: async () => basisEmbedding(0),
          stderrWrite: () => {},
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BudgetExhausted);
      expect((err as BudgetExhausted).reason).toBe('no_pricing');
      expect(t.calls).toBe(0); // reserve fails before the transport runs
    } finally {
      configureGatewayChat(PRICED_MODEL);
      __setChatTransportForTests(null);
    }
  });

  test('pricing.overrides reaches the tracker: an override-declared rate makes the cap meaningful', async () => {
    const t = makeChatTransport(UNPRICED_MODEL);
    __setChatTransportForTests(t.fn);
    configureGatewayChat(UNPRICED_MODEL);
    await engine.setConfig('pricing.overrides', JSON.stringify({ [UNPRICED_MODEL]: 5 }));
    try {
      const stderr: string[] = [];
      // Defaulted cap path: with an override price the model IS priceable,
      // so no drop-notice fires and the run completes under a real $5 cap.
      const result = await runBrainstorm(engine, {}, {
        question: 'unpriced cap test question',
        profile: tinyProfile,
        skipCostPreview: true,
        embedQueryFn: async () => basisEmbedding(0),
        stderrWrite: (s) => stderr.push(s),
      });
      expect(result.ideas.length).toBeGreaterThanOrEqual(1);
      expect(stderr.join('')).not.toContain('no pricing entry');
    } finally {
      configureGatewayChat(PRICED_MODEL);
      await engine.unsetConfig('pricing.overrides');
      __setChatTransportForTests(null);
    }
  });

  test('--max-cost off runs uncapped with no notice even on an unpriced model', async () => {
    const t = makeChatTransport(UNPRICED_MODEL);
    __setChatTransportForTests(t.fn);
    configureGatewayChat(UNPRICED_MODEL);
    try {
      const stderr: string[] = [];
      const result = await runBrainstorm(engine, {}, {
        question: 'unpriced cap test question',
        profile: tinyProfile,
        skipCostPreview: true,
        maxCostOff: true,
        embedQueryFn: async () => basisEmbedding(0),
        stderrWrite: (s) => stderr.push(s),
      });
      expect(result.ideas.length).toBeGreaterThanOrEqual(1);
      expect(stderr.join('')).not.toContain('no pricing entry');
    } finally {
      configureGatewayChat(PRICED_MODEL);
      __setChatTransportForTests(null);
    }
  });
});

describe('brainstorm_health — unpriced resolved chat model warns (#5873)', () => {
  beforeEach(async () => {
    await resetPgliteState(engine);
    await seedSmallBrain();
  });

  test('resolved chat model unpriced → warn naming pricing.overrides', async () => {
    configureGatewayChat(UNPRICED_MODEL);
    try {
      const check = await checkBrainstormHealth(engine);
    expect(check.name).toBe('brainstorm_health');
    expect(check.status).toBe('warn');
      expect(check.message).toContain(UNPRICED_MODEL);
      expect(check.message).toContain('pricing.overrides');
    } finally {
      configureGatewayChat(PRICED_MODEL);
    }
  });

  test('unpriced model WITH a pricing.overrides entry → no unpriced warn', async () => {
    configureGatewayChat(UNPRICED_MODEL);
    await engine.setConfig('pricing.overrides', JSON.stringify({ [UNPRICED_MODEL]: 5 }));
    try {
      const check = await checkBrainstormHealth(engine);
      expect(check.message).not.toContain('no pricing entry');
    } finally {
      configureGatewayChat(PRICED_MODEL);
      await engine.unsetConfig('pricing.overrides');
    }
  });
});
