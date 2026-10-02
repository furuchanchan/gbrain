// #5166: synthesize_concepts priced every model id missing from
// CANONICAL_PRICING at the Sonnet fallback with no trace — a gateway
// reporting `deepseek:deepseek-flash` (an alias of deepseek-v4-flash)
// accumulated ~37x the real spend and tripped the budget cap.
//
// Pins: (a) the alias + claude-cli recipe ids resolve through
// canonicalLookup, and (b) a remaining canonical miss lands in
// details.pricing_fallback_models so receipts and budget decisions are
// visibly built on the fallback rate.
//
// Hermetic: PGLite + injected `_atoms`/`_chat`. No provider credentials.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { canonicalLookup } from '../../src/core/model-pricing.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function t2Atoms() {
  return Array.from({ length: 5 }, (_, i) => ({
    slug: `atoms/a${i}`,
    concept_refs: ['concepts/x'],
    body: `body ${i}`,
    title: `A${i}`,
  }));
}

/** chat() that reports a chosen model id back (as a gateway does). */
function fixedModelChat(model: string, usage = { input_tokens: 1_000_000, output_tokens: 100_000 }) {
  return async (_o: ChatOpts): Promise<ChatResult> => ({
    text: 'narrative text',
    blocks: [{ type: 'text', text: 'narrative text' }],
    stopReason: 'end',
    usage: { ...usage, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model,
    providerId: 'test',
  });
}

describe('#5166 — canonical pricing coverage', () => {
  test('claude-cli recipe chat models resolve at the recipe nominal rate', () => {
    for (const id of [
      'claude-cli:claude-fable-5',
      'claude-cli:claude-fable-5-1',
      'claude-cli:claude-opus-5-5',
      'claude-cli:claude-opus-5',
      'claude-cli:claude-opus-4-8',
      'claude-cli:claude-opus-4-7',
      'claude-cli:claude-sonnet-5',
      'claude-cli:claude-sonnet-4-6',
      'claude-cli:claude-haiku-4-5-20251001',
    ]) {
      expect(canonicalLookup(id), id).toEqual({ input: 3.0, output: 15.0 });
    }
  });
});

describe('#5166 — synthesize_concepts spend accounting', () => {
  test('a canonical-priced model accumulates real rates and stamps no fallback', async () => {
    // 1M input + 100k output at gemini-2.5-flash rates: 0.30 + 0.25 = $0.55
    const res = await runPhaseSynthesizeConcepts(engine, {
      _atoms: t2Atoms(),
      _chat: fixedModelChat('google:gemini-2.5-flash'),
    });
    const details = res.details as Record<string, unknown>;
    expect(details.estimated_spend_usd).toBeCloseTo(0.55, 6);
    expect(details.pricing_fallback_models).toBeUndefined();
  });

  test('a claude-cli recipe id prices at the declared rate, not the fallback', async () => {
    const res = await runPhaseSynthesizeConcepts(engine, {
      _atoms: t2Atoms(),
      _chat: fixedModelChat('claude-cli:claude-opus-5-5'),
    });
    const details = res.details as Record<string, unknown>;
    expect(details.pricing_fallback_models).toBeUndefined();
    // 1M input + 100k output at the recipe nominal 3.0/15.0: $4.5
    expect(details.estimated_spend_usd).toBeCloseTo(4.5, 6);
  });

  test('an unknown model id is stamped in pricing_fallback_models', async () => {
    const res = await runPhaseSynthesizeConcepts(engine, {
      _atoms: t2Atoms(),
      _chat: fixedModelChat('someproxy:unlisted-model-9'),
    });
    const details = res.details as Record<string, unknown>;
    expect(details.pricing_fallback_models).toEqual(['someproxy:unlisted-model-9']);
    // Fallback rate still applies: 1M*3 + 100k*15 = $4.5
    expect(details.estimated_spend_usd).toBeCloseTo(4.5, 6);
  });
});
