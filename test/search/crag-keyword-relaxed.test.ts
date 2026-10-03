/**
 * gbrain-evals A4-2, end to end on the keyword path (hermetic PGLite, no
 * embedding provider): a question about a company no page names only
 * reaches the OR-relaxed fallback, and CRAG must grade that weak instead of
 * moderate. A question the corpus answers strictly stays moderate.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { gradeRetrievalConfidence } from '../../src/core/search/crag.ts';
import type { SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  resetGateway();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, title, text] of [
    ['companies/talzarra-example', 'Talzarra Example', 'Talzarra Example headcount is 41 people. The company sells payroll software.'],
    ['companies/kelvane-example', 'Kelvane Example', 'Kelvane Example has 18 months of runway and is headquartered in a coastal city.'],
  ] as const) {
    await engine.putPage(slug, { type: 'company', title, compiled_truth: text, timeline: '' });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text }]);
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

describe('A4-2: CRAG on the keyword path', () => {
  test('a question about an unnamed company reaches only relaxed rows and grades weak', async () => {
    const results = await hybridSearch(engine, 'What is the headcount of Morvane Example?', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].keyword_relaxed).toBe(true);
    expect(gradeRetrievalConfidence(results)).toMatchObject({ level: 'weak', reason: 'keyword_relaxed_top' });
  });

  test('a question the corpus matches strictly is not graded by the relaxed rule', async () => {
    const results = await hybridSearch(engine, 'Talzarra headcount', { limit: 5 });
    expect(results[0]?.slug).toBe('companies/talzarra-example');
    expect(results[0].keyword_relaxed).toBeUndefined();
    expect(gradeRetrievalConfidence(results).reason).not.toBe('keyword_relaxed_top');
  });
});

describe('#5919: keyword_relaxed_rescued', () => {
  const relaxed = (text: string): SearchResult => ({
    slug: 's', title: 't', chunk_text: text, type: 'note', source_id: 'default',
    chunk_index: 0, chunk_id: 1, score: 1,
    keyword_relaxed: true, keyword_hit: true, evidence: 'weak_semantic',
  } as SearchResult);

  const query = 'Which city is Gavimar Example headquartered in?';
  const answerChunk = 'Gavimar Example is headquartered in Wendovia.';

  test('no queryText keeps the wave-7 weak grade', () => {
    const results = [relaxed(answerChunk)];
    expect(gradeRetrievalConfidence(results)).toMatchObject({ level: 'weak', reason: 'keyword_relaxed_top' });
  });

  test('a lower-ranked row covering entity + attribute words rescues to moderate', () => {
    const results = [
      relaxed('Some other company in the world.'),
      relaxed('A third unrelated page about payroll.'),
      relaxed(answerChunk),
    ];
    expect(gradeRetrievalConfidence(results, { queryText: query })).toMatchObject({
      level: 'moderate', reason: 'keyword_relaxed_rescued',
    });
  });

  test('the top row itself rescues when it carries the full coverage', () => {
    const results = [relaxed(answerChunk)];
    expect(gradeRetrievalConfidence(results, { queryText: query })).toMatchObject({
      level: 'moderate', reason: 'keyword_relaxed_rescued',
    });
  });

  test('an acronym bridge rescues a paraphrased attribute (annual recurring revenue -> ARR)', () => {
    const results = [
      relaxed('Filler row.'),
      relaxed('Quoravel Example reports $4.1M ARR.'),
    ];
    expect(gradeRetrievalConfidence(results, { queryText: 'What is the annual recurring revenue of Quoravel Example?' }))
      .toMatchObject({ level: 'moderate', reason: 'keyword_relaxed_rescued' });
  });

  test('the entity page without the asked attribute does not rescue', () => {
    // sibling_attribute shape: the entity's own page is in top five but lacks runway.
    const results = [
      relaxed('Jovox Robotics Example is a fictional company.'),
      relaxed('Karumbra Robotics Example has 30 months of runway.'),
      relaxed('Jovox Robotics Example was founded in March 1987.'),
    ];
    expect(gradeRetrievalConfidence(results, { queryText: 'How many months of runway does Jovox Robotics Example have?' }))
      .toMatchObject({ level: 'weak', reason: 'keyword_relaxed_top' });
  });

  test('absent entity stays weak — no row covers the entity tokens', () => {
    const results = [
      relaxed('Talzarra Example headcount is 41 people.'),
      relaxed('Kelvane Example has 18 months of runway.'),
    ];
    expect(gradeRetrievalConfidence(results, { queryText: 'What is the headcount of Morvane Example?' }))
      .toMatchObject({ level: 'weak', reason: 'keyword_relaxed_top' });
  });

  test('rescue is bounded to the top five', () => {
    const results = [
      relaxed('Filler.'),
      relaxed('Filler.'),
      relaxed('Filler.'),
      relaxed('Filler.'),
      relaxed('Filler.'),
      relaxed(answerChunk), // rank 6 — outside the rescue depth
    ];
    expect(gradeRetrievalConfidence(results, { queryText: query })).toMatchObject({
      level: 'weak', reason: 'keyword_relaxed_top',
    });
  });

  test('a question with no capitalized entity needs full attribute coverage', () => {
    const rescued = [relaxed('Filler.'), relaxed('Runway is 18 months at current burn.')];
    expect(gradeRetrievalConfidence(rescued, { queryText: 'what is the runway in months' }))
      .toMatchObject({ level: 'moderate', reason: 'keyword_relaxed_rescued' });
    const notRescued = [relaxed('Filler.'), relaxed('Runway is bounded.')];
    expect(gradeRetrievalConfidence(notRescued, { queryText: 'what is the runway in months' }))
      .toMatchObject({ level: 'weak', reason: 'keyword_relaxed_top' });
  });
});
