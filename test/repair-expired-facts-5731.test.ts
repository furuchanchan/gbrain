/**
 * #5731 remaining scope: `gbrain repair expired-facts` re-activates
 * cli:-sourced facts the pre-v0.60.11 canonical projection wrongly expired
 * (fenceless page treated as an empty fence → expired_at + row_num = NULL).
 * cli: rows are never fence-owned, so that signature is always damage — but a
 * fact still covered by a fact_withdrawals record (explicit forget) or one
 * superseded in place (row_num kept) must stay expired.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runRepair, REPAIR_KINDS, type RepairHandler, type RepairScope } from '../src/core/repair/core.ts';
import { repairSpec, type RepairKindSpec } from '../src/core/repair/registry.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let scratch: string;
const scope: RepairScope = { brain_id: 'host', source_ids: ['default'] };
const logger = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'gbrain-repair-expired-facts-'));
  engine = new PGLiteEngine();
  await engine.connect({ database_path: join(scratch, 'brain') });
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  rmSync(scratch, { recursive: true, force: true });
});

const ctx = (dryRun: boolean) =>
  ({ engine, config: { engine: 'pglite', database_path: join(scratch, 'brain') }, logger, dryRun, remote: false, sourceId: 'default' }) as OperationContext;

/** Call-time imports keep the suite loading on a tree without the kind. */
const loadHandler = async (): Promise<RepairHandler | undefined> =>
  (await import('../src/core/repair/expired-facts.ts').catch(() => undefined))?.expiredFactsRepair;
const loadSpec = (): RepairKindSpec | undefined => {
  try { return repairSpec('expired-facts'); } catch { return undefined; }
};

