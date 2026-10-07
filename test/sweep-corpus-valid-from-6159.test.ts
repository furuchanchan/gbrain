/**
 * #6159 — the sweep's corpus pass stamps extracted facts with the session's
 * own time, not the extraction time. `valid_from` resolution: a `seg-*`
 * file's ledger `ts` (its bank time at compaction), else the corpus file's
 * mtime; a writeback turn file's mtime is its turn time.
 *
 * Protects: a backlog drained days late keeps session ordering — recall,
 * entity cards and hot memory rank recent facts first, so extraction-time
 * stamping lets an old session outrank what was learned since.
 * Fails on the pre-#6159 pass, which never set ctx.validFrom and stamped
 * every fact `new Date()`.
 *
 * Hermetic in-memory PGLite + chat-transport stub (sweep-corpus-windows
 * harness).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { ledgerFileName, segmentHash, writeSegment } from '../src/core/context/corpus-segments.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let dir: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-validfrom-'));
  tmpDirs.push(dir);
  await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: [{ fact: 'Prefers a quiet office for focused work', kind: 'preference', entity: null, confidence: 0.9, notability: 'high' }] }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:test-stub',
    providerId: 'anthropic',
  }));
});

const sweep = () =>
  runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED, budgetMs: 120_000, batchLimit: 20 });

const corpus = (texts: string[]): string =>
  toCorpusText(texts.map((text, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, text })));

async function factValidFrom(): Promise<Date> {
  const rows = await engine.executeRaw<{ valid_from: string | Date }>(
    `SELECT valid_from FROM facts WHERE source = 'sweep:corpus'`);
  expect(rows.length).toBeGreaterThan(0);
  return new Date(rows[0]!.valid_from);
}

describe('#6159 sweep corpus valid_from', () => {
  test('a corpus file swept days after its mtime stamps facts with the mtime, not the sweep clock', async () => {
    const file = join(dir, 'sess-old.txt');
    writeFileSync(file, corpus(['TAILMARK I prefer a quiet office for focused work.']));
    const old = new Date('2026-09-25T12:00:00.000Z');
    utimesSync(file, old, old);
    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    const validFrom = await factValidFrom();
    expect(validFrom.getTime()).toBe(old.getTime());
  });

  test('a checkpoint segment stamps facts with its ledger ts, not the file mtime or the sweep clock', async () => {
    const text = corpus(['TAILMARK I prefer a quiet office for focused work.']);
    const { hash, file } = writeSegment(dir, 'sess-seg', text);
    // Ledger records the bank time; the file may be swept (and its mtime
    // refreshed by a copy) long after.
    const bankTime = '2026-09-20T08:30:00.000Z';
    writeFileSync(join(dir, ledgerFileName('sess-seg')), JSON.stringify([{ hash, ts: bankTime }]) + '\n');
    const mtime = new Date('2026-10-01T00:00:00.000Z');
    utimesSync(file, mtime, mtime);
    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    const validFrom = await factValidFrom();
    expect(validFrom.getTime()).toBe(new Date(bankTime).getTime());
  });

  test('a segment with no ledger entry falls back to the file mtime', async () => {
    const text = corpus(['TAILMARK I prefer a quiet office for focused work.']);
    const { file } = writeSegment(dir, 'sess-noledger', text);
    const old = new Date('2026-09-22T09:00:00.000Z');
    utimesSync(file, old, old);
    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    const validFrom = await factValidFrom();
    expect(validFrom.getTime()).toBe(old.getTime());
  });
});
