/**
 * gbrain sources set-path <id> --clear|--null (#5673)
 *
 * Supported repair for a connector-managed source stranded with a
 * local_path nothing owns. Validates:
 *   - Happy path: an unbound connector source's local_path clears to NULL.
 *   - Filesystem sources are refused (exit 6): their local_path is the
 *     write-through identity, repoint-only.
 *   - A source whose current incarnation still has a connector binding is
 *     refused (exit 7): the binding verifies its canonical root against
 *     local_path.
 *   - Unknown source → exit 4; --clear plus a path argument → exit 2.
 *   - sourceIsConnectorManaged covers google/github kinds on object and
 *     string configs and stays false for filesystem sources.
 *
 * Modeled on test/sources-set-path.test.ts (same runSources dispatch,
 * same process.exit stub).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';
import { sourceIsConnectorManaged } from '../src/core/sources-load.ts';

describe('gbrain sources set-path --clear', () => {
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

  async function readLocalPath(id: string): Promise<string | null> {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = $1`,
      [id],
    );
    return rows[0]?.local_path ?? null;
  }

  async function insertConnectorSource(id: string, kind: 'google' | 'github'): Promise<string> {
    const [row] = await engine.executeRaw<{ incarnation: string }>(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, '/nonexistent/connector-root', jsonb_build_object('kind', $2::text))
       RETURNING incarnation::text`,
      [id, kind],
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

  test('sourceIsConnectorManaged recognizes connector kinds and rejects filesystem configs', () => {
    expect(sourceIsConnectorManaged({ kind: 'google' })).toBe(true);
    expect(sourceIsConnectorManaged({ kind: 'github' })).toBe(true);
    expect(sourceIsConnectorManaged(JSON.stringify({ kind: 'google' }))).toBe(true);
    expect(sourceIsConnectorManaged({})).toBe(false);
    expect(sourceIsConnectorManaged({ kind: 'filesystem' })).toBe(false);
    expect(sourceIsConnectorManaged(null)).toBe(false);
  });

  test('happy path: clears an unbound connector source local_path to NULL', async () => {
    await insertConnectorSource('gconn', 'google');
    expect(await readLocalPath('gconn')).toBe('/nonexistent/connector-root');
    await runSources(engine, ['set-path', 'gconn', '--clear']);
    expect(await readLocalPath('gconn')).toBeNull();
  });

  test('happy path: --null alias clears the same way', async () => {
    await insertConnectorSource('ghconn', 'github');
    await runSources(engine, ['set-path', 'ghconn', '--null']);
    expect(await readLocalPath('ghconn')).toBeNull();
  });

  test('rejection: filesystem source → exit 6 (repoint-only, never cleared)', async () => {
    const before = await readLocalPath('default');
    try {
      await runSources(engine, ['set-path', 'default', '--clear']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_6__');
    }
    expect(exitCode).toBe(6);
    expect(await readLocalPath('default')).toBe(before); // no mutation
  });

  test('rejection: connector source with an incarnation-matched binding → exit 7', async () => {
    const incarnation = await insertConnectorSource('boundconn', 'google');
    await bindSource('boundconn', incarnation);
    try {
      await runSources(engine, ['set-path', 'boundconn', '--clear']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_7__');
    }
    expect(exitCode).toBe(7);
    expect(await readLocalPath('boundconn')).toBe('/nonexistent/connector-root');
  });

  test('rejection: connector source bound under a DIFFERENT incarnation still clears', async () => {
    const staleIncarnation = '00000000-0000-0000-0000-00000000beef';
    const incarnation = await insertConnectorSource('rebornconn', 'google');
    expect(incarnation).not.toBe(staleIncarnation);
    await bindSource('rebornconn', staleIncarnation);
    // A stale-incarnation binding no longer verifies this source's root —
    // checkedConnectorBinding would reject it as source_changed anyway.
    await runSources(engine, ['set-path', 'rebornconn', '--clear']);
    expect(await readLocalPath('rebornconn')).toBeNull();
  });

  test('rejection: unknown source → exit 4 (loud, never a silent 0-row UPDATE)', async () => {
    try {
      await runSources(engine, ['set-path', 'nonexistent-connector', '--clear']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_4__');
    }
    expect(exitCode).toBe(4);
  });

  test('rejection: --clear with a path argument → exit 2 (usage)', async () => {
    await insertConnectorSource('argconn', 'google');
    try {
      await runSources(engine, ['set-path', 'argconn', '/tmp/wherever', '--clear']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_2__');
    }
    expect(exitCode).toBe(2);
    expect(await readLocalPath('argconn')).toBe('/nonexistent/connector-root');
  });
});
