/**
 * #5888 — ambient-writeback recent-write dedup + hot-memory near-dup collapse.
 *
 * `hook:writeback` re-extracts a user turn ~30–70 s after the agent's own
 * `remember` call saved the same statement — possibly on another entity,
 * where the per-entity dedup never looks. The writeback lane now dedups
 * against active facts written in the last few minutes regardless of
 * entity, and the hot-memory block collapses near-duplicate phrasings
 * before injection.
 *
 * Real PGLite engine (in-memory). Chat + embedding transports stubbed.
 * Each test claims its own fact text / embedding axes / session id — the
 * shared engine accumulates rows and the same-session cosine tier makes
 * every recent row a candidate for every other one.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import type { OperationContext } from '../src/core/operations.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
  __resetHotMemoryCacheForTests();
});

const LONG_BODY = 'this is a real meeting note longer than 80 chars '.repeat(3);
const PAGE = () => ({
  slug: 'meetings/test-' + Math.random().toString(36).slice(2, 9),
  type: 'meeting' as const,
  compiled_truth: LONG_BODY,
  frontmatter: {} as Record<string, unknown>,
});
const EMBED_MODEL = 'openai:text-embedding-3-small';

/** 1536-dim unit vector along axis i (axes are allocated per test). */
const axis = (i: number) => { const v = new Float32Array(1536); v[i] = 1; return v; };
/** Unit vector `c·axis(i) + sqrt(1−c²)·axis(i+1)` — cosine `c` with axis(i). */
const tilt = (i: number, c: number) => { const v = new Float32Array(1536); v[i] = c; v[i + 1] = Math.sqrt(1 - c * c); return v; };

function makeCtx(overrides: Partial<FactsBackstopCtx> = {}): FactsBackstopCtx {
  return { engine, sourceId: 'default', sessionId: 'sess-5888', source: 'hook:writeback', ...overrides };
}

