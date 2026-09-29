// #5674 — resumable, source-revision-bound withdrawal discovery. Whole-source
// inventory caps refused before matching on large brains; the plan table now
// retains cursor + accumulated affected set so a bounded scan resumes across
// invocations, and drift phases re-cover pages written mid-plan.
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { discoverWithdrawalTargets, persistWithdrawalDiscoveryPlan, type WithdrawalClaim } from '../src/core/facts/withdrawal-discovery.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const fence = (claim: string, visibility: 'private' | 'world' = 'world') => renderFactsTable([
  { rowNum: 1, claim, visibility, kind: 'fact', confidence: 1, notability: 'medium', active: true },
]);

for (const backend of testBackends()) describe(`resumable withdrawal discovery ${backend}`, () => {
  let engine: BrainEngine, close: () => Promise<void>;
  beforeAll(async () => {
    if (backend === 'postgres') {
      const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = fixture.engine; close = fixture.close;
    } else {
      engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect();
    }
  }, 60_000);
  afterAll(async () => { await close(); });

  async function fixture(pageCount = 6) {
    const sourceId = `resumable-${randomUUID()}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    for (let n = 0; n < pageCount; n++) {
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
        VALUES($1,$2,'note','Synthetic','Unrelated control text','','{}'::jsonb)`, [sourceId, `control-${n}`]);
    }
    await engine.putPage('affected', { type: 'note', title: 'affected', compiled_truth: fence('resumable sentinel') }, { sourceId });
    await engine.upsertChunks('affected', [{ chunk_index: 0, chunk_text: fence('resumable sentinel'), chunk_source: 'compiled_truth' }], { sourceId });
    const fact = await engine.insertFact({ fact: 'resumable sentinel', visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
    const [claim] = await engine.executeRaw<WithdrawalClaim>('SELECT visibility,gbrain_fact_fingerprint(fact) AS fact_hash FROM facts WHERE id=$1', [fact.id]);
    const plans = () => engine.executeRaw<{ phase: string; cursor: number }>('SELECT phase,cursor FROM fact_withdrawal_discovery WHERE source_id=$1', [sourceId]);
    return { sourceId, claims: [claim], plans };
  }

  // Mirrors the production outermost boundary: pending receipts carry the
  // plan and the caller persists it after the rolled-back tx releases the
  // connection. Errors without a carried plan rethrow immediately.
  const scan = (sourceId: string, claims: WithdrawalClaim[], opts?: { scanMs?: number; batch?: number }) =>
    discoverWithdrawalTargets(engine, sourceId, claims, opts).catch(async (error: unknown) => {
      await persistWithdrawalDiscoveryPlan(engine, error);
      throw error;
    });

  test('a zero-budget invocation reports pending and the retained plan resumes to the same target set', async () => {
    const f = await fixture();
    await expect(scan(f.sourceId, f.claims, { scanMs: 0 }))
      .rejects.toMatchObject({ code: 'withdrawal_pending' });
    expect(await f.plans()).toHaveLength(1);
    const targets = await scan(f.sourceId, f.claims);
    expect(targets.map(target => target.slug)).toEqual(['affected']);
    expect(await f.plans()).toEqual([]);
  });

  test('batch-bounded scanning completes across multiple pending receipts', async () => {
    const f = await fixture(24);
    let targets;
    let pendings = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { targets = await scan(f.sourceId, f.claims, { batch: 3, scanMs: 3 }); break; }
      catch (error) { if ((error as { code?: string }).code !== 'withdrawal_pending') throw error; pendings++; }
    }
    expect(pendings).toBeGreaterThan(0);
    expect(targets?.map(target => target.slug)).toEqual(['affected']);
    expect(await f.plans()).toEqual([]);
  });

  test('a replaced source incarnation resets a retained plan instead of resuming stale coverage', async () => {
    const f = await fixture();
    await expect(scan(f.sourceId, f.claims, { scanMs: 0 }))
      .rejects.toMatchObject({ code: 'withdrawal_pending' });
    const [before] = await f.plans();
    // Several tables FK-bind to sources.incarnation; the test only needs
    // sources.incarnation to move, so their rows for this source go with it.
    for (const table of ['page_write_guards', 'page_projection_jobs', 'source_ingestion_receipts', 'dream_synthesis_completions', 'extract_atoms_page_state']) {
      await engine.executeRaw(`DELETE FROM ${table} WHERE source_incarnation=(SELECT incarnation FROM sources WHERE id=$1)`, [f.sourceId]).catch(() => {});
    }
    await engine.executeRaw('UPDATE sources SET incarnation=gen_random_uuid() WHERE id=$1', [f.sourceId]);
    const targets = await scan(f.sourceId, f.claims);
    expect(targets.map(target => target.slug)).toEqual(['affected']);
    expect(before.phase).toBe('facts');
  });

  test('drift rescan catches a claim written into an already-scanned page mid-plan', async () => {
    const f = await fixture();
    // Force pending at the very start so every page is already behind the
    // cursor when the late write lands.
    await expect(scan(f.sourceId, f.claims, { batch: 2, scanMs: 1 }))
      .rejects.toMatchObject({ code: 'withdrawal_pending' });
    // Late write into an already-scanned page: updated_at moves past the
    // plan's started_at, so the drift phase re-covers it.
    await engine.executeRaw('UPDATE pages SET compiled_truth=$2,updated_at=now() WHERE source_id=$1 AND slug=$3',
      [f.sourceId, fence('resumable sentinel'), 'control-0']);
    const targets = await scan(f.sourceId, f.claims, { batch: 2 });
    expect(targets.map(target => target.slug).sort()).toEqual(['affected', 'control-0']);
  });

  test('a target set over the bound still refuses deterministically', async () => {
    const f = await fixture();
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
      SELECT $1,'extra-'||n,'note','Synthetic',$2,'','{}'::jsonb FROM generate_series(1,257) n`, [f.sourceId, fence('resumable sentinel')]);
    await expect(scan(f.sourceId, f.claims))
      .rejects.toMatchObject({ code: 'withdrawal_capacity' });
  });

  // Round-2 review cells — executed-assertion discrimination: every case
  // below exercises only the existing public surface and fails on behavior
  // (a missed target, a stale row, a wrong phase) rather than on imports.
  const claimsKey = (claims: WithdrawalClaim[]) =>
    createHash('sha256').update(JSON.stringify(claims.map(claim => [claim.visibility, claim.fact_hash])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])))).digest('hex');
  const seedPlan = async (f: { sourceId: string; claims: WithdrawalClaim[] }, row: { phase: string; cursor: number; affected?: number[]; started?: string; updated?: string; claims_key?: string; source_id?: string }) => {
    const [src] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [f.sourceId]);
    await engine.executeRaw(
      `INSERT INTO fact_withdrawal_discovery(source_id,claims_key,claims,source_incarnation,phase,cursor,affected,started_at,updated_at)
       VALUES($1,$2,'[]'::jsonb,$3,$4,$5,$6::int[],COALESCE($7::timestamptz,now()),COALESCE($8::timestamptz,now()))`,
      [row.source_id ?? f.sourceId, row.claims_key ?? claimsKey(f.claims), src.incarnation, row.phase, row.cursor, row.affected ?? [], row.started ?? null, row.updated ?? null]);
  };

  test('a low-id page written between invocations inside the drift window is re-covered', async () => {
    const f = await fixture();
    // Simulate a retained drift checkpoint whose id cursor already advanced
    // past every page: under the old id>cursor drift scan a later write to
    // a lower page id was skipped permanently yet the withdrawal committed.
    await seedPlan(f, { phase: 'drift_pages', cursor: 2_147_483_000, started: '2000-01-01 00:00:00+00' });
    await engine.executeRaw('UPDATE pages SET compiled_truth=$2,updated_at=now() WHERE source_id=$1 AND slug=$3',
      [f.sourceId, fence('resumable sentinel'), 'control-0']);
    const targets = await scan(f.sourceId, f.claims);
    expect(targets.map(target => target.slug).sort()).toEqual(['affected', 'control-0']);
    expect(await f.plans()).toEqual([]);
  });

  test('a persisted drift checkpoint restarts its window instead of skipping low ids', async () => {
    const f = await fixture();
    // Pull every page into the drift window, then suspend mid-drift_pages.
    await engine.executeRaw(`UPDATE pages SET compiled_truth=compiled_truth,updated_at=now() WHERE source_id=$1`, [f.sourceId]);
    await seedPlan(f, { phase: 'drift_pages', cursor: 0, started: '2000-01-01 00:00:00+00' });
    await expect(scan(f.sourceId, f.claims, { batch: 1, scanMs: 1 }))
      .rejects.toMatchObject({ code: 'withdrawal_pending' });
    const [first] = await f.plans();
    expect(first.phase).toBe('drift_pages');
    // The retained checkpoint is a window restart, not a row-id position:
    // carrying the last-seen id forward is what used to skip low ids forever.
    expect(Number(first.cursor)).toBe(0);
    await engine.executeRaw('UPDATE pages SET compiled_truth=$2,updated_at=now() WHERE source_id=$1 AND slug=$3',
      [f.sourceId, fence('resumable sentinel'), 'control-0']);
    const targets = await scan(f.sourceId, f.claims, { batch: 1 });
    expect(targets.map(target => target.slug).sort()).toEqual(['affected', 'control-0']);
  });

  test('facts provenance scans bounded id batches and resumes with committed progress on large sources', async () => {
    const f = await fixture();
    await engine.executeRaw(`INSERT INTO facts(source_id,fact,kind,visibility,source)
      SELECT $1,'unrelated-fact-'||n,'fact','world','synthetic' FROM generate_series(1,40050) n`, [f.sourceId]);
    // Duplicate claims must not double-count provenance matches.
    const dup = [...f.claims, ...f.claims];
    await expect(scan(f.sourceId, dup, { batch: 512, scanMs: 1 }))
      .rejects.toMatchObject({ code: 'withdrawal_pending' });
    const [first] = await f.plans();
    // The bounded facts phase commits its keyset progress — previously the
    // whole-source fingerprint join re-ran outside the resumable phases on
    // every retry and never left committed progress.
    expect(first.phase).toBe('facts');
    expect(Number(first.cursor)).toBeGreaterThan(0);
    const targets = await scan(f.sourceId, dup, { scanMs: 60_000 });
    expect(targets.map(target => target.slug)).toEqual(['affected']);
    expect(await f.plans()).toEqual([]);
  });

  test('an idle-expired plan restarts instead of resuming stale coverage', async () => {
    const f = await fixture();
    await seedPlan(f, {
      phase: 'drift_chunks', cursor: 2_147_483_000, affected: [2_147_482_999],
      started: '2000-01-01 00:00:00+00', updated: '2000-01-01 00:30:00+00',
    });
    const targets = await scan(f.sourceId, f.claims);
    expect(targets.map(target => target.slug)).toEqual(['affected']);
  });

  test('entry GC reaps plans orphaned by a deleted source', async () => {
    const f = await fixture();
    const ghost = `ghost-${randomUUID()}`;
    await seedPlan(f, { phase: 'pages', cursor: 0, source_id: ghost, claims_key: 'orphan' });
    await scan(f.sourceId, f.claims);
    const leftover = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM fact_withdrawal_discovery WHERE source_id=$1', [ghost]);
    expect(leftover[0].n).toBe(0);
  });
});
