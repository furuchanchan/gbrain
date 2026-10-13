import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

// gbrain#6609: on an unmanaged brain, restoring a page whose file sits under a
// db_only directory used to keep source_path bound, so the next full sync
// (which respects the generated .gitignore entry) re-deleted it — an infinite
// restore/delete loop with no supported way to keep the page database-only.
const fixtures: Array<{ engine: BrainEngine; root: string; ctx: OperationContext; close: () => Promise<void> }> = [];
const sourceId = 'restore-detach';
beforeAll(async () => {
  const engine = new PGLiteEngine();
  await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => { await engine.connect({}); await engine.initSchema(); });
  const root = mkdtempSync(join(tmpdir(), 'gbrain-restore-detach-'));
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  fixtures.push({ engine, root, close: () => engine.disconnect(),
    ctx: { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } });
}, 120_000);
afterAll(async () => {
  for (const { engine, root, close } of fixtures) { await disposePersistenceConsumer(engine); await close(); rmSync(root, { recursive: true, force: true }); }
});
const content = (body: string) => `---\ntitle: Example\ntype: note\n---\n${body}\n`;
const submit = (ctx: OperationContext, operation: string, params: Record<string, unknown>) =>
  submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } });
const sourcePath = async (engine: BrainEngine, slug: string) =>
  (await engine.executeRaw<{ source_path: string | null }>(
    'SELECT source_path FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]?.source_path;

test('restoring a page whose file is under a db_only dir keeps it database-only; a normal restore stays bound', async () => {
  for (const { engine, root, ctx } of fixtures) {
    // File-backed page first, db_only declared after — the reported sequence.
    const first = await submit(ctx, 'put_page', { slug: 'private/note', content: content('Detached body') });
    expect(first.state).toBe('committed');
    expect(await sourcePath(engine, 'private/note')).not.toBeNull();
    const kept = await submit(ctx, 'put_page', { slug: 'plain', content: content('Bound body') });
    expect(kept.state).toBe('committed');

    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - private\n');

    const deletedPrivate = await submit(ctx, 'delete_page', { slug: 'private/note', expected_revision: first.revision });
    const restoredPrivate = await submit(ctx, 'restore_page', { slug: 'private/note', expected_revision: deletedPrivate.revision });
    expect(restoredPrivate.state).toBe('committed');
    expect(restoredPrivate.detached).toBe('db_only');
    const detached = (await engine.readPageSnapshot('private/note', { sourceId }))!;
    expect(detached.page.deleted_at).toBeNull();
    expect(await sourcePath(engine, 'private/note')).toBeNull();

    const deletedPlain = await submit(ctx, 'delete_page', { slug: 'plain', expected_revision: kept.revision });
    const restoredPlain = await submit(ctx, 'restore_page', { slug: 'plain', expected_revision: deletedPlain.revision });
    expect(restoredPlain.state).toBe('committed');
    expect(restoredPlain.detached).toBeUndefined();
    expect(await sourcePath(engine, 'plain')).not.toBeNull();
  }
});
