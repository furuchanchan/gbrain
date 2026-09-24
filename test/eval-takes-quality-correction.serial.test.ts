/**
 * takes-quality-eval malformed-slot correction (#5325) — one re-ask per
 * malformed slot per cycle, never for provider failures or valid-but-low
 * scores. Serial: uses mock.module on the gateway.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let chatHandler: ((opts: any) => Promise<any>) | null = null;
mock.module('../src/core/ai/gateway.ts', () => ({
  chat: async (opts: any) => {
    if (!chatHandler) throw new Error('chatHandler not set in test');
    return chatHandler(opts);
  },
  configureGateway: () => undefined,
}));

const { runEval } = await import('../src/core/takes-quality-eval/runner.ts');
const { RUBRIC_DIMENSIONS } = await import('../src/core/takes-quality-eval/rubric.ts');
const { estimateCost } = await import('../src/core/takes-quality-eval/pricing.ts');

const MODELS = ['openai:gpt-4o', 'anthropic:claude-opus-4-7'] as const;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('test/correction-fixture', {
    type: 'note', title: 't', compiled_truth: 'b', frontmatter: {},
  });
  const pageRows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = 'test/correction-fixture' LIMIT 1`,
  );
  const pageId = pageRows[0].id;
  await engine.addTakesBatch(
    Array.from({ length: 5 }, (_, i) => ({
      page_id: pageId, row_num: i + 1, claim: `claim-${i}`, kind: 'take' as const,
      holder: 'world', weight: 0.5,
    })),
  );
});

afterAll(async () => {
  await engine.disconnect();
});

function fullScoreJson(score = 8): string {
  const scores: Record<string, { score: number; feedback?: string }> = {};
  for (const dim of RUBRIC_DIMENSIONS) scores[dim] = { score, feedback: 'fine' };
  return JSON.stringify({ scores });
}

function missingOneDimJson(): string {
  const parsed = JSON.parse(fullScoreJson());
  delete parsed.scores[RUBRIC_DIMENSIONS[0]];
  return JSON.stringify(parsed);
}

const response = (text: string) => ({
  text,
  usage: { input_tokens: 100, output_tokens: 50 },
});

describe('malformed-slot correction (#5325)', () => {
  test('only the malformed slot is re-asked once; a complete correction earns quorum and every attempt is costed', async () => {
    const calls: any[] = [];
    chatHandler = async (opts: any) => {
      calls.push(opts);
      return response(opts.model === MODELS[1] && calls.length === 2 ? missingOneDimJson() : fullScoreJson());
    };
    const r = await runEval(engine, { models: [...MODELS], cycles: 1 });
    expect(calls.map((c) => c.model)).toEqual([MODELS[0], MODELS[1], MODELS[1]]);
    expect(calls[2].messages[0].content).toContain('incomplete_scores');
    expect(r.receipt.successes_per_cycle).toEqual([2]);
    expect(r.receipt.verdict).toBe('pass');
    const cost = estimateCost(MODELS[0], 100, 50) + 2 * estimateCost(MODELS[1], 100, 50);
    expect(r.receipt.cost_usd).toBe(Math.round(cost * 10000) / 10000);
  });

  test('repeated malformed output stays inconclusive, with empty scores and a bounded call count', async () => {
    let calls = 0;
    chatHandler = async (opts: any) => {
      calls++;
      return response(opts.model === MODELS[1] ? missingOneDimJson() : fullScoreJson());
    };
    const r = await runEval(engine, { models: [...MODELS], cycles: 3 });
    expect(calls).toBe(3);
    expect(r.receipt.verdict).toBe('inconclusive');
    expect(r.receipt.scores).toEqual({});
    expect(r.receipt.overall_score).toBeNull();
  });

  test('a parse failure gets one retry, but a low VALID score is never retried for improvement', async () => {
    let calls = 0;
    chatHandler = async (opts: any) => {
      calls++;
      return response(opts.model === MODELS[1] && calls === 2 ? 'not JSON' : fullScoreJson(4));
    };
    const r = await runEval(engine, { models: [...MODELS], cycles: 1 });
    expect(calls).toBe(3);
    expect(r.receipt.verdict).toBe('fail');
  });

  test('provider failures are not retried', async () => {
    let calls = 0;
    chatHandler = async (opts: any) => {
      calls++;
      if (opts.model === MODELS[1]) throw new Error('offline failure');
      return response(fullScoreJson());
    };
    const r = await runEval(engine, { models: [...MODELS], cycles: 1 });
    expect(calls).toBe(2);
    expect(r.receipt.verdict).toBe('inconclusive');
  });

  test('the budget refuses the correction BEFORE the call and retains the invalid slot', async () => {
    let calls = 0;
    const budget = MODELS.reduce((n, m) => n + estimateCost(m, 5000, 2000), 0);
    chatHandler = async (opts: any) => {
      calls++;
      return {
        text: opts.model === MODELS[1] ? missingOneDimJson() : fullScoreJson(),
        usage: { input_tokens: 5000, output_tokens: 2000 },
      };
    };
    const r = await runEval(engine, { models: [...MODELS], cycles: 1, budgetUsd: budget });
    expect(calls).toBe(2); // two initial calls only — correction refused
    expect(r.budgetAborted).toBe(true);
    expect(r.receipt.verdict).toBe('inconclusive');
  });

  test('an abort prevents the malformed correction', async () => {
    let calls = 0;
    const controller = new AbortController();
    chatHandler = async (opts: any) => {
      calls++;
      if (opts.model === MODELS[1]) controller.abort();
      return response(opts.model === MODELS[1] ? missingOneDimJson() : fullScoreJson());
    };
    const r = await runEval(engine, { models: [...MODELS], cycles: 1, abortSignal: controller.signal });
    expect(calls).toBe(2);
    expect(r.receipt.verdict).toBe('inconclusive');
  });
});
