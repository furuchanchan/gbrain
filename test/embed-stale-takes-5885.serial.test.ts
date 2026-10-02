/**
 * #5885 — stale-take vectors ride the `--stale` embed pass.
 *
 * `embedStaleTakes` existed only behind the manual `gbrain takes embed`
 * command: no cycle phase and no `embed --stale` covered it, so every take
 * written after the last manual pass stayed keyword-only while `think` and
 * `takes search --semantic` read vectors. The fix runs the take sweep at
 * the end of a drained `--stale` pass (which is also what the cycle's
 * `runPhaseEmbed` and the embed minion handlers call), and doctor's
 * `embedding_column_registry` check now counts stale take vectors next to
 * chunk coverage.
 *
 * Serial: configures the AI gateway + a fake embed transport for the whole
 * file lifecycle (mirrors embed-stale-chunkless-pages.serial.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
let engine: PGLiteEngine;
let doctorHome: string;

async function seedPageWithStaleTake(slug: string, claim: string): Promise<number> {
  const page = await engine.putPage(slug, {
    type: 'person' as const,
    title: slug,
    compiled_truth: `## Takes\n\n${claim}\n`,
  });
  await engine.addTakesBatch([
    { page_id: page.id, row_num: 1, claim, kind: 'take', holder: 'garry', weight: 0.8 },
  ]);
  const [take] = await engine.listTakes({ page_id: page.id, active: true, limit: 1 });
  return take!.id;
}

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' },
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => new Array(DIMS).fill(0.001)),
    usage: { tokens: values.length * 4 },
  } as never));

  doctorHome = mkdtempSync(join(tmpdir(), 'gbrain-5885-doctor-'));
  mkdirSync(join(doctorHome, '.gbrain'));
  writeFileSync(join(doctorHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
  }));

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(doctorHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('embed --stale drains stale takes', () => {
  test('stale run embeds NULL-embedding takes and reports result.takes', async () => {
    const takeId = await seedPageWithStaleTake('people/alice-example', 'Alice is a strong founder.');
    expect(await engine.countStaleTakes()).toBe(1);

    const result = await runEmbedCore(engine, { stale: true, quiet: true });

    expect(result.takes?.total_stale).toBe(1);
    expect(result.takes?.embedded).toBe(1);
    expect(result.takes?.failures).toBe(0);
    expect(await engine.countStaleTakes()).toBe(0);
    const stored = await engine.getTakeEmbeddings([takeId]);
    expect(stored.get(takeId)?.length).toBe(DIMS);
  });

  test('dry-run counts take would_embed without writing vectors', async () => {
    const takeId = await seedPageWithStaleTake('people/bob-example', 'Bob ships fast.');
    const result = await runEmbedCore(engine, { stale: true, dryRun: true, quiet: true });

    expect(result.takes?.dryRun).toBe(true);
    expect(result.takes?.would_embed).toBe(1);
    expect(result.takes?.embedded).toBe(0);
    expect(await engine.countStaleTakes()).toBe(1);
    const stored = await engine.getTakeEmbeddings([takeId]);
    expect(stored.has(takeId)).toBe(false);
  });

  test('non-stale targets (slug) do not report a takes pass', async () => {
    await seedPageWithStaleTake('people/carol-example', 'Carol runs ops.');
    const result = await runEmbedCore(engine, { slug: 'people/carol-example', quiet: true });
    expect(result.takes).toBeUndefined();
  });
});

describe('doctor reports stale take vectors', () => {
  test('embedding_column_registry warns on stale takes, clears once embedded', async () => {
    const takeId = await seedPageWithStaleTake('people/dana-example', 'Dana mentors founders.');

    await withEnv({ GBRAIN_HOME: doctorHome }, async () => {
      const checks = await buildChecks(engine, []);
      const registry = checks.find(c => c.name === 'embedding_column_registry');
      expect(registry, 'embedding_column_registry').toBeDefined();
      expect(registry!.status).toBe('warn');
      expect(registry!.message).toContain('1 active take(s) lack embeddings');
      expect(registry!.message).toContain('gbrain embed --stale');
    });

    // Bank a vector directly — the warn segment disappears even though the
    // check keeps reporting on whatever else it always covered.
    await engine.updateTakeEmbeddings([{ take_id: takeId, embedding: new Float32Array(DIMS).fill(0.5) }]);
    expect(await engine.countStaleTakes()).toBe(0);

    await withEnv({ GBRAIN_HOME: doctorHome }, async () => {
      const checks = await buildChecks(engine, []);
      const registry = checks.find(c => c.name === 'embedding_column_registry');
      expect(registry!.message).not.toContain('active take(s) lack embeddings');
    });
  });
});
