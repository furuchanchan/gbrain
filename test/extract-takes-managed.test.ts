/**
 * #5728 — on a managed brain the v0.28.0 orchestrator's takes backfill was
 * refused `writer_coordinator_required` by the managed_writer_guard on
 * `takes`, recording `partial` on every run until the migration wedged and
 * every later orchestrator migration stayed pending. The backfill is a
 * maintenance writer of a derived index: it must run inside the
 * coordinator capability covering the enumerated sources.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTakesFromDb } from '../src/core/cycle/extract-takes.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';
import { __testing } from '../src/commands/migrations/v0_28_0.ts';

let engine: PGLiteEngine;

const ALICE_BODY = `# Alice Example

## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | CEO of Acme | fact | world | 1.0 | 2017-01 | Crustdata |
| 2 | Strong technical founder | take | garry | 0.85 | 2026-04-29 | notes |
${TAKES_FENCE_END}
`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // The fence page was written before managed persistence activated (its own
  // INSERT would need the grant now); the takes index still needs the
  // backfill the orchestrator runs.
  await engine.putPage('people/alice-example', {
    title: 'Alice', type: 'person', compiled_truth: ALICE_BODY,
  });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('extractTakesFromDb on a managed brain (#5728)', () => {
  test('the v0.28.0 backfill phase completes instead of refusing writer_coordinator_required', async () => {
    const phase = await __testing.phaseBBackfill(engine, {
      yes: true, dryRun: false, noAutopilotInstall: true,
    });
    expect(phase.status).toBe('complete');
    const takes = await engine.listTakes({ page_id: (await engine.getPage('people/alice-example', { sourceId: 'default' }))!.id });
    expect(takes.map(t => t.claim)).toContain('CEO of Acme');
    expect(takes.map(t => t.claim)).toContain('Strong technical founder');
  });

  test('extractTakesFromDb and rebuild writes both pass the managed writer guard', async () => {
    const fresh = await extractTakesFromDb(engine);
    expect(fresh.pagesScanned).toBe(1);
    expect(fresh.takesUpserted).toBe(2);
    const rebuilt = await extractTakesFromDb(engine, { rebuild: true });
    expect(rebuilt.takesUpserted).toBe(2);
    const all = await engine.executeRaw<{ row_num: number }>(
      'SELECT row_num FROM takes WHERE page_id = $1 ORDER BY row_num',
      [(await engine.getPage('people/alice-example', { sourceId: 'default' }))!.id],
    );
    expect(all.map(t => t.row_num)).toEqual([1, 2]);
  });

  test('the write_sources grant restores after the backfill (no capability leak)', async () => {
    const [row] = await engine.executeRaw<{ value: string }>(
      "SELECT current_setting('gbrain.write_sources',true) AS value",
    );
    expect(row?.value ?? '').toBe('');
  });
});
