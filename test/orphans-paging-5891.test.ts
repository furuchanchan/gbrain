/**
 * #5891 — find_orphans paging + per-row source provenance.
 *
 * Pre-fix the op returned EVERY orphan in one response: no limit/offset, no
 * source filter param, and no source_id on the rows — a megabyte-scale
 * single answer on a multi-source brain (reported: 2.3 MB on a 23k-page
 * brain). Pins:
 *
 *   - rows carry source_id (+ type) so an agent can route remediation
 *     without a second lookup;
 *   - findOrphans accepts limit/offset — applied AFTER exclusion filtering,
 *     total_orphans still reports the full filtered count;
 *   - the op defaults to a bounded page (200, max 1000) and accepts an
 *     explicit source_id that NARROWS the caller's grant — denied or dead
 *     sources fail loudly, never widen.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { findOrphans } from '../src/commands/orphans.ts';

let engine: PGLiteEngine;

const page = (title: string) => ({
  type: 'person' as const,
  title,
  compiled_truth: `${title} body.`,
  timeline: '',
  frontmatter: {},
});

const remoteCtx = (extra: Record<string, unknown> = {}) => ({
  engine,
  config: { engine: 'pglite' as const },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  dryRun: false,
  remote: true,
  ...extra,
});

const opHandler = async () => {
  const { operations } = await import('../src/core/operations.ts');
  const op = operations.find(o => o.name === 'find_orphans');
  expect(op).toBeDefined();
  return op!.handler;
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('src-b', 'src-b', '{}'::jsonb) ON CONFLICT DO NOTHING`,
  );
  // Three orphans in default (inbound mode), one in src-b.
  await engine.putPage('people/orphan-a', page('Orphan A'), { sourceId: 'default' });
  await engine.putPage('people/orphan-b', page('Orphan B'), { sourceId: 'default' });
  await engine.putPage('people/orphan-c', page('Orphan C'), { sourceId: 'default' });
  await engine.putPage('people/orphan-z', page('Orphan Z'), { sourceId: 'src-b' });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('findOrphans — row provenance + paging (#5891)', () => {
  test('rows carry source_id and type', async () => {
    const data = await findOrphans(engine, { mode: 'inbound' });
    const bySlug = Object.fromEntries(data.orphans.map(o => [o.slug, o]));
    expect(bySlug['people/orphan-a'].source_id).toBe('default');
    expect(bySlug['people/orphan-z'].source_id).toBe('src-b');
    expect(bySlug['people/orphan-a'].type).toBe('person');
  });

  test('limit slices the page; total_orphans still reports the full filtered count', async () => {
    const all = await findOrphans(engine, { mode: 'inbound', sourceId: 'default' });
    expect(all.orphans.length).toBe(3);
    expect(all.total_orphans).toBe(3);

    const page1 = await findOrphans(engine, { mode: 'inbound', sourceId: 'default', limit: 2 });
    expect(page1.orphans.length).toBe(2);
    expect(page1.total_orphans).toBe(3);

    const page2 = await findOrphans(engine, { mode: 'inbound', sourceId: 'default', limit: 2, offset: 2 });
    expect(page2.orphans.length).toBe(1);
    expect(page2.total_orphans).toBe(3);
    // Pages are disjoint and cover the full set.
    expect([...page1.orphans, ...page2.orphans].map(o => o.slug).sort())
      .toEqual(all.orphans.map(o => o.slug).sort());
  });

  test('offset beyond the set returns an empty page, not an error', async () => {
    const data = await findOrphans(engine, { mode: 'inbound', sourceId: 'default', limit: 10, offset: 99 });
    expect(data.orphans).toEqual([]);
    expect(data.total_orphans).toBe(3);
  });
});

describe('find_orphans op — limit/offset/source_id params (#5891)', () => {
  test('limit + offset page the response', async () => {
    const handler = await opHandler();
    const r1 = (await handler(remoteCtx() as any, { mode: 'inbound', limit: 2 })) as { orphans: { slug: string }[]; total_orphans: number };
    expect(r1.orphans.length).toBe(2);
    expect(r1.total_orphans).toBe(4); // brain-wide: 3 default + 1 src-b
    const r2 = (await handler(remoteCtx() as any, { mode: 'inbound', limit: 2, offset: 2 })) as { orphans: { slug: string }[]; total_orphans: number };
    expect(r2.orphans.length).toBe(2);
    expect([...r1.orphans, ...r2.orphans].map(o => o.slug).sort())
      .toEqual(['people/orphan-a', 'people/orphan-b', 'people/orphan-c', 'people/orphan-z']);
  });

  test('explicit source_id narrows the read to that source', async () => {
    const handler = await opHandler();
    const ctx = remoteCtx({
      auth: {
        token: 'test',
        clientId: 'test',
        scopes: ['read'],
        sourceId: 'default',
        allowedSources: ['default', 'src-b'],
      },
    });
    const r = (await handler(ctx as any, { mode: 'inbound', source_id: 'src-b' })) as { orphans: { slug: string; source_id: string }[]; total_orphans: number };
    expect(r.orphans.map(o => o.slug)).toEqual(['people/orphan-z']);
    expect(r.orphans[0].source_id).toBe('src-b');
    expect(r.total_orphans).toBe(1);
  });

  test('an out-of-grant source_id fails closed (permission_denied), never widens', async () => {
    const handler = await opHandler();
    const ctx = remoteCtx({
      sourceId: 'default',
      auth: {
        token: 'test',
        clientId: 'test',
        scopes: ['read'],
        sourceId: 'default',
        allowedSources: ['default'],
      },
    });
    await expect(handler(ctx as any, { mode: 'inbound', source_id: 'src-b' }))
      .rejects.toThrow(/outside your granted sources/i);
  });

  test('a granted-but-dead source_id fails unknown_source, not an empty list', async () => {
    const handler = await opHandler();
    const ctx = remoteCtx({
      auth: {
        token: 'test',
        clientId: 'test',
        scopes: ['read'],
        sourceId: 'default',
        allowedSources: ['default', 'ghost-src'],
      },
    });
    await expect(handler(ctx as any, { mode: 'inbound', source_id: 'ghost-src' }))
      .rejects.toThrow(/ghost-src.*does not exist|unknown_source/i);
  });
});
