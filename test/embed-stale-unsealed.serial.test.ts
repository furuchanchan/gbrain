/**
 * #5289: `embed --stale` must not silently drop pages the stale selector
 * counts. `countStaleChunks`/`listStaleChunks` carry no seal predicate, but
 * `readProjectionSnapshot` and `installPageEmbeddings` both require a sealed
 * projection — so a page whose projection rebuild is pending
 * (text_projection_revision <> knowledge_revision, e.g. a managed write the
 * coordinator has not re-projected yet) was silently skipped on every pass:
 * dry-run counted its NULL chunks, the real run embedded 0 and exited 0.
 *
 * Tested here on an unmanaged PGLite brain: the miss is classified, the page
 * is queued onto `page_projection_jobs`, the pending rebuild is drained
 * inline, and the SAME pass rescans and embeds the freshly-sealed page.
 *
 * Named `.serial.test.ts`: configures the AI gateway + a fake embed
 * transport for its whole lifecycle, which withEnv() can't wrap.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { classifyStalePageMiss } from '../src/core/embed-stale.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import type { ChunkInput } from '../src/core/types.ts';

const DIMS = 1536;
let engine: PGLiteEngine;

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

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function unseal(slug: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE pages SET text_projection_revision='00000000-0000-0000-0000-000000000000'::uuid WHERE slug=$1 AND source_id='default'`,
    [slug],
  );
}

const FIXTURE_CHUNKS: ChunkInput[] = [
  { chunk_index: 0, chunk_text: 'fixture chunk needing an embedding', chunk_source: 'compiled_truth', token_count: 8 },
];

async function seedSealedPage(slug: string, title: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'entity', title,
    compiled_truth: 'content that needs embedding coverage',
  });
  await installFixtureChunks(engine, slug, FIXTURE_CHUNKS);
}

describe('classifyStalePageMiss (#5289)', () => {
  test('an unsealed page queues the durable projection rebuild', async () => {
    await seedSealedPage('entity/unsealed', 'Unsealed');
    await unseal('entity/unsealed');
    expect(await classifyStalePageMiss(engine, 'default', 'entity/unsealed')).toBe('unsealed_projection');
    const jobs = await engine.executeRaw<{ reason: string }>(
      `SELECT reason FROM page_projection_jobs WHERE slug='entity/unsealed'`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].reason).toBe('embed_stale');
  });

  test('a sealed page and a missing page do not classify as unsealed', async () => {
    await seedSealedPage('entity/sealed', 'Sealed');
    expect(await classifyStalePageMiss(engine, 'default', 'entity/sealed')).toBe('page_gone');
    expect(await classifyStalePageMiss(engine, 'default', 'entity/no-such-page')).toBe('page_gone');
  });
});

describe('embed --stale on unsealed pages (#5289)', () => {
  test('an unsealed page is queued, sealed inline, and embedded in the same pass', async () => {
    await seedSealedPage('entity/needs-embed', 'NeedsEmbed');
    await unseal('entity/needs-embed');
    const staleBefore = await engine.countStaleChunks();
    expect(staleBefore).toBeGreaterThan(0);

    const result = await runEmbedCore(engine, { stale: true, quiet: true });

    // The miss was counted (not silently dropped), the rebuild ran, and the
    // rescanned pass actually embedded the page's chunks.
    expect(result.skipped_unsealed).toBeGreaterThan(0);
    expect(result.embedded).toBeGreaterThan(0);
    expect(await engine.countStaleChunks()).toBe(0);
    const [sealed] = await engine.executeRaw<{ sealed: boolean }>(
      `SELECT text_projection_revision = knowledge_revision AS sealed FROM pages WHERE slug='entity/needs-embed'`,
    );
    expect(sealed?.sealed).toBe(true);
  });

  test('a sealed stale page still embeds normally (no regression)', async () => {
    await seedSealedPage('entity/normal', 'Normal');
    const result = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(result.embedded).toBeGreaterThan(0);
    expect(result.skipped_unsealed ?? 0).toBe(0);
    expect(await engine.countStaleChunks()).toBe(0);
  });
});
