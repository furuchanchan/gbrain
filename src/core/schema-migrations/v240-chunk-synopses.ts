import type { Migration } from './types.ts';

// #6522: persist per-chunk synopses so a re-embed under a different
// embedding model does not regenerate them. The row is keyed by
// (page_id, chunk_index) and matched on chunk_text_hash +
// prompt_version + synopsis_model — none of which involve the
// embedding model — so it survives embedder changes while content,
// prompt and synopsis-model edits still regenerate. page cascade
// removes the rows when the page is purged; table also created in
// schema.sql for fresh installs.
export const v240: Migration = {
  version: 240,
  name: 'chunk_synopses',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS chunk_synopses (
      page_id         INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      chunk_index     INTEGER NOT NULL,
      chunk_text_hash TEXT    NOT NULL,
      synopsis        TEXT    NOT NULL,
      synopsis_model  TEXT    NOT NULL,
      prompt_version  INTEGER NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (page_id, chunk_index)
    );`,
};
