/**
 * #5735: the corpus extraction gates checked only the engine-blind
 * detectCapabilities() probe, so a DB-plane `facts.extraction_model` (the
 * model the pipeline actually runs) was invisible — a local model set via
 * `gbrain config set` classified the install as keyless and the sweep /
 * checkpoint harvest left eligible corpus files unprocessed forever.
 *
 * Serial: process-env mutation (provider keys are cleared so the ambient
 * probe really reports keyless) + module-global harvest queue.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests, configureGateway, resetGateway, type ChatResult,
} from '../src/core/ai/gateway.ts';
import { detectCapabilities } from '../src/core/capability.ts';
import { isFactsExtractionAvailable } from '../src/core/facts/extract.ts';
import { RECIPES } from '../src/core/ai/recipes/index.ts';
import { CORPUS_INGESTED_SUFFIX, runMaintenanceSweep } from '../src/core/sweep.ts';
import {
  __drainCheckpointHarvestForTests,
  __resetCheckpointHarvestForTests,
  scheduleCheckpointHarvest,
  shutdownCheckpointHarvest,
} from '../src/core/context/checkpoint-harvest.ts';
import { appendSegmentLedger, segmentFileName, writeSegment } from '../src/core/context/corpus-segments.ts';
import { readHeartbeatTail } from '../src/core/context/hook-heartbeat.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

const KEYLESS_CAPS = {
  embeddings: { available: false }, extraction: { available: false },
  search: 'keyword-only' as const, mode: 'keyless' as const,
};
const LOCAL_MODEL = 'ollama:qwen2.5-coder:14b';

/** Env map that deletes every key any recipe could satisfy itself with. */
const NEUTERED_ENV: Record<string, string | undefined> = Object.fromEntries(
  [...RECIPES.values()]
    .flatMap(r => [...(r.auth_env?.required ?? []), ...(r.auth_env?.optional ?? [])])
    .concat(['GBRAIN_MODEL'])
    .map(k => [k, undefined]),
);

let engine: PGLiteEngine;
let corpusDir: string;
let savedHome: string | undefined;
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
beforeEach(async () => {
  __resetCheckpointHarvestForTests();
  await resetPgliteState(engine);
  corpusDir = mkdtempSync(join(tmpdir(), 'gb-5735-corpus-'));
  const hb = mkdtempSync(join(tmpdir(), 'gb-5735-hb-'));
  tmpDirs.push(corpusDir, hb);
  savedHome = process.env.GBRAIN_HEARTBEAT_DIR;
  process.env.GBRAIN_HEARTBEAT_DIR = hb;
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  await engine.setConfig('facts.extraction_model', LOCAL_MODEL);
  configureGateway({ env: {} }); // the configured gateway, no keys — like the reporter's local-model install
});
afterEach(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await shutdownCheckpointHarvest();
  if (savedHome === undefined) delete process.env.GBRAIN_HEARTBEAT_DIR;
  else process.env.GBRAIN_HEARTBEAT_DIR = savedHome;
});
afterAll(async () => {
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function chatStub() {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({
      facts: [{ fact: 'Alice ships the beta in March', kind: 'commitment', entity: null, confidence: 0.9, notability: 'high' }],
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'ollama:test-stub',
    providerId: 'ollama',
  }));
}

describe('#5735 DB-plane extraction model is not keyless', () => {
  test('engine-aware availability resolves the DB-plane model the blind probe misses', async () => {
    await withEnv({ ...NEUTERED_ENV, GBRAIN_HOME: emptyHome() }, async () => {
      // The misclassification the issue reports, pinned:
      const caps = detectCapabilities();
      expect(caps.extraction.available).toBe(false);
      expect(caps.mode).toBe('keyless');
      // The model the pipeline will actually run — resolved engine-side —
      // is servable: local models need no key.
      expect(await isFactsExtractionAvailable(engine)).toBe(true);
    });
  });

  test('sweep corpus pass extracts via the DB-plane model instead of keyless-skipping', async () => {
    writeFileSync(join(corpusDir, 'fresh.txt'), 'Alice committed to shipping the beta in March.\n');
    chatStub();
    await withEnv({ ...NEUTERED_ENV, GBRAIN_HOME: emptyHome() }, async () => {
      expect(detectCapabilities().extraction.available).toBe(false); // fixture guard
      const r = await runMaintenanceSweep(engine, { sourceId: 'default' });
      expect(r.corpusIngested).toBe(1);
      expect(r.skipped).not.toContainEqual({ reason: 'keyless', count: 1 });
    });
    expect(existsSync(join(corpusDir, 'fresh.txt' + CORPUS_INGESTED_SUFFIX))).toBe(true);
    const facts = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts WHERE source = 'sweep:corpus'`,
    );
    expect(facts.length).toBe(1);
  });

  test('an explicit capability report stays the override: injected keyless still skips', async () => {
    writeFileSync(join(corpusDir, 'still-banked.txt'), 'Alice committed to shipping the beta.\n');
    chatStub();
    const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYLESS_CAPS });
    expect(r.corpusIngested).toBe(0);
    expect(r.skipped).toContainEqual({ reason: 'keyless', count: 1 });
    expect(existsSync(join(corpusDir, 'still-banked.txt' + CORPUS_INGESTED_SUFFIX))).toBe(false);
  });

  test('checkpoint harvest extracts via the DB-plane model instead of keyless-degrading', async () => {
    const w = writeSegment(corpusDir, 'sess-5735', 'User: Alice committed to shipping the beta.\n');
    appendSegmentLedger(corpusDir, 'sess-5735', w.hash);
    const file = segmentFileName('sess-5735', w.hash);
    chatStub();
    await withEnv({ ...NEUTERED_ENV, GBRAIN_HOME: emptyHome() }, async () => {
      expect(detectCapabilities().extraction.available).toBe(false); // fixture guard
      scheduleCheckpointHarvest({
        engine, sourceId: 'default', sessionId: 'sess-5735', corpusDir, file,
      });
      await __drainCheckpointHarvestForTests();
      const hb = (await readHeartbeatTail(5)).find(e => e.event === 'checkpoint-harvest');
      expect(hb?.reason).not.toBe('keyless');
    });
    const facts = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts WHERE source = 'hook:compact'`,
    );
    expect(facts.length).toBe(1);
  });
});
