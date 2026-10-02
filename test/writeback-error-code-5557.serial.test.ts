/**
 * #5557 — serve-side writeback harvests refused before extraction must be
 * diagnosable: the heartbeat reason carries the refusing OperationError
 * code (`operationerror:writer_lock_unavailable`, not bare `operationerror`),
 * the first occurrence of each reason reaches stderr once per serve run, and
 * doctor's `memory_writeback` warns when failures are a structural share of
 * attempts instead of a silent `failed` counter.
 *
 * Serial: mutates GBRAIN_HOME and the heartbeat file; PGLite engine.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import {
  __drainCheckpointHarvestForTests,
  __resetCheckpointHarvestForTests,
  harvestErrorReason,
  scheduleCheckpointHarvest,
} from '../src/core/context/checkpoint-harvest.ts';
import { writeSegment, segmentFileName } from '../src/core/context/corpus-segments.ts';
import { writeHeartbeat, readHeartbeatTail } from '../src/core/context/hook-heartbeat.ts';
import { buildMemoryWritebackCheck } from '../src/commands/doctor/checks/memory-writeback.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let corpusDir: string;
let homeDir: string;
let savedHome: string | undefined;
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  __resetCheckpointHarvestForTests();
  corpusDir = mkdtempSync(join(tmpdir(), 'gb-err5557-corpus-'));
  homeDir = mkdtempSync(join(tmpdir(), 'gb-err5557-home-'));
  tmpDirs.push(corpusDir, homeDir);
  savedHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = homeDir;
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
});

async function captureErr<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
  const orig = console.error;
  let err = '';
  console.error = (...a: unknown[]) => {
    err += a.map(String).join(' ') + '\n';
  };
  try {
    const result = await fn();
    return { result, err };
  } finally {
    console.error = orig;
  }
}

/** Engine whose getConfig refuses like the reporter's pre-extraction gate. */
function refusingEngine(code: string): PGLiteEngine {
  const broken = Object.create(engine) as PGLiteEngine;
  broken.getConfig = async () => {
    throw new OperationError(code as never, `synthetic ${code} refusal`);
  };
  return broken;
}

function bankTurn(sessionId: string, text: string): string {
  const w = writeSegment(corpusDir, sessionId, text);
  return segmentFileName(sessionId, w.hash);
}

describe('harvestErrorReason (#5557)', () => {
  test('OperationError keeps its gate code; other errors map to the lowered name', () => {
    expect(harvestErrorReason(new OperationError('writer_lock_unavailable', 'busy'))).toBe('operationerror:writer_lock_unavailable');
    expect(harvestErrorReason(new OperationError('idempotency_conflict', 'dup'))).toBe('operationerror:idempotency_conflict');
    expect(harvestErrorReason(new TypeError('nope'))).toBe('typeerror');
    expect(harvestErrorReason(new Error('plain'))).toBe('error');
    expect(harvestErrorReason('not-an-error')).toBe('error');
  });
});

