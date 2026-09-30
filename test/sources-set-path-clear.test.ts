/**
 * gbrain sources set-path <id> --clear|--null + autopilot connector skip (#5673)
 *
 * Connector-managed sources (config.kind google/github) legitimately carry a
 * local_path nothing owns — their connector-managed root. The autopilot
 * freshness loop submitted a legacy `sync` job for every source with a
 * local_path, which assertManagedFilesystemWrite always refuses, minting a
 * refused job per connector source per cycle; and there was no supported way
 * back to NULL short of editing the DB by hand.
 *
 * Validates:
 *   - The freshness dispatch loop skips connector-managed sources (wiring
 *     assertion — the loop lives inside the runAutopilot daemon, so this pins
 *     the guard the way autopilot-fanout-wiring.test.ts pins dispatchPerSource).
 *   - Happy path: an unbound connector source's local_path clears to NULL.
 *   - Filesystem sources are refused (exit 6): their local_path is the
 *     write-through identity, repoint-only.
 *   - A source whose current incarnation still has a connector binding is
 *     refused (exit 7): the binding verifies its canonical root against
 *     local_path. A stale-incarnation binding clears fine.
 *   - Unknown source → exit 4; --clear plus a path argument → exit 2.
 *
 * Discrimination: every assertion is executable against the pre-fix tree —
 * imports resolve (runSources / PGLiteEngine predate the fix), so on old code
 * each test runs and fails on its EXPECT, not on module load. `--clear`
 * through the old runSetPath was treated as the <path> argument → exit 5
 * (nonexistent dir), never touching local_path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';

const AUTOPILOT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

describe('gbrain sources set-path --clear (#5673)', () => {
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

  /** Every set-path call goes through the exit stub; a rejected command
   *  throws __test_exit_N__. Callers assert exitCode / the DB state. */
  async function trySetPath(args: string[]): Promise<void> {
    try {
      await runSources(engine, ['set-path', ...args]);
    } catch (err) {
      if (!(err as Error).message.startsWith('__test_exit_')) throw err;
    }
  }

  test('autopilot freshness loop skips connector-managed sources (wiring)', () => {
    // The loop is inside the runAutopilot daemon — same wiring-assertion
    // convention as autopilot-fanout-wiring.test.ts. The guard must sit
    // inside the freshness `sync` dispatch (before queue.add('sync', …)),
    // next to the existing isSyncDisabledConfig gate.
    expect(AUTOPILOT_SRC).toMatch(/sourceIsConnectorManaged\(src\.config\)\) continue/);
  });

  test('connector-kind predicate classifies google/github and rejects filesystem', async () => {
    // Resolved at call time so the suite still LOADS on a pre-fix tree —
    // the export is absent there and every assertion below fails by value.
    const mod = await import('../src/core/sources-load.ts');
    const isConnectorManaged = (mod as Record<string, unknown>)
      .sourceIsConnectorManaged as ((c: unknown) => boolean) | undefined;
    expect(isConnectorManaged?.({ kind: 'google' })).toBe(true);
    expect(isConnectorManaged?.({ kind: 'github' })).toBe(true);
    expect(isConnectorManaged?.(JSON.stringify({ kind: 'google' }))).toBe(true);
    expect(isConnectorManaged?.({})).toBe(false);
    expect(isConnectorManaged?.({ kind: 'filesystem' })).toBe(false);
    expect(isConnectorManaged?.(null)).toBe(false);
  });

  test('happy path: --clear NULLs an unbound connector source local_path', async () => {
    await insertConnectorSource('gconn', 'google');
    expect(await readLocalPath('gconn')).toBe('/nonexistent/connector-root');
    await trySetPath(['gconn', '--clear']);
    // Pre-fix: '--clear' was taken as <path>, exited 5 on the nonexistent
    // dir, and local_path stayed untouched — the stranded-root bug.
    expect(exitCode).toBeNull();
    expect(await readLocalPath('gconn')).toBeNull();
  });

  test('happy path: --null alias clears the same way', async () => {
    await insertConnectorSource('ghconn', 'github');
    await trySetPath(['ghconn', '--null']);
    expect(exitCode).toBeNull();
    expect(await readLocalPath('ghconn')).toBeNull();
  });

  test('rejection: filesystem source → exit 6 (repoint-only, never cleared)', async () => {
    const before = await readLocalPath('default');
    await trySetPath(['default', '--clear']);
    expect(exitCode).toBe(6);
    expect(await readLocalPath('default')).toBe(before); // no mutation
  });

  test('rejection: connector source with an incarnation-matched binding → exit 7', async () => {
    const incarnation = await insertConnectorSource('boundconn', 'google');
    await bindSource('boundconn', incarnation);
    await trySetPath(['boundconn', '--clear']);
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
    await trySetPath(['rebornconn', '--clear']);
    expect(exitCode).toBeNull();
    expect(await readLocalPath('rebornconn')).toBeNull();
  });

  test('rejection: unknown source → exit 4 (loud, never a silent 0-row UPDATE)', async () => {
    await trySetPath(['nonexistent-connector', '--clear']);
    expect(exitCode).toBe(4);
  });

  test('rejection: --clear with a path argument → exit 2 (usage)', async () => {
    await insertConnectorSource('argconn', 'google');
    await trySetPath(['argconn', '/tmp/wherever', '--clear']);
    expect(exitCode).toBe(2);
    expect(await readLocalPath('argconn')).toBe('/nonexistent/connector-root');
  });
});
