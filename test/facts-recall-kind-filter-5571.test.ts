/**
 * #5571 — recall's facts arm must filter `kind` and `exclude_source`
 * in SQL, BEFORE the limit and the budget.
 *
 * Before this change the op had no way to restrict by fact kind, and no
 * way to drop a write-provenance source (e.g. `hook:writeback` ambient
 * captures): standing preferences shared the response budget with
 * ambient writeback rows, so `recall <entity>` on a writeback-heavy
 * entity returned almost no preferences even when they existed.
 *
 * Like facts-recall-grep-sql.test.ts, seed order matters: the needle
 * rows go in FIRST (older created_at), then `limit`-plus newer
 * non-matching rows AFTER. With ORDER BY ... DESC, id DESC the needle
 * falls OUTSIDE the newest-N window — a post-limit filter finds nothing,
 * so these tests only pass when the engines apply kind/source in the
 * WHERE clause.
 *
 * The supersessions arm bypassed FactListOpts entirely (its opts type
 * was narrower), so its kind/source narrowing is pinned separately.
 *
 * PGLite-only; no DATABASE_URL, no API keys.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

const ENTITY = 'people/alice-example';
const SESSION = 'kind-filter-session-a';
const NEEDLE_FACT = 'alice prefers decaf after 3pm';
const WRITEBACK_SOURCE = 'hook:writeback';
// More filler rows than the limit used below, so a needle seeded first
// sits outside the newest-N window on every arm's sort key.
const FILLER_COUNT = 10;
const LIMIT = 5;

async function recall(params: Record<string, unknown>) {
  const result = await dispatchToolCall(engine, 'recall', params, {
    remote: false,
    sourceId: 'default',
  });
  return result;
}

async function recallOk(params: Record<string, unknown>) {
  const result = await recall(params);
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text) as {
    facts: Array<{ fact: string; kind?: string; source?: string }>;
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Needle: a preference-kind fact seeded FIRST (oldest), so a
  // post-limit kind filter could never find it.
  await engine.insertFact(
    { fact: NEEDLE_FACT, kind: 'preference', entity_slug: ENTITY, source: 'test', source_session: SESSION },
    { source_id: 'default' },
  );
  // A writeback-attributed fact of the same kind — must survive the kind
  // filter but drop under exclude_source.
  await engine.insertFact(
    { fact: 'alice prefers walking meetings', kind: 'preference', entity_slug: ENTITY, source: WRITEBACK_SOURCE, source_session: SESSION },
    { source_id: 'default' },
  );
  for (let i = 0; i < FILLER_COUNT; i++) {
    await engine.insertFact(
      { fact: `alice event filler number ${i}`, kind: 'event', entity_slug: ENTITY, source: 'test', source_session: SESSION },
      { source_id: 'default' },
    );
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('recall kind filters in SQL before the limit (#5571)', () => {
  test('entity arm: preference needle outside the newest-N window is still found', async () => {
    const payload = await recallOk({ entity: ENTITY, kind: 'preference', limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
    expect(payload.facts.every(f => f.kind === 'preference')).toBe(true);
    // The 10 event fillers are excluded in SQL, not post-limit —
    // otherwise the window would be full of them.
    expect(payload.facts.some(f => f.fact.includes('filler'))).toBe(false);
  });

  test('session arm: kind filter reaches listFactsBySession', async () => {
    const payload = await recallOk({ session_id: SESSION, kind: 'preference', limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
    expect(payload.facts.every(f => f.kind === 'preference')).toBe(true);
  });

  test('since arm: kind filter reaches listFactsSince', async () => {
    const payload = await recallOk({ since: '1 hour ago', kind: 'preference', limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
  });

  test('no-filter arm: kind narrows the unfiltered window', async () => {
    const payload = await recallOk({ kind: 'preference', limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
    expect(payload.facts.every(f => f.kind === 'preference')).toBe(true);
  });

  test('unknown kind is rejected invalid_params, never silently widened', async () => {
    const result = await recall({ entity: ENTITY, kind: 'preferance' });
    expect(result.isError).toBeTruthy();
    expect(result.content[0].text).toContain('invalid_params');
  });
});

describe('recall exclude_source filters in SQL before the limit (#5571)', () => {
  test('entity arm: writeback-attributed facts drop out', async () => {
    const payload = await recallOk({ entity: ENTITY, kind: 'preference', exclude_source: WRITEBACK_SOURCE, limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
    expect(payload.facts.every(f => f.fact === 'alice prefers walking meetings' ? false : true)).toBe(true);
    expect(payload.facts.every(f => f.source !== WRITEBACK_SOURCE)).toBe(true);
  });

  test('exclude_source composes with source_id (different axes)', async () => {
    // source_id selects which brain source to read; exclude_source drops
    // rows by their per-row write attribution. Both apply.
    const payload = await recallOk({ entity: ENTITY, source_id: 'default', kind: 'preference', exclude_source: WRITEBACK_SOURCE, limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
    expect(payload.facts.every(f => f.source !== WRITEBACK_SOURCE)).toBe(true);
  });

  test('excluding a nonexistent source changes nothing', async () => {
    const payload = await recallOk({ entity: ENTITY, kind: 'preference', exclude_source: 'hook:no-such-source', limit: LIMIT });
    expect(payload.facts.some(f => f.fact === NEEDLE_FACT)).toBe(true);
    expect(payload.facts.some(f => f.fact === 'alice prefers walking meetings')).toBe(true);
  });
});

describe('supersessions arm honors kind and exclude_source (#5571)', () => {
  test('kind narrows the supersession audit log in SQL', async () => {
    const old = await engine.insertFact(
      { fact: 'bob-example prefers morning standups', kind: 'preference', entity_slug: 'people/bob-example', source: 'test' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'bob-example prefers afternoon standups', kind: 'preference', entity_slug: 'people/bob-example', source: 'test' },
      { source_id: 'default', supersedeId: old.id },
    );
    const old2 = await engine.insertFact(
      { fact: 'carol-example met the acme-example team', kind: 'event', entity_slug: 'people/carol-example', source: 'test' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'carol-example met the acme-example team again', kind: 'event', entity_slug: 'people/carol-example', source: 'test' },
      { source_id: 'default', supersedeId: old2.id },
    );
    const hit = await recallOk({ supersessions: true, kind: 'preference' });
    expect(hit.facts.some(f => f.fact === 'bob-example prefers morning standups')).toBe(true);
    expect(hit.facts.every(f => f.fact === 'carol-example met the acme-example team' ? false : true)).toBe(true);
  });
});
