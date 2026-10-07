// #6212 — a brain upgraded from an older version can hold pages whose slugs
// the current create grammar rejects (spaces, e.g. `people/jane doe` from
// old capture-cli imports). Grammar must gate creation, not addressing:
// delete and restore work on the stored slug; file safety still applies.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const fixtures: Array<{ engine: BrainEngine; root: string; ctx: OperationContext; close: () => Promise<void> }> = [];
const sourceId = 'legacy-slug-delete';
beforeAll(async () => {
  const engine = new PGLiteEngine();
  await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => { await engine.connect({}); await engine.initSchema(); });
  const databases: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [{ engine, close: () => engine.disconnect() }];
  if (process.env.DATABASE_URL) databases.push(await isolatedPersistencePostgres(process.env.DATABASE_URL));
  for (const database of databases) {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-legacy-slug-delete-'));
    await database.engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await claimWorktree(database.engine, sourceId, root);
    fixtures.push({ ...database, root, ctx: { engine: database.engine, config: { engine: database.engine.kind, embedding_disabled: true },
      sourceId, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } });
  }
}, 120_000);
afterAll(async () => {
  for (const { engine, root, close } of fixtures) { await disposePersistenceConsumer(engine); await close(); rmSync(root, { recursive: true, force: true }); }
});

const submit = (ctx: OperationContext, operation: string, params: Record<string, unknown>) =>
  submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } });

test('a legacy space-slug page can be deleted and restored while creates and traversal stay refused (#6212)', async () => {
  for (const { engine, ctx } of fixtures) {
    const slug = 'people/jane doe';
    // The reporter's shape: a database-only row written by an older version
    // (source_path null, no canonical file).
    await engine.putPage(slug, { type: 'note', title: 'Jane Doe', compiled_truth: 'Legacy body' }, { sourceId });
    const snap = (await engine.readPageSnapshot(slug, { sourceId }))!;
    // The create grammar still gates writes — only addressing was relaxed.
    await expect(submit(ctx, 'put_page', { slug, content: 'x', expected_revision: snap.revision }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    const deleted = await submit(ctx, 'delete_page', { slug, expected_revision: snap.revision });
    expect(deleted.status).toBe('soft_deleted');
    expect((await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!.page.deleted_at).not.toBeNull();
    // A tombstone must not be stranded either — restore is the same addressing.
    const restored = await submit(ctx, 'restore_page', { slug, expected_revision: deleted.revision });
    expect(restored.status).toBe('restored');
    // Lookup-safety is still enforced: traversal is invalid_params, not a lookup.
    await expect(submit(ctx, 'delete_page', { slug: '../escape' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(submit(ctx, 'delete_page', { slug: '/abs' })).rejects.toMatchObject({ code: 'invalid_params' });
  }
}, 120_000);
