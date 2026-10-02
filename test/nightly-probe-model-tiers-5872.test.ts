/**
 * #5872 — the nightly quality probe resolved its reader/extractor models
 * against a null engine and had no config route for its judge slots, so
 * DB-plane model config (models.eval.longmemeval, models.tier.*, models.chat)
 * never reached the probe. The probe's routes now resolve against the
 * brain's ConfigReader: longmemeval takes a modelConfigReader seam, the
 * cross-modal adapter reads models.eval.cross_modal.slot_* and hands the
 * #4636 substitute the engine-resolved chat model, and `gbrain models`
 * reports slot routes through resolveProbeSlotModel.
 *
 * Hermetic: in-memory PGLite benchmark brain, stub ThinkLLMClients, fake
 * ConfigReader, gateway chat-transport seam — no API keys, no network.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';

import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { substituteUnavailableDefaultSlots } from '../src/commands/eval-cross-modal.ts';
import { resolveProbeSlotModel } from '../src/core/cycle/nightly-probe-adapters.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { DEFAULT_SLOTS } from '../src/core/cross-modal-eval/runner.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ConfigReader } from '../src/core/config-snapshot.ts';
import type { ThinkLLMClient } from '../src/core/think/index.ts';

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');

afterEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
});

function fakeReader(map: Record<string, string>): ConfigReader {
  return { getConfig: async (k) => map[k] ?? null };
}

function textClient(text: string): ThinkLLMClient {
  return {
    create: async () =>
      ({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'stub',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }) as Anthropic.Message,
  };
}

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  let stderr = '';
  const orig = process.stderr.write;
  // @ts-ignore runtime override for the test
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return stderr;
}

describe('runEvalLongMemEval — modelConfigReader seam (#5872)', () => {
  test('reader + extractor resolve against the brain config when no CLI flag pins them', async () => {
    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-5872-'));
    const outPath = join(tmp, 'out.jsonl');
    try {
      const stderr = await captureStderr(() =>
        runEvalLongMemEval(
          [FIXTURE_PATH, '--keyword-only', '--limit', '1', '--output', outPath],
          {
            engine,
            client: textClient('stub answer'),
            extractorClient: textClient('[]'),
            exitOnError: false,
            modelConfigReader: fakeReader({
              'models.eval.longmemeval': 'openai:gpt-5',
              'models.tier.utility': 'claude-cli:claude-sonnet-5',
            }),
          },
        ),
      );
      expect(stderr).toContain('model: openai:gpt-5');
      expect(stderr).toContain('extractor: claude-cli:claude-sonnet-5');
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  test('an explicit --model still wins over the brain config', async () => {
    const engine = await createBenchmarkBrain();
    const tmp = mkdtempSync(join(tmpdir(), 'lme-5872-flag-'));
    const outPath = join(tmp, 'out.jsonl');
    try {
      const stderr = await captureStderr(() =>
        runEvalLongMemEval(
          [
            FIXTURE_PATH,
            '--keyword-only',
            '--limit', '1',
            '--model', 'openai:gpt-5.2',
            '--output', outPath,
          ],
          {
            engine,
            client: textClient('stub answer'),
            extractorClient: textClient('[]'),
            exitOnError: false,
            modelConfigReader: fakeReader({
              'models.eval.longmemeval': 'openai:gpt-5',
            }),
          },
        ),
      );
      expect(stderr).toContain('model: openai:gpt-5.2');
      expect(stderr).not.toContain('model: openai:gpt-5,');
    } finally {
      await engine.disconnect();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('substituteUnavailableDefaultSlots — engine-resolved chat model (#5872)', () => {
  test('substitutes unusable defaults with the caller-resolved chat model', async () => {
    // Only OpenAI is "available": A's default stays, B and C substitute.
    configureGateway({ env: { OPENAI_API_KEY: 'sk-test' } });
    const slots = DEFAULT_SLOTS.map((s) => ({ ...s }));
    const result = substituteUnavailableDefaultSlots(slots, {}, 'openai:gpt-5');
    const byId = new Map(result.map((s) => [s.id, s.model]));
    expect(byId.get('A')).toBe('openai:gpt-5.2'); // usable default — untouched
    expect(byId.get('B')).toBe('openai:gpt-5');
    expect(byId.get('C')).toBe('openai:gpt-5');
  });

  test('an explicit slot flag still wins over the substitute', async () => {
    configureGateway({ env: { OPENAI_API_KEY: 'sk-test' } });
    // Callers apply --slot-*-model to s.model first; the explicit map then
    // keeps that flag value even when its provider is unusable here.
    const slots = DEFAULT_SLOTS.map((s) =>
      s.id === 'B' ? { ...s, model: 'deepseek:deepseek-v4-pro' } : { ...s },
    );
    const result = substituteUnavailableDefaultSlots(
      slots,
      { B: 'deepseek:deepseek-v4-pro' },
      'openai:gpt-5',
    );
    const byId = new Map(result.map((s) => [s.id, s.model]));
    expect(byId.get('B')).toBe('deepseek:deepseek-v4-pro');
  });
});

describe('resolveProbeSlotModel — `gbrain models` slot route display (#5872)', () => {
  test('pin → usable default → engine chat-model substitute', async () => {
    configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-test' } });

    const pinned = await resolveProbeSlotModel(
      fakeReader({ 'models.eval.cross_modal.slot_a': 'openai:gpt-5' }),
      'a',
    );
    expect(pinned).toEqual({ model: 'openai:gpt-5', source: 'config' });

    // B's default is anthropic — usable under the configured key.
    const usable = await resolveProbeSlotModel(fakeReader({}), 'b');
    expect(usable).toEqual({ model: 'anthropic:claude-opus-4-7', source: 'tier_default' });

    // A's default is openai — unusable here — so the probe's substitute
    // route (models.chat) is what `gbrain models` reports.
    const sub = await resolveProbeSlotModel(
      fakeReader({ 'models.chat': 'claude-cli:claude-opus-5-5' }),
      'a',
    );
    expect(sub).toEqual({ model: 'claude-cli:claude-opus-5-5', source: 'tier_default' });
  });
});