describe('pump error reporting (#5557 ask 1)', () => {
  test('a refused turn heartbeats operationerror:<code> and warns stderr once per reason', async () => {
    const file = bankTurn('sess-gate', 'User: refused turn one.');
    const r = await captureErr(async () => {
      scheduleCheckpointHarvest({
        engine: refusingEngine('writer_lock_unavailable'),
        sourceId: 'default', sessionId: 'sess-gate', corpusDir, file, capabilities: KEYED,
      });
      await __drainCheckpointHarvestForTests();
    });

    expect(r.err).toContain('[checkpoint-harvest] harvest failed (operationerror:writer_lock_unavailable)');
    const tail = await readHeartbeatTail(20);
    const hb = tail.find((e) => e.event === 'checkpoint-harvest' && e.outcome === 'error');
    expect(hb?.reason).toBe('operationerror:writer_lock_unavailable');
  });

  test('the same reason warns only once per serve run; a different code warns again', async () => {
    const f1 = bankTurn('sess-gate2a', 'User: refused turn two.');
    const f2 = bankTurn('sess-gate2b', 'User: refused turn three.');
    const r = await captureErr(async () => {
      scheduleCheckpointHarvest({
        engine: refusingEngine('writer_lock_unavailable'),
        sourceId: 'default', sessionId: 'sess-gate2a', corpusDir, file: f1, capabilities: KEYED,
      });
      await __drainCheckpointHarvestForTests();
      scheduleCheckpointHarvest({
        engine: refusingEngine('writer_lock_unavailable'),
        sourceId: 'default', sessionId: 'sess-gate2b', corpusDir, file: f2, capabilities: KEYED,
      });
      await __drainCheckpointHarvestForTests();
    });

    const warns = r.err.split('\n').filter((l) => l.includes('writer_lock_unavailable'));
    // First test already warned this reason in-process → zero lines here;
    // either way the process emits it at most once. Assert ≤1 across the file.
    expect(warns.length).toBeLessThanOrEqual(1);

    const f3 = bankTurn('sess-gate3', 'User: refused turn four.');
    const r3 = await captureErr(async () => {
      scheduleCheckpointHarvest({
        engine: refusingEngine('idempotency_conflict'),
        sourceId: 'default', sessionId: 'sess-gate3', corpusDir, file: f3, capabilities: KEYED,
      });
      await __drainCheckpointHarvestForTests();
    });
    expect(r3.err).toContain('operationerror:idempotency_conflict');

    const tail = await readHeartbeatTail(20);
    const reasons = tail.filter((e) => e.event === 'checkpoint-harvest' && e.outcome === 'error').map((e) => e.reason);
    expect(reasons).toContain('operationerror:idempotency_conflict');
  });
});

describe('doctor memory_writeback error-share warn (#5557 ask 3)', () => {
  async function enableWriteback(home: string): Promise<void> {
    await engine.setConfig('memory.auto_writeback', 'salient');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', memory: { auto_writeback: 'salient' } }) + '\n');
  }

  async function seedWriteback(events: Array<{ outcome: 'ok' | 'error' | 'degraded'; reason?: string }>): Promise<void> {
    for (const e of events) {
      await writeHeartbeat({ ts: new Date().toISOString(), event: 'writeback', outcome: e.outcome, duration_ms: 1, ...(e.reason ? { reason: e.reason } : {}) }, { trim: false });
    }
  }

  test('structural failure share warns and names the top refusing gates', async () => {
    await enableWriteback(homeDir);
    await seedWriteback([
      ...Array.from({ length: 4 }, () => ({ outcome: 'error' as const, reason: 'operationerror:writer_lock_unavailable' })),
      { outcome: 'error', reason: 'operationerror:idempotency_conflict' },
      ...Array.from({ length: 7 }, () => ({ outcome: 'ok' as const })),
    ]);

    const c = await buildMemoryWritebackCheck(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('5/12');
    expect(c.message).toContain('writer_lock_unavailable');
    const reasons = (c.details?.backstop_7d as Record<string, unknown>).error_reasons as Record<string, number>;
    expect(reasons['operationerror:writer_lock_unavailable']).toBe(4);
    expect(reasons['operationerror:idempotency_conflict']).toBe(1);
  });

  test('a sparse failure does not warn but still surfaces the reason histogram', async () => {
    await enableWriteback(homeDir);
    await seedWriteback([
      { outcome: 'error', reason: 'operationerror:writer_lock_unavailable' },
      ...Array.from({ length: 11 }, () => ({ outcome: 'ok' as const })),
    ]);

    const c = await buildMemoryWritebackCheck(engine);
    expect(c.status).not.toBe('warn');
    const reasons = (c.details?.backstop_7d as Record<string, unknown>).error_reasons as Record<string, number>;
    expect(reasons['operationerror:writer_lock_unavailable']).toBe(1);
  });
});
