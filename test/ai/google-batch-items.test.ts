/**
 * #5321 — the Google embedding recipe must declare max_batch_items.
 *
 * BatchEmbedContentsRequest rejects more than 100 requests per batch — a
 * hard COUNT cap a 20k-token budget cannot bound (one-line facts stay far
 * under the token budget while sailing past 100 items). Without the item
 * cap a page holding >100 facts sent the whole array in ONE request and
 * the provider rejected the entire batch, inserting every fact with a
 * NULL embedding.
 *
 * Verified through the public embed() with the transport stubbed (same
 * seam as no-batch-cap-item-split.test.ts).
 */

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

function fakeEmbeddings(values: string[], dims: number): { embeddings: number[][] } {
  return {
    embeddings: values.map((_, i) =>
      Array.from({ length: dims }, (_, j) => (j === 0 ? i : 0.1)),
    ),
  };
}

describe('#5321 google recipe item cap', () => {
  afterEach(() => {
    __setEmbedTransportForTests(null);
    resetGateway();
  });

  test('recipe declares max_batch_items at the provider limit', () => {
    const embedding = getRecipe('google')!.touchpoints.embedding!;
    expect(embedding.max_batch_items).toBe(100);
  });

  test('150 short inputs ride out as <=100-item transport calls', async () => {
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 768,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
    });
    const sizes: number[] = [];
    const stub = mock(async ({ values }: { values: string[] }) => {
      sizes.push(values.length);
      return fakeEmbeddings(values, 768);
    });
    __setEmbedTransportForTests(stub as any);

    const texts = Array.from({ length: 150 }, (_, i) => `short fact ${i}`);
    const out = await embed(texts);
    expect(out).toHaveLength(150);
    expect(sizes.length).toBeGreaterThan(1);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(100);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(150);
  });
});
