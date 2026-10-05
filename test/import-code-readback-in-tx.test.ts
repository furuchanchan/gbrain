/**
 * #6011 — importCodeFile's read-back verification runs inside the write
 * transaction, mirroring the markdown path. A competing writer committing
 * between the import's commit and its read-back can no longer turn a
 * successful import into a false "silent desync" failure.
 *
 * Strategy: poison every OUTER-engine getPage once the import's transaction
 * has committed — exactly what a concurrent last-write-wins row looks like.
 * The transaction-scoped engine (Object.create(this) in both engines) reaches
 * the same method with `this !== engine`, so an in-tx read-back still sees
 * the real row. Before the fix the post-commit verifyPageReadable read the
 * outer engine and threw a stale-content_hash error.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GetPageOpts, Page } from '../src/core/types.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const engines: BrainEngine[] = [];
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL);
    const pg = new PostgresEngine(); await pg.connect({ database_url: process.env.DATABASE_URL }); await pg.initSchema(); engines.push(pg);
  }
}, 120_000);
afterAll(async () => { for (const engine of engines) await engine.disconnect(); });

describe('importCodeFile — in-transaction read-back', () => {
test('a competing post-commit write cannot fail a committed code import (#6011)', async () => {
  for (const [lane, engine] of engines.entries()) {
    // A persistent lane keeps pages between runs — a fresh path keeps the
    // import on the write path every time.
    const path = `src/test/racy-readback-6011-${Date.now()}-${lane}.ts`;
    const src = `export function keep() { return 1; }\n`;

    // Flip when the import's write transaction commits: every outer-engine
    // getPage after that point observes the "competing writer's" row.
    // Nested tx.transaction() calls reach this same own-property via the
    // prototype chain — pass them through on their own `this` so a savepoint
    // is never rerouted onto the outer engine.
    let committed = false;
    const origTransaction: BrainEngine['transaction'] = engine.transaction;
    const origGetPage = engine.getPage;
    engine.transaction = function <T>(this: BrainEngine, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
      const result = origTransaction.call(this, fn) as Promise<T>;
      return this === engine ? result.finally(() => { committed = true; }) : result;
    };
    engine.getPage = function (this: BrainEngine, slug: string, opts?: GetPageOpts): Promise<Page | null> {
      return origGetPage.call(this, slug, opts).then(page =>
        committed && this === engine && page ? { ...page, content_hash: 'competing-writer-hash' } : page);
    };

    try {
      const result = await importCodeFile(engine, path, src, { noEmbed: true });
      expect(result.status).toBe('imported');
    } finally {
      delete (engine as unknown as Record<string, unknown>).transaction;
      delete (engine as unknown as Record<string, unknown>).getPage;
    }
  }
}, 60_000);
});
