/**
 * #6177 — the patterns phase measures its own submitted runs
 * (`dream.patterns.last_run_ms`, per source/incarnation like the evidence
 * watermark) and skips `insufficient_cycle_budget` when the clamped budget
 * is below that recent run time, instead of submitting a child that dies
 * mid-flight after spending its tokens. A dead child still stamps — it is
 * a real measurement of what the evidence costs to process.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await seedReflections(3);
  // Probe-passing model with a stubbed (offline) provider key.
  await engine.setConfig('models.dream.patterns', 'openai:gpt-5.4');
});

async function seedReflections(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, updated_at)
       VALUES ($1, 'note', $1, 'reflection body', NOW())`,
      [`wiki/personal/reflections/r-${i}`],
    );
  }
}

const submit = () =>
  withEnv(
    { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: 'sk-test' },
    () => runPhasePatterns(engine, {
      brainDir: '/tmp',
      dryRun: false,
      // ~9 min clamped child budget after the reserve — comfortably above
      // MIN_PATTERNS_SUBAGENT_BUDGET_MS so only the run-time guard can skip.
      deadlineAtMs: Date.now() + 10 * 60 * 1000,
    }),
  );

const subagentJobCount = async () =>
  (await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM minion_jobs WHERE name = 'subagent'`,
  ))[0]!.n;

describe('#6177 recent-run-time budget guard', () => {
  test('a clamped budget below the recorded run time skips without submitting a child', async () => {
    await engine.setConfig('dream.patterns.last_run_ms', String(30 * 60 * 1000));
    const offline = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('offline'); }) as never);
    let result;
    try {
      result = await submit();
    } finally {
      offline.mockRestore();
    }
    expect(result.status).toBe('skipped');
    expect(result.details.reason).toBe('insufficient_cycle_budget');
    expect(result.summary).toContain('recent run time');
    expect(await subagentJobCount()).toBe(0);
  });

  test('a budget above the recorded run time submits, and the terminal outcome re-stamps it', async () => {
    await engine.setConfig('dream.patterns.last_run_ms', String(60 * 1000));
    const offline = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('offline'); }) as never);
    let result;
    try {
      result = await submit();
    } finally {
      offline.mockRestore();
    }
    // The guard let the run through; the dead-lettered child is a terminal
    // outcome, so last_run_ms was re-stamped with this run's wall time.
    expect(result.details.reason).not.toBe('insufficient_cycle_budget');
    expect(await subagentJobCount()).toBe(1);
    const stamped = Number(await engine.getConfig('dream.patterns.last_run_ms'));
    expect(Number.isFinite(stamped) && stamped > 0).toBe(true);
    expect(stamped).not.toBe(60 * 1000);
  }, 60_000);

  test('no stamp fails open: the first run submits normally', async () => {
    const offline = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('offline'); }) as never);
    try {
      await submit();
    } finally {
      offline.mockRestore();
    }
    expect(await subagentJobCount()).toBe(1);
  }, 60_000);
});