function chatStub(facts: Array<{ fact: string; entity?: string | null }>) {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({
      facts: facts.map(f => ({ fact: f.fact, kind: 'fact', entity: f.entity ?? null, confidence: 1.0, notability: 'high' })),
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
}

function configureEmbed(vector: Float32Array) {
  configureGateway({ embedding_model: EMBED_MODEL, embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async () => ({ embeddings: [Array.from(vector)] })) as never);
}

/** Insert a "remembered" row the way an agent write would. */
async function remembered(opts: {
  fact: string; entity?: string | null; session?: string | null; embedding?: Float32Array | null;
  confidence?: number; visibility?: 'private' | 'world'; source?: string;
}) {
  const { id } = await engine.insertFact({
    fact: opts.fact, kind: 'fact', entity_slug: opts.entity ?? null, visibility: opts.visibility ?? 'private',
    source: opts.source ?? 'mcp:extract_facts', source_session: opts.session === undefined ? 'sess-5888' : opts.session,
    confidence: opts.confidence, embedding: opts.embedding ?? null, embedding_model: opts.embedding ? EMBED_MODEL : null,
  }, { source_id: 'default' });
  return id;
}

describe('hook:writeback — recent-write cross-entity dedup (#5888)', () => {
  test('a normalized-text match on ANOTHER entity dedups without embeddings', async () => {
    const rememberedId = await remembered({ fact: 'Alpha joined Acme as CTO', entity: 'people/alpha' });
    chatStub([{ fact: 'Alpha joined Acme as CTO!', entity: 'people/bob-else' }]);
    const r = await runFactsBackstop(PAGE(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.inserted).toBe(0);
      expect(r.duplicate).toBe(1);
      expect(r.fact_ids).toEqual([rememberedId]);
    }
  });

  test('a same-session paraphrase at cosine ~0.92 on another entity dedups', async () => {
    const rememberedId = await remembered({ fact: 'Beta joined BetaCorp', entity: 'people/beta', embedding: axis(0) });
    configureEmbed(tilt(0, 0.92));
    chatStub([{ fact: 'Beta became the CTO of BetaCorp', entity: 'people/bob-else' }]);
    const r = await runFactsBackstop(PAGE(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.inserted).toBe(0);
      expect(r.duplicate).toBe(1);
      expect(r.fact_ids).toEqual([rememberedId]);
    }
  });

  test('the loose session bar does NOT apply across sessions — 0.92 inserts', async () => {
    await remembered({ fact: 'Gamma joined GammaCo', entity: 'people/gamma', embedding: axis(3), session: 'other-session' });
    configureEmbed(tilt(3, 0.92));
    chatStub([{ fact: 'Gamma became the CTO of GammaCo', entity: 'people/bob-else' }]);
    const r = await runFactsBackstop(PAGE(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.inserted).toBe(1);
  });

  test('the strict 0.95 bar still dedups across sessions', async () => {
    const rememberedId = await remembered({ fact: 'Delta joined DeltaCo', entity: 'people/delta', embedding: axis(6), session: 'other-session' });
    configureEmbed(tilt(6, 0.96));
    chatStub([{ fact: 'Delta became the CTO of DeltaCo', entity: 'people/bob-else' }]);
    const r = await runFactsBackstop(PAGE(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.inserted).toBe(0);
      expect(r.fact_ids).toEqual([rememberedId]);
    }
  });

  test('a same-session paraphrase OUTSIDE the recent window inserts', async () => {
    const rememberedId = await remembered({ fact: 'Epsilon joined EpsilonCo', entity: 'people/epsilon', embedding: axis(9) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE facts SET created_at = now() - interval '20 minutes' WHERE id = $1`, [rememberedId]);
    configureEmbed(tilt(9, 0.92));
    chatStub([{ fact: 'Epsilon became the CTO of EpsilonCo', entity: 'people/bob-else' }]);
    const r = await runFactsBackstop(PAGE(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.inserted).toBe(1);
  });

  test('non-writeback lanes are untouched — mcp:put_page inserts at 0.92', async () => {
    await remembered({ fact: 'Zeta joined ZetaCo', entity: 'people/zeta', embedding: axis(12) });
    configureEmbed(tilt(12, 0.92));
    chatStub([{ fact: 'Zeta became the CTO of ZetaCo', entity: 'people/bob-else' }]);
    const r = await runFactsBackstop(PAGE(), makeCtx({ mode: 'inline', source: 'mcp:put_page' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.inserted).toBe(1);
  });
});

describe('hot memory — near-duplicate collapse (#5888)', () => {
  const metaCtx = (sessionId: string): OperationContext =>
    ({ engine, remote: false, sourceId: 'default', sessionId, config: {} as never, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } });

  test('two phrasings of one statement collapse to the more confident row', async () => {
    const session = 'sess-5888-hot-a';
    await remembered({ fact: 'Eta joined EtaCo', entity: 'people/eta', embedding: axis(15), confidence: 0.6, session });
    const { id: keep } = await engine.insertFact({
      fact: 'Eta became the CTO of EtaCo', kind: 'fact', entity_slug: 'people/eta-alt', visibility: 'private',
      source: 'hook:writeback', source_session: session, embedding: tilt(15, 0.93), embedding_model: EMBED_MODEL, confidence: 1.0,
    }, { source_id: 'default' });
    await remembered({ fact: 'Omicron raised a seed round', entity: 'people/omicron', embedding: axis(18), session });
    const meta = await getBrainHotMemoryMeta('get_stats', metaCtx(session));
    const facts = (meta?.brain_hot_memory as { facts: Array<{ id: number; fact: string }> }).facts;
    expect(facts.length).toBe(2);
    expect(facts.map(f => f.id)).toContain(keep);
    expect(facts.some(f => f.fact === 'Eta joined EtaCo')).toBe(false);
    expect(facts.some(f => f.fact === 'Omicron raised a seed round')).toBe(true);
  });

  test('normalized-text copies collapse without embeddings', async () => {
    const session = 'sess-5888-hot-b';
    await remembered({ fact: 'Iota joined IotaCo', entity: 'people/iota', session });
    await remembered({ fact: 'iota joined iotaco!', entity: 'people/bob-e', session });
    const meta = await getBrainHotMemoryMeta('get_stats', metaCtx(session));
    const facts = (meta?.brain_hot_memory as { facts: Array<{ fact: string }> }).facts;
    expect(facts.length).toBe(1);
  });
});
