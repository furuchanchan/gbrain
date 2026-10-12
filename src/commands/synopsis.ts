import type { BrainEngine } from '../core/engine.ts';
import { listChunkSynopses, type ChunkSynopsisRow } from '../core/synopsis-store.ts';

/**
 * #6522: `gbrain synopsis` — audit the persisted per-chunk synopses
 * (per_chunk_synopsis contextual retrieval). Read-only.
 *
 * Usage:
 *   gbrain synopsis show <slug> [--source <id>] [--json]
 */

const SYNOPSIS_HELP = `gbrain synopsis — audit persisted per-chunk synopses

Usage:
  gbrain synopsis show <slug> [--source <id>] [--json]

Synopses are stored when the per_chunk_synopsis contextual-retrieval
tier generates them, keyed by (page, chunk) and matched on the chunk
text, prompt version and synopsis model — independent of the embedding
model, so a re-embed under a different embedder reuses them.`;

export async function runSynopsis(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(SYNOPSIS_HELP);
    return;
  }
  const sub = args[0];
  if (sub !== 'show') {
    console.error(`gbrain synopsis: unknown subcommand "${sub}"\n\n${SYNOPSIS_HELP}`);
    process.exitCode = 2;
    return;
  }
  const json = args.includes('--json');
  const sourceIdx = args.indexOf('--source');
  const sourceId = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;
  const slug = args.slice(1).find((a, i) => !a.startsWith('-') && args[i] !== '--source');

  if (!slug) {
    console.error('gbrain synopsis show: a page slug is required');
    process.exitCode = 2;
    return;
  }

  const page = await resolvePage(engine, slug, sourceId);
  if (!page) {
    console.error(`gbrain synopsis show: no page "${slug}"${sourceId ? ` in source "${sourceId}"` : ''}`);
    process.exitCode = 1;
    return;
  }
  const rows = await listChunkSynopses(engine, page.id);

  if (json) {
    console.log(JSON.stringify({ slug: page.slug, title: page.title, synopses: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(`${page.slug}: no persisted synopses`);
    return;
  }
  console.log(`${page.slug} — ${rows.length} persisted synopsis(es)`);
  for (const row of rows) printRow(row);
}

function printRow(row: ChunkSynopsisRow): void {
  console.log(`\n--- chunk ${row.chunk_index} (${row.chunk_text_hash.slice(0, 12)}…)`);
  console.log(`    model: ${row.synopsis_model}  prompt_version: ${row.prompt_version}  saved: ${row.updated_at}`);
  console.log(`    ${row.synopsis}`);
}

async function resolvePage(
  engine: BrainEngine, slug: string, sourceId?: string,
): Promise<{ id: number; slug: string; title: string } | null> {
  const rows = sourceId
    ? await engine.executeRaw<{ id: number; slug: string; title: string }>(
        'SELECT id, slug, title FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL ORDER BY id LIMIT 1',
        [slug, sourceId])
    : await engine.executeRaw<{ id: number; slug: string; title: string }>(
        'SELECT id, slug, title FROM pages WHERE slug = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1',
        [slug]);
  return rows[0] ?? null;
}
