/**
 * #6522: per-chunk synopses persist across re-embeds so an embedding-model
 * change does not regenerate them. The store is keyed by (page_id,
 * chunk_index) and matched on chunk_text_hash + prompt_version +
 * synopsis_model — the embedder plays no part in the key.
 *
 * Discriminates on unpatched master: chunk_synopses does not exist and the
 * service always regenerates, so every test fails there.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { reembedPageWithContextualRetrieval } from '../src/core/contextual-retrieval-service.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { lookupChunkSynopsis, listChunkSynopses } from '../src/core/synopsis-store.ts';
import { SYNOPSIS_PROMPT_VERSION } from '../src/core/page-summary.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
const SLUG = 'wiki/concepts/synopsis-persist';
const BODY = `---
title: "Persisted Synopsis"
type: concept
---

First paragraph of the page body for chunking.

Second paragraph to keep the chunker honest.`;

let engine: PGLiteEngine;
let chatCalls: string[];
let embedCalls: string[];

function chatOk(text: string): ChatResult {
  return { text, blocks: [], stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'stub:chat', providerId: 'stub' } as ChatResult;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  configureGateway({
    embedding_model: MODEL,
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => {
    embedCalls.push(...values);
    return { embeddings: values.map(() => new Array<number>(DIMS).fill(0.001)), usage: { tokens: 0 } } as any;
  });
  __setChatTransportForTests(async (opts) => {
    const raw = opts.messages[0]?.content ?? '';
    const content = typeof raw === 'string' ? raw : raw.map(b => (b.type === 'text' ? b.text : '')).join('\n');
    const chunk = content.match(/<chunk>\n([\s\S]*?)\n<\/chunk>/)?.[1] ?? '';
    chatCalls.push(chunk);
    return chatOk(`Synopsis for ${chunk}`);
  });
  await importFromContent(engine, SLUG, BODY, { sourceId: 'default' });
}, 60_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

afterEach(() => { chatCalls.length = 0; embedCalls.length = 0; });

function pageId(): Promise<number> {
  return engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`, [SLUG])
    .then(rows => rows[0]!.id);
}

async function reembed(synopsisModel = 'anthropic:claude-haiku-4-5-20251001') {
  const result = await reembedPageWithContextualRetrieval({
    engine, pageSlug: SLUG, sourceId: 'default',
    globalMode: 'per_chunk_synopsis', synopsisModel,
  });
  expect(result.kind).toBe('success');
  return result;
}

describe('#6522 persisted chunk synopses', () => {
  test('generation writes a chunk_synopses row and a re-embed reuses it', async () => {
    chatCalls = []; embedCalls = [];
    await reembed();
    const generated = chatCalls.length;
    expect(generated).toBeGreaterThan(0);
    const rows = await listChunkSynopses(engine, await pageId());
    expect(rows.length).toBe(generated);
    expect(rows[0]).toMatchObject({ synopsis_model: 'anthropic:claude-haiku-4-5-20251001', prompt_version: SYNOPSIS_PROMPT_VERSION });
    expect(rows[0]!.synopsis.length).toBeGreaterThan(0);
    expect(embedCalls.some(text => text.includes(rows[0]!.synopsis))).toBe(true);

    // Second re-embed (e.g. after an embedding-model swap): no model calls,
    // the embedder still sees the persisted synopsis wrapped in.
    chatCalls = []; embedCalls = [];
    await reembed();
    expect(chatCalls).toHaveLength(0);
    expect(embedCalls.some(text => text.includes(rows[0]!.synopsis))).toBe(true);
  });

  test('a changed synopsis model regenerates; the stored key stays matched', async () => {
    const slug2 = 'wiki/concepts/synopsis-model-swap';
    await importFromContent(engine, slug2, BODY, { sourceId: 'default' });
    const id2 = (await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug2]))[0]!.id;
    const embed2 = (synopsisModel: string) => reembedPageWithContextualRetrieval({
      engine, pageSlug: slug2, sourceId: 'default',
      globalMode: 'per_chunk_synopsis', synopsisModel,
    });

    chatCalls = [];
    expect((await embed2('anthropic:claude-haiku-4-5-20251001')).kind).toBe('success');
    expect(chatCalls.length).toBeGreaterThan(0);
    // Same model: hit. Different synopsis model: miss → regenerate + replace.
    chatCalls = [];
    await embed2('anthropic:claude-haiku-4-5-20251001');
    expect(chatCalls).toHaveLength(0);
    await embed2('openai:gpt-5-mini');
    expect(chatCalls.length).toBeGreaterThan(0);
    // The row under the new model exists; looking up with the wrong hash misses.
    const rows = await listChunkSynopses(engine, id2);
    expect(rows[0]!.synopsis_model).toBe('openai:gpt-5-mini');
    const miss = await lookupChunkSynopsis(engine, {
      pageId: id2, chunkIndex: 0, chunkText: 'different chunk text',
      promptVersion: SYNOPSIS_PROMPT_VERSION, synopsisModel: 'openai:gpt-5-mini',
    });
    expect(miss).toBeNull();
    const [chunk] = await engine.executeRaw<{ chunk_text: string }>(
      `SELECT chunk_text FROM content_chunks WHERE page_id = $1 AND chunk_index = $2`,
      [id2, rows[0]!.chunk_index]);
    const hit = await lookupChunkSynopsis(engine, {
      pageId: id2, chunkIndex: rows[0]!.chunk_index, chunkText: chunk!.chunk_text,
      promptVersion: SYNOPSIS_PROMPT_VERSION, synopsisModel: 'openai:gpt-5-mini',
    });
    expect(hit).not.toBeNull();
  });
});
