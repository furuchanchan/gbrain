/**
 * `gbrain repair failed-writes` restricted-namespace replay (#5994): a failed
 * write authored on a subagent lane replays within its stored delegated
 * prefixes. The stored WriteAuthority keeps delegatedPrefixes but drops the
 * numeric subagentId, and the replay lane rebuilds the same shape — so the
 * slug fence must check the allow-list without demanding an id.
 * Fail-closed stays: a stored authority whose prefixes do not cover the slug
 * is refused, and --apply now prints refusal reasons in human output.
 * Runs on PGLite and, through test/e2e, Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { MANAGED_WRITER_GUARD_FUNCTION_SQL } from '../src/core/persistence/writer-guard-schema.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { installPre5983Guard } from './helpers/pre-5983-guard.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-replay-5994-db-'));
let closePostgres: (() => Promise<void>) | undefined;
const logger = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    for (const table of ['tags', 'timeline_entries', 'takes']) await engine.executeRaw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_id TEXT`);
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

const ctxFor = (engine: BrainEngine, sourceId: string) =>
  ({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger }) as OperationContext;
const page = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\ntags: [repro]\n---\n${body}`;

async function attemptSubagent(engine: BrainEngine, sourceId: string, slug: string, lane: 'workspace' | 'legacy') {
  const ctx = { ...ctxFor(engine, sourceId), remote: true, viaSubagent: true, subagentId: 42,
    ...(lane === 'workspace' ? { allowedSlugPrefixes: ['wiki/personal/*'] } : {}) } as OperationContext;
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: page(slug, `${slug} body.`), request_id: randomUUID() } })
    .catch(() => undefined);
}

test('failed subagent writes replay inside their stored delegated namespaces; a narrowed stored list still refuses, with the reason printed', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-replay-5994-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `r5994-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

        await installPre5983Guard(engine);
        await attemptSubagent(engine, sourceId, 'wiki/personal/dream-note', 'workspace');
        await attemptSubagent(engine, sourceId, 'wiki/agents/42/legacy-note', 'legacy');
        const failed = await engine.executeRaw<{ slug: string; authority: { restrictedNamespace?: boolean; delegatedPrefixes?: string[] } }>(
          `SELECT slug, authority FROM persistence_requests WHERE source_id=$1 AND state='failed' ORDER BY slug`, [sourceId]);
        expect(failed.map(r => r.slug)).toEqual(['wiki/agents/42/legacy-note', 'wiki/personal/dream-note']);
        // The trusted-workspace write stored its explicit allow-list; the
        // legacy write stored its derived wiki/agents/<id>/ namespace. Neither
        // stores the numeric job id.
        expect(failed[0].authority).toMatchObject({ restrictedNamespace: true, delegatedPrefixes: ['wiki/agents/42/*'] });
        expect(failed[1].authority).toMatchObject({ restrictedNamespace: true, delegatedPrefixes: ['wiki/personal/*'] });
        // A third write whose stored allow-list no longer covers its slug —
        // the namespace a stored replay must still refuse.
        await attemptSubagent(engine, sourceId, 'wiki/personal/fenced-out', 'workspace');
        await engine.executeRaw(
          `UPDATE persistence_requests SET authority=jsonb_set(authority,'{delegatedPrefixes}','["wiki/other/*"]')
            WHERE source_id=$1 AND slug='wiki/personal/fenced-out'`, [sourceId]);
        await engine.executeRaw(MANAGED_WRITER_GUARD_FUNCTION_SQL);

        const scope = await resolveRepairScope(engine, sourceId);
        const preview = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
        expect((preview.listing ?? []).map(e => `${e.item.split(' ').slice(0, 2).join(' ')} ${e.class}`)).toEqual([
          `${sourceId}:wiki/personal/dream-note put_page replay`,
          `${sourceId}:wiki/agents/42/legacy-note put_page replay`,
          `${sourceId}:wiki/personal/fenced-out put_page replay`,
        ]);

        const applied = await (await repairRunner(engine, { apply: true, logger })).run('failed-writes', scope,
          { explicit: true, sourceFlag: sourceId, expect: preview.apply_command.split('--expect ')[1] });
        // The tampered authority dies at authorizeStoredRequest, before the
        // replay's own admission — the durable layer still owns the denial.
        expect(applied.outcomes).toEqual({ replayed: 2, authority_revoked: 1 });
        expect((await engine.getPage('wiki/personal/dream-note', { sourceId }))?.compiled_truth).toContain('wiki/personal/dream-note body.');
        expect((await engine.getPage('wiki/agents/42/legacy-note', { sourceId }))?.compiled_truth).toContain('wiki/agents/42/legacy-note body.');
        expect(await engine.getPage('wiki/personal/fenced-out', { sourceId })).toBeNull();
        const refused = applied.outcome_items?.find(i => i.outcome === 'authority_revoked');
        expect(refused?.item).toBe(`${sourceId}:wiki/personal/fenced-out`);
        expect(refused?.reason).toContain('delegated namespace');

        // Restoring the stored allow-list makes the same item replayable.
        await engine.executeRaw(
          `UPDATE persistence_requests SET authority=jsonb_set(authority,'{delegatedPrefixes}','["wiki/personal/*"]')
            WHERE source_id=$1 AND slug='wiki/personal/fenced-out'`, [sourceId]);
        const preview2 = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
        const applied2 = await (await repairRunner(engine, { apply: true, logger })).run('failed-writes', scope,
          { explicit: true, sourceFlag: sourceId, expect: preview2.apply_command.split('--expect ')[1] });
        expect(applied2.outcomes).toEqual({ replayed: 1 });
        expect((await engine.getPage('wiki/personal/fenced-out', { sourceId }))?.compiled_truth).toContain('wiki/personal/fenced-out body.');
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw(MANAGED_WRITER_GUARD_FUNCTION_SQL);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);

test('the apply run prints refused items with their reasons in human output', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-replay-5994h-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `r5994h-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await installPre5983Guard(engine);
        await attemptSubagent(engine, sourceId, 'wiki/personal/fenced-out', 'workspace');
        await engine.executeRaw(
          `UPDATE persistence_requests SET authority=jsonb_set(authority,'{delegatedPrefixes}','["wiki/other/*"]')
            WHERE source_id=$1 AND slug='wiki/personal/fenced-out'`, [sourceId]);
        await engine.executeRaw(MANAGED_WRITER_GUARD_FUNCTION_SQL);

        const scope = await resolveRepairScope(engine, sourceId);
        const preview = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
        const out: string[] = [];
        const log = console.log;
        console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
        try {
          await runRepairCommand(engine, ['failed-writes', '--source', sourceId, '--apply', '--expect', preview.apply_command.split('--expect ')[1]]);
        } finally { console.log = log; }
        const text = out.join('\n');
        expect(text).toContain('authority_revoked=1');
        expect(text).toContain(`authority_revoked: ${sourceId}:wiki/personal/fenced-out`);
        expect(text).toContain('delegated namespace');
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw(MANAGED_WRITER_GUARD_FUNCTION_SQL);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);
