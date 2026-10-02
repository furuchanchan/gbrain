/**
 * #5874 — propose_takes per-call extractor timeout is configurable.
 *
 * The extractor call bound was a fixed derivation (90s scaled by maxTokens,
 * capped at 300s) with no config key. On claude-cli routes a call pays the
 * `claude -p` cold start on top of model time, so the largest pages aborted
 * every nightly cycle and were retried — with no tombstone — forever.
 *
 * Post-fix: `dream.propose_takes.call_timeout_ms` resolves at the phase's
 * engine.getConfig seam (same #4494 pattern as the max_tokens pair) and
 * threads into defaultExtractor as `input.callTimeoutMs`, where it replaces
 * the scaled bound. The gateway's own GBRAIN_AI_CHAT_TIMEOUT_MS still
 * composes whichever signal fires first.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import {
  runPhaseProposeTakes,
  defaultExtractor,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

function chatResult(text: string, stopReason: ChatResult['stopReason']): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  } as ChatResult;
}

const GOOD_JSON = '[{"claim_text":"Acme doubles ARR by Q4","kind":"bet","holder":"brain","weight":0.7}]';

const baseInput = {
  pagePath: 'companies/acme-example',
  pageBody: 'I bet Acme doubles ARR by Q4.',
  existingTakes: [],
};

describe('defaultExtractor callTimeoutMs (#5874)', () => {
  test('a configured bound aborts the call at the configured ms', async () => {
    __setChatTransportForTests(async (opts: ChatOpts) => {
      // Honors the caller's signal the way the SDK does: resolves on abort.
      await new Promise<void>((resolve) => {
        if (opts.abortSignal?.aborted) return resolve();
        opts.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return chatResult(GOOD_JSON, 'end');
    });
    const start = Date.now();
    await defaultExtractor({ ...baseInput, callTimeoutMs: 25 });
    const elapsed = Date.now() - start;
    // The 90s scaled default would never let this return inside a test run.
    expect(elapsed).toBeLessThan(5_000);
  });

  test('the scaled default still bounds the call when no override is set', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(GOOD_JSON, 'end');
    });
    await defaultExtractor(baseInput);
    expect(seen).toHaveLength(1);
    expect(seen[0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(seen[0].abortSignal!.aborted).toBe(false);
  });

  test('the configured bound applies to the truncation retry too', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    __setChatTransportForTests(async (opts) => {
      signals.push(opts.abortSignal);
      return signals.length === 1
        ? chatResult('trunc', 'length')
        : chatResult(GOOD_JSON, 'end');
    });
    await defaultExtractor({ ...baseInput, callTimeoutMs: 40 });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
  });
});

// ─── phase-level config threading ───────────────────────────────────

function buildMockEngine(config: Record<string, string>): BrainEngine {
  return {
    kind: 'pglite',
    async getConfig(key: string): Promise<string | null> {
      return config[key] ?? null;
    },
    async executeRaw<T>(sql: string): Promise<T[]> {
      if (sql.includes('SELECT slug, source_id, compiled_truth')) {
        return [{
          slug: 'wiki/page-0',
          source_id: 'default',
          compiled_truth: 'prose with a bold claim in it',
        }] as T[];
      }
      if (sql.includes('SELECT id FROM take_proposals')) return [];
      if (sql.includes('INSERT INTO take_proposals')) return [{ id: 1 } as unknown as T];
      return [];
    },
  } as unknown as BrainEngine;
}

function buildCtx(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

describe('runPhaseProposeTakes threads dream.propose_takes.call_timeout_ms (#5874)', () => {
  test('a configured bound reaches the extractor input', async () => {
    const engine = buildMockEngine({ 'dream.propose_takes.call_timeout_ms': '240000' });
    const seen: Array<{ callTimeoutMs?: number }> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push({ callTimeoutMs: input.callTimeoutMs });
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].callTimeoutMs).toBe(240000);
  });

  test('unset config leaves the bound unset (scaled default)', async () => {
    const engine = buildMockEngine({});
    const seen: Array<{ callTimeoutMs?: number }> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push({ callTimeoutMs: input.callTimeoutMs });
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen[0].callTimeoutMs).toBeUndefined();
  });

  test('non-positive and garbage values fall back to the scaled default', async () => {
    for (const bad of ['banana', '', '0', '-5000']) {
      const engine = buildMockEngine({ 'dream.propose_takes.call_timeout_ms': bad });
      const seen: Array<{ callTimeoutMs?: number }> = [];
      const extractor: ProposeTakesExtractor = async (input) => {
        seen.push({ callTimeoutMs: input.callTimeoutMs });
        return [];
      };
      await runPhaseProposeTakes(buildCtx(engine), { extractor });
      expect(seen[0].callTimeoutMs).toBeUndefined();
    }
  });
});
