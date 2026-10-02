/**
 * #5857 — operator opt-in `search.remote_private_facts` widens private-fact
 * reads for remote callers (the facts counterpart of #4352's
 * `search.remote_private_pages`).
 *
 * Legacy brains hold `visibility: private` rows — in the facts table and
 * inside stored `## Facts` fences — that remote agents can never read and
 * operators have no bulk re-tag path for. Pins:
 *   - resolveExposePrivateFacts: trust rules + config gate + env hatch +
 *     fail-closed config reads (a failed read means "not opted in")
 *   - sanitizeRemoteBody: `keepPrivateFacts` retains private fence rows;
 *     withdrawn rows still go (a separate gate)
 *   - recall (facts arm), get_page fence bodies, and the entity card's
 *     facts columns all widen under the opt-in — and stay closed without it
 *   - context_pack's `include_private` still requires the per-call flag:
 *     the opt-in only removes the remote refusal
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  resolveExposePrivateFacts,
  __resetFactsExposeCacheForTests,
  REMOTE_PRIVATE_FACTS_KEY,
} from '../src/core/facts/visibility.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';

let engine: PGLiteEngine;

const FACTS_BODY = (world: string, priv: string) =>
  renderFactsTable([
    { rowNum: 1, claim: world, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    { rowNum: 2, claim: priv, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
  ]);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Facts-table rows for the recall/entity-card arms.
  await engine.insertFact({ fact: 'WORLD_FACT_5857 public claim', visibility: 'world', source: 'test', entity_slug: 'notes/fact-entity' }, { source_id: 'default' });
  await engine.insertFact({ fact: 'PRIVATE_FACT_5857 legacy claim', visibility: 'private', source: 'test', entity_slug: 'notes/fact-entity' }, { source_id: 'default' });
  // A world page carrying a mixed-visibility fence for the page-body arm.
  const fencePage = serializeMarkdown({ visibility: 'world' },
    `Ordinary body.\n\n${FACTS_BODY('FENCE_WORLD_5857', 'FENCE_PRIVATE_5857')}\n`,
    '', { type: 'concept', title: 'Fence Carrier 5857', tags: [] });
  expect((await importFromContent(engine, 'notes/fence-page', fencePage, { noEmbed: true, forceRechunk: true })).status).toBe('imported');
  // Entity page the private/world facts attach to.
  const entityPage = serializeMarkdown({}, 'entity body', '', { type: 'concept', title: 'Fact Entity 5857', tags: [] });
  expect((await importFromContent(engine, 'notes/fact-entity', entityPage, { noEmbed: true, forceRechunk: true })).status).toBe('imported');
});

afterAll(async () => {
  await engine.disconnect();
});

function mkCtx(remote: boolean) {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote,
    sourceId: 'default',
  } as never;
}

describe('resolveExposePrivateFacts (#5857)', () => {
  test('trusted local callers always expose; remote defaults closed', async () => {
    __resetFactsExposeCacheForTests();
    expect(await resolveExposePrivateFacts(engine, false)).toBe(true);
    expect(await resolveExposePrivateFacts(engine, true)).toBe(false);
    // Fail-closed: anything not strictly false is untrusted.
    expect(await resolveExposePrivateFacts(engine, undefined)).toBe(false);
  });

  test('config opt-in widens remote; clearing re-closes', async () => {
    for (const v of ['visible', 'true', '1']) {
      await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, v);
      __resetFactsExposeCacheForTests();
      expect(await resolveExposePrivateFacts(engine, true)).toBe(true);
    }
    await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, 'nonsense');
    __resetFactsExposeCacheForTests();
    expect(await resolveExposePrivateFacts(engine, true)).toBe(false);
    await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, '');
    __resetFactsExposeCacheForTests();
    expect(await resolveExposePrivateFacts(engine, true)).toBe(false);
  });

  test('GBRAIN_REMOTE_PRIVATE_FACTS=1 env escape hatch widens remote reads', async () => {
    __resetFactsExposeCacheForTests();
    await withEnv({ GBRAIN_REMOTE_PRIVATE_FACTS: '1' }, async () => {
      expect(await resolveExposePrivateFacts(engine, true)).toBe(true);
    });
  });
});

describe('sanitizeRemoteBody keepPrivateFacts (#5857)', () => {
  test('opt keeps private fence rows; default strips them; withdrawn still go', () => {
    const body = `before\n${FACTS_BODY('FENCE_WORLD_X', 'FENCE_PRIVATE_X')}\nafter`;
    const strict = sanitizeRemoteBody(body);
    expect(strict).toContain('FENCE_WORLD_X');
    expect(strict).not.toContain('FENCE_PRIVATE_X');
    const kept = sanitizeRemoteBody(body, { keepPrivateFacts: true });
    expect(kept).toContain('FENCE_WORLD_X');
    expect(kept).toContain('FENCE_PRIVATE_X');
    // includeWithdrawn is a separate gate — forgotten rows still strip.
    const forgotten = renderFactsTable([
      { rowNum: 1, claim: 'GONE_PRIVATE_X', kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: false, forgotten: true, context: 'forgotten: test' },
    ]);
    expect(sanitizeRemoteBody(forgotten, { keepPrivateFacts: true })).not.toContain('GONE_PRIVATE_X');
  });
});

describe('remote reads widen under the opt-in (#5857)', () => {
  test('recall facts arm: remote hides private by default, opt-in exposes', async () => {
    __resetFactsExposeCacheForTests();
    const op = operationsByName['recall'];
    const remoteOut = (await op.handler(mkCtx(true), {})) as { facts: Array<{ fact: string }> };
    const remoteTexts = remoteOut.facts.map((r) => r.fact);
    expect(remoteTexts).toContain('WORLD_FACT_5857 public claim');
    expect(remoteTexts).not.toContain('PRIVATE_FACT_5857 legacy claim');

    await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, 'visible');
    __resetFactsExposeCacheForTests();
    const widened = (await op.handler(mkCtx(true), {})) as { facts: Array<{ fact: string }> };
    expect(widened.facts.map((r) => r.fact)).toContain('PRIVATE_FACT_5857 legacy claim');
    await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, '');
    __resetFactsExposeCacheForTests();

    const localOut = (await op.handler(mkCtx(false), {})) as { facts: Array<{ fact: string }> };
    expect(localOut.facts.map((r) => r.fact)).toContain('PRIVATE_FACT_5857 legacy claim');
  });

  test('get_page: remote strips private fence rows by default, opt-in keeps them', async () => {
    __resetFactsExposeCacheForTests();
    const op = operationsByName['get_page'];
    const remote = (await op.handler(mkCtx(true), { slug: 'notes/fence-page' })) as { compiled_truth: string };
    expect(remote.compiled_truth).toContain('FENCE_WORLD_5857');
    expect(remote.compiled_truth).not.toContain('FENCE_PRIVATE_5857');

    await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, 'visible');
    __resetFactsExposeCacheForTests();
    const widened = (await op.handler(mkCtx(true), { slug: 'notes/fence-page' })) as { compiled_truth: string };
    expect(widened.compiled_truth).toContain('FENCE_PRIVATE_5857');
    await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, '');
    __resetFactsExposeCacheForTests();

    const local = (await op.handler(mkCtx(false), { slug: 'notes/fence-page' })) as { compiled_truth: string };
    expect(local.compiled_truth).toContain('FENCE_PRIVATE_5857');
  });

  test('entity card: remote counts world facts only until the opt-in', async () => {
    __resetFactsExposeCacheForTests();
    const remoteRes = await buildEntityCard(engine, 'default', 'notes/fact-entity', { remote: true });
    expect(remoteRes.found).toBe(true);
    expect(remoteRes.card?.active_fact_count).toBe(1);

    await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, 'visible');
    __resetFactsExposeCacheForTests();
    const widened = await buildEntityCard(engine, 'default', 'notes/fact-entity', { remote: true });
    expect(widened.card?.active_fact_count).toBe(2);
    await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, '');
    __resetFactsExposeCacheForTests();

    const localRes = await buildEntityCard(engine, 'default', 'notes/fact-entity', { remote: false });
    expect(localRes.card?.active_fact_count).toBe(2);
  });

  test('delta: include_private still needs its per-call flag under the opt-in', async () => {
    __resetFactsExposeCacheForTests();
    const op = operationsByName['delta'];
    const since = '2020-01-01T00:00:00Z';
    // Without the opt-in, a remote include_private request stays world-only.
    const denied = (await op.handler(mkCtx(true), { since, include_private: true })) as { facts: Array<{ fact: string }> };
    expect(denied.facts.map((f) => f.fact)).not.toContain('PRIVATE_FACT_5857 legacy claim');
    // With the opt-in the per-call flag widens; without the flag it does not.
    await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, 'visible');
    __resetFactsExposeCacheForTests();
    const widened = (await op.handler(mkCtx(true), { since, include_private: true })) as { facts: Array<{ fact: string }> };
    expect(widened.facts.map((f) => f.fact)).toContain('PRIVATE_FACT_5857 legacy claim');
    const unflagged = (await op.handler(mkCtx(true), { since })) as { facts: Array<{ fact: string }> };
    expect(unflagged.facts.map((f) => f.fact)).not.toContain('PRIVATE_FACT_5857 legacy claim');
    await engine.setConfig(REMOTE_PRIVATE_FACTS_KEY, '');
    __resetFactsExposeCacheForTests();
  });
});
