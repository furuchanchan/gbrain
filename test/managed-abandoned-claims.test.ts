import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { configDir } from '../src/core/config.ts';
import { localHostId, persistenceHome } from '../src/core/persistence/identity.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath, reservePhysicalRootRecord, writePhysicalRootStamp } from '../src/core/persistence/physical-root-record.ts';
import { canonicalFilesystemPath } from '../src/core/persistence/root-registry.ts';
import { assertLegacyFilesystemWriter, assertManagedFilesystemWrite } from '../src/core/persistence/filesystem-guard.ts';
import { cleanupRetiredManagedMarkers } from '../src/core/persistence/deactivation.ts';
import { withEnv } from './helpers/with-env.ts';

/**
 * #2920: a claim's marker files land inside its transaction, so a rolled-back
 * or interrupted claim leaves `.gbrain-owner-*` residue that fences every
 * legacy write while `sources writer status` reports the coordination system
 * disabled and empty. The marker cleanup is the verified drain: it removes
 * files whose recorded worktree never committed, keeps live claims and other
 * hosts' evidence, and the legacy-writer assert drains before refusing.
 */
let engine: BrainEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-abandoned-claims-'));
const root = join(home, 'claimed-repo');
let brainId: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  mkdirSync(root, { recursive: true });
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  brainId = brain!.brain_id;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',
    ['claimed-repo', root, JSON.stringify({})]);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

/** Craft the files claimPhysicalRoot writes, then age them past the in-flight window. */
function abandonedClaim(worktreeId: string, hostId: string) {
  // createPrivate writes exclusively; drop earlier residue so this claim is fresh.
  rmSync(physicalRootReservationPath(root), { force: true });
  rmSync(join(root, PHYSICAL_ROOT_MARKER), { force: true });
  const reservation = reservePhysicalRootRecord(root,
    { brainId, worktreeId, hostId, coordinationPath: join(persistenceHome(), 'locks', `${worktreeId}.lock`) });
  writePhysicalRootStamp(root, reservation);
  const past = new Date(Date.now() - 120_000);
  utimesSync(physicalRootReservationPath(root), past, past);
  utimesSync(join(root, PHYSICAL_ROOT_MARKER), past, past);
  return reservation;
}

const fence = () => expect(() => assertManagedFilesystemWrite(join(root, 'page.md'))).toThrow('managed canonical worktree');

test('an uncommitted claim\'s marker residue is drained by the legacy-writer assert, then sync can proceed (#2920)', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    abandonedClaim(randomUUID(), localHostId());
    fence();
    await assertLegacyFilesystemWriter(engine, join(root, 'page.md'));
    expect(existsSync(physicalRootReservationPath(root))).toBe(false);
    expect(existsSync(join(root, PHYSICAL_ROOT_MARKER))).toBe(false);
    expect(() => assertManagedFilesystemWrite(join(root, 'page.md'))).not.toThrow();
  });
});

test('a committed worktree keeps its markers and the legacy write stays fenced (#2920)', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const worktreeId = randomUUID();
    abandonedClaim(worktreeId, localHostId());
    await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch) VALUES($1::uuid,$2::uuid,1)',
      [worktreeId, localHostId()]);
    await expect(assertLegacyFilesystemWriter(engine, join(root, 'page.md'))).rejects.toThrow('managed canonical worktree');
    expect(existsSync(physicalRootReservationPath(root))).toBe(true);
    await engine.executeRaw('DELETE FROM persistence_worktrees WHERE id=$1::uuid', [worktreeId]);
  });
});

test('another host\'s uncommitted claim residue is kept, and the fence still names it (#2920)', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    abandonedClaim(randomUUID(), randomUUID());
    await expect(assertLegacyFilesystemWriter(engine, join(root, 'page.md'))).rejects.toThrow('managed canonical worktree');
    expect(existsSync(physicalRootReservationPath(root))).toBe(true);
    rmSync(physicalRootReservationPath(root), { force: true });
    rmSync(join(root, PHYSICAL_ROOT_MARKER), { force: true });
  });
});

test('a managed-root registry record of an uncommitted claim is drained by the cleanup (#2920)', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const worktreeId = randomUUID();
    const canonical = canonicalFilesystemPath(root);
    const registryDir = join(configDir(), 'persistence', 'managed-roots');
    mkdirSync(registryDir, { recursive: true });
    const record = join(registryDir, `${brainId}.${createHash('sha256').update(canonical).digest('hex')}.json`);
    writeFileSync(record, JSON.stringify({ version: 1, brain_id: brainId, root: canonical, local_path: canonical, worktree_id: worktreeId }));
    const past = new Date(Date.now() - 120_000);
    utimesSync(record, past, past);
    const report = await cleanupRetiredManagedMarkers(engine);
    expect(report.removed).toContain(record);
    expect(() => assertManagedFilesystemWrite(join(root, 'page.md'))).not.toThrow();
  });
});
