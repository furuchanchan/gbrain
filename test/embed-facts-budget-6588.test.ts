/**
 * #6588 regression: `embedStaleFacts` treated its internal wall-clock budget
 * stop as a failure (`stopped: 'aborted'`, `failures++`), and the migration
 * called it once per source with the 60 s default and no `budgetMs` — so a
 * slow provider made the facts phase fail ~600 facts in, `if (facts.failures)
 * break` skipped every remaining source, and the migration ended incomplete.
 *
 * Fix: the internal timer alone now reports `stopped: 'budget'` (a bounded
 * resume point, not a failure — same contract as chunk embeds' time_budget);
 * only an external abort reports 'aborted' + failure. The migration loops
 * `embedStaleFacts` per source until `remaining === 0` with a 60 min window,
 * so a 'budget'/'limit' stop resumes rather than skipping sources.
 *
 * Pinned here: a tiny budgetMs yields 'budget' + zero failures; an external
 * abort still yields 'aborted' + failure; unattempted rows resume cleanly.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { embedStaleFacts } from '../src/core/embed-facts.ts';
import { saveConfig, loadConfig } from '../src/core/config.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourceId = 'fact-budget-6588';
const originalConfig = loadConfig() ?? { engine: 'pglite' as const };

describe('embedStaleFacts budget stop (#6588)', () => {
  let engine: BrainEngine;
  let databasePath: string;
  let calls: string[][];
  let transportDelayMs = 0;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    databasePath = mkdtempSync(join(tmpdir(), 'fact-budget-6588-'));
    await engine.connect({ database_path: join(databasePath, 'db') });
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT(id) DO NOTHING', [sourceId]);
  });

  beforeEach(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test-key' } });
    saveConfig({ ...originalConfig, embedding_disabled: false });
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
    await engine.setConfig('embedding_dimensions', '1536');
    await engine.setConfig('embedding_disabled', 'false');
    await engine.executeRaw('DELETE FROM facts WHERE source_id=$1', [sourceId]);
    calls = [];
    transportDelayMs = 0;
    __setEmbedTransportForTests(async ({ values }) => {
      calls.push([...values]);
      if (transportDelayMs > 0 && calls.length > 1) await new Promise((r) => setTimeout(r, transportDelayMs));
      return { values, usage: { tokens: values.length }, warnings: [], embeddings: values.map(() => Array(1536).fill(0.25)) };
    });
  });

  afterEach(async () => {
    saveConfig({ ...originalConfig, embedding_disabled: false });
    __setEmbedTransportForTests(null);
    resetGateway();
  });

  afterAll(async () => {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.disconnect();
    rmSync(databasePath, { recursive: true, force: true });
    saveConfig(originalConfig ?? {});
  });

  async function seed(fact: string) {
    await engine.insertFact({ fact, kind: 'fact', confidence: 1, source: 'notes', visibility: 'world', notability: 'medium' }, { source_id: sourceId });
  }

  test('internal wall-clock stop is stopped=budget with zero failures', async () => {
    await seed('one');
    await seed('two');
    // First call is instant (banks one row); the second outlives the budget so
    // the internal timer fires before the batch lands — aborts mid-flight or at
    // the transaction's throwIfAborted, same classification either way.
    transportDelayMs = 500;
    const result = await embedStaleFacts(engine, { sourceId, yes: true, maxCostUsd: 1, batchSize: 1, budgetMs: 100 });
    expect(result.stopped).toBe('budget');
    expect(result.failures).toBe(0);
    expect(result.embedded).toBe(1);
    expect(result.remaining).toBe(1);
    // A bounded stop resumes cleanly — the next call completes the row.
    const resumed = await embedStaleFacts(engine, { sourceId, yes: true, maxCostUsd: 1 });
    expect(resumed).toMatchObject({ embedded: 1, remaining: 0, stopped: 'complete', failures: 0 });
  });

  test('external abort is still stopped=aborted with a failure counted', async () => {
    await seed('two');
    const controller = new AbortController();
    controller.abort();
    const result = await embedStaleFacts(engine, { sourceId, yes: true, maxCostUsd: 1, signal: controller.signal });
    expect(result.stopped).toBe('aborted');
    expect(result.failures).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  test('external abort wins over the internal timer when both fire', async () => {
    await seed('three');
    const controller = new AbortController();
    controller.abort();
    const result = await embedStaleFacts(engine, { sourceId, yes: true, maxCostUsd: 1, budgetMs: 1, signal: controller.signal });
    expect(result.stopped).toBe('aborted');
    expect(result.failures).toBeGreaterThan(0);
  });
});
