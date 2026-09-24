/**
 * Slug-keyed binding moves for updateSlug (Postgres + PGLite parity helper).
 *
 * `pages.slug` is a TEXT coordinate other tables bind to: facts carry
 * `entity_slug` / `source_markdown_slug`, `slug_aliases.canonical_slug`
 * resolves redirect targets, and `page_aliases.slug` stores the named-alias
 * target. Renaming a page without moving these strands them under a slug
 * that no longer exists — facts detach, aliases dangle, old-name lookups
 * break.
 *
 * `moveSlugBindings` is called inside the same transaction as the
 * `pages.slug` UPDATE (after it reports >0 rows), keeping the move
 * source-qualified like the rename itself.
 */

import type { BrainEngine } from './engine.ts';

export async function moveSlugBindings(
  engine: BrainEngine,
  sourceId: string,
  oldSlug: string,
  newSlug: string,
): Promise<void> {
  await engine.executeRaw(
    'UPDATE facts SET entity_slug = $1 WHERE source_id = $2 AND entity_slug = $3',
    [newSlug, sourceId, oldSlug]);
  await engine.executeRaw(
    'UPDATE facts SET source_markdown_slug = $1 WHERE source_id = $2 AND source_markdown_slug = $3',
    [newSlug, sourceId, oldSlug]);
  await engine.executeRaw(
    'UPDATE slug_aliases SET canonical_slug = $1 WHERE source_id = $2 AND canonical_slug = $3',
    [newSlug, sourceId, oldSlug]);
  await engine.executeRaw(
    'UPDATE page_aliases SET slug = $1 WHERE source_id = $2 AND slug = $3',
    [newSlug, sourceId, oldSlug]);
  // Old-name lookups keep resolving to the renamed page. An intentional
  // redirect already recorded for the old slug wins (ON CONFLICT).
  await engine.executeRaw(
    `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
     VALUES ($1, $2, $3, 'auto: slug rename')
     ON CONFLICT (source_id, alias_slug) DO NOTHING`,
    [sourceId, oldSlug, newSlug]);
}
