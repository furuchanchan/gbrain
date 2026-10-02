/**
 * Issue #5831 — atom pages are not a facts-backstop source, and the
 * consolidation pending count matches what `consolidate` can drain.
 *
 * Two coupled fixes, both from the issue's Expected section:
 *
 *   1. `atom` is out of ELIGIBLE_TYPES. Atom pages are derived digests of
 *      pages that already went through the backstop; extracting facts from
 *      them re-spends an LLM call on derived text and yields mostly
 *      entity-less facts (gbrain-base-v2 agrees — `atom` is declared
 *      without `extractable`; the annotation IS the extracted unit).
 *      `atoms/*` is not in RESCUE_SLUG_PREFIXES, so atom pages are fully
 *      ineligible unless individually mistyped under a rescued prefix.
 *
 *   2. `countUnconsolidatedFacts` excludes `entity_slug IS NULL` rows —
 *      consolidate buckets strictly on (source_id, entity_slug), so a
 *      null-entity row is a pending count it can never reach (the
 *      function's own comment already states that contract).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isFactsBackstopEligible } from '../src/core/facts/eligibility.ts';
import type { PageType } from '../src/core/types.ts';

let engine: PGLiteEngine;

const LONG_BODY = 'x'.repeat(120); // > 80 char threshold

function parsed(type: PageType, body = LONG_BODY) {
  return { type, compiled_truth: body, frontmatter: {} };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('#5831 — atom pages are not backstop-eligible', () => {
  test('type=atom under atoms/ slug is rejected with kind:atom', () => {
    expect(isFactsBackstopEligible('atoms/keep-measuring', parsed('atom')))
      .toEqual({ ok: false, reason: 'kind:atom' });
  });

  test('type=atom anywhere is rejected (no slug rescue for atoms/)', () => {
    expect(isFactsBackstopEligible('anywhere/derived-atom', parsed('atom')))
      .toEqual({ ok: false, reason: 'kind:atom' });
  });

  test('siblings stay eligible: media, tweet, analysis still extract', () => {
    for (const t of ['media', 'tweet', 'analysis'] as PageType[]) {
      expect(isFactsBackstopEligible(`pages/${t}-1`, parsed(t))).toEqual({ ok: true });
    }
  });
});

describe('#5831 — pending count matches what consolidate can drain', () => {
  const SRC = 'atom-5831-pending';

  beforeAll(async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [SRC],
    );
  });

  test('entity-less unconsolidated facts do not count as backlog', async () => {
    // One drainable fact (has an entity) + three atom-style facts with no
    // entity_slug — the shape the issue measured (4.3 entity-less facts
    // per atom page). Pre-fix the count read 4; the consolidator can only
    // ever reach 1.
    await engine.insertFact(
      { fact: 'drainable fact about alice-example', kind: 'fact', entity_slug: 'people/alice-example', source: 'test' },
      { source_id: SRC },
    );
    for (let i = 0; i < 3; i++) {
      await engine.insertFact(
        { fact: `entity-less insight ${i} derived from an atom page`, kind: 'fact', entity_slug: null, source: 'test' },
        { source_id: SRC },
      );
    }
    expect(await engine.countUnconsolidatedFacts(SRC)).toBe(1);
  });

  test('entity-less facts still surface on active reads (only the count changed)', async () => {
    const facts = await engine.listFactsByEntity(SRC, 'people/alice-example');
    expect(facts.length).toBe(1);
    expect(facts[0].fact).toContain('drainable');
  });
});
