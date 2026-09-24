/**
 * gbrain#5331 — per-call extended-thinking override.
 *
 * `provider_chat_options` merges into every chat() call, so a deployment-wide
 * `thinking: { type: 'adaptive' }` reaches callers with a strict output
 * contract and a small maxTokens — thinking consumes the budget, the reply
 * hits the cap, and the caller gets `text: ''` misread as a parse failure.
 * `opts.anthropicThinking` is the narrow per-call escape: applied AFTER the
 * config deep-merge, only when `recipe.id === 'anthropic'`, and spreading the
 * existing bag so every other configured option (cacheControl) survives.
 *
 * Pinned by inspecting the providerOptions handed to the generateText
 * transport (via `__setGenerateTextTransportForTests`).
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  chat,
  configureGateway,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';

afterAll(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
});

describe('gbrain#5331 — per-call anthropicThinking override', () => {
  let captured: { providerOptions?: Record<string, any> } | undefined;

  beforeEach(() => {
    resetGateway();
    captured = undefined;
    __setGenerateTextTransportForTests(async (args: any) => {
      captured = args;
      return {
        content: [{ type: 'text', text: '{}' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as any;
    });
    configureGateway({
      chat_model: 'anthropic:claude-opus-4-7',
      env: { ANTHROPIC_API_KEY: 'fake', OPENAI_API_KEY: 'fake' },
    });
  });

  const base = {
    model: 'anthropic:claude-opus-4-7',
    system: 'system',
    messages: [{ role: 'user' as const, content: 'hello' }],
    maxTokens: 64,
  };

  test('a per-call disable beats a configured adaptive default', async () => {
    await chat({
      ...base,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' }, cacheControl: { ttl: '1h' } } },
      anthropicThinking: 'disabled',
    });
    expect(captured?.providerOptions?.anthropic?.thinking).toEqual({ type: 'disabled' });
  });

  test('sibling provider options survive the override', async () => {
    await chat({
      ...base,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' }, cacheControl: { ttl: '1h' } } },
      anthropicThinking: 'disabled',
    });
    expect(captured?.providerOptions?.anthropic?.cacheControl).toEqual({ ttl: '1h' });
  });

  test('omitting the option changes nothing', async () => {
    await chat({
      ...base,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' } } },
    });
    expect(captured?.providerOptions?.anthropic?.thinking).toEqual({ type: 'adaptive' });
  });

  test('the option does not leak into a non-anthropic provider', async () => {
    await chat({ ...base, model: 'openai:gpt-4o-mini', anthropicThinking: 'disabled' });
    expect(captured?.providerOptions?.anthropic).toBeUndefined();
  });
});
