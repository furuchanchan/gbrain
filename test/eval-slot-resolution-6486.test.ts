/**
 * #6486: cross-modal eval slots resolve at run time from the provider
 * recipes + the credentials present, one slot per distinct provider
 * family. Explicit --slot-*-model flags always win and reserve their
 * provider; fewer than three healthy families fails closed naming what
 * is missing instead of silently judging with unconfigured defaults.
 */
import { describe, test, expect } from 'bun:test';
import {
  resolveEvalSlots,
  EVAL_FAMILY_ORDER,
  EVAL_SLOT_IDS,
} from '../src/core/cross-modal-eval/slot-resolution.ts';
import { RECIPES } from '../src/core/ai/recipes/index.ts';
import { splitProviderModelId } from '../src/core/model-id.ts';

const NO_EXPLICIT: Record<string, string | undefined> = { A: undefined, B: undefined, C: undefined };

const THREE_FAMILIES = {
  OPENAI_API_KEY: 'k',
  ANTHROPIC_API_KEY: 'k',
  GOOGLE_GENERATIVE_AI_API_KEY: 'k',
  DEEPSEEK_API_KEY: 'k',
};

describe('#6486: resolveEvalSlots', () => {
  test('three configured families resolve to three distinct providers without flags', () => {
    const res = resolveEvalSlots(NO_EXPLICIT, { env: THREE_FAMILIES });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.slots.map(s => s.id)).toEqual([...EVAL_SLOT_IDS]);
    const providers = res.slots.map(s => splitProviderModelId(s.model).provider);
    expect(new Set(providers).size).toBe(3);
    // resolved models come from the recipe's own chat list — no static ids
    for (const s of res.slots) {
      const { provider, model } = splitProviderModelId(s.model);
      expect(RECIPES.get(provider!)?.touchpoints.chat?.models).toContain(model);
    }
  });

  test('explicit flags win and reserve their provider family', () => {
    const res = resolveEvalSlots(
      { A: 'anthropic:claude-opus-4-7', B: undefined, C: undefined },
      { env: THREE_FAMILIES },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.slots[0].model).toBe('anthropic:claude-opus-4-7');
    const providers = res.slots.map(s => splitProviderModelId(s.model).provider);
    expect(new Set(providers).size).toBe(3);
    expect(providers.filter(p => p === 'anthropic')).toHaveLength(1);
  });

  test('fewer than three healthy families fails closed naming what is ready', () => {
    const res = resolveEvalSlots(NO_EXPLICIT, { env: { ANTHROPIC_API_KEY: 'k' } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.needed).toBe(3);
    expect(res.ready).toContain('anthropic');
    expect(res.ready).not.toContain('openai');
  });

  test('no keys at all fails closed with an empty ready list', () => {
    const res = resolveEvalSlots(NO_EXPLICIT, { env: {} });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.ready).toEqual([]);
  });

  test('unkeyed generic families do not count as ready', () => {
    // only a family absent from EVAL_FAMILY_ORDER would resolve nothing;
    // an openrouter key alone is one family — still fails closed.
    const res = resolveEvalSlots(NO_EXPLICIT, { env: { OPENROUTER_API_KEY: 'k' } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.ready).toEqual(['openrouter']);
  });
});
