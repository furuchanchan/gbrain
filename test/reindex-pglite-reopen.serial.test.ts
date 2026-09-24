/**
 * #5284 — `gbrain reindex --markdown` wedges a single long-lived PGLite
 * connection inside its own COMMIT after ~2,600–3,300 page writes (100%
 * CPU WASM spin, SIGTERM unreached). The reporter's verified workaround
 * bounds work per connection (~500 pages per process); the fix re-opens
 * the engine at batch boundaries once the processed-page count crosses
 * `GBRAIN_REINDEX_PGLITE_REOPEN_EVERY` (default 500, 0 disables).
 *
 * Serial: mutates process.env (`GBRAIN_REINDEX_PGLITE_REOPEN_EVERY`).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindex } from '../src/commands/reindex.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;
let reconnectCalls = 0;
const originalReconnect = PGLiteEngine.prototype.reconnect;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  PGLiteEngine.prototype.reconnect = originalReconnect;
  await engine.disconnect();
});

beforeEach(async () => {
  _resetCliExitVerdictForTests();
  reconnectCalls = 0;
  PGLiteEngine.prototype.reconnect = async function (this: PGLiteEngine, ctx?: { error?: unknown }) {
    reconnectCalls++;
    return originalReconnect.call(this, ctx);
  };
  await (engine as any).db.exec('DELETE FROM content_chunks');
  await (engine as any).db.exec('DELETE FROM pages');
});

afterEach(() => {
  delete process.env.GBRAIN_REINDEX_PGLITE_REOPEN_EVERY;
});

async function seedLegacyPage(slug: string, body: string) {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, chunker_version, source_path, contextual_retrieval_mode)
     VALUES ('default', $1, 'note', $2, $3, 'markdown', 1, NULL, NULL)`,
    [slug, slug.split('/').pop() ?? slug, body],
  );
}

// Mirrors runReindex's --no-embed drift predicate (chunker_version only).
async function countPending(): Promise<number> {
  const rows = await engine.executeRaw<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM pages
       WHERE page_kind = 'markdown' AND deleted_at IS NULL
         AND chunker_version < $1`,
    [MARKDOWN_CHUNKER_VERSION],
  );
  return rows[0]?.c ?? 0;
}

describe('#5284 PGLite connection bound', () => {
  test('sweep re-opens the connection once the page count crosses the cadence', async () => {
    for (let i = 0; i < 110; i++) {
      await seedLegacyPage(`docs/page-${i}`, `# Page ${i}\n\nBody text for page ${i}.\n`);
    }
    process.env.GBRAIN_REINDEX_PGLITE_REOPEN_EVERY = '50';
    const result = await runReindex(engine, ['--markdown', '--no-embed']);
    // One 100-page batch crosses 50 before the final 10-page batch.
    expect(reconnectCalls).toBeGreaterThanOrEqual(1);
    expect(result.reindexed).toBe(110);
    expect(await countPending()).toBe(0);
  });

  test('REOPEN_EVERY=0 opts out — no re-open mid-sweep', async () => {
    for (let i = 0; i < 110; i++) {
      await seedLegacyPage(`docs/optout-${i}`, `# Page ${i}\n\nBody.\n`);
    }
    process.env.GBRAIN_REINDEX_PGLITE_REOPEN_EVERY = '0';
    const result = await runReindex(engine, ['--markdown', '--no-embed']);
    expect(reconnectCalls).toBe(0);
    expect(result.reindexed).toBe(110);
  });

  test('a real file-backed re-open completes mid-sweep and the store stays writable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-reindex-reopen-'));
    const fileEngine = new PGLiteEngine();
    let fileReconnects = 0;
    try {
      await fileEngine.connect({ engine: 'pglite', database_path: join(dir, 'brain') });
      await fileEngine.initSchema();
      const original = fileEngine.reconnect.bind(fileEngine);
      fileEngine.reconnect = async (ctx?: { error?: unknown }) => {
        fileReconnects++;
        return original(ctx);
      };
      for (let i = 0; i < 110; i++) {
        await fileEngine.executeRaw(
          `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, chunker_version, source_path, contextual_retrieval_mode)
           VALUES ('default', $1, 'note', $2, $3, 'markdown', 1, NULL, NULL)`,
          [`docs/f-${i}`, `f-${i}`, `# F${i}\n\nBody.\n`],
        );
      }
      process.env.GBRAIN_REINDEX_PGLITE_REOPEN_EVERY = '50';
      const result = await runReindex(fileEngine, ['--markdown', '--no-embed']);
      expect(fileReconnects).toBeGreaterThanOrEqual(1);
      expect(result.reindexed).toBe(110);
      const rows = await fileEngine.executeRaw<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM pages WHERE chunker_version >= $1`,
        [MARKDOWN_CHUNKER_VERSION],
      );
      expect(rows[0]?.c).toBe(110);
    } finally {
      await fileEngine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
