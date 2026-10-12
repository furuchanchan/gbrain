import type { BrainEngine } from './engine.ts';

/**
 * #6522: persisted store for per-chunk synopses (per_chunk_synopsis
 * contextual retrieval). A synopsis is keyed by (page_id, chunk_index)
 * and matched on chunk_text_hash + prompt_version + synopsis_model —
 * none of which involve the embedding model, so a re-embed under a
 * different embedder reuses it while content, prompt or synopsis-model
 * changes still regenerate. `chunk_text_hash` is md5(chunk_text), the
 * same digest content_chunks.embedded_text_hash stores. Rows die with
 * their page via ON DELETE CASCADE.
 */

export interface ChunkSynopsisKey {
  pageId: number;
  chunkIndex: number;
  chunkText: string;
  promptVersion: number;
  synopsisModel: string;
}

export interface ChunkSynopsisRow {
  page_id: number;
  chunk_index: number;
  chunk_text_hash: string;
  synopsis: string;
  synopsis_model: string;
  prompt_version: number;
  created_at: string;
  updated_at: string;
}

/** The stored synopsis whose key matches, else null. */
export async function lookupChunkSynopsis(engine: BrainEngine, key: ChunkSynopsisKey): Promise<string | null> {
  const rows = await engine.executeRaw<{ synopsis: string }>(
    `SELECT synopsis FROM chunk_synopses
      WHERE page_id = $1 AND chunk_index = $2 AND chunk_text_hash = md5($3)
        AND prompt_version = $4 AND synopsis_model = $5`,
    [key.pageId, key.chunkIndex, key.chunkText, key.promptVersion, key.synopsisModel]);
  return rows[0]?.synopsis ?? null;
}

/** Insert or replace the chunk's synopsis row with the freshly generated text. */
export async function saveChunkSynopsis(engine: BrainEngine, key: ChunkSynopsisKey & { synopsis: string }): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO chunk_synopses (page_id, chunk_index, chunk_text_hash, synopsis, synopsis_model, prompt_version)
     VALUES ($1, $2, md5($3), $4, $5, $6)
     ON CONFLICT (page_id, chunk_index) DO UPDATE SET
       chunk_text_hash = EXCLUDED.chunk_text_hash,
       synopsis        = EXCLUDED.synopsis,
       synopsis_model  = EXCLUDED.synopsis_model,
       prompt_version  = EXCLUDED.prompt_version,
       updated_at      = now()`,
    [key.pageId, key.chunkIndex, key.chunkText, key.synopsis, key.synopsisModel, key.promptVersion]);
}

/** Every synopsis row for a page, in chunk order — `gbrain synopsis show`. */
export async function listChunkSynopses(engine: BrainEngine, pageId: number): Promise<ChunkSynopsisRow[]> {
  return engine.executeRaw<ChunkSynopsisRow>(
    `SELECT page_id, chunk_index, chunk_text_hash, synopsis, synopsis_model, prompt_version,
            created_at::text AS created_at, updated_at::text AS updated_at
       FROM chunk_synopses WHERE page_id = $1 ORDER BY chunk_index`,
    [pageId]);
}