const CLI_SOURCE = 'cli:extract-conversation-facts:terminal:v2';
const seed = async (row: { fact: string; expired: boolean; rowNum?: number | null; source?: string; entity?: string }) => {
  const [r] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (fact, kind, source, source_id, visibility, entity_slug, expired_at, row_num, source_markdown_slug)
     VALUES ($1, 'fact', $4, 'default', 'private', $3,
             CASE WHEN $5 THEN now() ELSE NULL END, $2, 'meetings/example')
     RETURNING id`,
    [row.fact, row.rowNum ?? null, row.entity ?? null, row.source ?? CLI_SOURCE, row.expired],
  );
  return r.id;
};
const expiredAt = async (id: number) =>
  (await engine.executeRaw<{ expired_at: string | null }>('SELECT expired_at::text FROM facts WHERE id=$1', [id]))[0]!.expired_at;

describe('repair expired-facts (#5731)', () => {
  test('is registered with a projection-only, no-embed spec', async () => {
    expect(REPAIR_KINDS).toContain('expired-facts');
    const spec = loadSpec();
    const repair = await loadHandler();
    expect(spec?.embeds).toBe('none');
    expect(spec?.handler).toBe(repair);
    expect(repair?.publication).toBe('projection');
    expect(repair?.embeds).toBe(false);
  });

  test('plan lists bug-expired cli facts and keeps withdrawn/superseded rows as residuals', async () => {
    await resetPgliteState(engine);
    const victim1 = await seed({ fact: 'alice-example prefers tea', expired: true, entity: 'alice-example' });
    const victim2 = await seed({ fact: 'bob-example shipped the widget', expired: true, entity: 'bob-example' });
    // Same damage signature but covered by an explicit withdrawal → keep.
    await seed({ fact: 'carol-example retracted claim', expired: true, entity: 'carol-example' });
    await engine.executeRaw(
      `INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash)
       VALUES ('default', 'private', '*', gbrain_fact_fingerprint('carol-example retracted claim'))`,
    );
    // Superseded in place keeps row_num — a legitimate expiry, not the bug.
    await seed({ fact: 'old claim about dave-example', expired: true, rowNum: 7, entity: 'dave-example' });
    // Active cli fact and a fence-sourced expired fact are outside the kind.
    await seed({ fact: 'erin-example is active', expired: false });
    await seed({ fact: 'fence-owned row', expired: true, source: 'extract' });

    const repair = await loadHandler();
    const plan = await repair!.plan(engine, scope, null);
    expect(plan.items.map(item => item.cursor.id)).toEqual([victim1, victim2]);
    expect(plan.items.map(item => item.action)).toEqual(['unexpire', 'unexpire']);
    expect(plan.residuals).toEqual({ withdrawn_kept: 1, superseded_kept: 1 });
  });

  test('resume cursor skips already-planned victims', async () => {
    const repair = await loadHandler();
    const plan = await repair!.plan(engine, scope, null);
    const partial = await repair!.plan(engine, scope, { phase: 0, id: plan.items[0]!.cursor.id });
    expect(partial.items.map(item => item.cursor.id)).toEqual([plan.items[1]!.cursor.id]);
  });

  test('apply restores only the victims, idempotent on rerun', async () => {
    const all = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM facts WHERE source LIKE 'cli:%' AND expired_at IS NOT NULL AND row_num IS NULL ORDER BY id`);
    expect(all.map(r => r.id)).toHaveLength(3); // 2 victims + 1 withdrawn-covered

    const repair = await loadHandler();
    const result = await withEnv({ GBRAIN_HOME: scratch }, () => runRepair(ctx(false), repair!, scope, { apply: true }));
    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.complete).toBe(true);
    expect(result.outcomes).toEqual({ restored: 2 });

    const plan = await repair!.plan(engine, scope, null);
    for (const item of plan.items) expect(await expiredAt(item.cursor.id)).toBeNull();

    // The withdrawn-covered and superseded rows stay expired.
    const kept = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM facts WHERE source LIKE 'cli:%' AND expired_at IS NOT NULL ORDER BY id`);
    expect(kept).toHaveLength(2);

    // A completed run resets its cursor and re-plans empty.
    const rerun = await withEnv({ GBRAIN_HOME: scratch }, () => runRepair(ctx(false), repair!, scope, { apply: true }));
    expect(rerun.affected).toBe(0);
    expect(rerun.resumed_from).toBeNull();
  });

  test('dry-run plans without touching rows and apply honors the withdrawal guard at recheck time', async () => {
    await resetPgliteState(engine);
    const victim = await seed({ fact: 'frank-example met grace-example', expired: true, entity: 'frank-example' });
    const repair = await loadHandler();
    const dry = await runRepair(ctx(true), repair!, scope, { apply: false });
    expect(dry.mode).toBe('dry_run');
    expect(dry.affected).toBe(1);
    expect(await expiredAt(victim)).not.toBeNull();

    // Withdrawn between preview and apply — the re-plan excludes it.
    await engine.executeRaw(
      `INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash)
       VALUES ('default', 'private', 'frank-example', gbrain_fact_fingerprint('frank-example met grace-example'))`);
    // runRepair re-plans at apply time, so a fact withdrawn after preview is
    // excluded before any item reaches the handler; the row stays expired.
    const result = await withEnv({ GBRAIN_HOME: scratch }, () => runRepair(ctx(false), repair!, scope, { apply: true }));
    expect(result.applied).toBe(0);
    expect(result.affected).toBe(0);
    expect(await expiredAt(victim)).not.toBeNull();
  });

  test('only in-scope sources are repaired', async () => {
    await resetPgliteState(engine);
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('mount-b', 'mount-b')`);
    const other = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (fact, kind, source, source_id, visibility, expired_at)
       VALUES ('outside claim', 'fact', $1, 'mount-b', 'private', now()) RETURNING id`, [CLI_SOURCE]);
    const repair = await loadHandler();
    const result = await withEnv({ GBRAIN_HOME: scratch }, () => runRepair(ctx(false), repair!, scope, { apply: true }));
    expect(result.applied).toBe(0);
    expect(await expiredAt(other[0]!.id)).not.toBeNull();
  });
});
