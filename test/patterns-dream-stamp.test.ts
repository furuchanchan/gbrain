/**
 * Dream patterns phase stamps `dream_generated` on its pages (#5733)
 *
 * Pages written by the patterns phase carried no dream-output identity
 * marker (synthesize's post-step stamps it; patterns published through
 * child `brain_put_page` calls only), so transcript-discovery's
 * self-consumption guard, source-boost demotion, and the
 * extract-atoms/salience `dream_generated` filters all treated pattern
 * pages as user-authored content. Validates the post-publish stamp:
 *   - A page the patterns child wrote gains `dream_generated: true` plus
 *     both cycle-date markers set to the cycle date.
 *   - An existing stamp's first date is preserved (idempotent re-runs).
 *   - Soft-deleted and unlisted pages are untouched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { __testing } from '../src/core/cycle/patterns.ts';

const { stampPatternPagesDreamGenerated } = __testing;

describe('patterns dream_generated stamp (#5733)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  async function insertPage(slug: string, frontmatter: Record<string, unknown> = {}, deleted = false): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, frontmatter, deleted_at)
       VALUES ('default', $1, 'pattern', $1, $2::text::jsonb, $3)`,
      [slug, JSON.stringify(frontmatter), deleted ? '2026-01-01' : null],
    );
  }

  async function readFrontmatter(slug: string): Promise<Record<string, unknown>> {
    const [row] = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
      `SELECT frontmatter FROM pages WHERE slug = $1 AND source_id = 'default'`,
      [slug],
    );
    return row!.frontmatter;
  }

  test('stamps dream_generated and both cycle dates on a written page', async () => {
    await insertPage('wiki/personal/patterns/morning-routine');
    await stampPatternPagesDreamGenerated(
      engine,
      [{ slug: 'wiki/personal/patterns/morning-routine', source_id: 'default' }],
      '2026-09-30',
    );
    const fm = await readFrontmatter('wiki/personal/patterns/morning-routine');
    expect(fm.dream_generated).toBe(true);
    expect(fm.dream_cycle_date).toBe('2026-09-30');
    expect(fm.dream_created_cycle_date).toBe('2026-09-30');
  });

  test('preserves the first stamp date on re-run (idempotent)', async () => {
    await insertPage('wiki/personal/patterns/old-pattern', {
      dream_generated: true,
      dream_cycle_date: '2026-08-01',
      dream_created_cycle_date: '2026-08-01',
    });
    await stampPatternPagesDreamGenerated(
      engine,
      [{ slug: 'wiki/personal/patterns/old-pattern', source_id: 'default' }],
      '2026-09-30',
    );
    const fm = await readFrontmatter('wiki/personal/patterns/old-pattern');
    expect(fm.dream_cycle_date).toBe('2026-08-01');
    expect(fm.dream_created_cycle_date).toBe('2026-08-01');
  });

  test('soft-deleted and unlisted pages are untouched', async () => {
    await insertPage('wiki/personal/patterns/deleted-one', {}, true);
    await insertPage('notes/user-authored');
    await stampPatternPagesDreamGenerated(
      engine,
      [{ slug: 'wiki/personal/patterns/deleted-one', source_id: 'default' }],
      '2026-09-30',
    );
    expect((await readFrontmatter('wiki/personal/patterns/deleted-one')).dream_generated).toBeUndefined();
    expect((await readFrontmatter('notes/user-authored')).dream_generated).toBeUndefined();
  });

  test('other frontmatter keys survive the stamp', async () => {
    await insertPage('wiki/personal/patterns/keep-keys', { type: 'pattern', confidence: 'high' });
    await stampPatternPagesDreamGenerated(
      engine,
      [{ slug: 'wiki/personal/patterns/keep-keys', source_id: 'default' }],
      '2026-09-30',
    );
    const fm = await readFrontmatter('wiki/personal/patterns/keep-keys');
    expect(fm.confidence).toBe('high');
    expect(fm.dream_generated).toBe(true);
  });
});
