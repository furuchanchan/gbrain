/**
 * #4209 — the entity-hints cap is NAMED and surfaced in the contract.
 *
 * The extractor prompt forwards only the first ENTITY_HINTS_CAP entity
 * hints. Pre-fix that was an anonymous inline slice(0, 5): callers passing
 * 20 hints had 15 silently eaten with no signal. Now the cap is exported,
 * stated in the entity_hints param description, and every extract_facts
 * envelope reports entity_hints_used / entity_hints_dropped.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ENTITY_HINTS_CAP } from '../src/core/facts/extract.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const ctx = (): OperationContext =>
  ({ engine, remote: false, sourceId: 'default' } as unknown as OperationContext);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('ENTITY_HINTS_CAP (#4209)', () => {
  test('the cap is named, exported, and is the documented 5', () => {
    expect(ENTITY_HINTS_CAP).toBe(5);
  });

  test('param description states the cap instead of hiding it', () => {
    const desc = operationsByName.extract_facts!.params.entity_hints!.description ?? '';
    expect(desc).toContain(String(ENTITY_HINTS_CAP));
    expect(desc).toContain('entity_hints_used');
  });

  test('20 hints → used=5, dropped=15 on the response envelope', async () => {
    // is_dream_generated short-circuits before any LLM call — deterministic,
    // zero-key path that still exercises the cap accounting.
    const r = await operationsByName.extract_facts!.handler(ctx(), {
      turn_text: 'Alice moved to Berlin.',
      entity_hints: Array.from({ length: 20 }, (_, i) => `people/p-${i}`),
      is_dream_generated: true,
    }) as { entity_hints_used: number; entity_hints_dropped: number; skipped: string };
    expect(r.skipped).toBe('dream_generated');
    expect(r.entity_hints_used).toBe(5);
    expect(r.entity_hints_dropped).toBe(15);
  });

  test('under-cap and absent hints report honest zeros', async () => {
    const withThree = await operationsByName.extract_facts!.handler(ctx(), {
      turn_text: 'x', entity_hints: ['a', 'b', 'c'], is_dream_generated: true,
    }) as { entity_hints_used: number; entity_hints_dropped: number };
    expect(withThree.entity_hints_used).toBe(3);
    expect(withThree.entity_hints_dropped).toBe(0);

    const withNone = await operationsByName.extract_facts!.handler(ctx(), {
      turn_text: 'x', is_dream_generated: true,
    }) as { entity_hints_used: number; entity_hints_dropped: number };
    expect(withNone.entity_hints_used).toBe(0);
    expect(withNone.entity_hints_dropped).toBe(0);
  });
});

describe('job_binding attestation (#5278)', () => {
  test('skipped envelopes carry recorded:false with the skip reason', async () => {
    const r = await operationsByName.extract_facts!.handler(ctx(), {
      turn_text: 'x', is_dream_generated: true,
    }) as { skipped: string; job_binding: { recorded: boolean; reason?: string } };
    expect(r.job_binding.recorded).toBe(false);
    expect(r.job_binding.reason).toBe('dream_generated');
  });

  test('no chat model → extraction_unavailable records false with reason', async () => {
    const LONG = 'this is a real meeting note longer than 80 chars '.repeat(3);
    const r = await operationsByName.extract_facts!.handler(ctx(), {
      turn_text: LONG,
    }) as { skipped: string; job_binding: { recorded: boolean; reason?: string } };
    expect(r.skipped).toBe('extraction_unavailable');
    expect(r.job_binding.recorded).toBe(false);
    expect(r.job_binding.reason).toBe('extraction_unavailable');
  });

  test('a recorded extraction binds to the durable fact ids it wrote', async () => {
    const { __setChatTransportForTests } = await import('../src/core/ai/gateway.ts');
    __setChatTransportForTests(async () => ({
      text: JSON.stringify({ facts: [{ fact: 'binding-probe-fact', kind: 'event', entity: 'people/binding-probe', confidence: 1.0 }] }),
      blocks: [], stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub', providerId: 'test',
    }));
    try {
      const LONG = 'this is a real meeting note longer than 80 chars '.repeat(3);
      const r = await operationsByName.extract_facts!.handler(ctx(), {
        turn_text: LONG,
      }) as {
        inserted: number; fact_ids: number[];
        job_binding: { recorded: boolean; fact_ids: number[]; recorded_at?: string };
      };
      expect(r.job_binding.recorded).toBe(true);
      expect(r.job_binding.fact_ids).toEqual(r.fact_ids);
      expect(r.fact_ids.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(r.job_binding.recorded_at ?? ''))).toBe(true);
    } finally {
      __setChatTransportForTests(null);
    }
  });
});
