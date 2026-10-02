/**
 * #5883 — get_timeline same-date tie-breaker.
 *
 * Pre-fix the read was `ORDER BY te.date DESC LIMIT n` with no secondary
 * key, so which same-date row a limit kept — and in what order — was
 * planner-arbitrary (the reporter hit it on a company page with limit: 4).
 * The chronicle reads in the same file already tie-break on `te.id`; this
 * pins `te.date DESC, te.id DESC` on the main read.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await resetPgliteState(engine);
  await engine.putPage('companies/acme-example', {
    type: 'company' as const,
    title: 'Acme',
    compiled_truth: 'body.',
    timeline: '',
    frontmatter: {},
  });
  // Three entries share 2026-09-01; one is older. Insertion order pins the
  // id sequence: same-date rows must come back newest-id-first.
  await engine.addTimelineEntry('companies/acme-example', { date: '2026-09-01', source: 'test', summary: 'same-day first' });
  await engine.addTimelineEntry('companies/acme-example', { date: '2026-08-15', source: 'test', summary: 'older' });
  await engine.addTimelineEntry('companies/acme-example', { date: '2026-09-01', source: 'test', summary: 'same-day second' });
  await engine.addTimelineEntry('companies/acme-example', { date: '2026-09-01', source: 'test', summary: 'same-day third' });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('getTimeline — same-date deterministic order (#5883)', () => {
  test('same-date entries order by id DESC (newest insertion first)', async () => {
    const rows = await engine.getTimeline('companies/acme-example', {});
    const summaries = rows.map(r => r.summary);
    expect(summaries).toEqual(['same-day third', 'same-day second', 'same-day first', 'older']);
    // And the ids are strictly descending within the same-date group.
    const ids = rows.slice(0, 3).map(r => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  test('limit deterministically keeps the newest same-date entries', async () => {
    const rows = await engine.getTimeline('companies/acme-example', { limit: 2 });
    expect(rows.map(r => r.summary)).toEqual(['same-day third', 'same-day second']);
  });
});
