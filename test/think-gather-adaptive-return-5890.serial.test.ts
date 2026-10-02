/**
 * #5890 — think's evidence gather must pin `adaptiveReturn: false` on BOTH
 * hybridSearch legs, the same way it pins `autocut: false` (#4561) and
 * `expansion: false`. With `search.adaptive_return = true`, `sizeReturnPool`
 * trims the ranked pool to the intent cap (2 for `entity` intent, 6 for
 * every other intent) BEFORE the limit slice — so a breadth-sized gather
 * (default 40) reached the model with as few as 2 pages on entity-shaped
 * questions. An internal evidence gather is not a reader-facing answer
 * page; precision trimming is the synth prompt's job.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { describe, expect, mock, test } from 'bun:test';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const captured: Array<Record<string, unknown>> = [];

// Mock BEFORE importing gather (gather.ts binds hybridSearch at import time;
// the spread keeps every other export live).
mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearch: async (
    _engine: unknown,
    _query: string,
    opts: Record<string, unknown>,
  ) => {
    captured.push(opts);
    return [];
  },
}));

const { runGather } = await import('../src/core/think/gather.ts');

const engineStub = {
  searchTakes: async () => [],
  listPages: async () => [],
} as unknown as BrainEngine;

describe('think gather pins adaptiveReturn:false (#5890)', () => {
  test('plain leg passes adaptiveReturn:false alongside autocut/expansion', async () => {
    captured.length = 0;
    await runGather(engineStub, { question: 'what changed in the payments migration' });
    expect(captured.length).toBe(1);
    // Pre-fix: adaptiveReturn was absent → resolved from search.adaptive_return
    // config; entity-intent questions were capped to 2 pages, all others to 6.
    expect(captured[0].adaptiveReturn).toBe(false);
    expect(captured[0].autocut).toBe(false);
    expect(captured[0].expansion).toBe(false);
  });

  test('temporal-window leg passes adaptiveReturn:false alongside autocut/expansion', async () => {
    captured.length = 0;
    await runGather(engineStub, {
      question: 'what changed last week',
      window: { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2026, 0, 8) },
    });
    expect(captured.length).toBe(1);
    expect(captured[0].adaptiveReturn).toBe(false);
    expect(captured[0].autocut).toBe(false);
    expect(captured[0].expansion).toBe(false);
  });
});
