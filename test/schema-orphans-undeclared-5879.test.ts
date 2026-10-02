// #5879 — orphan/coverage surfaces must classify stored types with
// classifyStoredType (undeclared = neither a declared page_type nor an
// alias), not just `type IS NULL OR type = ''`. `pages.type` is NOT NULL,
// so a non-empty undeclared value is still "no active-pack type match".

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runReviewOrphans } from '../src/core/schema-pack/review.ts';
import { runStatsCore } from '../src/core/schema-pack/stats.ts';
import { checkSchemaPackConsistency } from '../src/commands/doctor/schema-pack-checks.ts';
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let tmpDir: string;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState clears the config table; the engine caches the schema
  // version it needs for several reads.
  await engine.setConfig('version', schemaVersion);
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-orphans-5879-'));
});

function ctxOf(remote = false): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote,
  } as unknown as OperationContext;
}

async function seedPage(slug: string, type: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, source_path, type, title, compiled_truth, timeline, content_hash)
     VALUES ($1, 'default', $2, $3, $1, '', '', '')`,
    [slug, `${slug}.md`, type],
  );
}

// Pack declaring `person` and aliasing `human` → person.
function seedTestPack(): void {
  const dir = join(tmpDir, 'testpack');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(path, `api_version: gbrain-schema-pack-v1
name: testpack
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: person
    primitive: entity
    path_prefixes:
      - people/
    aliases:
      - human
    extractable: false
    expert_routing: false
link_types: []
frontmatter_links: []
takes_kinds:
  - fact
enrichable_types: []
filing_rules: []
`, 'utf-8');
  __setPackLocatorForTests((name) => (name === 'testpack' ? path : null));
}

describe('runReviewOrphans — undeclared types are orphans', () => {
  it('lists undeclared + untyped pages, excludes declared + alias', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'testpack' }, async () => {
      seedTestPack();
      await seedPage('typed-person', 'person');       // declared — NOT an orphan
      await seedPage('aliased-human', 'human');       // alias — NOT an orphan
      await seedPage('undeclared-idea', 'idea');      // undeclared — orphan
      await seedPage('untyped-page', '');             // empty — orphan
      const result = await runReviewOrphans(engine, { sourceId: 'default' });
      const slugs = result.orphans.map((o) => o.slug).sort();
      expect(slugs).toEqual(['undeclared-idea', 'untyped-page']);
      expect(result.orphan_count).toBe(2);
    });
  });
});

describe('runStatsCore — coverage counts undeclared types as untyped', () => {
  it('reports coverage < 1.0 when pages store undeclared types', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'testpack' }, async () => {
      seedTestPack();
      await seedPage('a', 'person');
      await seedPage('b', 'human');  // alias — typed
      await seedPage('c', 'idea');   // undeclared — untyped
      await seedPage('d', '');       // empty — untyped
      const result = await runStatsCore(ctxOf());
      expect(result.aggregate.total_pages).toBe(4);
      expect(result.aggregate.typed_pages).toBe(2);
      expect(result.aggregate.untyped_pages).toBe(2);
      expect(result.aggregate.coverage).toBe(0.5);
    });
  });
});

describe('schema_review_orphans (MCP op) — undeclared types are orphans', () => {
  it('lists undeclared pages alongside untyped ones', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'testpack' }, async () => {
      seedTestPack();
      await seedPage('typed-person', 'person');
      await seedPage('undeclared-idea', 'idea');
      const result = await operationsByName.schema_review_orphans!.handler(ctxOf(), {}) as Record<string, unknown>;
      const slugs = (result.orphans as Array<{ slug: string }>).map((o) => o.slug);
      expect(slugs).toEqual(['undeclared-idea']);
      expect(result.orphan_count).toBe(1);
    });
  });

  it('falls back to the empty-type predicate when the pack cannot resolve', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'testpack' }, async () => {
      __setPackLocatorForTests(() => null);  // pack resolution fails
      await seedPage('undeclared-idea', 'idea');
      await seedPage('untyped-page', '');
      const result = await operationsByName.schema_review_orphans!.handler(ctxOf(), {}) as Record<string, unknown>;
      const slugs = (result.orphans as Array<{ slug: string }>).map((o) => o.slug);
      expect(slugs).toEqual(['untyped-page']);
    });
  });
});

describe('checkSchemaPackConsistency — undeclared types count as unmatched', () => {
  it('warns when undeclared pages exceed the threshold', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'testpack' }, async () => {
      seedTestPack();
      await seedPage('a', 'person');
      await seedPage('b', 'idea');    // undeclared
      await seedPage('c', 'idea');    // undeclared
      await seedPage('d', 'widget');  // undeclared
      const check = await checkSchemaPackConsistency(engine);
      expect(check.name).toBe('schema_pack_consistency');
      expect(check.status).toBe('warn');
      expect(check.message).toContain('3 of 4 pages');
    });
  });

  it('reports ok when every stored type is declared or aliased', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'testpack' }, async () => {
      seedTestPack();
      await seedPage('a', 'person');
      await seedPage('b', 'human');
      const check = await checkSchemaPackConsistency(engine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('All pages match the active schema pack');
    });
  });
});
