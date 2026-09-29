/**
 * #5709 — get_page returns `timeline: ""` for pages whose timeline lives in
 * the structured timeline_entries store; include_timeline surfaces it.
 *
 * Entries appended via add_timeline_entry / auto_timeline go only to
 * `timeline_entries` and never touch the `pages.timeline` column (which is
 * written only by markdown import/put_page's splitBody). So get_page reported
 * `timeline: ""` for a page get_timeline showed had entries, and no param
 * could include them. Post-fix:
 *   - include_timeline: true adds `timeline_entries` — same shape and
 *     untrusted-reader filtering as get_timeline — scoped to the resolved
 *     page's own source so a same-slug page in another granted source does
 *     not union its entries in.
 *   - Default false: get_page is the most-called read op; the field is a
 *     second store's payload most readers don't need.
 *
 * Hermetic in-memory PGLite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const getPage = operations.find((o) => o.name === 'get_page')!;

function localCtx(): OperationContext {
  return {
    engine,
    config: {} as GBrainConfig,
    logger: noopLogger,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as OperationContext;
}

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/example', {
    type: 'note',
    title: 'Example',
    compiled_truth: 'Body with no timeline sentinel.',
    timeline: '',
    source_id: 'default',
  } as never);
  await engine.addTimelineEntry('notes/example', { date: '2026-09-01', summary: 'First entry' }, { sourceId: 'default' });
  await engine.addTimelineEntry('notes/example', { date: '2026-09-15', summary: 'Second entry', source: 'meetings/x' }, { sourceId: 'default' });
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

describe('get_page include_timeline (#5709)', () => {
  test('default: timeline stays the (empty) markdown sentinel section; no timeline_entries key', async () => {
    const page = (await getPage.handler(localCtx(), { slug: 'notes/example' })) as Record<string, unknown>;
    expect(page.timeline).toBe('');
    expect('timeline_entries' in page).toBe(false);
  }, 30_000);

  test('include_timeline: true returns the structured entries in get_timeline shape', async () => {
    const page = (await getPage.handler(localCtx(), { slug: 'notes/example', include_timeline: true })) as Record<string, unknown>;
    const entries = page.timeline_entries as Array<{ date: string; summary: string; source?: string }>;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(2);
    // get_timeline orders date DESC.
    expect(entries[0].summary).toBe('Second entry');
    expect(entries[0].source).toBe('meetings/x');
    expect(entries[1].summary).toBe('First entry');
    // The markdown sentinel column stays verbatim — no merging.
    expect(page.timeline).toBe('');
  }, 30_000);

  test('a same-slug page in another source does not union its entries into the resolved page', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', '/tmp/other') ON CONFLICT (id) DO NOTHING`,
    );
    await engine.putPage('notes/example', {
      type: 'note',
      title: 'Other-source twin',
      compiled_truth: 'Twin body.',
      timeline: '',
    } as never, { sourceId: 'other' });
    await engine.addTimelineEntry('notes/example', { date: '2026-09-02', summary: 'Foreign entry' }, { sourceId: 'other' });

    const page = (await getPage.handler(localCtx(), { slug: 'notes/example', include_timeline: true })) as Record<string, unknown>;
    const entries = page.timeline_entries as Array<{ summary: string }>;
    expect(entries.map((e) => e.summary)).toEqual(['Second entry', 'First entry']);
  }, 30_000);
});
