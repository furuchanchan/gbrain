/**
 * #6454: older import paths stored `type`/`title`/`tags`/`slug` inside
 * `pages.frontmatter`, but `parseMarkdown` strips those keys from file
 * frontmatter, so a page imported that way can never digest-match its file
 * and every coordinated write refuses `source_changed`. `fileMatchesSnapshot`
 * now compares the stored frontmatter with those parser-stripped keys
 * removed — they carry no information a file could hold.
 */
import { describe, expect, test } from 'bun:test';
import { fileMatchesSnapshot } from '../src/core/persistence/page-prepare.ts';
import type { PageSnapshot } from '../src/core/page-state/types.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// overlayCanonicalBodies returns early when there are no withdrawals and no
// global purge marker, so executeRaw is never called.
const engine = { executeRaw: async () => { throw new Error('unexpected query'); } } as unknown as BrainEngine;

const FILE = '---\ntitle: Shalim Monteagudo\nyc_user_id: 1868407\n---\nShalim.';

function snapshot(frontmatter: Record<string, unknown>): PageSnapshot {
  return {
    page: {
      slug: 'people/shalim-monteagudo',
      type: 'person',
      title: 'Shalim Monteagudo',
      compiled_truth: 'Shalim.',
      timeline: '',
      frontmatter,
      source_id: 'default',
      deleted_at: null,
      source_path: 'people/shalim-monteagudo.md',
      source_uri: null,
      source_kind: null,
      ingested_via: null,
      ingested_at: null,
      created_at: '2026-05-01T00:00:00Z',
    },
    tags: [],
    withdrawals: [],
  } as unknown as PageSnapshot;
}

describe('#6454 fileMatchesSnapshot — parser-stripped keys in stored frontmatter', () => {
  test('a file matches a snapshot whose frontmatter carries legacy type/title keys', async () => {
    // The reported page: file parses to {yc_user_id, validate:false}; the row
    // holds {type:'person', validate:false, yc_user_id} — previously always drift.
    expect(await fileMatchesSnapshot(engine, 'people/shalim-monteagudo', FILE, snapshot({ type: 'person', title: 'Shalim Monteagudo', yc_user_id: 1868407, validate: false }))).toBe(true);
  });

  test('stored slug/tags keys are normalized away the same way', async () => {
    expect(await fileMatchesSnapshot(engine, 'people/shalim-monteagudo', FILE, snapshot({ slug: 'people/shalim-monteagudo', tags: ['a'], yc_user_id: 1868407 }))).toBe(true);
  });

  test('a real frontmatter difference still refuses', async () => {
    expect(await fileMatchesSnapshot(engine, 'people/shalim-monteagudo', FILE, snapshot({ type: 'person', yc_user_id: 9999999 }))).toBe(false);
  });
});
