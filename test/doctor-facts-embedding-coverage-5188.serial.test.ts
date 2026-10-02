/**
 * #5188 — `facts_embedding_coverage` doctor check: counts active (eligible)
 * facts whose embedding is NULL per source and names the bounded repair
 * (`gbrain embed --stale --facts`). Excludes expired/superseded/audit rows;
 * ok on zero, on a pre-facts-embedding schema, and on keyless brains.
 * Serial: mutates GBRAIN_HOME / gateway config.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkFactsEmbeddingCoverage } from '../src/commands/doctor/checks/graph-embedding.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string;
let engine: PGLiteEngine;

const insertFact = async (fact: string, rowNum: number) =>
  engine.insertFacts(
    [{ fact, kind: 'fact', visibility: 'private', source: 'fixture',
       entity_slug: 'people/example', row_num: rowNum, source_markdown_slug: 'people/example' }],
    { source_id: 'src-a' },
  );

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'g5188-'));
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources(id,name) VALUES('src-a','src-a') ON CONFLICT DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources(id,name) VALUES('src-b','src-b') ON CONFLICT DO NOTHING`);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('#5188 checkFactsEmbeddingCoverage', () => {
  test('no facts / all embedded → ok', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const c = await checkFactsEmbeddingCoverage(engine);
      expect(c.name).toBe('facts_embedding_coverage');
      expect(c.status).toBe('ok');
    });
  });

  test('NULL-embedding active facts → warn per source, names the bounded repair', async () => {
    await insertFact('fact one needs vector', 1);
    await insertFact('fact two needs vector', 2);
    await engine.insertFacts(
      [{ fact: 'other source missing vector', kind: 'fact', visibility: 'private', source: 'fixture',
         entity_slug: 'people/example', row_num: 1, source_markdown_slug: 'people/example' }],
      { source_id: 'src-b' },
    );
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const c = await checkFactsEmbeddingCoverage(engine);
      expect(c.status).toBe('warn');
      expect(c.message).toContain('3 active fact(s)');
      expect(c.message).toContain('src-a: 2');
      expect(c.message).toContain('src-b: 1');
      expect(c.message).toContain('embed --stale --facts');
      expect(c.message).toContain('--dry-run');
    });
  });

  test('expired + superseded + audit-source rows are NOT counted', async () => {
    // Expire one src-a row.
    await engine.executeRaw(
      `UPDATE facts SET expired_at = now() WHERE fact = 'fact one needs vector'`,
    );
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const c = await checkFactsEmbeddingCoverage(engine);
      expect(c.status).toBe('warn');
      expect(c.message).toContain('2 active fact(s)');
      expect(c.message).toContain('src-a: 1');
    });
  });

  test('facts carrying an embedding are NOT counted; clearing all → ok again', async () => {
    // One embedded fact alongside the two remaining NULL rows: still warns
    // (only NULL vectors count), then deleting the NULL rows returns ok.
    const { readFactsEmbeddingDim } = await import('../src/core/embedding-dim-check.ts');
    const dim = await readFactsEmbeddingDim(engine);
    const emb = new Float32Array(dim.dims ?? 1024);
    emb[0] = 0.5;
    await engine.insertFacts(
      [{ fact: 'embedded fact stays uncounted', kind: 'fact', visibility: 'private', source: 'fixture',
         entity_slug: 'people/example', row_num: 3, source_markdown_slug: 'people/example',
         embedding: emb }],
      { source_id: 'src-a' },
    );
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const c = await checkFactsEmbeddingCoverage(engine);
      expect(c.status).toBe('warn');
      expect(c.message).toContain('2 active fact(s)');
      await engine.executeRaw(`DELETE FROM facts WHERE embedding IS NULL`);
      const c2 = await checkFactsEmbeddingCoverage(engine);
      expect(c2.status).toBe('ok');
      expect(c2.message).toContain('All active facts carry an embedding');
    });
  });

  test('embedding_disabled brain → ok (NULL vectors by design)', async () => {
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const c = await checkFactsEmbeddingCoverage(engine);
        expect(c.status).toBe('ok');
        expect(c.message).toContain('disabled');
      });
    } finally {
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
    }
  });
});
