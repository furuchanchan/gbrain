/**
 * #6195 — lowercase multi-word references ("call alice example", "did alice
 * sample reply") used to extract only single-token weak candidates, which are
 * alias-restricted and could never reach a multi-word alias or title. The
 * n-gram pass emits bounded 2–3-word weak grams; they resolve through the
 * exact unique alias fold and, after an alias miss, a globally-unique
 * exact-title arm restricted to entity-typed pages.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { normalizeAlias } from '../src/core/search/alias-normalize.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import { extractCandidates } from '../src/core/context/entity-salience.ts';
import { disposeReflex } from '../src/core/context/reflex.ts';

let engine: PGLiteEngine;

async function seed(slug: string, title: string, body: string, source = 'default', frontmatter = '{}') {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter)
     VALUES ($1, $2, 'person', $3, $4, '', $5::jsonb)`,
    [slug, source, title, body, frontmatter],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  await disposeReflex();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM page_aliases').catch(() => {});
  await engine.executeRaw('DELETE FROM pages');
});

describe('#6195 lowercase multi-word references', () => {
  test('n-gram emission: "call alice example" emits the weak gram', () => {
    const cands = extractCandidates('call alice example when free');
    const weak = cands.filter((c) => c.weak).map((c) => normalizeAlias(c.query));
    expect(weak).toContain('alice example');
  });

  test('weak-title arm: lowercase full name resolves a person page by title', async () => {
    await seed('people/alice-example', 'Alice Example', 'A founder.');
    const block = await resolveEntitiesToPointers(
      engine, 'default', extractCandidates('call alice example when free'), {},
    );
    expect(block).not.toBeNull();
    expect(block!.pointers[0].slug).toBe('people/alice-example');
    expect(block!.pointers[0].arm).toBe('weak-title');
    expect(block!.pointers[0].confidence).toBeGreaterThanOrEqual(0.7);
  });

  test('registered multi-word alias still wins through the alias arm', async () => {
    await seed('people/alice-example', 'Alice Example', 'A founder.');
    await engine.setPageAliases('people/alice-example', 'default', [normalizeAlias('alice sample')]);
    const block = await resolveEntitiesToPointers(
      engine, 'default', extractCandidates('did alice sample reply'), {},
    );
    expect(block).not.toBeNull();
    expect(block!.pointers[0].arm).toBe('alias');
  });

  test('single lowercase word still cannot resolve a bare title (no alias)', async () => {
    await seed('people/saoirse-x', 'Saoirse', 'A founder.');
    const block = await resolveEntitiesToPointers(
      engine, 'default', extractCandidates('what did saoirse say'), {},
    );
    expect(block).toBeNull();
  });

  test('ambiguous multi-word title across sources injects nothing', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT DO NOTHING`, []).catch(() => {});
    await seed('people/alice-example', 'Alice Example', 'A founder.');
    await seed('people/alice-example-2', 'Alice Example', 'Another founder.', 'other');
    const block = await resolveEntitiesToPointers(
      engine, 'default', extractCandidates('call alice example when free'), { sourceIds: ['default', 'other'] },
    );
    expect(block).toBeNull();
  });

  test('a private page is invisible to the weak-title arm', async () => {
    await seed('people/alice-example', 'Alice Example', 'A founder.', 'default', '{"visibility":"private"}');
    const block = await resolveEntitiesToPointers(
      engine, 'default', extractCandidates('call alice example when free'), {},
    );
    expect(block).toBeNull();
  });

  test('non-entity page type cannot resolve by weak title', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('notes/the-standup', 'default', 'note', 'the standup', 'notes', '')`,
      [],
    );
    const block = await resolveEntitiesToPointers(
      engine, 'default', extractCandidates('notes from the standup'), {},
    );
    expect(block?.pointers.some((p) => p.arm === 'weak-title') ?? false).toBe(false);
  });

  test('punctuation breaks the run: "alice, example" emits no such gram', () => {
    const cands = extractCandidates('ping alice, example follows');
    const weak = cands.filter((c) => c.weak).map((c) => normalizeAlias(c.query));
    expect(weak).not.toContain('alice example');
  });

  test('kill switch: lexicalArms=false reproduces pre-fix resolution', async () => {
    await seed('people/alice-example', 'Alice Example', 'A founder.');
    const block = await resolveEntitiesToPointers(
      engine, 'default', extractCandidates('call alice example when free'), { lexicalArms: false },
    );
    expect(block).toBeNull();
  });
});
