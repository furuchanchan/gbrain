/**
 * #5889 — bounded title-equality fallback probe for the #1663 exact-lookup
 * tier. Remote callers rank the title arm on to_tsvector(title) without
 * length normalization, so an arm cut can drop the page whose title IS the
 * query; the fallback re-scans the FTS-matched title population directly.
 * Hermetic PGLite; structuralExactLookup is exercised directly (same shape
 * as exact-lookup.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  structuralExactLookup,
  EXACT_TITLE_STAMP,
} from '../../src/core/search/exact-lookup.ts';
import { _resetSupersedeProbeForTests } from '../../src/core/search/hybrid.ts';
import { classifyEvidence } from '../../src/core/search/evidence.ts';
import type { SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  _resetSupersedeProbeForTests();
});

function res(slug: string, score: number, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    slug, title: slug, score, chunk_text: '', type: 'note', source_id: 'default',
    chunk_index: 0, chunk_id: 1, ...extra,
  } as unknown as SearchResult;
}

describe('#5889 — title-equality fallback probe', () => {
  test('exact-title page outside the arm cut is still found', async () => {
    // Reporter scenario: 60 contender titles all contain the query's terms,
    // so the arm's top rows (passed as titleCandidates) exclude the page
    // whose title IS the query.
    for (let i = 0; i < 60; i++) {
      await engine.putPage(`meetings/acme-example-${i}`, {
        type: 'meeting', title: `Weekly sync acme example ${i}`, compiled_truth: `notes ${i}`,
      });
    }
    await engine.putPage('projects/acme-example', {
      type: 'project', title: 'Acme Example', compiled_truth: 'The Acme Example project page.',
    });
    const titleArm = [
      res('meetings/acme-example-1', 0.4, { title: 'Weekly sync acme example 1' }),
      res('meetings/acme-example-2', 0.4, { title: 'Weekly sync acme example 2' }),
    ];
    const hits = await structuralExactLookup(engine, 'acme example', {
      sourceId: 'default',
      titleCandidates: titleArm,
    });
    expect(hits.length).toBe(1);
    expect(hits[0].slug).toBe('projects/acme-example');
    expect(hits[0].exact_lookup).toBe('title');
    expect(hits[0].title_match_boost).toBeGreaterThanOrEqual(EXACT_TITLE_STAMP);
    expect(hits[0].page_id).toBeGreaterThan(0);
    expect(hits[0].chunk_text).toContain('Acme Example project page');
    expect(classifyEvidence(hits[0])).toBe('exact_title_match');
  });

  test('arm hit suppresses the fallback (no behavior change for the common case)', async () => {
    await engine.putPage('projects/mingtang', {
      type: 'note', title: 'The Mingtang', compiled_truth: 'Indoor amphitheater.',
    });
    const titleArm = [res('projects/mingtang', 0.4, { title: 'The Mingtang' })];
    const hits = await structuralExactLookup(engine, 'the mingtang', {
      sourceId: 'default',
      titleCandidates: titleArm,
    });
    expect(hits.length).toBe(1);
    expect(hits[0].slug).toBe('projects/mingtang');
    expect(hits[0].chunk_index).toBe(0); // arm row shape, not the fallback's synthetic row
  });

  test('no arm candidates at all still resolves the identity page', async () => {
    await engine.putPage('companies/acme-example', {
      type: 'company', title: 'Acme Example', compiled_truth: 'Company page.',
    });
    const hits = await structuralExactLookup(engine, 'acme example', { sourceId: 'default' });
    expect(hits.length).toBe(1);
    expect(hits[0].slug).toBe('companies/acme-example');
    expect(hits[0].exact_lookup).toBe('title');
  });

  test('a page whose title only CONTAINS the query never hits (equality, not phrase)', async () => {
    await engine.putPage('meetings/acme-weekly', {
      type: 'meeting', title: 'Acme Example Weekly Sync', compiled_truth: 'notes',
    });
    const hits = await structuralExactLookup(engine, 'acme example', { sourceId: 'default' });
    expect(hits.length).toBe(0);
  });

  test('case and whitespace differences still normalize to equality', async () => {
    await engine.putPage('projects/acme-example', {
      type: 'project', title: 'ACME   Example', compiled_truth: 'Project page.',
    });
    const hits = await structuralExactLookup(engine, 'acme example', { sourceId: 'default' });
    expect(hits.length).toBe(1);
    expect(hits[0].slug).toBe('projects/acme-example');
  });

  test('private pages cannot enter through the fallback (pageReadFilter parity)', async () => {
    await engine.putPage('projects/acme-example', {
      type: 'project', title: 'Acme Example',
      compiled_truth: 'SECRET_EXACT', frontmatter: { visibility: 'private' },
    });
    const hits = await structuralExactLookup(engine, 'acme example', { excludePrivate: true });
    expect(hits.length).toBe(0);
  });

  test('source scope gates the fallback probe', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team-b', 'team-b') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('projects/acme-example', {
      type: 'project', title: 'Acme Example', compiled_truth: 'B-side page.',
    }, { sourceId: 'team-b' });
    expect(await structuralExactLookup(engine, 'acme example', { sourceId: 'default' })).toEqual([]);
    const scoped = await structuralExactLookup(engine, 'acme example', { sourceIds: ['team-b'] });
    expect(scoped.length).toBe(1);
    expect(scoped[0].source_id).toBe('team-b');
  });

  test('shape filters still gate fallback hits (type/types/excludeSlugs)', async () => {
    await engine.putPage('projects/acme-example', {
      type: 'project', title: 'Acme Example', compiled_truth: 'Project page.',
    });
    expect(await structuralExactLookup(engine, 'acme example', { types: ['company'] })).toEqual([]);
    expect(await structuralExactLookup(engine, 'acme example', { excludeSlugs: ['projects/acme-example'] })).toEqual([]);
    const hits = await structuralExactLookup(engine, 'acme example', { types: ['project'] });
    expect(hits.length).toBe(1);
  });

  test('a superseded fallback hit is filtered, not injected', async () => {
    await engine.putPage('notes/canon', { type: 'note', title: 'Canon', compiled_truth: 'current' });
    await engine.putPage('notes/acme-example', { type: 'note', title: 'Acme Example', compiled_truth: 'stale copy' });
    await engine.addLink('notes/canon', 'notes/acme-example', '', 'supersedes', 'manual');
    const hits = await structuralExactLookup(engine, 'acme example', { sourceId: 'default' });
    expect(hits.length).toBe(0);
  });

  test('probe failure falls back to arm-only behavior (fail-open)', async () => {
    await engine.putPage('projects/acme-example', {
      type: 'project', title: 'Acme Example', compiled_truth: 'Project page.',
    });
    const original = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: unknown }).executeRaw = async () => { throw new Error('probe down'); };
    try {
      const hits = await structuralExactLookup(engine, 'acme example', { sourceId: 'default' });
      expect(hits.length).toBe(0); // arm had no candidates; probe threw → []
    } finally {
      (engine as unknown as { executeRaw: unknown }).executeRaw = original;
    }
  });
});
