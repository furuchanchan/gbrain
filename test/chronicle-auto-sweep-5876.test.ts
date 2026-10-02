/**
 * #5876 — `auto_chronicle=true` has enqueued zero chronicle_extract jobs
 * since v0.51.0.0: the put_page backstop lost its caller and nothing replaced
 * it. The extract phase of the cycle now runs sweepChronicleCandidates —
 * watermark-forward, idempotency-keyed, gated on the config + a chat provider.
 *
 * PGLite in-memory; the cycle test drives the REAL runCycle extract phase.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { sweepChronicleCandidates } from '../src/core/chronicle/sweep.ts';
import { runCycle } from '../src/core/cycle.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
const LONG = 'B'.repeat(120);

const chatOn = () =>
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-test' } } as never);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
});
afterAll(async () => { resetGateway(); await engine.disconnect(); });
// resetPgliteState wipes config; the queue's schema gate needs 'version' back.
beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig('version', schemaVersion); resetGateway(); });

const jobCount = async () =>
  Number((await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM minion_jobs WHERE name='chronicle_extract'`))[0].n);

describe('sweepChronicleCandidates (#5876)', () => {
  test('enqueues chronicle_extract for eligible pages when auto_chronicle is on', async () => {
    await engine.setConfig('auto_chronicle', 'true');
    chatOn();
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await engine.putPage('life/diary/d1', { type: 'diary', title: 'd1', compiled_truth: LONG }); // excluded
    const r = await sweepChronicleCandidates(engine, {});
    expect(r.enqueued).toBe(1);
    expect(r.errors).toBe(0);
    expect(await jobCount()).toBe(1);
    const jobs = await engine.executeRaw<{ data: { slug: string }; idempotency_key: string }>(
      `SELECT data, idempotency_key FROM minion_jobs WHERE name='chronicle_extract'`);
    expect(jobs[0].data.slug).toBe('meetings/m1');
    expect(jobs[0].idempotency_key?.startsWith('chronicle:')).toBe(true);
  });

  test('skips without enqueuing when auto_chronicle is off (default)', async () => {
    chatOn();
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    const r = await sweepChronicleCandidates(engine, {});
    expect(r.skipped).toBe('auto_chronicle_off');
    expect(await jobCount()).toBe(0);
  });

  test('skips when no chat provider is available', async () => {
    await engine.setConfig('auto_chronicle', 'true');
    resetGateway(); // no chat_model configured → isAvailable('chat') false
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    const r = await sweepChronicleCandidates(engine, {});
    expect(r.skipped).toBe('chat_unavailable');
    expect(await jobCount()).toBe(0);
  });

  test('is forward-only: a re-sweep enqueues nothing new, a content change re-candidates', async () => {
    await engine.setConfig('auto_chronicle', 'true');
    chatOn();
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    await sweepChronicleCandidates(engine, {});
    const second = await sweepChronicleCandidates(engine, {});
    expect(second.enqueued).toBe(0);
    expect(await jobCount()).toBe(1);
    // A real content change bumps updated_at → a fresh idempotency key → re-extract.
    await engine.executeRaw(`UPDATE pages SET updated_at = updated_at + interval '1 second' WHERE slug='meetings/m1'`);
    const third = await sweepChronicleCandidates(engine, {});
    expect(third.enqueued).toBe(1);
    expect(await jobCount()).toBe(2);
  });

  test('scopes the sweep to the cycle source', async () => {
    await engine.setConfig('auto_chronicle', 'true');
    chatOn();
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other-src', 'other-src') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('meetings/default-src', { type: 'meeting', title: 'default', compiled_truth: LONG });
    await engine.putPage('meetings/other-src', { type: 'meeting', title: 'other', compiled_truth: LONG }, { sourceId: 'other-src' });
    const r = await sweepChronicleCandidates(engine, { sourceId: 'other-src' });
    expect(r.enqueued).toBe(1);
    const jobs = await engine.executeRaw<{ data: { slug: string } }>(
      `SELECT data FROM minion_jobs WHERE name='chronicle_extract'`);
    expect(jobs[0].data.slug).toBe('meetings/other-src');
  });
});

describe('cycle extract phase hook (#5876)', () => {
  test('runCycle extract phase enqueues chronicle candidates and reports details', async () => {
    await engine.setConfig('auto_chronicle', 'true');
    chatOn();
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'm1', compiled_truth: LONG });
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-5876-'));
    const report = await runCycle(engine, { brainDir, phases: ['extract'] });
    const extract = report.phases.find((p) => p.phase === 'extract');
    expect(extract?.status).toBe('ok');
    expect(extract?.details?.chronicle_enqueued).toBe(1);
    expect(await jobCount()).toBe(1);
  });

  test('runCycle extract phase reports the skip reason when auto_chronicle is off', async () => {
    chatOn();
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-5876-'));
    const report = await runCycle(engine, { brainDir, phases: ['extract'] });
    const extract = report.phases.find((p) => p.phase === 'extract');
    expect(extract?.status).toBe('ok');
    expect(extract?.details?.chronicle_skipped).toBe('auto_chronicle_off');
    expect(extract?.details?.chronicle_enqueued).toBe(0);
    expect(await jobCount()).toBe(0);
  });
});
