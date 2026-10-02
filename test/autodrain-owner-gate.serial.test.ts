/**
 * #5856 — the auto-drain owner gate: `managedAtomOwnerGate` is the single
 * predicate both `managedAtomSession` (throw) and the autopilot
 * `dispatchAutoDrain` (skip) evaluate. A source with a configured root but
 * no canonical owner on this host must report `blocked`, so dispatch never
 * submits a drain job that can only retry and dead-letter.
 *
 * These tests fail on pre-fix trees at the first `typeof` assertion (the
 * gate does not exist yet); the parity assertion — gate blocked AND session
 * throwing owner_unavailable for the same source — is the load-bearing
 * proof that dispatch-skip and session-throw cannot drift apart.
 *
 * Serial: shares one PGLite engine across tests and flips
 * `persistence_brain.enabled`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import * as atomMaintenance from '../src/core/persistence/atom-maintenance.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-5856-home-'));
let engine: PGLiteEngine;

// Pre-fix trees have no gate: assert the export exists via a real expect
// (executed-assertion discrimination), then use it.
const managedAtomOwnerGate = (...args: Parameters<typeof atomMaintenance.managedAtomOwnerGate>) =>
  atomMaintenance.managedAtomOwnerGate(...args);
const managedAtomSession = (...args: Parameters<typeof atomMaintenance.managedAtomSession>) =>
  atomMaintenance.managedAtomSession(...args);
function gateExists(): void {
  expect(typeof atomMaintenance.managedAtomOwnerGate).toBe('function');
}

/**
 * Insert a source (and optionally claim its worktree) while persistence is
 * OFF — source topology writes require the writer coordinator once managed
 * persistence is enabled — then flip it back on and run `fn` under a
 * fixture GBRAIN_HOME (host identity lives there).
 */
async function withManagedSource<T>(
  localPath: string | null,
  opts: { claim?: boolean; foreignOwner?: boolean },
  fn: (id: string) => Promise<T>,
): Promise<T> {
  const id = `s-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  if (localPath) mkdirSync(localPath, { recursive: true });
  // withEnv wraps the WHOLE fixture: claimWorktree and the gate must resolve
  // the same host identity (localHostId reads GBRAIN_HOME/host.json).
  return withEnv({ GBRAIN_HOME: home }, async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, localPath]);
    if (opts.claim && localPath) await claimWorktree(engine, id, localPath);
    if (opts.foreignOwner) {
      await engine.executeRaw(
        `UPDATE persistence_worktrees SET owner_host_id=$1
         WHERE id=(SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$2)`,
        [randomUUID(), id],
      );
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    return fn(id);
  });
}

describe('#5856 — managedAtomOwnerGate mirrors the session refusal', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  test('exported gate exists (load-bearing discrimination anchor)', () => {
    gateExists();
  });

  test('root configured, no worktree binding → blocked: no_binding, and the session throws owner_unavailable', () =>
    withManagedSource(join(home, 'repo-unbound'), { claim: false }, async (id) => {
      gateExists();
      const gate = await managedAtomOwnerGate(engine, { id, local_path: join(home, 'repo-unbound') });
      expect(gate.blocked).toBe('no_binding');
      expect(gate.writeThrough).toBe(true);
      // Parity: the session refuses the SAME source with the SAME failure
      // the drain job was dead-lettering on — skipping at dispatch is exact.
      const err = await managedAtomSession(engine, id).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(OperationError);
      expect((err as OperationError).code).toBe('owner_unavailable');
    }));

  test('claimed local worktree → not blocked (the canonical owner may drain)', () =>
    withManagedSource(join(home, 'repo-claimed'), { claim: true }, async (id) => {
      gateExists();
      const gate = await managedAtomOwnerGate(engine, { id, local_path: join(home, 'repo-claimed') });
      expect(gate.blocked).toBeNull();
      expect(gate.binding).not.toBeNull();
      expect(gate.binding!.owner_host_id).not.toBeNull();
    }));

  test('write-through disabled → not blocked (database-only session)', () =>
    withManagedSource(join(home, 'repo-wtoff'), { claim: false }, async (id) => {
      gateExists();
      await engine.setConfig('sync.write_through', 'false');
      const gate = await managedAtomOwnerGate(engine, { id, local_path: join(home, 'repo-wtoff') });
      expect(gate.writeThrough).toBe(false);
      expect(gate.blocked).toBeNull();
    }));

  test('no local_path and not default → no root → not blocked', () =>
    withManagedSource(null, { claim: false }, async (id) => {
      gateExists();
      const gate = await managedAtomOwnerGate(engine, { id, local_path: null });
      expect(gate.root).toBeNull();
      expect(gate.blocked).toBeNull();
    }));

  test('binding owned by a different host → blocked: owner_unavailable', () =>
    withManagedSource(join(home, 'repo-remote-owner'), { claim: true, foreignOwner: true }, async (id) => {
      gateExists();
      const gate = await managedAtomOwnerGate(engine, { id, local_path: join(home, 'repo-remote-owner') });
      expect(gate.blocked).toBe('owner_unavailable');
      const err = await managedAtomSession(engine, id).then(() => null, (e) => e);
      expect((err as OperationError | null)?.code).toBe('owner_unavailable');
    }));
});
