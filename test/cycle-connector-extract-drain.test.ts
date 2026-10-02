/**
 * #5875 — a per-source autopilot cycle for a connector source runs with
 * brainDir === null (the source has no checkout). The extract phase used to
 * skip with `no_brain_dir`, so a managed brain's Google connector pages never
 * got link/timeline extraction — the only extraction path they had.
 *
 * The phase now skips the fs walk only: its source-scoped DB stale drain is
 * pure database work and still runs. This test drives the REAL runCycle with
 * brainDir: null, a connector-shaped source (local_path NULL), and a stale
 * DB page, and asserts the drain runs — plus the old skip contract flips.
 * PGLite in-memory.
 */
import { beforeAll, afterAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function connectorSource(): Promise<string> {
  const src = `connector-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(
    "INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,'{}'::jsonb)", [src]);
  return src;
}

test('connector cycle (brainDir: null) runs the extract phase drain instead of skipping it', async () => {
  const src = await connectorSource();
  await engine.putPage('emails/thread-one', {
    type: 'email', title: 'Deck thread',
    compiled_truth: 'See [[people/bob-example]] about the deck.',
  }, { sourceId: src });
  await engine.putPage('people/bob-example', {
    type: 'person', title: 'Bob Example', compiled_truth: 'A person.',
  }, { sourceId: src });
  await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1', [src]);

  const report = await runCycle(engine, { brainDir: null, sourceId: src, phases: ['extract'] });
  const extract = report.phases.find((p) => p.phase === 'extract');
  expect(extract?.status).toBe('ok');
  expect(extract?.details?.fs_walk).toBe('skipped_no_brain_dir');
  expect(extract?.details?.stale_pages_drained).toBe(2);
});

test('a connector cycle with nothing stale still reports ok, not no_brain_dir', async () => {
  const src = await connectorSource();
  const report = await runCycle(engine, { brainDir: null, sourceId: src, phases: ['extract'] });
  const extract = report.phases.find((p) => p.phase === 'extract');
  expect(extract?.status).toBe('ok');
  expect(extract?.details?.reason).not.toBe('no_brain_dir');
  expect(extract?.details?.stale_pages_drained ?? 0).toBe(0);
});
