/**
 * Issue #5828 — brain_score's 15-point timeline component grades only pages
 * whose type's schema-pack primitive is `entity` or `temporal`.
 *
 * Pre-fix the denominator was every linkable page, so a document-heavy
 * brain (notes, writing, guides — types that describe no event and cannot
 * honestly earn a timeline row) read 4/15 with no honest fix. Now
 * document-primitive types drop out of BOTH numerator and denominator;
 * types the active pack does not declare keep the historical graded
 * behaviour; zero graded pages still gets full marks (vacuous truth).
 *
 * The orphan/link components and the entity-scoped `timeline_coverage`
 * metric keep their existing scopes — asserted alongside.
 *
 * GBRAIN_HOME is isolated per test so pack resolution is deterministic
 * (bundled gbrain-base: entity = person/company/…, temporal =
 * meeting/email/…, documents = note/concept/project/writing/…).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';
import { timelineScoreScopeFromPack, isTimelineScoreGraded } from '../src/core/schema-pack/timeline-scope.ts';

let engine: PGLiteEngine;
let packHome = '';

async function getHealthScoped() {
  return withEnv({ GBRAIN_HOME: packHome, GBRAIN_SCHEMA_PACK: undefined }, () => engine.getHealth());
}

async function put(slug: string, type: string): Promise<void> {
  await engine.putPage(slug, { type, title: slug, compiled_truth: `body of ${slug}`, frontmatter: {} });
}

async function withTimeline(slug: string, type: string): Promise<void> {
  await put(slug, type);
  await engine.addTimelineEntry(slug, { date: '2025-01-01', source: 'test', summary: `event on ${slug}` });
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

describe('#5828 — timelineScoreScopeFromPack', () => {
  test('entity + temporal types grade; media/concept/annotation do not; undeclared keeps graded', () => {
    const pt = (name: string, primitive: string) => ({ name, primitive }) as never;
    const scope = timelineScoreScopeFromPack({
      page_types: [
        pt('person', 'entity'),
        pt('meeting', 'temporal'),
        pt('note', 'concept'),
        pt('guide', 'media'),
        pt('synthesis', 'annotation'),
      ],
    });
    expect(isTimelineScoreGraded('person', scope)).toBe(true);
    expect(isTimelineScoreGraded('meeting', scope)).toBe(true);
    expect(isTimelineScoreGraded('note', scope)).toBe(false);
    expect(isTimelineScoreGraded('guide', scope)).toBe(false);
    expect(isTimelineScoreGraded('synthesis', scope)).toBe(false);
    // Undeclared types keep the historical graded behaviour.
    expect(isTimelineScoreGraded('research', scope)).toBe(true);
    expect(isTimelineScoreGraded('zzz-undeclared', scope)).toBe(true);
  });
});

describe('#5828 — getHealth timeline component', () => {
  test('the reporter case: document-heavy brain no longer dilutes the component', async () => {
    // 10 temporal pages all carrying a row + 20 concept documents without —
    // pre-fix denominator 30 → 5/15; graded denominator 10 → 15/15.
    for (let i = 0; i < 10; i++) await withTimeline(`meetings/m-${i}`, 'meeting');
    for (let i = 0; i < 20; i++) await put(`notes/n-${i}`, 'note');
    const h = await getHealthScoped();
    expect(h.timeline_coverage_score).toBe(15);
  });

  test('documents without rows still cannot hide a graded gap', async () => {
    // 1 covered meeting + 1 uncovered meeting → 1/2 graded → 8/15.
    await withTimeline('meetings/covered', 'meeting');
    await put('meetings/uncovered', 'meeting');
    for (let i = 0; i < 8; i++) await put(`notes/n-${i}`, 'note');
    const h = await getHealthScoped();
    expect(h.timeline_coverage_score).toBe(8);
  });

  test('undeclared types stay graded', async () => {
    // 'zzz-undeclared' is not in gbrain-base — it keeps the historical
    // behaviour and dilutes: 1 covered / (1 meeting + 1 undeclared) → 8/15.
    await withTimeline('meetings/m', 'meeting');
    await put('custom/x', 'zzz-undeclared');
    const h = await getHealthScoped();
    expect(h.timeline_coverage_score).toBe(8);
  });

  test('all-document brain gets the vacuous full marks', async () => {
    await put('notes/a', 'note');
    await put('guides/b', 'guide');
    const h = await getHealthScoped();
    expect(h.timeline_coverage_score).toBe(15);
  });

  test('orphan and entity metrics keep their own scopes', async () => {
    // The notes are still islanded linkable pages: they keep counting for
    // the orphan component even though the timeline component ignores them.
    await withTimeline('people/alice-example', 'person');
    for (let i = 0; i < 4; i++) await put(`notes/n-${i}`, 'note');
    const h = await getHealthScoped();
    expect(h.timeline_coverage_score).toBe(15); // 1/1 graded
    expect(h.linkable_page_count).toBe(5);      // linkable scope unchanged
    expect(h.no_orphans_score).toBe(0);         // 5/5 islanded — notes still count
  });
});
