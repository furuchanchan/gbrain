/**
 * Issue #2298 — timeline metric presentation contract.
 *
 * Authoritative upstream semantics (src/core/types.ts):
 *   - Metric A `timeline_coverage` (entity-scoped, fraction 0–1):
 *       eligible entity pages WITH a timeline entry / eligible entity pages
 *     -> surfaced by `graph_coverage` check AND `get_health` CLI entity line.
 *   - Metric B `timeline_coverage_score` (whole-brain, 0–15 brain-score component):
 *       entity/temporal-primitive pages WITH a timeline entry / entity/temporal-primitive pages
 *       (#5828: document-primitive types — note, writing, guide, … — no longer
 *       dilute the denominator; undeclared types stay graded)
 *     -> surfaced by `brain_score` component breakdown AND (separately) CLI.
 *
 * The two have DIFFERENT numerators/denominators. This PR labels each
 * explicitly and keeps BOTH the entity CLI line and the whole-brain line.
 *
 * Tests (no private EriadorMu data, no production/home DB, no network):
 *   - numeric denominator assertions (Metric A = 50%, Metric B = 8/15)
 *   - doctor rendered-message assertions (exact labels, no ambiguous old label)
 *   - CLI rendered-output assertions (exact lines, guard matrix)
 *   - red/green: same assertions FAIL on origin/master, PASS on this branch
 *
 * Scoring formula UNCHANGED. Canonical PGLite fixture via resetPgliteState.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { formatResult } from '../src/cli.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';

// #5828: Metric B's denominator now depends on the active pack's type
// primitives — isolate GBRAIN_HOME so pack resolution is deterministic
// (bundled gbrain-base) whatever the host's real config says.
let packHome = '';
async function withPackEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: packHome, GBRAIN_SCHEMA_PACK: undefined }, fn);
}

let engine: PGLiteEngine;

async function seedFourPages(eng: PGLiteEngine): Promise<void> {
  const sql = sqlQueryForEngine(eng);
  // 6 eligible entity pages (>= the gbrain#4147 small-N floor of 5, so the
  // entity ratio is a real percentage rather than the below-floor null),
  // 2 technical/non-entity pages, and one quarantined entity shell (#4280:
  // NOT served memory, so it must not join any coverage denominator — with
  // it counted, Metric A reads 3/7 and Metric B 3/9, breaking every pinned
  // number below). THREE served entity pages carry timeline entries:
  //   Metric A (entity-scoped):   3/6 = 50%  (same 50% the contract pins)
  //   Metric B (whole-brain):     3/8 -> round(15 * 0.375) = 6/15
  // Metric B's denominator is now the graded (entity/temporal) scope: the two
  // `note` pages are concept-primitive documents and drop out, so Metric B
  // grades 3/6 = 50% — the same ratio Metric A reports. The fixture keeps a
  // `meeting` page below (temporal, counted) so the denominators stay
  // provably distinct from the old all-pages scope.
  await sql`
    INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
    VALUES ('standup-example', 'default', 'meeting', 'Standup', '', '{}', 'hm', now(), now())
  `;
  await sql`
    INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
    VALUES
      ('acme-example', 'default', 'company', 'Acme', '', '{}', 'h1', now(), now()),
      ('alice-example', 'default', 'person', 'Alice', '', '{}', 'h2', now(), now()),
      ('bob-example', 'default', 'person', 'Bob', '', '{}', 'h5', now(), now()),
      ('carol-example', 'default', 'person', 'Carol', '', '{}', 'h6', now(), now()),
      ('widget-co-example', 'default', 'company', 'Widget Co', '', '{}', 'h7', now(), now()),
      ('dana-example', 'default', 'person', 'Dana', '', '{}', 'h8', now(), now()),
      ('quarantined-example', 'default', 'company', 'Quarantined', '', '{"quarantine":{"reason":"junk_pattern","detail":"test","assessed_at":"2026-01-01T00:00:00Z"}}', 'hq', now(), now()),
      ('technical-a', 'default', 'note', 'Tech A', '', '{}', 'h3', now(), now()),
      ('technical-b', 'default', 'note', 'Tech B', '', '{}', 'h4', now(), now())
  `;
  for (const slug of ['acme-example', 'alice-example', 'bob-example']) {
    const pid = (await sql`SELECT id FROM pages WHERE slug=${slug}`)[0].id as number;
    await sql`INSERT INTO timeline_entries (page_id, date, source, summary, detail)
      VALUES (${pid}, CURRENT_DATE, 'test', 'milestone', '{}')`;
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  _resetPackCacheForTests();
  packHome = mkdtempSync(join(tmpdir(), 'gbrain-5828-'));
  await resetPgliteState(engine);
  return () => rmSync(packHome, { recursive: true, force: true });
});

describe('issue #2298 — numeric denominator semantics', () => {
  test('entity timeline coverage = 3/6 = 50% (6 eligible entities, 3 with timeline)', async () => {
    await seedFourPages(engine);
    const health = await engine.getHealth();
    expect(health.timeline_coverage).toBeDefined();
    expect(Math.round((health.timeline_coverage ?? 0) * 100)).toBe(50);
  });

  test('whole-brain timeline density = 3/7 graded -> score 6/15 (6 entities + 1 meeting, 3 with timeline)', async () => {
    await seedFourPages(engine);
    const health = await withPackEnv(() => engine.getHealth());
    expect(health.timeline_coverage_score).toBeDefined();
    expect(health.timeline_coverage_score).toBe(6);
  });

  test('the two metrics use independent denominators', async () => {
    await seedFourPages(engine);
    const health = await withPackEnv(() => engine.getHealth());
    expect(Math.round((health.timeline_coverage ?? 0) * 100)).toBe(50);
    expect(health.timeline_coverage_score ?? 0).toBe(6);
    // Metric A counts entity pages only (/6). Metric B counts entity+temporal
    // pages (/7 — the meeting joins, the two concept notes do not).
    expect(Math.round(((health.timeline_coverage_score ?? 0) / 15) * 100)).not.toBe(50);
  });
});

describe('issue #2298 — doctor rendered-message contract', () => {
  test('graph_coverage renders entity-scoped label with 50%', async () => {
    await seedFourPages(engine);
    const checks = await withPackEnv(() => buildChecks(engine, [], null));
    const graph = checks.find((c) => c.name === 'graph_coverage');
    expect(graph, 'graph_coverage check must be present').toBeDefined();
    expect(graph!.message).toContain('entity timeline coverage 50%');
    // ambiguous old label must NOT be present
    expect(graph!.message).not.toMatch(/timeline 50%/);
    expect(graph!.message).not.toMatch(/timeline \(entity, brain score\)/);
  });

  test('brain_score renders graded-scope density label 6/15', async () => {
    await seedFourPages(engine);
    const checks = await withPackEnv(() => buildChecks(engine, [], null));
    const brain = checks.find((c) => c.name === 'brain_score');
    expect(brain, 'brain_score check must be present').toBeDefined();
    expect(brain!.message).toContain('timeline density (entity and event pages) 6/15');
    // wrong labels must NOT be present
    expect(brain!.message).not.toMatch(/timeline 6\/15/);
    expect(brain!.message).not.toMatch(/timeline \(entity, brain score\)/);
    // the Metric-A label must not leak into the brain-score component
    expect(brain!.message).not.toContain('entity timeline coverage');
  });
});

describe('issue #2298 — CLI get_health rendered-output contract', () => {
  function fakeHealth(overrides: Record<string, unknown>): any {
    return {
      embed_coverage: 1, missing_embeddings: 0, stale_pages: 0, orphan_pages: 0,
      link_coverage: 1, timeline_coverage: 0.5, timeline_coverage_score: 4,
      most_connected: [], ...overrides,
    };
  }

  test('both entity and whole-brain lines render, no undefined/15', () => {
    const out = formatResult('get_health', fakeHealth({}));
    expect(out).toContain('Timeline coverage (entity pages): 50.0%');
    expect(out).toContain('Timeline density (entity and event pages): 4/15');
    expect(out).not.toContain('undefined/15');
    expect(out).not.toContain('Timeline coverage (entities)');
    expect(out).not.toMatch(/timeline \(entity, brain score\)/);
    expect(out).not.toMatch(/bare "timeline 6\/15"/);
  });

  test('guard matrix: entity present, whole-brain absent -> only entity line', () => {
    const out = formatResult('get_health', fakeHealth({ timeline_coverage_score: undefined }));
    expect(out).toContain('Timeline coverage (entity pages): 50.0%');
    expect(out).not.toContain('Timeline density (entity and event pages)');
    expect(out).not.toContain('undefined/15');
  });

  test('guard matrix: whole-brain present, entity absent -> only whole-brain line', () => {
    const out = formatResult('get_health', fakeHealth({ timeline_coverage: undefined }));
    expect(out).toContain('Timeline density (entity and event pages): 4/15');
    expect(out).not.toContain('Timeline coverage (entity pages)');
    expect(out).not.toContain('undefined/15');
  });

  test('guard matrix: both absent -> neither timeline line, never undefined/15', () => {
    const out = formatResult('get_health', fakeHealth({ timeline_coverage: undefined, timeline_coverage_score: undefined }));
    expect(out).not.toContain('Timeline coverage (entity pages)');
    expect(out).not.toContain('Timeline density (entity and event pages)');
    expect(out).not.toContain('undefined/15');
  });
});
