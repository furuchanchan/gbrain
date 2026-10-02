/**
 * #5527: `embed <slug>` / `embed --slugs` honored only embedding presence —
 * a page whose `embedding_signature` drifted (or was never stamped, under
 * `--include-null-signature`) and a chunk whose `embedded_text_hash` no
 * longer matches `md5(chunk_text)` still printed "all chunks already
 * embedded" and left the stale vectors in place. The flag was also dropped
 * from the explicit-slug CLI opts entirely.
 *
 * This file pins the widened per-slug selection: signature-drifted pages
 * re-embed every chunk and restamp; NULL-signature pages do the same only
 * under the flag; hash-mismatched chunks re-embed individually while a NULL
 * hash keeps its pre-v133 grandfather.
 *
 * Named `.serial.test.ts` (mirrors embed-stale-chunkless-pages): configures
 * the AI gateway + a fake embed transport for its whole lifecycle.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { currentEmbeddingSignature } from '../src/core/embedding.ts';

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

const SIGNATURE = () => currentEmbeddingSignature()!;

async function seedEmbeddedPage(slug: string, sentence: string): Promise<number> {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: `${sentence} ${'lorem ipsum dolor sit amet '.repeat(40)}`,
  });
  const first = await runEmbedCore(engine, { slug, quiet: true });
  expect(first.failures).toBe(0);
  const [{ count }] = await engine.executeRaw<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1', [slug]);
  const [{ sig }] = await engine.executeRaw<{ sig: string | null }>(
    'SELECT embedding_signature AS sig FROM pages WHERE slug=$1', [slug]);
  expect(sig).toBe(SIGNATURE());
  return Number(count);
}

async function pageSignature(slug: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ sig: string | null }>(
    'SELECT embedding_signature AS sig FROM pages WHERE slug=$1', [slug]);
  return row?.sig ?? null;
}

describe('#5527: explicit-slug embed sees signature + hash staleness', () => {
  test('embed <slug> --include-null-signature re-embeds a never-stamped page and stamps it', async () => {
    const chunks = await seedEmbeddedPage('n/nullsig', 'a page that predates the signature stamp');
    await engine.executeRaw('UPDATE pages SET embedding_signature=NULL WHERE slug=$1', ['n/nullsig']);

    // Without the flag the grandfather clause keeps the page skipped.
    const skipped = await runEmbedCore(engine, { slug: 'n/nullsig', quiet: true });
    expect(skipped.embedded).toBe(0);
    expect(await pageSignature('n/nullsig')).toBeNull();

    const res = await runEmbedCore(engine, { slug: 'n/nullsig', quiet: true, includeNullSignature: true });
    expect(res.failures).toBe(0);
    expect(res.embedded).toBe(chunks);
    expect(await pageSignature('n/nullsig')).toBe(SIGNATURE());
  });

  test('embed <slug> re-embeds a signature-drifted page without any flag', async () => {
    const chunks = await seedEmbeddedPage('n/drifted', 'a page stamped under a previous model');
    await engine.executeRaw('UPDATE pages SET embedding_signature=$2 WHERE slug=$1', ['n/drifted', 'voyage:voyage-3:1024']);

    const res = await runEmbedCore(engine, { slug: 'n/drifted', quiet: true });
    expect(res.failures).toBe(0);
    expect(res.embedded).toBe(chunks);
    expect(await pageSignature('n/drifted')).toBe(SIGNATURE());
  });

  test('embed --slugs honors --include-null-signature too', async () => {
    const chunks = await seedEmbeddedPage('n/slugs-null', 'a slugs-list page with no signature');
    await engine.executeRaw('UPDATE pages SET embedding_signature=NULL WHERE slug=$1', ['n/slugs-null']);

    const res = await runEmbedCore(engine, { slugs: ['n/slugs-null'], quiet: true, includeNullSignature: true });
    expect(res.failures).toBe(0);
    expect(res.embedded).toBe(chunks);
    expect(await pageSignature('n/slugs-null')).toBe(SIGNATURE());
  });

  test('a hash-mismatched chunk re-embeds alone; a NULL hash keeps its grandfather', async () => {
    const chunks = await seedEmbeddedPage('n/hashdrift', 'a page whose chunk text changed after embedding');
    expect(chunks).toBeGreaterThan(0);
    // Corrupt one chunk's hash (text untouched → hash <> md5(chunk_text));
    // null out a second chunk's hash (pre-v133 grandfather).
    await engine.executeRaw(
      `UPDATE content_chunks SET embedded_text_hash='00000000000000000000000000000000'
        WHERE page_id=(SELECT id FROM pages WHERE slug=$1) AND chunk_index=0`, ['n/hashdrift']);
    if (chunks > 1) {
      await engine.executeRaw(
        `UPDATE content_chunks SET embedded_text_hash=NULL
          WHERE page_id=(SELECT id FROM pages WHERE slug=$1) AND chunk_index=1`, ['n/hashdrift']);
    }

    const res = await runEmbedCore(engine, { slug: 'n/hashdrift', quiet: true });
    expect(res.failures).toBe(0);
    expect(res.embedded).toBe(1);
    // A clean signature is preserved on a partial re-embed (not stamped away).
    expect(await pageSignature('n/hashdrift')).toBe(SIGNATURE());
  });

  test('a healthy page still reports all chunks already embedded', async () => {
    const chunks = await seedEmbeddedPage('n/healthy', 'a fully current page');
    const res = await runEmbedCore(engine, { slug: 'n/healthy', quiet: true });
    expect(res.failures).toBe(0);
    expect(res.embedded).toBe(0);
    expect(res.skipped).toBe(chunks);
    expect(await pageSignature('n/healthy')).toBe(SIGNATURE());
  });
});
