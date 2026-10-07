/**
 * #6069 — degenerate judge verdicts (unparseable / truncated / refusal) are
 * recorded as marker rows (score null, reasons[0] = `unreliable:<kind>`) that
 * suppress the paid re-judge for UNRELIABLE_VERDICT_BACKOFF_MS, and the raw
 * judge response head is carried on the log path for diagnosis.
 *
 * Same harness as cycle-synthesize-triage.test.ts: Map-backed fake engine,
 * injected judge + clock. No PGLite, no real sleeps.
 *
 * Run: bun test test/cycle-synthesize-unreliable-backoff.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  runTriagePass,
  TRIAGE_VERSION,
  type JudgeClient,
  type TriagePassCfg,
} from '../src/core/cycle/synthesize.ts';
import {
  isUnreliableVerdictMarker,
  UNRELIABLE_VERDICT_BACKOFF_MS,
} from '../src/core/cycle/triage-unreliable.ts';
import type { BrainEngine, DreamVerdict, DreamVerdictInput } from '../src/core/engine.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';

const MODEL = 'anthropic:claude-haiku-4-5-20251001';

function makeTranscript(name: string): DiscoveredTranscript {
  return {
    filePath: `/corpus/${name}.txt`,
    contentHash: `hash-${name}`.padEnd(20, '0'),
    content: `content of ${name} `.repeat(50),
    basename: name,
    inferredDate: null,
  };
}

function makeFakeEngine(): { engine: BrainEngine; rows: Map<string, DreamVerdict>; putCalls: { n: number } } {
  const rows = new Map<string, DreamVerdict>();
  const putCalls = { n: 0 };
  const engine = {
    async getDreamVerdict(filePath: string, contentHash: string): Promise<DreamVerdict | null> {
      return rows.get(`${filePath}|${contentHash}`) ?? null;
    },
    async putDreamVerdict(filePath: string, contentHash: string, v: DreamVerdictInput): Promise<void> {
      putCalls.n++;
      rows.set(`${filePath}|${contentHash}`, { ...v, judged_at: new Date().toISOString() });
    },
  } as unknown as BrainEngine;
  return { engine, rows, putCalls };
}

/** Judge whose response never parses to a scored verdict. */
function unparseableJudge(calls: { n: number }): JudgeClient {
  return {
    create: async () => {
      calls.n++;
      return {
        content: [{ type: 'text', text: 'Sorry, I cannot score this transcript because reasons' }],
        stop_reason: 'end_turn',
      } as never;
    },
  };
}

function baseCfg(judge: JudgeClient, over: Partial<TriagePassCfg> = {}): TriagePassCfg {
  return {
    model: MODEL,
    maxChars: 24_000,
    maxTokens: 2048,
    threshold: 0.5,
    concurrency: 4,
    maxMs: 0,
    judge,
    ...over,
  };
}

describe('#6069 unreliable verdict marker + diagnostics', () => {
  test('unparseable verdict writes a marker row (score null, unreliable: prefix) instead of skipping the cache write', async () => {
    const fake = makeFakeEngine();
    const t = makeTranscript('a');
    const r = await runTriagePass(fake.engine, [t], baseCfg(unparseableJudge({ n: 0 })));
    expect(r.reports[0].unreliable).toBe('unparseable');
    expect(fake.putCalls.n).toBe(1);
    const row = fake.rows.get(`${t.filePath}|${t.contentHash}`)!;
    expect(row.score).toBeNull();
    expect(row.worth_processing).toBe(false);
    expect(row.reasons[0]).toBe('unreliable:unparseable');
    expect(row.model).toBe(MODEL);
    expect(row.triage_version).toBe(TRIAGE_VERSION);
  });

  test('marker row within the backoff window suppresses the paid re-judge', async () => {
    const fake = makeFakeEngine();
    const calls = { n: 0 };
    const t = makeTranscript('b');
    const first = await runTriagePass(fake.engine, [t], baseCfg(unparseableJudge(calls)));
    expect(calls.n).toBe(1);
    expect(first.reports[0].cached).toBe(false);
    const second = await runTriagePass(fake.engine, [t], baseCfg(unparseableJudge(calls)));
    expect(calls.n).toBe(1);
    expect(second.reports[0].cached).toBe(true);
    expect(second.reports[0].unreliable).toBe('unparseable');
    expect(second.reports[0].reasons.join(' ')).toContain('re-judge suppressed');
    expect(second.judged).toBe(0);
  });

  test('marker older than the backoff window re-judges', async () => {
    const fake = makeFakeEngine();
    const calls = { n: 0 };
    const t = makeTranscript('c');
    await runTriagePass(fake.engine, [t], baseCfg(unparseableJudge(calls)));
    const row = fake.rows.get(`${t.filePath}|${t.contentHash}`)!;
    row.judged_at = new Date(Date.now() - UNRELIABLE_VERDICT_BACKOFF_MS - 60_000).toISOString();
    const r = await runTriagePass(fake.engine, [t], baseCfg(unparseableJudge(calls)));
    expect(calls.n).toBe(2);
    expect(r.judged).toBe(1);
  });

  test('a marker from another model re-judges (cache tuple still applies)', async () => {
    const fake = makeFakeEngine();
    const calls = { n: 0 };
    const t = makeTranscript('d');
    await runTriagePass(fake.engine, [t], baseCfg(unparseableJudge(calls), { model: 'openai:gpt-4o-mini' }));
    const r = await runTriagePass(fake.engine, [t], baseCfg(unparseableJudge(calls)));
    expect(calls.n).toBe(2);
    expect(r.judged).toBe(1);
  });

  test('unparseable TriageResult carries the raw judge response head', async () => {
    const fake = makeFakeEngine();
    const t = makeTranscript('e');
    const judge: JudgeClient = {
      create: async () => ({
        content: [{ type: 'text', text: 'DIAGNOSTIC-HEAD-MARKER ' + 'x'.repeat(3000) }],
        stop_reason: 'end_turn',
      } as never),
    };
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as never;
    try {
      await runTriagePass(fake.engine, [t], baseCfg(judge));
    } finally {
      process.stderr.write = orig;
    }
    const line = writes.find(w => w.includes('unparseable'));
    expect(line).toContain('DIAGNOSTIC-HEAD-MARKER');
    expect(line!.length).toBeLessThan(2500);
  });

  test('isUnreliableVerdictMarker: tuple + prefix + freshness gates', () => {
    const now = Date.now();
    const base = {
      score: null as number | null,
      triage_version: TRIAGE_VERSION,
      model: MODEL,
      judged_at: new Date(now - 60_000).toISOString(),
      reasons: ['unreliable:truncated'],
    };
    expect(isUnreliableVerdictMarker(base, MODEL, TRIAGE_VERSION, undefined, now)).toBe(true);
    expect(isUnreliableVerdictMarker({ ...base, score: 0.5 }, MODEL, TRIAGE_VERSION, undefined, now)).toBe(false);
    expect(isUnreliableVerdictMarker({ ...base, model: 'other' }, MODEL, TRIAGE_VERSION, undefined, now)).toBe(false);
    expect(isUnreliableVerdictMarker({ ...base, reasons: ['seed'] }, MODEL, TRIAGE_VERSION, undefined, now)).toBe(false);
    expect(isUnreliableVerdictMarker({ ...base, judged_at: new Date(now - UNRELIABLE_VERDICT_BACKOFF_MS - 1).toISOString() }, MODEL, TRIAGE_VERSION, undefined, now)).toBe(false);
    expect(isUnreliableVerdictMarker(base, MODEL, TRIAGE_VERSION, new Date(now + 60_000), now)).toBe(false);
  });
});
