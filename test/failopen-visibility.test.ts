// Contract under test (#5324): when a lexical retrieval arm errors,
// hybridSearch must (a) still return results — fail-open is preserved — and
// (b) report the degraded arm through HybridSearchMeta.degraded_arms +
// meta.degraded, NOT only warn on stderr where MCP/serve consumers can
// never see it.
import { test, expect } from 'bun:test';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';

/**
 * Permissive engine stub: any method not defined here resolves to a benign
 * empty value, so the test pins ONLY the arm-degradation contract and survives
 * unrelated growth of the engine surface.
 */
function stubEngine(overrides: Record<string, unknown>): any {
  const base: Record<string, unknown> = {
    getConfig: async () => null,
    resolveAliases: async () => new Map(),
    searchKeyword: async () => [
      {
        slug: 'notes/alpha',
        page_id: 1,
        title: 'Alpha',
        type: 'note',
        chunk_text: 'alpha bravo charlie',
        base_score: 0.5,
        score: 0.5,
      },
    ],
    searchTitles: async () => [],
  };
  return new Proxy(
    { ...base, ...overrides },
    {
      get(target, prop: string) {
        if (prop in target) return (target as any)[prop];
        return async () => [];
      },
    },
  );
}

test('titles arm failure is fail-open AND visible in meta.degraded_arms + degraded', async () => {
  const engine = stubEngine({
    searchTitles: async () => {
      throw new Error('canceling statement due to statement timeout');
    },
  });
  let meta: HybridSearchMeta | null = null;
  const results = await hybridSearch(engine, 'alpha bravo charlie', {
    limit: 5,
    expansion: false,
    onMeta: (m: HybridSearchMeta) => { meta = m; },
  } as any);
  // fail-open preserved: the surviving arm's results still come back
  expect(Array.isArray(results)).toBe(true);
  // new contract: the degradation is visible to the meta consumer
  expect(meta).not.toBeNull();
  expect((meta as any).degraded_arms).toEqual(['titles']);
  expect(((meta as any).degraded ?? []).some((d: { stage?: string }) => d.stage === 'title_arm_failed')).toBe(true);
});

test('keyword arm failure is reported the same way', async () => {
  const engine = stubEngine({
    searchKeyword: async () => {
      throw new Error('keyword backend down');
    },
  });
  let meta: HybridSearchMeta | null = null;
  await hybridSearch(engine, 'alpha bravo charlie', {
    limit: 5,
    expansion: false,
    onMeta: (m: HybridSearchMeta) => { meta = m; },
  } as any);
  expect((meta as any).degraded_arms).toEqual(['keyword']);
  expect(((meta as any).degraded ?? []).some((d: { stage?: string }) => d.stage === 'keyword_arm_failed')).toBe(true);
});

test('healthy search reports NO degraded_arms', async () => {
  const engine = stubEngine({});
  let meta: HybridSearchMeta | null = null;
  await hybridSearch(engine, 'healthy query', {
    limit: 5,
    expansion: false,
    onMeta: (m: HybridSearchMeta) => { meta = m; },
  } as any);
  expect(meta).not.toBeNull();
  expect((meta as any).degraded_arms).toBeUndefined();
});
