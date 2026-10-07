/**
 * #6242 — a bare `gbrain dream` derives sourceId 'default' and used to take
 * `gbrain-cycle:default`, while autopilot's global maintenance holds the
 * legacy `gbrain-cycle` row. The two ran concurrently and the brain-wide
 * (mixed/global-scoped) phases — synthesize, patterns, grade_takes, ... —
 * executed twice at once on the same rows.
 *
 * Fix: the DB lock a cycle takes is chosen by the resolved phase set, not by
 * opts.sourceId — any non-source-scoped phase → the legacy global lock;
 * source-scoped-only selections keep the per-source lock so different
 * sources' freshness cycles can still overlap.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../src/core/db-lock.ts';
import { runCycle } from '../src/core/cycle.ts';

let engine: PGLiteEngine;
let tmpHome: string;
let prevHome: string | undefined;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cycle-scope-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpHome;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

async function withHeldLock<T>(lockId: string, work: () => Promise<T>): Promise<T> {
  const held: DbLockHandle | null = await tryAcquireDbLock(engine, lockId, 5);
  if (held === null) throw new Error(`test setup: could not acquire ${lockId}`);
  try {
    return await work();
  } finally {
    try { await held.release(); } catch { /* best effort */ }
  }
}

describe('runCycle lock scope follows the resolved phase set (#6242)', () => {
  test('mixed/global phases take the legacy gbrain-cycle lock even with a sourceId', async () => {
    // The reported bug: bare `gbrain dream` (sourceId 'default', full phase
    // set) vs autopilot (legacy lock). Holding 'gbrain-cycle' must now skip
    // the dream instead of racing its brain-wide phases.
    const report = await withHeldLock('gbrain-cycle', () =>
      runCycle(engine, { phases: ['synthesize'], sourceId: 'default', brainDir: null }));
    expect(report.status).toBe('skipped');
    expect(report.reason).toBe('cycle_already_running');
  }, 60_000);

  test('a different-source per-source lock does not block a global-phase cycle', async () => {
    // Holding 'gbrain-cycle:testsrc' must NOT block a cycle whose set
    // includes mixed/global phases — it consults the legacy row.
    const report = await withHeldLock('gbrain-cycle:testsrc', () =>
      runCycle(engine, { phases: ['synthesize'], sourceId: 'default', brainDir: null }));
    expect(report.status).not.toBe('skipped');
  }, 60_000);

  test('source-scoped-only selections keep the per-source lock', async () => {
    // A source-scoped phase set on 'testsrc' must skip while
    // 'gbrain-cycle:testsrc' is held ...
    const skipped = await withHeldLock('gbrain-cycle:testsrc', () =>
      runCycle(engine, { phases: ['lint'], sourceId: 'testsrc', brainDir: null }));
    expect(skipped.status).toBe('skipped');
    expect(skipped.reason).toBe('cycle_already_running');

    // ... and must NOT skip while only the legacy global row is held —
    // a freshness cycle can still overlap autopilot's global maintenance.
    const report = await withHeldLock('gbrain-cycle', () =>
      runCycle(engine, { phases: ['lint'], sourceId: 'testsrc', brainDir: null }));
    expect(report.status).not.toBe('skipped');
  }, 120_000);
});
