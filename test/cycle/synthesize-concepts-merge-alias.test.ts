// #6161 — synthesize_concepts resolves merged-away concept names.
//
// The concept-synthesis skill's Phase 1 merge leaves markers instead of
// retagging member atoms: the canonical page's frontmatter `aliases`, and a
// `merged_into` pointer on the `_merged/` archive copy (and on the absorbed
// page's tombstone while it lasts). Atoms still tagged with the absorbed
// name must group under the canonical stem — otherwise `concepts/concept-b`
// re-forms, defers on the stale tombstone revision, and comes back after
// the purge. A live unabsorbed page always keeps its own stem.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const atom = (slug: string, ref: string) => ({ slug, title: slug, body: `body ${slug}`, concept_refs: [ref] });

async function putConcept(slug: string, frontmatter: Record<string, unknown>): Promise<void> {
  await engine.putPage(slug, {
    type: 'concept',
    title: slug,
    compiled_truth: `${slug} narrative.`,
    timeline: '',
    frontmatter: { synthesized_by: 'synthesize_concepts-v0.41', ...frontmatter },
  });
}

describe('synthesize_concepts merge-alias resolution (#6161)', () => {
  test('atoms tagged with an absorbed name group under the canonical via its aliases', async () => {
    await putConcept('concepts/concept-a', { aliases: ['concept-b'] });
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: [atom('atoms/a1', 'concept-b'), atom('atoms/a2', 'concept-b')],
      sourceId: 'default',
    });
    const canonical = await engine.getPage('concepts/concept-a', { sourceId: 'default' });
    expect(canonical?.frontmatter.mention_count).toBe(2);
    expect(await engine.getPage('concepts/concept-b', { sourceId: 'default' })).toBeNull();
    expect(result.details?.concepts_written).toBe(1);
  });

  test('a merged_into marker on the _merged archive copy resolves the absorbed stem', async () => {
    await putConcept('concepts/_merged/march/concept-b', { merged_into: 'concepts/concept-a' });
    await putConcept('concepts/concept-a', {});
    await runPhaseSynthesizeConcepts(engine, {
      _atoms: [atom('atoms/a1', 'concept-b'), atom('atoms/a2', 'concept-b')],
      sourceId: 'default',
    });
    expect((await engine.getPage('concepts/concept-a', { sourceId: 'default' }))?.frontmatter.mention_count).toBe(2);
    expect(await engine.getPage('concepts/concept-b', { sourceId: 'default' })).toBeNull();
  });

  test('merged_into on the absorbed page\'s tombstone resolves until purge', async () => {
    await putConcept('concepts/concept-b', { merged_into: 'concepts/concept-a' });
    await engine.softDeletePage('concepts/concept-b', { sourceId: 'default' });
    await putConcept('concepts/concept-a', {});
    await runPhaseSynthesizeConcepts(engine, {
      _atoms: [atom('atoms/a1', 'concept-b'), atom('atoms/a2', 'concept-b')],
      sourceId: 'default',
    });
    expect((await engine.getPage('concepts/concept-a', { sourceId: 'default' }))?.frontmatter.mention_count).toBe(2);
    const absorbed = await engine.getPage('concepts/concept-b', { sourceId: 'default' });
    expect(absorbed).toBeNull();
  });

  test('a live unabsorbed page keeps its own stem even when listed as another page\'s alias', async () => {
    await putConcept('concepts/concept-a', { aliases: ['concept-b'] });
    await putConcept('concepts/concept-b', {});
    await runPhaseSynthesizeConcepts(engine, {
      _atoms: [atom('atoms/a1', 'concept-b'), atom('atoms/a2', 'concept-b')],
      sourceId: 'default',
    });
    expect((await engine.getPage('concepts/concept-b', { sourceId: 'default' }))?.frontmatter.mention_count).toBe(2);
    expect((await engine.getPage('concepts/concept-a', { sourceId: 'default' }))?.frontmatter.mention_count).toBeUndefined();
  });

  test('merge chains collapse to the final live stem', async () => {
    // concept-b was aliased into concept-a, and concept-a was later merged
    // into concept-c (archive copy carries merged_into).
    await putConcept('concepts/concept-a', { aliases: ['concept-b'] });
    await putConcept('concepts/_merged/may/concept-a', { merged_into: 'concepts/concept-c' });
    await putConcept('concepts/concept-c', {});
    await runPhaseSynthesizeConcepts(engine, {
      _atoms: [atom('atoms/a1', 'concept-b'), atom('atoms/a2', 'concept-b')],
      sourceId: 'default',
    });
    expect((await engine.getPage('concepts/concept-c', { sourceId: 'default' }))?.frontmatter.mention_count).toBe(2);
    expect(await engine.getPage('concepts/concept-b', { sourceId: 'default' })).toBeNull();
  });
});
