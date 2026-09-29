// #5693 — a second `gbrain apply-migrations` must refuse while another run
// holds the brain (Postgres single-runner guard via gbrain_cycle_locks).
// The Postgres acquire/refuse path runs under CI's DATABASE_URL lanes; here
// we pin the lock id's serialization on the shared primitive plus the
// wiring that keeps the guard in the mutating path only.
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock, inspectLock } from '../src/core/db-lock.ts';

const SOURCE = readFileSync(join(resolve(import.meta.dir, '..'), 'src/commands/apply-migrations.ts'), 'utf8');
const LOCK_ID = 'gbrain-apply-migrations';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

describe('apply-migrations single-runner lock (#5693)', () => {
  test('the lock id serializes: a second acquire is refused while held, freed on release', async () => {
    const first = await tryAcquireDbLock(engine, LOCK_ID, 10);
    expect(first).not.toBeNull();
    expect(await tryAcquireDbLock(engine, LOCK_ID, 10)).toBeNull();
    const snap = await inspectLock(engine, LOCK_ID);
    expect(snap?.holder_pid).toBe(process.pid);
    expect(snap?.ttl_expired).toBe(false);
    await first!.release();
    const second = await tryAcquireDbLock(engine, LOCK_ID, 10);
    expect(second).not.toBeNull();
    await second!.release();
  });

  test('guard placement: acquires before the orchestrator loop, refuses by throwing, releases on every exit', () => {
    const guardIdx = SOURCE.indexOf('single-runner guard');
    const toRunIdx = SOURCE.indexOf('const toRun');
    const releaseIdx = SOURCE.indexOf('const releaseRunLock');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(toRunIdx).toBeGreaterThan(guardIdx); // lock is held before work is scheduled
    expect(releaseIdx).toBeGreaterThan(guardIdx);
    // Held → refusal propagates (in-process upgrade callers catch it;
    // standalone CLI exits non-zero at the top level).
    expect(SOURCE).toContain('Another apply-migrations run already holds this brain');
    // Released on the no-work exits and the failed-run exit, not just success.
    const afterReleaseDef = SOURCE.slice(releaseIdx);
    expect(afterReleaseDef).toContain('await releaseRunLock();');
    // Read-only surfaces never lock: the guard sits after the --list/--dryRun exits.
    expect(SOURCE.indexOf('if (cli.list)')).toBeLessThan(guardIdx);
    expect(SOURCE.indexOf('if (cli.dryRun)')).toBeLessThan(guardIdx);
    // --list reports the in-flight holder so the upgrade guide's check can
    // distinguish "still running" from "never finished".
    expect(SOURCE).toContain('await printInFlightRunLine();');
    expect(SOURCE).toContain("cfg?.engine !== 'postgres'");
  });
});
