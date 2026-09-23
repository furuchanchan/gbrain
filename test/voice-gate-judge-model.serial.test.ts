/**
 * #5357 — voice-gate defaultJudge must resolve the utility tier, not pin
 * the Anthropic literal. On an install with only OPENAI_API_KEY the
 * literal TIER_DEFAULTS.utility targets a provider with no key.
 *
 * Serial: uses mock.module (leaks across files sharing a bun process) and
 * pins provider-key envs + GBRAIN_HOME so the config read misses.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

const chatCalls: ChatOpts[] = [];

mock.module('../src/core/ai/gateway.ts', () => ({
  chat: async (opts: ChatOpts): Promise<ChatResult> => {
    chatCalls.push(opts);
    return { text: '{"verdict":"conversational","reason":"ok"}' } as ChatResult;
  },
}));

const { defaultJudge } = await import('../src/core/calibration/voice-gate.ts');
const { resolveTierDefault } = await import('../src/core/model-config.ts');

const PINNED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GBRAIN_HOME'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of PINNED_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = '/nonexistent-gbrain-home-for-voice-gate-tests';
  chatCalls.length = 0;
});

afterEach(() => {
  for (const k of PINNED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('defaultJudge model selection (#5357)', () => {
  test('openai-only install: judge uses resolved utility tier, not the Anthropic literal', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    await defaultJudge({ candidate: 'candidate text', mode: 'nudge', rubric: 'rubric' });
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0]!.model).toBe(resolveTierDefault('utility'));
    expect(chatCalls[0]!.model).not.toBe('anthropic:claude-haiku-4-5-20251001');
  });

  test('anthropic install: judge still lands on the Anthropic utility default', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    await defaultJudge({ candidate: 'candidate text', mode: 'nudge', rubric: 'rubric' });
    expect(chatCalls.length).toBe(1);
    expect(chatCalls[0]!.model).toBe('anthropic:claude-haiku-4-5-20251001');
  });
});
