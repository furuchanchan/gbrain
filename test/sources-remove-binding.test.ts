/**
 * `sources remove` + stale claim rows (#5732)
 *
 * `persistence_source_bindings` has no FK to `sources`, so `gbrain sources
 * remove` left the claim row behind — and the claim probe in
 * `resolveSyncPersistenceMode` matched bindings by `source_id` alone. A new
 * source reusing the id then read as claimed and every sync refused with
 * `writer_coordinator_required`. Validates:
 *   - `sources remove` deletes the binding in the same transaction as the
 *     source row.
 *   - The claim probe only counts a binding whose `source_incarnation`
 *     matches the source's current incarnation — a stale row (orphaned or
 *     from a previous incarnation) no longer claims the new source.
 *   - A current-incarnation binding still claims (the refusal is preserved).
 *
 * Modeled on test/sources-set-path-clear.test.ts (real PGLite, runSources
 * dispatch, process.exit stub).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';
import { resolveSyncPersistenceMode } from '../src/core/persistence/sync-authority.ts';

describe('sources remove cleans up persistence_source_bindings (#5732)', () => {
  let engine: PGLiteEngine;
  let origExit: typeof process.exit;
  let exitCode: number | null;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    process.exit = origExit;
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    exitCode = null;
    origExit = process.exit;
    (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
      exitCode = n;
      throw new Error(`__test_exit_${n}__`);
    }) as never;
  });

  async function insertSource(id: string): Promise<string> {
    const [row] = await engine.executeRaw<{ incarnation: string }>(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, '/nonexistent/repo', '{}'::jsonb)
       RETURNING incarnation::text`,
      [id],
    );
    return row!.incarnation;
  }

  async function bindSource(id: string, incarnation: string): Promise<void> {
    const [wt] = await engine.executeRaw<{ id: string }>(
      `INSERT INTO persistence_worktrees DEFAULT VALUES RETURNING id`,
    );
    await engine.executeRaw(
      `INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id)
       VALUES ($1, $2::uuid, $3::uuid)`,
      [id, incarnation, wt!.id],
    );
  }

  async function bindingCount(id: string): Promise<number> {
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM persistence_source_bindings WHERE source_id = $1`,
      [id],
    );
    return Number(rows[0]?.n ?? 0);
  }

  test('remove deletes the binding row in the same transaction as the source', async () => {
    const incarnation = await insertSource('claimed-src');
    await bindSource('claimed-src', incarnation);
    expect(await bindingCount('claimed-src')).toBe(1);
    await runSources(engine, ['remove', 'claimed-src', '--yes']);
    expect(await bindingCount('claimed-src')).toBe(0);
    const [src] = await engine.executeRaw(`SELECT id FROM sources WHERE id = 'claimed-src'`);
    expect(src).toBeUndefined();
  });

  test('a stale-incarnation binding no longer claims the source', async () => {
    await insertSource('reborn-src');
    await bindSource('reborn-src', '00000000-0000-0000-0000-00000000dead');
    // Pre-fix this threw writer_coordinator_required — the reporter's stuck state.
    expect(await resolveSyncPersistenceMode(engine, { sourceId: 'reborn-src' })).toBe(false);
  });

  test('a current-incarnation binding still claims the source', async () => {
    const incarnation = await insertSource('live-src');
    await bindSource('live-src', incarnation);
    const refused = await resolveSyncPersistenceMode(engine, { sourceId: 'live-src' })
      .then(() => null)
      .catch((err: { code?: string }) => err);
    expect(refused?.code).toBe('writer_coordinator_required');
  });

  test('end-to-end: remove + re-add under the same id syncs clean', async () => {
    const incarnation = await insertSource('reuse-src');
    await bindSource('reuse-src', incarnation);
    await runSources(engine, ['remove', 'reuse-src', '--yes']);
    const newIncarnation = await insertSource('reuse-src');
    expect(newIncarnation).not.toBe(incarnation);
    // The new source never had a claim — resolve must not refuse.
    expect(await resolveSyncPersistenceMode(engine, { sourceId: 'reuse-src' })).toBe(false);
  });
});
