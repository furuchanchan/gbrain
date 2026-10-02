/**
 * Embedding pass for typed take claims.
 *
 * Takes already have vector search and a stale-row contract, but no writer.
 * Keep this pass separate from page/chunk embedding so callers can opt into
 * the extra provider work and see its counts independently.
 */

import type { BrainEngine, StaleTakeRow, TakeEmbeddingInput } from './engine.ts';
import type { EmbedOpts, EmbedResult } from '../commands/embed.ts';
import { embedBatchWithBackoff } from '../commands/embed.ts';
import { serr, slog } from './console-prefix.ts';

const DEFAULT_BATCH_SIZE = 100;

export interface EmbedTakesOpts {
  batchSize?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  embedFn?: (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;
  onProgress?: (done: number, total: number, embedded: number) => void;
}

export interface EmbedTakesResult {
  total_stale: number;
  embedded: number;
  would_embed: number;
  failures: number;
  failure_samples: string[];
  dryRun: boolean;
}

/** Embed active takes whose embedding column is NULL. */
export async function embedStaleTakes(
  engine: BrainEngine,
  opts: EmbedTakesOpts = {},
): Promise<EmbedTakesResult> {
  const stale = await engine.listStaleTakes();
  const result: EmbedTakesResult = {
    total_stale: stale.length,
    embedded: 0,
    would_embed: opts.dryRun ? stale.length : 0,
    failures: 0,
    failure_samples: [],
    dryRun: !!opts.dryRun,
  };
  if (opts.dryRun || stale.length === 0) {
    opts.onProgress?.(stale.length, stale.length, 0);
    return result;
  }

  const batchSize = Math.min(500, Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE)));
  const embedFn = opts.embedFn ?? ((texts: string[], embedOpts: { abortSignal?: AbortSignal }) =>
    embedBatchWithBackoff(texts, embedOpts));

  for (let start = 0; start < stale.length; start += batchSize) {
    if (opts.signal?.aborted) break;
    const batch = stale.slice(start, start + batchSize);
    try {
      const embeddings = await embedFn(
        batch.map((row) => row.claim),
        { abortSignal: opts.signal },
      );
      if (embeddings.length !== batch.length) {
        throw new Error(`embedding provider returned ${embeddings.length} vectors for ${batch.length} takes`);
      }
      const writes: TakeEmbeddingInput[] = batch.map((row: StaleTakeRow, index) => ({
        take_id: row.take_id,
        embedding: embeddings[index],
      }));
      result.embedded += await engine.updateTakeEmbeddings(writes, { signal: opts.signal });
    } catch (error: unknown) {
      result.failures += batch.length;
      if (result.failure_samples.length < 10) {
        result.failure_samples.push(error instanceof Error ? error.message : String(error));
      }
    }
    opts.onProgress?.(Math.min(start + batch.length, stale.length), stale.length, result.embedded);
  }

  return result;
}

/**
 * #5885: run at the successful end of `runEmbedCore`'s `--stale` drain so
 * take vectors ride the same pass as stale chunks — previously only the
 * manual `gbrain takes embed` wrote them, so every take written after the
 * last manual pass stayed keyword-only while `think` and
 * `takes search --semantic` read vectors. Runs inside the single-flight
 * window the caller already holds, and only on `stale` — `--all` keeps its
 * documented page/chunk-only meaning. A structural failure (e.g. an older
 * schema without takes.embedding) degrades to a logged empty result rather
 * than failing the chunk drain that already banked its work.
 */
export async function finishStaleEmbedPass(engine: BrainEngine, opts: EmbedOpts, result: EmbedResult): Promise<EmbedResult> {
  if (opts.stale) {
    try {
      result.takes = await embedStaleTakes(engine, {
        dryRun: opts.dryRun,
        signal: opts.signal,
        batchSize: opts.batchSize,
      });
      if (!opts.quiet) {
        if (result.takes.dryRun && result.takes.would_embed > 0) {
          slog(`[dry-run] Would embed ${result.takes.would_embed} stale take(s)`);
        } else if (!result.takes.dryRun && (result.takes.embedded > 0 || result.takes.failures > 0)) {
          slog(`Embedded ${result.takes.embedded} stale take(s)${result.takes.failures > 0 ? ` (${result.takes.failures} failed)` : ''}`);
        }
      }
    } catch (e) {
      serr(`  [embed] take-vector pass failed (page/chunk result unaffected): ${e instanceof Error ? e.message : e}`);
      result.takes = { total_stale: 0, embedded: 0, would_embed: 0, failures: 0, failure_samples: [], dryRun: !!opts.dryRun };
    }
  }
  return result;
}
